import 'dotenv/config'
import express from 'express'
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js'
import mongoose, { Schema } from 'mongoose'

/* =========================
 * Helpers & Config (IDs แบบคงที่ตามที่ผู้ใช้ระบุ)
 * ========================= */
const cfg = {
  ACTION_ROLE_ID: '1419190035361697863',        // ใช้ /add, /remove ได้
  MEMBER_ROLE_ID: '1139181683300634664',        // บทบาทสมาชิกแคลน (ใช้ตอน warn ครบ3 / ban / unban)
  ADD_LOG_CHANNEL_ID: '1419188238932901910',    // log ของ /add
  REMOVE_LOG_CHANNEL_ID: '1419188292531912704', // log ของ /remove
  WARN_LOG_CHANNEL_ID: '1419192910842433547',
  PROMOTE_LOG_CHANNEL_ID: '1419324568757338122',
  DEMOTE_LOG_CHANNEL_ID: '1419324625950605332',
}

const RANKS = {
  LEADER: 'หัวแคลน',
  DEPUTY: 'รองหัวแคลน',
  SERGEANT: 'จ่า',
  MEMBER: 'สมาชิก',
}
const rankChoices = [RANKS.LEADER, RANKS.DEPUTY, RANKS.SERGEANT, RANKS.MEMBER]
const promotable = [RANKS.DEPUTY, RANKS.SERGEANT]
const demotable = [RANKS.SERGEANT, RANKS.MEMBER]

function formatDateTH(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function parseDateInput(s) {
  if (!s) return null
  const t = s.replace(/-/g, '/').trim()
  const [dd, mm, yyyy] = t.split('/')
  if (!dd || !mm || !yyyy) return null
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd))
  return isNaN(d.getTime()) ? null : d
}

function hasActionRole(member) {
  return member.roles?.cache?.has(cfg.ACTION_ROLE_ID)
}

/* =========================
 * Mongo Schemas
 * ========================= */
try {
  await mongoose.connect(process.env.MONGO_URI)
  console.log('[MongoDB] connected')
} catch (err) {
  console.error('[MongoDB] connect error', err)
}

const MemberSchema = new Schema({
  gameId: { type: String, unique: true, index: true },
  discordId: { type: String, default: null },
  rank: { type: String, enum: rankChoices, default: RANKS.MEMBER },
  joinedAt: { type: Date, default: Date.now },
  notes: { type: String, default: '' },
  history: [{ ts: Date, action: String, by: String, meta: Schema.Types.Mixed }],
})

const WarnSchema = new Schema({
  gameId: { type: String, index: true },
  entries: [
    {
      reason: String,
      ts: { type: Date, default: Date.now },
      moderatorId: String,
    },
  ],
})

const BanSchema = new Schema({
  gameId: { type: String, unique: true, index: true },
  reason: String,
  moderatorId: String,
  ts: { type: Date, default: Date.now },
  active: { type: Boolean, default: true },
  discordId: { type: String, default: null },
})

const Member = mongoose.model('Member', MemberSchema)
const Warns = mongoose.model('Warns', WarnSchema)
const Ban = mongoose.model('Ban', BanSchema)

