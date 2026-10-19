// Trouve ton chat_id Telegram et l'enregistre dans .env.
// Avant : crée un bot avec @BotFather, mets TELEGRAM_BOT_TOKEN dans .env, puis envoie "bonjour" à ton bot.
import 'dotenv/config'
import { appendFileSync, readFileSync } from 'node:fs'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) throw new Error('Add TELEGRAM_BOT_TOKEN=... to .env (from @BotFather)')

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`)
const data = (await res.json()) as { ok: boolean; result: any[]; description?: string }
if (!data.ok) throw new Error(`Token rejected by Telegram: ${data.description}`)

const msg = data.result.map(u => u.message).filter(Boolean).at(-1)
if (!msg) {
  console.log('No message found. Send "hello" to your bot on Telegram, then run this command again.')
  process.exit(1)
}
const chatId = String(msg.chat.id)
if (readFileSync('.env', 'utf8').includes('TELEGRAM_CHAT_ID=')) {
  console.log(`TELEGRAM_CHAT_ID is already in .env (yours is ${chatId}).`)
} else {
  appendFileSync('.env', `TELEGRAM_CHAT_ID=${chatId}\n`)
  console.log(`Chat found (${msg.chat.first_name ?? msg.chat.title}) — TELEGRAM_CHAT_ID=${chatId} added to .env`)
}
