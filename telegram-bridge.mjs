/**
 * Automaton Telegram Bridge
 *
 * Runs alongside your Automaton as a separate process.
 * - Polls Telegram for your messages
 * - Drops them into the Automaton's SQLite inbox
 * - Watches for the Automaton's replies and sends them back to you
 *
 * Usage:
 *   node telegram-bridge.mjs
 *
 * Required env vars in ~/.automaton/.env:
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_ALLOWED_IDS=...   (your Telegram user ID from @userinfobot)
 */

import https from "https";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

// ─── Load .env file ────────────────────────────────────────────────────────────

const envPath = join(homedir(), ".automaton", ".env");
if (!existsSync(envPath)) {
  console.error(`[Bridge] ERROR: No .env file found at ${envPath}`);
  console.error(`[Bridge] Please create it with TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_IDS`);
  process.exit(1);
}

for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

// ─── Validate config ───────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

if (!BOT_TOKEN) {
  console.error("[Bridge] ERROR: TELEGRAM_BOT_TOKEN is not set in ~/.automaton/.env");
  process.exit(1);
}
if (ALLOWED_IDS.size === 0) {
  console.error("[Bridge] ERROR: TELEGRAM_ALLOWED_IDS is not set in ~/.automaton/.env");
  console.error("[Bridge] Message @userinfobot on Telegram to find your ID");
  process.exit(1);
}

// ─── Open the Automaton's database ────────────────────────────────────────────

const DB_PATH = join(homedir(), ".automaton", "state.db");
if (!existsSync(DB_PATH)) {
  console.error(`[Bridge] ERROR: Database not found at ${DB_PATH}`);
  console.error(`[Bridge] Make sure the Automaton has been run at least once`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Prepared statements
const insertMsg = db.prepare(
  `INSERT OR IGNORE INTO inbox_messages (id, from_address, content, received_at, reply_to)
   VALUES (?, ?, ?, ?, NULL)`
);

const getLatestTurn = db.prepare(
  `SELECT id, timestamp, thinking FROM turns ORDER BY timestamp DESC LIMIT 1`
);

console.log("[Bridge] Database opened:", DB_PATH);

// ─── Telegram API helper ───────────────────────────────────────────────────────

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("Bad JSON from Telegram: " + data)); }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  // Telegram max length is 4096 chars — split if needed
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));

  for (const chunk of chunks) {
    const res = await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
    // Retry without markdown if it failed (e.g. malformed markdown from agent)
    if (!res.ok) {
      await telegramRequest("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}

async function sendTyping(chatId) {
  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ─── State tracking ───────────────────────────────────────────────────────────

let lastUpdateId = 0;
let lastTurnId = null;
let waitingForReply = false;
let replyTargetChatId = null;
let typingInterval = null;

// Grab the current latest turn ID on startup so we don't re-send old replies
const latestOnBoot = getLatestTurn.get();
if (latestOnBoot) {
  lastTurnId = latestOnBoot.id;
  console.log("[Bridge] Boot turn ID:", lastTurnId);
}

// ─── Inject message into Automaton inbox ──────────────────────────────────────

function injectMessage(userId, text) {
  const id = `tg-${Date.now()}-${userId}`;
  const from = `telegram:${userId}`;
  const now = new Date().toISOString();
  insertMsg.run(id, from, `[Direct message from your Creator via Telegram - please respond conversationally and directly to them]: ${text}`, now);
  console.log(`[Bridge] Injected into inbox: "${text.slice(0, 80)}"`);

  // Also clear any existing sleep so the agent wakes up promptly
  try {
    db.prepare("DELETE FROM kv WHERE key = 'sleep_until'").run();
    console.log("[Bridge] Cleared sleep_until so agent wakes immediately");
  } catch (e) {
    // Not critical if this fails
  }
}

// ─── Watch for agent reply ────────────────────────────────────────────────────

async function checkForReply() {
  if (!waitingForReply || !replyTargetChatId) return;

  const latest = getLatestTurn.get();
  if (!latest) return;

  // A new turn has appeared since we sent the message
  if (latest.id !== lastTurnId && latest.thinking && latest.thinking.trim()) {
    lastTurnId = latest.id;
    waitingForReply = false;

    // Stop the typing indicator
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }

    const reply = latest.thinking.trim();
    console.log(`[Bridge] Agent replied: "${reply.slice(0, 100)}"`);
    await sendMessage(replyTargetChatId, reply);
    replyTargetChatId = null;
  }
}

// ─── Handle incoming Telegram messages ────────────────────────────────────────

async function handleMessage(msg) {
  const userId = msg.from?.id ?? 0;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";

  if (!text) return; // ignore stickers, photos, etc.

  // Security: block unknown users
  if (!ALLOWED_IDS.has(userId)) {
    console.warn(`[Bridge] Blocked message from unknown user ${userId} (@${username})`);
    await sendMessage(chatId, "⛔ You are not authorised to talk to this Automaton.");
    return;
  }

  console.log(`[Bridge] Message from @${username} (${userId}): ${text}`);

  // Built-in commands
  if (text === "/start" || text === "/hello") {
    await sendMessage(chatId,
      "👋 *Automaton bridge is online.*\n\nSend me any message and I'll pass it to your Automaton. " +
      "It will reply once it processes its inbox.\n\n" +
      "⚠️ The Automaton runs on its own loop — replies may take 30–90 seconds depending on what it's doing."
    );
    return;
  }

  if (text === "/status") {
    const state = db.prepare("SELECT value FROM kv WHERE key = 'agent_state'").get();
    const sleepUntil = db.prepare("SELECT value FROM kv WHERE key = 'sleep_until'").get();
    const turnCount = db.prepare("SELECT COUNT(*) as c FROM turns").get();
    const statusText = [
      `*Automaton Status*`,
      `State: \`${state?.value ?? "unknown"}\``,
      `Turns completed: ${turnCount?.c ?? 0}`,
      sleepUntil?.value ? `Sleeping until: ${new Date(sleepUntil.value).toLocaleTimeString()}` : `Not sleeping`,
    ].join("\n");
    await sendMessage(chatId, statusText);
    return;
  }

  // Forward message to agent inbox
  injectMessage(userId, text);

  // Start waiting for reply
  waitingForReply = true;
  replyTargetChatId = chatId;

  // Show typing indicator
  await sendTyping(chatId);
  typingInterval = setInterval(() => sendTyping(chatId), 4000);

  await sendMessage(chatId, "📨 *Message received.* Waiting for your Automaton to respond...");
}

// ─── Main polling loop ────────────────────────────────────────────────────────

async function pollTelegram() {
  while (true) {
    try {
      const res = await telegramRequest("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (res.ok) {
        for (const update of res.result) {
          lastUpdateId = update.update_id;
          if (update.message) {
            await handleMessage(update.message).catch((err) => {
              console.error("[Bridge] Error handling message:", err.message);
            });
          }
        }
      } else {
        console.error("[Bridge] getUpdates error:", res.description);
        await sleep(5000);
      }
    } catch (err) {
      console.error("[Bridge] Poll error:", err.message);
      await sleep(5000);
    }
  }
}

// Check for agent replies every 5 seconds
setInterval(() => {
  checkForReply().catch((err) => console.error("[Bridge] Reply check error:", err.message));
}, 5000);

// ─── Start ────────────────────────────────────────────────────────────────────

console.log("[Bridge] Starting Automaton Telegram Bridge...");
console.log(`[Bridge] Allowed user IDs: ${[...ALLOWED_IDS].join(", ")}`);
console.log("[Bridge] Waiting for Telegram messages...");

pollTelegram();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