/* =========================
 * Discord Client
 * ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
})

/* =========================
 * Command Builders
 * ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('เพิ่มสมาชิกหลายไอดี (คั่นด้วยช่องว่าง)')
    .addStringOption(o => o.setName('ids').setDescription('ไอดีเกม: A B C').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('บัญชี Discord (ไม่บังคับ)'))
    .addStringOption(o => o.setName('day').setDescription('วันเข้ารูปแบบ DD/MM/YYYY (เว้นว่าง = วันนี้)'))
    .addStringOption(o => o.setName('ตำแหน่ง').setDescription('ตำแหน่งในแคลน').addChoices(
      ...rankChoices.map(r => ({ name: r, value: r }))
    ))
    .addStringOption(o => o.setName('หมายเหตุ').setDescription('โน้ตเพิ่มเติม (ไม่บังคับ)')),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('ลบสมาชิกหลายไอดี (คั่นด้วยช่องว่าง)')
    .addStringOption(o => o.setName('ids').setDescription('ไอดีเกม: A B C').setRequired(true))
    .addStringOption(o => o.setName('day').setDescription('วันลบรูปแบบ DD/MM/YYYY (เว้นว่าง = วันนี้)'))
    .addStringOption(o => o.setName('หมายเหตุ').setDescription('สาเหตุ/หมายเหตุ')),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('ลิสต์สมาชิกตามตำแหน่งพร้อมวันที่เข้า'),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('เตือนสมาชิก (เก็บประวัติ)')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addStringOption(o => o.setName('หมายเหตุ').setDescription('เตือนเรื่องอะไร').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('ส่ง DM ถ้าใส่')),

  new SlashCommandBuilder()
    .setName('warnlog')
    .setDescription('ดูประวัติการเตือนของไอดีเกม')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('ลบหมายเหตุเตือน (ตามลำดับข้อ)')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addIntegerOption(o => o.setName('ลำดับ').setDescription('1 = อันแรก').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('แบนสมาชิกแคลน (ไม่เตะออกจากเซิร์ฟเวอร์)')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addStringOption(o => o.setName('เหตุผล').setDescription('เหตุผลการแบน').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('เลือกผู้ใช้ Discord (ไม่บังคับ)')),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('ยกเลิกการแบน')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addStringOption(o => o.setName('เหตุผล').setDescription('เหตุผล (ไม่บังคับ)'))
    .addUserOption(o => o.setName('discord').setDescription('เลือกผู้ใช้ Discord (ไม่บังคับ)')),

  new SlashCommandBuilder()
    .setName('promote')
    .setDescription('เลื่อนตำแหน่ง รองหัวแคลน/จ่า')
    .addStringOption(o => o.setName('ตำแหน่ง').setDescription('รองหัวแคลน/จ่า').setRequired(true).addChoices(
      ...promotable.map(r => ({ name: r, value: r }))
    ))
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('ผู้ใช้ Discord (ไม่บังคับ)')),

  new SlashCommandBuilder()
    .setName('demote')
    .setDescription('ลดตำแหน่ง จ่า/สมาชิก')
    .addStringOption(o => o.setName('ตำแหน่ง').setDescription('จ่า/สมาชิก').setRequired(true).addChoices(
      ...demotable.map(r => ({ name: r, value: r }))
    ))
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('ผู้ใช้ Discord (ไม่บังคับ)')),
]
  .map(c => c.setDMPermission(false))

/* =========================
 * Register Commands (toggle by env)
 * ========================= */
if (process.env.REGISTER_COMMANDS === 'true') {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
  const body = commands.map(c => c.toJSON())
  const run = async () => {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body })
      console.log('Guild commands registered')
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body })
      console.log('Global commands registered')
    }
    process.exit(0)
  }
  await run()
}

/* =========================
 * Utility: logging
 * ========================= */
async function sendLog(channelId, embed) {
  try {
    const ch = await client.channels.fetch(channelId)
    if (ch && ch.type === ChannelType.GuildText) {
      await ch.send({ embeds: [embed] })
    }
  } catch (e) {
    console.error('sendLog error', e)
  }
}

function makeBasicEmbed(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setTimestamp(new Date())
}

/* =========================
 * Core Handlers
 * ========================= */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return

  try {
    switch (i.commandName) {
      case 'add':
        return handleAdd(i)
      case 'remove':
        return handleRemove(i)
      case 'list':
        return handleList(i)
      case 'warn':
        return handleWarn(i)
      case 'warnlog':
        return handleWarnLog(i)
      case 'unwarn':
        return handleUnwarn(i)
      case 'ban':
        return handleBan(i)
      case 'unban':
        return handleUnban(i)
      case 'promote':
        return handlePromote(i)
      case 'demote':
        return handleDemote(i)
    }
  } catch (err) {
    console.error(err)
    if (!i.replied) await i.reply({ content: 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', ephemeral: true })
  }
})

