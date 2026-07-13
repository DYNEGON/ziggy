# Ziggy — Setup Templates

Template files for building your own Ziggy: a personal AI-orchestration system controlled entirely through Telegram. See `Ziggy_Overview.md` in this repo for the full architecture, why each piece exists, and how it all fits together — read that first if you haven't already.

Every file here has real secrets and paths replaced with clear placeholders (`YOUR_XXX_HERE`). This README tells you exactly which placeholder goes where, and how to get the real value.

## Folder structure

```
droplet/     — files that live on your always-on cloud server (tested on a DigitalOcean droplet)
pc/          — files that live on your local Windows PC (needs a GPU for image gen + local AI)
```

## Placeholder reference — what to edit, and where to get it

| Placeholder | Appears in | Where to get the real value |
|---|---|---|
| `YOUR_TELEGRAM_BOT_TOKEN_HERE` | `telegram_bot.js`, `cloud_agent.py`, `backlog_research.js`, `notes_campaign_manager.js`, `local_executor.js` | Message **@BotFather** on Telegram → `/newbot` → it gives you a token immediately |
| `YOUR_TELEGRAM_USER_ID_HERE` | Same five files as above | Message **@userinfobot** on Telegram → it replies with your numeric ID. This is the single-user security lock — only this exact ID can control your bot |
| `YOUR_GEMINI_API_KEY_HERE` | `telegram_bot.js`, `run_hindsight.sh`, `backlog_research.js` | aistudio.google.com — free tier is enough to start |
| `YOUR_MISTRAL_API_KEY_HERE` | `run_hindsight.sh` | console.mistral.ai — used for the memory system's fact-extraction |
| `YOUR_MIMO_API_KEY_HERE` | `telegram_bot.js` | platform.xiaomimimo.com — only needed if you want the design-to-code feature |
| `YOUR_GITHUB_TOKEN_HERE` | `telegram_bot.js` | github.com/settings/tokens/new — classic token, `repo` scope, **leave `workflow` unticked** unless you specifically need it |
| `YOUR_RELAY_SECRET_HERE` | `telegram_bot.js`, `cloud_agent.py`, `local_executor.js` | You generate this yourself — any long random string works, e.g. run `openssl rand -base64 32` or similar. **The exact same string must appear in all three files** — this is what authenticates your PC and Droplet to each other |
| `YOUR_DROPLET_IP_HERE` | `local_executor.js` | Your cloud server's public IP address, from your hosting provider's dashboard |
| `YOUR_OAUTH_CLIENT_ID_HERE` / `YOUR_OAUTH_CLIENT_SECRET_HERE` | `stitch_oauth_setup_pc.js` | Google Cloud Console → APIs & Services → Credentials → Create OAuth Client ID → type **"Desktop app"** specifically (not "TVs and Limited Input devices" — that type doesn't support the scope needed here). Only required if you want the AI UI-design feature |
| `YOUR_GCP_PROJECT_ID_HERE` | `telegram_bot.js` | The Google Cloud project ID you created for the Stitch OAuth setup above (visible on your project's dashboard/selector in Google Cloud Console). Only required alongside the OAuth setup |
| `YOUR_SAFEWORD_HERE` | `cloud_agent.py` | Self-chosen, not fetched from anywhere — pick your own word or phrase. This gates the dormant "Jules" cloud agent's destructive actions; must never be an easily-guessable word |
| `YOUR_USERNAME` | `telegram_bot.js`, `local_executor.js`, `executor_supervisor.vbs`, `silent_start_ziggy.vbs` | Your actual Windows username — these are hardcoded file paths, they won't work with a placeholder left in, find-and-replace it with your real username in each of these four files |
| `[YOUR-BRAND]` | Wherever content/publishing branding is mentioned | Your own Substack (or other platform) brand name |

## Setup order

Doing these roughly in order avoids backtracking:

1. **Get your Telegram bot token and user ID** first (via BotFather and @userinfobot) — nothing else works without these.
2. **Generate your relay secret** and drop it into all three files that need it.
3. **Set up the Droplet**: install Node.js, Python, PM2, rclone; deploy the `droplet/` files; fill in every placeholder in each one.
4. **Set up the PC**: install Node.js, Ollama, ComfyUI; deploy the `pc/` files; fill in every placeholder, including your real username in the four files listed above.
5. **Get your Gemini and Mistral keys**, plug them into `run_hindsight.sh` and `telegram_bot.js`.
6. **Optional features** — only set these up if you want them:
   - **UI design generation**: Google Cloud OAuth client (Desktop app type) + `stitch_oauth_setup_pc.js`, run once to get a refresh token.
   - **Design-to-code**: MiMo API key.
   - **GitHub push**: GitHub personal access token.
7. **Register the PC watchdog**: use Windows Task Scheduler to run `executor_supervisor.vbs` every 5 minutes, and put `silent_start_ziggy.vbs` in your Windows Startup folder. Both are explained in full in `Ziggy_Overview.md`, section 13 and the Health Check reference.
8. **Test end-to-end**: message your bot. `/help` should respond. Then work through each feature one at a time rather than assuming everything works at once.

## What's NOT in this template

Deliberately excluded, since these are personal, single-use setup artifacts rather than reusable code:
- The actual Google Cloud service account JSON key (you generate your own)
- Any real `.env` or credential files — every placeholder above needs filling with **your own** values
- The full disaster-recovery runbook with exact command sequences — see `Ziggy_Overview.md` for the conceptual version; build your own exact deploy scripts as you go

## A note on scope

This is a personal project built for one person's use, controlled by a hardcoded single Telegram user ID for security. It is not designed for multi-user deployment. If you fork this, keep that single-user lock — it's your first, simplest line of defence.
