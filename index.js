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
 * Config (IDs แบบคงที่)
 * ========================= */
const cfg = {
  ACTION_ROLE_ID: '1419190035361697863',        // ใช้ /add, /remove ได้
  MEMBER_ROLE_ID: '1139181683300634664',        // บทบาทสมาชิกแคลน (ใช้ตอน warn ครบ3 / ban / unban)
  ADD_LOG_CHANNEL_ID: '1419188238932901910',    // log ของ /add
  REMOVE_LOG_CHANNEL_ID: '1419188292531912704', // log ของ /remove
  WARN_LOG_CHANNEL_ID: '1419192910842433547',   // log ของ /warn
  PROMOTE_LOG_CHANNEL_ID: '1419324568757338122',
  DEMOTE_LOG_CHANNEL_ID: '1419324625950605332',
  BAN_LOG_CHANNEL_ID: '1419193578386751528',    // log ของ /ban
  UNBAN_LOG_CHANNEL_ID: '1419193635592736838',  // log ของ /unban
  WELCOME_CHANNEL_ID: '1409540148810485913',    // ส่งข้อความยินดีต้อนรับเมื่อได้รับบทบาทสมาชิก
  TALK_CHANNEL_ID: '1139185427497111692',       // ห้องพูดคุยสำหรับแนะนำตัว
}

/* =========================
 * Utils
 * ========================= */
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

async function sendLog(channelId, payload) {
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || ch.type !== ChannelType.GuildText) return
    await ch.send(payload)
  } catch (e) {
    console.error('sendLog error', e)
  }
}

function makeBasicEmbed(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setTimestamp(new Date())
}

/* =========================
 * Mongo Schemas
 * ========================= */
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
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
      imageUrl: { type: String, default: null },
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
  imageUrl: { type: String, default: null },
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
 * Slash Commands
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
    .setName('list-ban')
    .setDescription('ลิสต์สมาชิกที่ถูกแบน (active=true)'),

  new SlashCommandBuilder()
    .setName('ban-check')
    .setDescription('ตรวจสอบว่าไอดีนี้ถูกแบนหรือไม่ และเพราะอะไร')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true)),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('เตือนสมาชิก (เก็บประวัติ)')
    .addStringOption(o => o.setName('game_id').setDescription('ไอดีเกม').setRequired(true))
    .addStringOption(o => o.setName('หมายเหตุ').setDescription('เตือนเรื่องอะไร').setRequired(true))
    .addUserOption(o => o.setName('discord').setDescription('ส่ง DM ถ้าใส่'))
    .addAttachmentOption(o => o.setName('รูป').setDescription('แนบรูปประกอบ (ตัวเลือกเพิ่มเติม)')),

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
    .addUserOption(o => o.setName('discord').setDescription('เลือกผู้ใช้ Discord (ไม่บังคับ)'))
    .addAttachmentOption(o => o.setName('รูป').setDescription('แนบรูปประกอบ (ตัวเลือกเพิ่มเติม)')),

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
].map(c => c.setDMPermission(false))

/* =========================
 * Register (toggle)
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
 * Core Handlers
 * ========================= */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return
  try {
    switch (i.commandName) {
      case 'add':        return handleAdd(i)
      case 'remove':     return handleRemove(i)
      case 'list':       return handleList(i)
      case 'list-ban':   return handleListBan(i)
      case 'ban-check':  return handleBanCheck(i)
      case 'warn':       return handleWarn(i)
      case 'warnlog':    return handleWarnLog(i)
      case 'unwarn':     return handleUnwarn(i)
      case 'ban':        return handleBan(i)
      case 'unban':      return handleUnban(i)
      case 'promote':    return handlePromote(i)
      case 'demote':     return handleDemote(i)
    }
  } catch (err) {
    console.error(err)
    if (!i.replied) await i.reply({ content: 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', ephemeral: true })
  }
})