/* =========================
 * Prefix Commands (!hello, !ac, !sp)
 * ========================= */
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return
  const content = msg.content.trim()

  if (content.startsWith('!hello')) {
    return void msg.reply('สวัสดี')
  }

  if (content.startsWith('!ac')) {
    const mentionedUser = msg.mentions.users.first()
    await msg.delete().catch(() => {})
    const mention = mentionedUser ? `<@${mentionedUser.id}>` : ''
    const embed = new EmbedBuilder()
      .setTitle('__**การสมัครแคลน**__')
      .setDescription(
        `${mention}\n\nโปรดทราบว่าการสมัครแคลนคุณจะต้องสมัครผ่านในเกมตามไอดีแคลนหากคุณสมัครแล้วแต่ยังไม่ได้บทบาทโปรดคลิกเพิ่มไอดีของคุณด่านล้าง โปรดทราบว่าการอนุมัติในแคลนจะต้องใช้เวลา 1-12 ชั่วโมงในการอนุมัติและการเพิ่มไอดีเกมคุณลงใน discord หากคุณอยู่ในแคลนแล้วเราจะไม่ให้บทบาทโดยทันทีแต่คุณต้องเพิ่มเอง โดยการกดยืนยันอีกครั้งในห้อง <#1155132320144162867>\n\nไอดีแคลน: **YL9KM1**\n\nหากพบปัญหา โปรดติดต่อสนับสนุน <#1139191108547653704>`
      )
      .setTimestamp(new Date())
    return void msg.channel.send({ embeds: [embed] })
  }

  if (content.startsWith('!sp')) {
    const mentionedUser = msg.mentions.users.first()
    await msg.delete().catch(() => {})
    const mention = mentionedUser ? `<@${mentionedUser.id}>` : ''
    const embed = new EmbedBuilder()
      .setDescription(`${mention}\n\nหากพบปัญหาอะไรให้ติดต่อ <#1139191108547653704> หรือสนับสนุนของเรานั่นเอง`)
      .setTimestamp(new Date())
    return void msg.channel.send({ embeds: [embed] })
  }
})

/* =========================
 * Handlers Implementation
 * ========================= */
async function handleAdd(i) {
  const member = await i.guild.members.fetch(i.user.id)
  if (!hasActionRole(member)) return i.reply({ content: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true })

  const idsStr = i.options.getString('ids', true)
  const discordUser = i.options.getUser('discord')
  const dayStr = i.options.getString('day')
  const pos = i.options.getString('ตำแหน่ง') || RANKS.MEMBER
  const note = i.options.getString('หมายเหตุ') || ''

  const joinDate = parseDateInput(dayStr) || new Date()
  const joinDateStr = formatDateTH(joinDate)

  const ids = idsStr.split(/\s+/).map(s => s.trim()).filter(Boolean)
  if (!ids.length) return i.reply({ content: 'กรุณาใส่ไอดีอย่างน้อย 1 รายการ', ephemeral: true })

  const banned = await Ban.find({ gameId: { $in: ids }, active: true })
  if (banned.length) {
    const bList = banned.map(b => `• ${b.gameId} (แบนอยู่)`).join('\n')
    return i.reply({ content: `มีไอดีถูกแบนอยู่ ไม่สามารถเพิ่มได้:\n${bList}`, ephemeral: true })
  }

  const results = []
  for (const gid of ids) {
    const update = {
      gameId: gid,
      discordId: discordUser?.id || null,
      rank: pos,
      joinedAt: joinDate,
      notes: note,
    }
    const doc = await Member.findOneAndUpdate(
      { gameId: gid },
      { $setOnInsert: update, $push: { history: { ts: new Date(), action: 'add', by: i.user.id, meta: { pos, note } } } },
      { upsert: true, new: true }
    )
    results.push(doc)
  }

  const embed = makeBasicEmbed('เพิ่มสมาชิก', `โดย <@${i.user.id}>\nวันที่: **${joinDateStr}**\nตำแหน่ง: **${pos}**\n\n${results.map(d => `• ${d.gameId}${d.discordId ? ` (<@${d.discordId}>)` : ''}`).join('\n')}${note ? `\n\นหมายเหตุ: ${note}` : ''}`)
  await sendLog(cfg.ADD_LOG_CHANNEL_ID, embed)

  return i.reply({ content: `เพิ่มสมาชิกแล้ว: ${results.length} รายการ (ดู log)`, ephemeral: true })
}

