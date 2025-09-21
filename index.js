import 'dotenv/config'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js'
import mongoose, { Schema } from 'mongoose'

/* =========================
 * Helpers & Config
 * ========================= */
const cfg = {
  ACTION_ROLE_ID: '1419190035361697863',
  MEMBER_ROLE_ID: '1139181683300634664',
  ADD_LOG_CHANNEL_ID: '1419188238932901910',
  REMOVE_LOG_CHANNEL_ID: '1419188292531912704',
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
await mongoose.connect(process.env.MONGO_URI)

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

  const embed = makeBasicEmbed('เพิ่มสมาชิก', `โดย <@${i.user.id}>\nวันที่: **${joinDateStr}**\nตำแหน่ง: **${pos}**\n\n${results.map(d => `• ${d.gameId}${d.discordId ? ` (<@${d.discordId}>)`