/* Welcome message: เมื่อได้รับบทบาทสมาชิก */
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const hadRole = oldMember.roles.cache.has(cfg.MEMBER_ROLE_ID)
    const hasRole = newMember.roles.cache.has(cfg.MEMBER_ROLE_ID)
    if (!hadRole && hasRole) {
      const ch = await newMember.guild.channels.fetch(cfg.WELCOME_CHANNEL_ID).catch(() => null)
      if (ch && ch.type === ChannelType.GuildText) {
        await ch.send(`ยินดีต้อนรับ <@${newMember.id}>\nคุณสามารถแนะนำตัวได้ที่นี่พูดคุยในห้อง <#${cfg.TALK_CHANNEL_ID}> หากต้องการอะไรให้แท็ก แอดมิน/chok`)
      }
    }
  } catch (e) {
    console.error('welcome handler error', e)
  }
})

/* =========================
 * Prefix Commands (ตัวอย่างสั้น)
 * ========================= */
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return
  const content = msg.content.trim()

  if (content.startsWith('!hello')) {
    return void msg.reply('สวัสดี')
  }
})

/* =========================
 * Implementations
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

  const embed = makeBasicEmbed('เพิ่มสมาชิก',
    `โดย <@${i.user.id}>\nวันที่: **${joinDateStr}**\nตำแหน่ง: **${pos}**\n\n${results.map(d => `• ${d.gameId}${d.discordId ? ` (<@${d.discordId}>)` : ''}`).join('\n')}${note ? `\n\nหมายเหตุ: ${note}` : ''}`
  )
  await sendLog(cfg.ADD_LOG_CHANNEL_ID, { embeds: [embed] })
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

  const embed = makeBasicEmbed('ลบสมาชิก',
    `โดย <@${i.user.id}>\nวันที่: **${whenStr}**\n\n${ids.map(g => `• ${g}${foundIds.has(g) ? '' : ' (ไม่พบเดิม)'} `).join('\n')}${note ? `\n\nหมายเหตุ: ${note}` : ''}`
  )
  await sendLog(cfg.REMOVE_LOG_CHANNEL_ID, { embeds: [embed] })
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

async function handleListBan(i) {
  const bans = await Ban.find({ active: true }).sort({ ts: -1 })
  if (!bans.length) return i.reply({ content: 'ยังไม่มีสมาชิกที่ถูกแบน', ephemeral: true })
  const lines = bans.map(b => `• ${b.gameId} — ${b.reason || '-'} (${formatDateTH(b.ts)}) โดย <@${b.moderatorId}>`)
  const embed = new EmbedBuilder().setTitle('รายชื่อผู้ถูกแบน').setDescription(lines.join('\n')).setTimestamp(new Date())
  return i.reply({ embeds: [embed], ephemeral: true })
}

async function handleBanCheck(i) {
  const gameId = i.options.getString('game_id', true)
  const rec = await Ban.findOne({ gameId })
  if (!rec || !rec.active) {
    return i.reply({ content: `ไอดีเกม **${gameId}** ยังไม่ถูกแบน`, ephemeral: true })
  }
  const embed = makeBasicEmbed('สถานะแบน',
    `ไอดีเกม: **${gameId}**\nสถานะ: **แบนอยู่**\nเหตุผล: ${rec.reason || '-'}\nเมื่อ: ${formatDateTH(rec.ts)}\nโดย: <@${rec.moderatorId}>`
  )
  if (rec.imageUrl) embed.setImage(rec.imageUrl)
  return i.reply({ embeds: [embed], ephemeral: true })
}

async function handleWarn(i) {
  const gameId = i.options.getString('game_id', true)
  const reason = i.options.getString('หมายเหตุ', true)
  const target = i.options.getUser('discord')
  const img = i.options.getAttachment('รูป') // Attachment from slash option

  const doc = (await Warns.findOne({ gameId })) || new Warns({ gameId, entries: [] })
  const imageUrl = img?.url || null
  doc.entries.push({ reason, ts: new Date(), moderatorId: i.user.id, imageUrl })
  await doc.save()

  const count = doc.entries.length
  const embed = makeBasicEmbed('เตือนสมาชิก',
    `โดย <@${i.user.id}>\nไอดีเกม: **${gameId}**\nจำนวนเตือน: **${count}/3**\nสาเหตุ: ${reason}`
  )
  if (imageUrl) embed.setImage(imageUrl)
  await sendLog(cfg.WARN_LOG_CHANNEL_ID, { embeds: [embed] })

  if (target) {
    try { await target.send(`คุณถูกเตือนในแคลน\nสาเหตุ: ${reason}\nสถานะ: ${count}/3`) } catch {}
  }

  if (count >= 3) {
    await Ban.updateOne(
      { gameId },
      { $set: { active: true, reason: 'ครบ 3 เตือน', moderatorId: i.user.id, ts: new Date(), discordId: target?.id || null, imageUrl: imageUrl || null } },
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
  const lines = doc.entries.map((e, idx) => `${idx + 1}) ${e.reason} — ${formatDateTH(e.ts)} โดย <@${e.moderatorId}>${e.imageUrl ? ' [รูปแนบ]' : ''}`)
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
  const img = i.options.getAttachment('รูป')
  const imageUrl = img?.url || null

  await Ban.updateOne(
    { gameId },
    { $set: { active: true, reason, moderatorId: i.user.id, ts: new Date(), discordId: user?.id || null, imageUrl } },
    { upsert: true }
  )
  if (user) {
    try {
      const gm = await i.guild.members.fetch(user.id)
      await gm.roles.remove(cfg.MEMBER_ROLE_ID).catch(() => {})
    } catch {}
  }

  const embed = makeBasicEmbed('แบนสมาชิก',
    `โดย <@${i.user.id}>\nไอดีเกม: **${gameId}**\nเหตุผล: ${reason}${user ? `\nDiscord: <@${user.id}>` : ''}`
  )
  if (imageUrl) embed.setImage(imageUrl)
  await sendLog(cfg.BAN_LOG_CHANNEL_ID, { embeds: [embed] })

  return i.reply({ content: `แบนแล้ว: ${gameId}`, ephemeral: true })
}

async function handleUnban(i) {
  const gameId = i.options.getString('game_id', true)
  await Ban.updateOne({ gameId }, { $set: { active: false } })

  const reason = i.options.getString('เหตุผล') || ''
  const user = i.options.getUser('discord')
  if (user) {
    try {
      const gm = await i.guild.members.fetch(user.id)
      await gm.roles.add(cfg.MEMBER_ROLE_ID).catch(() => {})
    } catch {}
  }

  const embed = makeBasicEmbed('ยกเลิกแบน',
    `โดย <@${i.user.id}>\nไอดีเกม: **${gameId}**${reason ? `\nเหตุผล: ${reason}` : ''}${user ? `\nDiscord: <@${user.id}>` : ''}`
  )
  await sendLog(cfg.UNBAN_LOG_CHANNEL_ID, { embeds: [embed] })

  return i.reply({ content: `ยกเลิกแบน: ${gameId}`, ephemeral: true })
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
  await sendLog(cfg.PROMOTE_LOG_CHANNEL_ID, { embeds: [embed] })

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
  await sendLog(cfg.DEMOTE_LOG_CHANNEL_ID, { embeds: [embed] })

  return i.reply({ content: `ลดตำแหน่งแล้ว: ${gid} → ${pos}`, ephemeral: true })
}

/* =========================
 * Login & Health
 * ========================= */
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`)
})
client.login(process.env.DISCORD_TOKEN)

/* Express health server */
const app = express()
app.get('/', (_req, res) => res.send('Discord Clan Bot is running'))
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Health server listening on ${PORT}`))

/* Avoid early exit logging silence */
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err))
process.on('uncaughtException', (err) => console.error('UncaughtException:', err))