async function handleRemove(i) {
  const member = await i.guild.members.fetch(i.user.id)
  if (!hasActionRole(member)) return i.reply({ content: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true })

  const idsStr = i.options.getString('ids', true)
  const dayStr = i.options.getString('day')
  const note = i.options.getString('หมายเหตุ') || ''
  const when = parseDateInput(dayStr) || new Date()
  const whenStr = formatDateTH(when)

  const ids = idsStr.split(/\s+/).map(s => s.trim()).filter(Boolean)
  if (!ids.length) return i.reply({ content: 'กรุณาใส่ไอดีอย่างน้อย 1 รายการ', ephemeral: true })

  const found = await Member.find({ gameId: { $in: ids } })
  const foundIds = new Set(found.map(f => f.gameId))
  await Member.deleteMany({ gameId: { $in: ids } })

  const embed = makeBasicEmbed('ลบสมาชิก', `โดย <@${i.user.id}>\nวันที่: **${whenStr}**\n\n${ids.map(g => `• ${g}${foundIds.has(g) ? '' : ' (ไม่พบเดิม)'} `).join('\n')}${note ? `\n\nหมายเหตุ: ${note}` : ''}`)
  await sendLog(cfg.REMOVE_LOG_CHANNEL_ID, embed)

  return i.reply({ content: `ลบแล้ว ${ids.length} รายการ (ดู log)`, ephemeral: true })
}

async function handleList(i) {
  const all = await Member.find({}).sort({ joinedAt: 1 })
  const buckets = {
    [RANKS.LEADER]: [],
    [RANKS.DEPUTY]: [],
    [RANKS.SERGEANT]: [],
    [RANKS.MEMBER]: [],
  }
  for (const m of all) {
    const line = `• ${m.gameId}${m.discordId ? ` (<@${m.discordId}>)` : ''} — เข้าวันที่ ${formatDateTH(m.joinedAt)}`
    ;(buckets[m.rank] || buckets[RANKS.MEMBER]).push(line)
  }
  const desc = `**${RANKS.LEADER}**\n${buckets[RANKS.LEADER].join('\n') || '-'}\n\n**${RANKS.DEPUTY}**\n${buckets[RANKS.DEPUTY].join('\n') || '-'}\n\n**${RANKS.SERGEANT}**\n${buckets[RANKS.SERGEANT].join('\n') || '-'}\n\n**${RANKS.MEMBER}**\n${buckets[RANKS.MEMBER].join('\n') || '-'}`
  const embed = new EmbedBuilder().setTitle('รายชื่อสมาชิกแคลน').setDescription(desc).setTimestamp(new Date())
  return i.reply({ embeds: [embed], ephemeral: true })
}

async function handleWarn(i) {
  const gameId = i.options.getString('game_id', true)
  const reason = i.options.getString('หมายเหตุ', true)
  const target = i.options.getUser('discord')

  const doc = (await Warns.findOne({ gameId })) || new Warns({ gameId, entries: [] })
  doc.entries.push({ reason, ts: new Date(), moderatorId: i.user.id })
  await doc.save()

  const count = doc.entries.length
  const embed = makeBasicEmbed('เตือนสมาชิก', `โดย <@${i.user.id}>\nไอดีเกม: **${gameId}**\nจำนวนเตือน: **${count}/3**\nสาเหตุ: ${reason}`)
  await sendLog(cfg.WARN_LOG_CHANNEL_ID, embed)

  if (target) {
    try { await target.send(`คุณถูกเตือนในแคลน\nสาเหตุ: ${reason}\nสถานะ: ${count}/3`) } catch {}
  }

  if (count >= 3) {
    await Ban.updateOne(
      { gameId },
      { $set: { active: true, reason: 'ครบ 3 เตือน', moderatorId: i.user.id, ts: new Date(), discordId: target?.id || null } },
      { upsert: true }
    )
    try {
      if (target) {
        const gm = await i.guild.members.fetch(target.id)
        await gm.roles.remove(cfg.MEMBER_ROLE_ID).catch(() => {})
      }
    } catch {}
  }

  return i.reply({ content: `เตือนแล้ว: ${gameId} (รวม ${count}/3)`, ephemeral: true })
}

async function handleWarnLog(i) {
  const gameId = i.options.getString('game_id', true)
  const doc = await Warns.findOne({ gameId })
  if (!doc || doc.entries.length === 0) {
    return i.reply({ content: `ไอดีเกม: **${gameId}**\n**คนนี้ยังใสสะอาดไม่ทำผิดอะไร**`, ephemeral: true })
  }
  const lines = doc.entries.map((e, idx) => `${idx + 1}) ${e.reason} — ${formatDateTH(e.ts)} โดย <@${e.moderatorId}>`)
  const embed = makeBasicEmbed('ประวัติการเตือน', `ไอดีเกม: **${gameId}**\nทำผิด **${doc.entries.length}/3** ครั้ง\n\n${lines.join('\n')}`)
  return i.reply({ embeds: [embed], ephemeral: true })
}

