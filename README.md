# Automaton Telegram Skill

A Telegram bridge for [Conway Automaton](https://github.com/Conway-Research/automaton) — chat with your agent directly via Telegram when the web app is unavailable, or simply when you want to stay in touch with your agent on the go.

## What It Does

This skill adds a Telegram interface to your Conway Automaton by running a lightweight bridge process alongside your agent. It works by injecting your Telegram messages directly into the agent's SQLite inbox — the same inbox the agent already uses for inter-agent communication — and watches for new turns to send replies back to you in Telegram.

No modifications to the Automaton's core code are required.

## Features

- Chat with your Automaton via any Telegram client (phone or desktop)
- Allowlist-based security — only approved Telegram user IDs can talk to your agent
- Typing indicator shown while the agent is thinking
- Built-in `/status` command to check agent state and credit balance
- Auto-splits long responses to stay within Telegram's message length limit
- Zero extra dependencies beyond what Automaton already uses

## Requirements

- A running Conway Automaton (see [Conway-Research/automaton](https://github.com/Conway-Research/automaton))
- Node.js v18 or higher
- A Telegram account
- A Telegram bot created via @BotFather

---

## Setup

### Step 1 — Create your Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name for your bot, e.g. `My Automaton`
4. Choose a username ending in `bot`, e.g. `myautomaton_bot`
5. BotFather will reply with your bot token — it looks like:
```
   7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
6. Save that token — you'll need it in Step 3

### Step 2 — Find your Telegram user ID

1. In Telegram search for **@userinfobot**
2. Press Start
3. It will instantly reply with your numeric user ID, e.g. `123456789`
4. Save that number — you'll need it in Step 3

### Step 3 — Add credentials to your Automaton's .env file

Open your Automaton's environment file:
```bash
nano ~/.automaton/.env
```

Add these two lines, replacing the example values with your real ones:
```
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_ALLOWED_IDS=123456789
```

If you want multiple people to be able to message your agent, separate their IDs with commas:
```
TELEGRAM_ALLOWED_IDS=123456789,987654321
```

Save and close the file.

### Step 4 — Copy the bridge file

Download `telegram-bridge.mjs` from this repo and place it inside your Automaton folder:
```
~/automaton/telegram-bridge.mjs
```

### Step 5 — Run the bridge

You need two terminal windows — one for your Automaton and one for the bridge.

**Terminal 1 — Start your Automaton:**
```bash
cd ~/automaton
node dist/index.js --run
```

**Terminal 2 — Start the Telegram bridge:**
```bash
cd ~/automaton
node telegram-bridge.mjs
```

You should see:
```
[Bridge] Database opened: /home/youruser/.automaton/state.db
[Bridge] Starting Automaton Telegram Bridge...
[Bridge] Allowed user IDs: 123456789
[Bridge] Waiting for Telegram messages...
```

### Step 6 — Test it

Open Telegram, find your bot by its username, press **Start**, and send it a message. Your Automaton will reply once it processes its inbox.

---

## Built-in Commands

| Command | Description |
|---|---|
| `/start` | Shows welcome message and instructions |
| `/status` | Shows agent state, turn count, and sleep status |

---

## How It Works
```
You (Telegram) ──► Bot API ──► Bridge polling loop
                                      │
                                      ▼
                            Injects into SQLite inbox
                                      │
                                      ▼
                              Automaton agent loop
                                      │
                                      ▼
                            Bridge detects new turn
                                      │
                                      ▼
You (Telegram) ◄── Bot API ◄── Sends reply back
```

The bridge long-polls the Telegram Bot API every 30 seconds, so no open ports or webhooks are needed on your server. It uses only Node.js built-in modules — no extra packages to install.

---

## Security

- **Allowlist enforced** — any Telegram user ID not listed in `TELEGRAM_ALLOWED_IDS` is rejected and never forwarded to your agent
- **No webhook exposure** — uses polling, not webhooks, so no ports need to be open
- **Token safety** — keep your `TELEGRAM_BOT_TOKEN` in your `.env` file only, never commit it to git

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond at all | Check `TELEGRAM_BOT_TOKEN` is correct in your `.env` file |
| "You are not authorised" message | Your user ID isn't in `TELEGRAM_ALLOWED_IDS` — message @userinfobot to confirm your exact ID |
| `Allowed user IDs: NaN` in terminal | The ID in your `.env` file has a space or formatting issue — check there's no space around the `=` sign |
| Replies take a long time | Normal — depends on your agent's sleep cycle. Can be 30–90 seconds. |
| Agent replies with strategy plans instead of conversation | Add a `creatorMessage` to your `~/.automaton/automaton.json` telling it to respond conversationally to your Telegram ID |

---

## Contributing

Pull requests welcome. If you've improved the bridge or added features, feel free to open a PR.

## License

MIT