async function handleUnwarn(i) {
  const gameId = i.options.getString('game_id', true)
  const idx = i.options.getInteger('ลำดับ', true) - 1
  const doc = await Warns.findOne({ gameId })
  if (!doc || idx < 0 || idx >= doc.entries.length) {
    return i.reply({ content: 'ไม่พบรายการเตือนตามลำดับที่ระบุ', ephemeral: true })
  }
  doc.entries.splice(idx, 1)
  await doc.save()
  return i.reply({ content: `ลบการเตือนลำดับ ${idx + 1} ของ ${gameId} แล้ว`, ephemeral: true })
}

async function handleBan(i) {
  const gameId = i.options.getString('game_id', true)
  const reason = i.options.getString('เหตุผล', true)
  const user = i.options.getUser('discord')

  await Ban.updateOne(
    { gameId },
    { $set: { active: true, reason, moderatorId: i.user.id, ts: new Date(), discordId: user?.id || null } },
    { upsert: true }
  )
  if (user) {
    try {
      const gm = await i.guild.members.fetch(user.id)
      await gm.roles.remove(cfg.MEMBER_ROLE_ID).catch(() => {})
    } catch {}
  }

  return i.reply({ content: `แบนแล้ว: ${gameId}` })
}

async function handleUnban(i) {
  const gameId = i.options.getString('game_id', true)
  await Ban.updateOne({ gameId }, { $set: { active: false } })

  const user = i.options.getUser('discord')
  if (user) {
    try {
      const gm = await i.guild.members.fetch(user.id)
      await gm.roles.add(cfg.MEMBER_ROLE_ID).catch(() => {})
    } catch {}
  }

  return i.reply({ content: `ยกเลิกแบน: ${gameId}` })
}

async function handlePromote(i) {
  const pos = i.options.getString('ตำแหน่ง', true)
  const gid = i.options.getString('game_id', true)
  const user = i.options.getUser('discord')

  await Member.findOneAndUpdate(
    { gameId: gid },
    { $set: { rank: pos }, $push: { history: { ts: new Date(), action: 'promote', by: i.user.id, meta: { pos } } } },
    { new: true, upsert: true }
  )
  const embed = makeBasicEmbed('เลื่อนตำแหน่ง', `โดย <@${i.user.id}>\nเกมไอดี: **${gid}** → **${pos}**${user ? `\nDiscord: <@${user.id}>` : ''}`)
  await sendLog(cfg.PROMOTE_LOG_CHANNEL_ID, embed)

  return i.reply({ content: `เลื่อนตำแหน่งแล้ว: ${gid} → ${pos}`, ephemeral: true })
}

async function handleDemote(i) {
  const pos = i.options.getString('ตำแหน่ง', true)
  const gid = i.options.getString('game_id', true)
  const user = i.options.getUser('discord')

  await Member.findOneAndUpdate(
    { gameId: gid },
    { $set: { rank: pos }, $push: { history: { ts: new Date(), action: 'demote', by: i.user.id, meta: { pos } } } },
    { new: true, upsert: true }
  )
  const embed = makeBasicEmbed('ลดตำแหน่ง', `โดย <@${i.user.id}>\nเกมไอดี: **${gid}** → **${pos}**${user ? `\nDiscord: <@${user.id}>` : ''}`)
  await sendLog(cfg.DEMOTE_LOG_CHANNEL_ID, embed)

  return i.reply({ content: `ลดตำแหน่งแล้ว: ${gid} → ${pos}`, ephemeral: true })
}

/* =========================
 * Login Discord
 * ========================= */
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`)
})
client.login(process.env.DISCORD_TOKEN)

/* =========================
 * Express Health Server (Web Service / Health Check)
 * ========================= */
const app = express()
app.get('/', (_req, res) => res.send('Discord Clan Bot is running'))
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Health server listening on ${PORT}`))


อัปเดตให้แล้ว! ผมวางไฟล์ใหม่ชื่อ index.express.js ในแคนวาส (รวมโค้ดเต็ม + Express health server + ปรับ log แยก add/remove และ IDs แบบคงที่) ✅

ให้คุณทำตามนี้:

1. แทนที่ไฟล์เก่า index.js ด้วยไ