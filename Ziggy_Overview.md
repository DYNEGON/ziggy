# Ziggy — Complete System Documentation

*A full technical reference for the Ziggy content-automation system: architecture, every API and model in use, why each piece exists, how to troubleshoot it, and what it takes to run.*

---

## 1. What Ziggy Is

Ziggy is a personal AI-orchestration system built for content creation and delivery, controlled entirely through Telegram. One phone, one chat window — behind it, an AI writes articles, publishes them, promotes them, remembers you across conversations, searches your own writing, researches its own future article ideas, takes commands to control your PC directly, organises your cloud storage, generates images, designs UI screens and writes real working code from those designs, then pushes it straight to GitHub. It spans two physical machines, one cloud storage layer, and eight AI services and tools (five external APIs, three running entirely locally), coordinated by a single Telegram bot.

---

## 2. Architecture Overview

```
┌─────────────────────┐           ┌──────────────────────────────────┐
│ YOUR PC (Windows)   │           │ DROPLET (DigitalOcean, 24/7)     │
│ RTX 5070, 12GB      │ ◄───────► │ Ubuntu 24.04, 2GB RAM            │
│                     │   relay   │                                  │
│ • Ollama (local AI) │  (secret  │ • telegram-bot  (the brain)      │
│ • ComfyUI (images)  │   token)  │ • cloud-agent   (relay + Jules*) │
│ • local_executor.js │           │ • hindsight     (memory)         │
│   + watchdog        │           │ • pm2-logrotate                  │
└─────────────────────┘           └──────────────────────────────────┘
           │                                    │
           │         ┌──────────────────┐       │
           └────────►│ Google Drive     │◄──────┘
                     │ (shared storage) │
                     └──────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                       ▼
┌─────────────────┐  ┌───────────┐  ┌─────────────┐
│ Gemini          │  │ Substack  │  │ GitHub      │
│ (chat, /ask,    │  │ (publish) │  │ (code push) │
│ embeds, trends) │  │           │  │             │
└─────────────────┘  └───────────┘  └─────────────┘
┌──────────┐  ┌───────────────┐  ┌───────────────┐
│ Mistral  │  │ MiMo V2.5 Pro │  │ Google Stitch │
│ (memory  │  │ (coding)      │  │ (UI design)   │
│ extract) │  │               │  │               │
└──────────┘  └───────────────┘  └───────────────┘
```

**Why two machines, not one:** the PC has a GPU (needed for local AI article-writing and image generation) but isn't always switched on. The Droplet has no GPU but is always available — perfect for coordination, scheduling, and lightweight cloud-AI work. Google Drive is the hand-off point between them; neither machine needs to talk to the other directly except through the guarded relay.

**Jules — currently dormant, not currently reachable.** `cloud_agent.py` contains a second, separate feature beyond the PC relay: an autonomous cloud agent ("Jules," built on `google.antigravity`, with genuine read/write/execute capability on the Droplet, guarded by a soft, undisclosed safeword requirement for destructive actions). **Traced through every call site in `telegram_bot.js`: every single message the bot forwards to the relay is prefixed with `/local`, and `cloud_agent.py` only activates Jules for messages that are NOT prefixed that way.** In practice, this means nothing in current normal Telegram use ever reaches Jules — it's live code, still running, still worth keeping secured (its endpoint could still be reached directly by anyone with the relay secret, bypassing Telegram entirely), but it isn't part of the system's actual day-to-day behaviour right now. If you want it reachable again, that's a small, deliberate wiring change in `telegram_bot.js`, not something to assume already works.

---

## 3. Hardware & Software Requirements

### PC
- **GPU:** 12GB+ VRAM recommended (tested on RTX 5070, confirmed via ComfyUI's own startup log: `Total VRAM 12227 MB`). Runs Ollama (article writing, local chat) and ComfyUI (image generation) — both compete for the same VRAM if used simultaneously.
- **RAM:** 32GB tested and comfortable.
- **Confirmed versions from this build:** Python 3.13.12, PyTorch 2.12.0+cu130, ComfyUI 0.27.0.
- **Software:** Node.js, real Python 3.13 (not the Microsoft Store stub — it breaks background tasks), Ollama, ComfyUI (portable NVIDIA build).
- **Always-on requirement:** none — the Droplet covers everything that needs 24/7 uptime. The PC only needs to be on for `/generate`, `/local`, `/image`, and local-model chat.
- **⚠️ Exact install paths are hardcoded in the code, not configurable without editing and redeploying it.** Confirmed directly from source — installing to a different location will silently break the relevant feature:
  - Python: `C:\Users\your-username\AppData\Local\Programs\Python\Python313\python.exe` (used by `/generate`)
  - Ollama: `C:\Users\your-username\AppData\Local\Programs\Ollama\ollama.exe` (used by the watchdog to relaunch it)
  - ComfyUI: `C:\AI\ComfyUI` (used by `/image` and the watchdog)
  - The Ziggy project folder itself: `C:\Users\your-username\Documents\Antigravity\Ziggy`

### Droplet
- **Spec:** 1 vCPU, 2GB RAM, 70GB NVMe SSD (DigitalOcean). Comfortably runs four persistent services (bot, relay, memory, log rotation) with headroom, confirmed via repeated `free -h` checks throughout build (typically 45-55% RAM used).
- **Swap:** 2GB file, cushions memory spikes during heavier operations (embedding downloads, memory consolidation).
- **Confirmed versions from this build:** Node.js v18.19.1, npm 9.2.0, Python 3.12.
- **Software:** Node.js 18, Python 3.12, PM2 (process manager), rclone (Drive access), ufw (firewall), cron (scheduled jobs).
- **Always-on requirement:** yes — this is the system's 24/7 brain.

---

## 4. Every AI Service, Model, and API — What, Why, Cost

| Service | Used for | Why this one | Approx. cost |
|---|---|---|---|
| **Gemini** (`gemini-3.1-flash-lite` default) | Chat replies, `/local`/`/drive` translation, `/ask` answers, Hindsight's embeddings, backlog trend/gap research (with Google Search grounding) | Free-tier friendly (500 req/day on flash-lite vs. 20/day on newer "-latest" aliases — a real trap we hit and fixed) | Free tier (Google Search grounding is billed per search query on Gemini 3-family models — a small real cost, not free like the rest of this row) |
| **Mistral** (`mistral-small-2506`) | Hindsight's memory fact-extraction | Groq's free tier (6,000 tokens/min) proved too small for real use — Mistral's ~2.25M tokens/min on this specific model solved it | Free tier |
| **MiMo V2.5 Pro** (Xiaomi) | Turning approved Stitch designs into real code (`/design` → Approve & Build) | ~$1/$3 per million tokens (input/output) — roughly half Grok 4.5's price, 1M token context, strong coding benchmarks, lower hallucination risk than alternatives for code going straight to a real repo | ~$1-3 per million tokens |
| **Google Stitch** | AI UI-design generation (`/design`) | Purpose-built for exactly this; Apache-licensed underlying tooling | Included in Google Cloud project |
| **fastembed** (local, Droplet CPU) | Turning your articles/docs into searchable vectors for `/ask` | Free, runs on CPU with no GPU, no API key | Free |
| **Ollama** (local, PC GPU) | Article writing (`qwen3.5:9b`), local chat models | Free, private, uses hardware that would otherwise sit idle | Free |
| **ComfyUI + SDXL** (local, PC GPU) | `/image` — image generation from text | Free, local, fits 12GB VRAM comfortably | Free |
| **GitHub API** | `/design` Approve & Build → pushes MiMo's code to a new repo | Standard, stable, well-documented REST API | Free (personal repos) |

**Local models available via `/model`:** Qwen 3.5 9B (creative writing), Llama 3.1 8B (coding & technical), DeepSeek R1 8B (math & reasoning), Gemma 4 e4b (document analysis).

---

## 5. Rate Limits & Quotas Reference

A single place to check "did I hit a limit?" before troubleshooting further.

| Service | Limit | What happens if hit |
|---|---|---|
| Gemini `gemini-3.1-flash-lite` | 500 requests/day (free tier) | Bot auto-falls-back or reports a clear quota error rather than hanging |
| Gemini `-latest` aliases (avoid as default) | As low as 20 requests/**day** on the newest model they silently resolve to | This is the trap that broke the original default — pin explicit model names, never `-latest`, for anything you rely on |
| Gemini Search grounding | Billed per search query (Gemini 3-family) | Real cost accrues on Google Cloud billing — monitor if backlog research runs frequently |
| Mistral `mistral-small-2506` | ~2.25M tokens/minute (free tier) | Effectively never hit in this system's normal use |
| Groq free tier (not currently used — abandoned for Hindsight) | 6,000 tokens/**minute** | Too small for Hindsight's extraction prompt — this is *why* Mistral was chosen instead |
| MiMo V2.5 Pro | Pay-per-token, no free tier | Real cost per `/design` → Approve & Build |
| GitHub API (personal token) | 5,000 requests/hour (standard authenticated limit) | Never realistically hit by this system's usage pattern |
| Stitch API | No documented hard limit found; real backend does occasionally return incomplete responses under normal load | Retry — confirmed via direct diagnostics that identical calls succeed on a second attempt |

---

## 6. Full File Map

### PC
| File | Path | Job |
|---|---|---|
| `pipeline.py` | `...\Ziggy\` | Reads `future_article_backlog.md`, drafts articles via Ollama, also auto-generates `content_inventory.md` by fetching your live published Substack archive |
| `local_executor.js` | same | Polls the relay, runs commands, generates images, **includes the watchdog** that relaunches Ollama/ComfyUI if they silently die |
| `executor_supervisor.vbs` | same | Launched every 5 minutes by a Windows Task Scheduler task — relaunches `local_executor.js` itself if it's ever dead (crash, reboot, anything), independent of Node entirely |
| `silent_start_ziggy.vbs` | Windows Startup folder | Launches Ollama + ComfyUI + the executor hidden, at every login |
| `style-guide.md` | synced to Drive | House style rules |
| `future_article_backlog.md` | synced to Drive | Article idea queue — read top-to-bottom by `pipeline.py`; also written to (at the top) by the Droplet's backlog research automation |

### Droplet — PM2 services (always running)
| Service | File | Port | Job |
|---|---|---|---|
| `telegram-bot` | `/root/telegram_bot.js` | — | Every command, all AI routing, all state |
| `cloud-agent` | `/root/Ziggy/cloud_agent.py` | *(configurable — see RELAY_PORT)* | Relay to PC + the "Jules" cloud agent |
| `hindsight` | `hindsight-api` | *(localhost only, not internet-facing)* | Conversational memory |
| `pm2-logrotate` | (module) | — | Prevents log bloat |

### Droplet — cron jobs
| Schedule | Script | Job |
|---|---|---|
| `30 18 * * *` (18:30 UTC daily) | `run_notes.sh` | Runs one Notes campaign cycle step |
| `0 19 * * *` (19:00 UTC daily) | `backlog_research.js` | Checks backlog depth; researches + proposes new ideas if running low |

### Droplet — scripts & data
| File | Job |
|---|---|
| `substack_api_drafts.js` | Pushes articles to Substack |
| `notes_campaign_manager.js` | Runs one Notes teaser campaign |
| `backlog_research.js` | Checks backlog depth; if low, researches gap/trend ideas via Gemini + Google Search and proposes them in Telegram |
| `ingest_documents.py` / `search_documents.py` | Build/query the `/ask` search index |
| `run_hindsight.sh` | Hindsight's PM2 launch wrapper (Mistral + Gemini config baked in) |
| `stitch-credentials.json` | Service account key (root-only, 600 permissions) |
| `stitch-oauth-token.json` | Your own Google identity's refresh token (root-only) |
| `substack_sid.txt` | Your Substack login session cookie — used by `substack_api_drafts.js` to authenticate as you when pushing drafts |
| `campaign_state.json` | Current Notes campaign progress |
| `pending_backlog_proposal.json` | The currently-awaiting-approval backlog proposal, if any (deleted once approved/discarded) |
| `backlog_research_state.json` | Tracks when backlog research last ran |
| `doc_index.json` | Built `/ask` search index |

---

## 7. Google Drive — The Shared Hub

```
gdrive:Ziggy/
├── articles_pending/       AI-written, not yet on Substack
├── articles_drafted/       pushed as Substack drafts — Notes campaigns run on these
├── articles_published/     live and confirmed
├── style-guide.md
├── future_article_backlog.md    read top-to-bottom by pipeline.py; new ideas get
│                                 inserted at the TOP so they draft first
└── content_inventory.md         auto-generated catalog of everything already
                                  published (fetched live from Substack's API) —
                                  used both by you and by the backlog research
                                  automation to avoid suggesting repeats

gdrive:Ziggy-backups/<date>/    dated snapshots of every Droplet script
```

The three-stage lifecycle: `/generate` → `articles_pending` → `/run_pipeline` → `articles_drafted` → Notes campaign runs → you publish + confirm → `articles_published`.

**Where the actual writing gets reviewed:** there is no content-approval step inside Telegram — `/generate` writes full articles with no human check before `/run_pipeline` pushes them to Substack. The review happens on **Substack itself**: articles land as private drafts (never public), and you read, edit, and polish them in Substack's own editor before you personally click Publish there. Tapping ✅ in Telegram afterwards only confirms *that* it's published, so the bot can move the file and free the next campaign — it isn't approving the writing itself, that already happened on Substack. (This is separate from the backlog research automation's Approve/Discard buttons, which gate *ideas* going into the queue, not the articles that get written from them.)

---

## 8. Article Idea Generation — Backlog Research Automation

**The problem it solves:** `pipeline.py` only *reads* `future_article_backlog.md` — it drafts the next un-produced ideas and marks them done, but it has never generated new ideas itself. Left alone, the backlog eventually runs dry. This automation keeps it topped up, and does it by actually looking outward rather than just brainstorming from what's already known.

**How it decides when to act:** once a day (cron, 19:00 UTC, right after the Notes campaign check), `backlog_research.js` reads the real backlog from Drive and counts genuinely un-drafted ideas (using the exact same block-parsing logic as `pipeline.py` itself, so the count is always accurate to what would actually get drafted next). If it's above the threshold (currently 2), it does nothing.

**How it researches, when triggered:** it calls Gemini with the **Google Search grounding tool** enabled — a real, current Gemini API feature that lets the model search the live web before answering, rather than relying only on training data. The prompt is deliberately split into two kinds of ideas:
- **Gap ideas** — genuine angles nobody in this content space is covering well right now.
- **Trend ideas** — something rising but *not yet* mainstream or peaked, explicitly asked to find the earliest real signal rather than something already saturated in headlines, so Ziggy can be first out the gate.

Both are cross-checked against `content_inventory.md` (your real, live-fetched published archive) and the existing backlog, so it won't propose something you've already written or already queued.

**Honest gap:** `content_inventory.md` is only refreshed when `pipeline.py` runs in `--mode audit` (or the default `--mode all`) — `pipeline.py`'s own `--mode generate` (what `/generate` in Telegram appears to invoke) is a separate step that only drafts articles, and whether it also refreshes the inventory wasn't directly confirmed during this build. If the inventory goes stale, backlog research could theoretically suggest a topic you've since published. Worth periodically running `pipeline.py` with `--mode audit` (or `--mode all`) directly on the PC to be certain, until this is explicitly verified one way or the other.

**Nothing goes in automatically.** Proposed ideas are sent to Telegram as a message (each tagged 🔍 GAP or 📈 TREND with its reasoning) with **✅ Add all to backlog / ❌ Discard** buttons. Nothing touches the real backlog file until you approve.

**How "urgent" prioritization actually works:** approved ideas get written to the very **top** of `future_article_backlog.md`, ahead of everything already there. Because `pipeline.py`'s own selection logic (`extract_next_backlog_ideas`) simply walks the file top-to-bottom taking the first N un-drafted entries, this alone makes new ideas draft first — no changes to `pipeline.py` were needed at all.

**Manual trigger, for testing:**
```bash
cd /root/Ziggy && node backlog_research.js
```
If the backlog has plenty remaining, this prints `Plenty remaining — nothing to do.` and exits — that's the correct, expected result, not a failure.

**Known limitation, not yet guarded against:** the proposal message concatenates all proposed ideas into one Telegram message with no length cap. Telegram messages have a hard 4096-character limit — a run that proposes several ideas with unusually long reasoning could theoretically exceed it and fail to send. Hasn't happened in testing, but worth knowing if a proposal ever silently doesn't arrive.

**Tunable settings:** `LOW_THRESHOLD` (currently 2) and `IDEAS_TO_PROPOSE` (currently 6) are plain constants near the top of `backlog_research.js` — edit and redeploy the file directly to change how early or how many ideas it proposes.

---

## 9. The Notes Campaign — What It Is and Why

**The problem it solves:** publishing an article cold, with no lead-up, gets little organic reach. A short "teaser" campaign on Substack Notes (2-4 short posts over several days) builds anticipation before the full article goes live.

**Why it's automated but not autonomous:** the bot drafts and *schedules* the notes, but never posts them itself — it sends you the exact text to copy-paste. That deliberate human-in-the-loop step means nothing goes public without your eyes on it first.

**Why random article selection, not alphabetical:** a predictable posting order is a detectable pattern; picking randomly from `articles_drafted` avoids that.

**How each note is actually written — the STAR framework:** every campaign draws from a fixed pool of four distinct note "archetypes," each explicitly tagged to resonate with a different reader psychology, using the STAR framework (Socialisers, Thinkers, Adventurers, Realists), created by David Chadderton: **Socialisers** (chatty, relationship-driven — met by a "Personal Spark" note sharing a first-person observation), **Adventurers** (curious, engagement-driven — met by an "Audience Question" note inviting a reply), **Thinkers** (analytical, skeptical of convention — met by a "Counter-Intuitive Observation" challenging assumed wisdom), and **Realists** (practical, outcomes-focused — met by an "Authoritative Insight" stating a direct, no-nonsense position). Each campaign randomly picks 2-4 of these four archetypes rather than running all four every time, so the note *style* varies campaign to campaign as well as targeting different readers within any single campaign. Every note, regardless of archetype, is passed through the same house style rules before sending (no em/en dashes, British English, no banned vocabulary).

**The gate:** one campaign runs at a time. The cycle can't advance to the next article until you've published the current one and tapped the confirmation button — this prevents a backlog of half-finished promotional threads.

**Schedule:** a daily cron at 18:30 UTC checks in; `run_notes.sh` syncs the latest drafted articles from Drive first, so it always works from current data.

---

## 10. Document Search (`/ask`) — What, Why, How

**The problem it solves:** as your article library grows, "have I already made this argument?" or "what's my established position on X?" becomes hard to answer from memory alone. `/ask` searches your *actual writing*, not general AI knowledge.

**How it works, step by step:**
1. Every article + your style guide + backlog get split into ~220-word overlapping chunks.
2. Each chunk is turned into a numeric "fingerprint" (embedding) using `fastembed`, entirely on the Droplet's CPU — no GPU, no API key.
3. A question gets embedded the same way; the closest-matching chunks are found by similarity.
4. Gemini writes an answer using **only** those chunks, explicitly instructed to say "not found" rather than guess.

**Kept current automatically:** the index rebuilds after every `/run_pipeline` or `/push`. Force a rebuild any time with `/reindex`.

**Example:**
> `/ask have I covered magnesium before?`
> → *"Yes — 'The Magnesium Trap' covers absorption differences between oxide and glycinate forms..."*

---

## 11. Conversational Memory (Hindsight) — What, Why, The Journey

**The problem it solves:** without memory, every conversation starts from zero — the bot can't recall that you prefer British English, or what you told it yesterday.

**Why Hindsight, and why Mistral specifically:** this took real trial and error. Groq was the first choice (fast, generous free tier by request-count), but its 6,000-tokens-*per-minute* cap turned out too small — Hindsight's fact-extraction prompt alone can use most of that in one call. Mistral's `mistral-small-2506` offers roughly 2.25 million tokens/minute on the free tier, solving the problem outright, reached via `litellm` (a proper translation layer, not the naive OpenAI-compatibility shim that caused the original Groq failure).

**Two ways things get remembered:**
- **Automatic** — every plain chat exchange is quietly sent to Hindsight in the background (never slows down your reply).
- **Explicit** — `/remember <fact>` stores something immediately, useful for things you want *guaranteed* saved.

**Safety net:** every Hindsight call has a hard timeout (8s for recall, 25s for explicit remember). If the service is slow or down, chat still works, just without memory for that turn.

**Example:**
> `/remember I prefer British English and I hate em dashes`
> *(days later, a fresh conversation)*
> `what do you know about my writing preferences?`
> → *"You prefer British English and dislike em dashes in your writing."*

---

## 12. Controlling Your PC From Telegram (`/local`, `/drive`)

**`/local <plain English>`** — Gemini (`gemini-3.1-flash-lite`) translates your sentence into a real Windows command. Safe commands run instantly. Anything matching a risky pattern (delete, format, shutdown, etc.) shows **✅ Run / ❌ Cancel** buttons first — nothing destructive happens without a tap.

**`/localraw <command>`** — sends an exact command, no translation, for when you know precisely what you want.

**`/drive <plain English>`** — the same pattern, but for Google Drive via `rclone`: create folders, move/copy/rename files. Important limitation: `rclone` can't search file *content*, only names — for "find articles about X," use `/ask` first, then `/drive` to organize what it finds.

**The security model:** both commands share one risk-detection system (`RISKY_PATTERN`), and both PC and Drive operations route through the same confirm/cancel button flow, keyed by a pending-action ID.

---

## 13. Image Generation (`/image` + ComfyUI)

**Requirements:** ComfyUI running on your PC (auto-starts via the Startup script), an SDXL checkpoint (`dreamshaperXL_v21TurboDPMSDE.safetensors`) in `ComfyUI/models/checkpoints/`.

**How it works:** `/image <description>` sends the prompt straight to your PC (no translation needed) → ComfyUI runs a 7-node SDXL workflow (load checkpoint → encode prompt positive/negative → sample → decode → save) → the finished image uploads directly to Telegram.

**PC reliability — two independent layers, not one:**
1. **In-process watchdog** (inside `local_executor.js`): every ~30 seconds, checks whether Ollama and ComfyUI are still responding, and relaunches whichever died (common after the PC sleeps), notifying you in Telegram when it happens.
2. **External supervisor** (Windows Task Scheduler, `Ziggy Executor Supervisor`): checks every 5 minutes whether `local_executor.js` itself is still alive, and relaunches it if not — regardless of *why* it stopped (a crash, a full reboot, anything).

**Why both layers are necessary, not redundant:** the in-process watchdog has one unavoidable blind spot — if `local_executor.js` itself is the thing that dies, there's nothing left running inside it to notice or fix the problem. This happened for real during development: every `node.exe` process on the PC vanished at once (including unrelated background ones, suggesting a reboot), and nothing brought the executor back for roughly 20 hours, until it was noticed manually via `/check`. The external Task Scheduler layer exists specifically to close that gap — it runs completely outside Node, so it doesn't care what killed the executor or whether Node itself is even running at all, it just tries to relaunch it every 5 minutes, forever. `local_executor.js`'s own single-instance lock (port 49352) makes repeated launch attempts a safe no-op whenever it's already running.

**Future option discussed, not yet built:** instruction-based image *editing* ("change the top to a polo") via Qwen-Image-Edit — a separate model and workflow, licensed for commercial use (Apache-2.0), unlike FLUX Kontext's non-commercial license.

---

## 14. UI Design Generation & GitHub Push (`/design`)

This is the most involved chain in the system — worth understanding in full.

```
/design "a login page"
        │
        ▼
  Create New Project?  or  Use Existing Project?
        │                         │
        ▼                         ▼
  stitch.createProject()    stitch.projects() → pick one
        │                         │
        └───────────┬─────────────┘
                     ▼
         project.generate(prompt)
         (Google Stitch — full design
          system + screen, ~30-90s for
          a new project, faster for
          an existing one)
                     │
                     ▼
         Screenshot + HTML returned
         (image only, sometimes — Stitch's
          own variability, not a bug)
                     │
                     ▼
         ✅ Approve & Build (your review gate)
                     │
                     ▼
         MiMo V2.5 Pro converts the HTML
         into clean implementation files
         (strict JSON response: files + commit message)
                     │
                     ▼
         New private GitHub repo created,
         files pushed via the Contents API
                     │
                     ▼
         Repo link sent back to you
```

**Why OAuth instead of just the service account:** the service account is a separate Google identity — anything it creates is invisible in *your* browser at stitch.withgoogle.com. Switching Stitch to authenticate as **you** (via a one-time OAuth consent, using the loopback flow since device flow doesn't support the required scope) means designs show up in your own dashboard. The bot automatically prefers your OAuth token if present, falling back to the service account otherwise.

**Why a brand-new GitHub repo per design, not one shared repo:** your explicit choice — keeps each approved design's implementation cleanly separated rather than mixed into one growing codebase.

---

## 15. Security Architecture

- **Single-user lock:** the bot checks every incoming message and button tap against one hardcoded Telegram user ID; anyone else's messages are silently ignored. This is the first line of defence before the relay secret ever comes into play — a stranger finding your bot's username can't interact with it at all.
- **Jules's safeword:** `cloud_agent.py`'s dormant Jules agent (see Architecture Overview) is instructed never to delete files, directories, or databases unless a specific, undisclosed safeword appears in the prompt. This is a soft, prompt-level instruction to the AI, not a hard technical boundary — it guides behaviour, it doesn't enforce it the way the relay secret or firewall do.
- **Relay secret:** every request between the bot, the PC, and the relay carries a shared secret (`X-Auth-Token` header). Without it, the relay returns `401 Unauthorized`. This closes what was originally a completely open endpoint (confirmed via `ufw status` showing no firewall protection at all) sitting behind an AI agent with real read/write/execute capability.
- **Firewall:** a minimal allow-list, only the ports genuinely needed for remote administration and PC-to-Droplet communication are open; everything else is denied by default.
- **Least-privilege credentials:** the GitHub token's `workflow` scope was deliberately excluded (CI/CD access wasn't needed and carries outsized risk if leaked). The Stitch service account has only `roles/serviceusage.serviceUsageConsumer` — enough to call already-enabled APIs, nothing broader.
- **File permissions:** every real credential file (`stitch-credentials.json`, `stitch-oauth-token.json`) is locked to `600` (root-only read).

---

## 16. A Day in the Life — End-to-End Example Flow

```
 Morning:
   /generate
     → PC writes 4 articles (Ollama) → articles_pending (Drive)
   /run_pipeline
     → pushed to Substack as drafts → articles_drafted (Drive)
     → /ask search index rebuilds automatically

 Daily, 18:30 UTC:
   → Notes campaign picks a random drafted article
     → sends teaser notes to Telegram over several days
     → "time to publish" + ✅ button → you publish, tap ✅
     → articles_published (Drive), next campaign begins

 Daily, 19:00 UTC:
   → backlog_research.js checks remaining ideas
     → if low: researches gaps + early trends via Gemini + Search
     → proposes them in Telegram → you approve → inserted at the
       top of the backlog, drafted first next /generate run

 Any time:
   /ask "have I covered X?"        → grounded answer from your own writing
   plain message                    → chat, aware of pipeline state + memory
   /remember "I prefer X"           → stored permanently, recalled later
   /local "open notepad"            → PC does it (confirmed if risky)
   /image "a snow leopard..."       → ComfyUI generates it on your PC
   /design "a login page"           → Stitch designs it
     → ✅ Approve & Build → MiMo writes real code → new GitHub repo
   /check                           → is the PC actually online right now?
```

---

## 17. Full Command Reference

| Command | What it does |
|---|---|
| `/help`, `/status` | Status and command list |
| `/model` | Pick the active chat brain |
| *(plain message)* | Chat, with live pipeline status + memory automatically applied |
| `/check` | Is the PC currently online? |
| `/local <English>` | Tell your PC what to do (risky actions confirm first) |
| `/drive <English>` | Organise Google Drive (risky actions confirm first) |
| `/localraw <command>` | Exact command on the PC, no translation |
| `/generate` | Write 4 new articles on the PC |
| `/run_pipeline` / `/push` | Push drafts to Substack, rebuild search index |
| `/sync` | Pull latest articles from Drive |
| `/run_notes` | Manually trigger a Notes campaign cycle |
| `/ask <question>` | Search your articles/docs |
| `/reindex` | Manually rebuild the search index |
| `/remember <fact>` | Explicitly store something in memory |
| `/image <description>` | Generate an image (needs ComfyUI running) |
| `/design <description>` | Generate a UI screen, then optionally build it into a GitHub repo |

*(Backlog research isn't a slash command — it runs on its own daily schedule and proposes ideas via buttons when triggered. Run `node backlog_research.js` on the Droplet to trigger it manually.)*

---

## 18. Health Check Quick-Reference

Run this block any time something feels off, before diving into troubleshooting:

```bash
# On the Droplet
pm2 list                    # all 4 services should show "online", low/stable restart counts
free -h                     # should show real headroom, not near-zero available
ufw status                  # should show only the minimal necessary ports allowed
curl -s http://127.0.0.1:<relay port>/get_local -H "X-Auth-Token: <your relay secret>"
                             # should return {"command": null} or similar — not a hang
```

```
# In Telegram
/check                      # is the PC actually online right now?
/status                     # bot's own uptime + active model
```

```powershell
# On the PC (PowerShell)
Get-Process node -ErrorAction SilentlyContinue    # executor should be one of the results
Get-Process python -ErrorAction SilentlyContinue  # ComfyUI, if it should be running
Get-ScheduledTask -TaskName "Ziggy Executor Supervisor"  # should show State: Ready
```

**What "healthy" looks like:** all four PM2 services `online`, no climbing restart counts, `/check` reports the PC online whenever it should be, and none of the above commands hang or time out.

---

## 19. Troubleshooting Guide

**"Waiting for PC to connect" and nothing follows, or `/check` reports the PC offline even though you're using it right now** → the executor itself has likely died (not just Ollama/ComfyUI). Confirm with `Get-CimInstance Win32_Process -Filter "name='node.exe'"` in PowerShell — if it comes back completely empty (not even unrelated background node processes), that's a strong signal the whole machine rebooted rather than just the executor crashing on its own. The `Ziggy Executor Supervisor` scheduled task should now catch and fix this automatically within 5 minutes; if it's been longer than that and it's still down, confirm the task itself is healthy with `Get-ScheduledTask -TaskName "Ziggy Executor Supervisor"`.

**`Register-ScheduledTask` fails with `"The task XML contains a value which is incorrectly formatted or out of range... P99999999DT23H59M59S"`** → caused by passing `[TimeSpan]::MaxValue` as the repetition duration — it's too large for Task Scheduler's underlying format. Use a large but finite duration instead, e.g. `New-TimeSpan -Days 3650` (10 years), which is effectively permanent for practical purposes.

**A Telegram command hangs with "typing..." and never resolves** → check for a missing timeout on whatever external call is involved. Every properly-built command in this system wraps external calls in `fetchWithTimeout` or `withTimeout` specifically to prevent this; if a new feature is added without one, this is the exact failure mode to expect.

**Deploy pastes seem to fail or the console disconnects** → never paste a large multi-line script directly into the DigitalOcean web console. Always use single-line, base64-encoded `python3 -c "..."` commands, run one at a time.

**A shared secret / API key seems "wrong" despite being set** → check the *actual deployed* value on the server directly (`grep` the live file), not what you assume was last sent — values have drifted between files more than once during development. Never hand-type a `sed` command without the full `s/old/new/` syntax; always use a complete, tested one-liner.

**Stitch generation fails with "Incomplete API response... expected object at projection path"** → this is Stitch's own backend occasionally not returning a complete response (confirmed via raw-response diagnostics that the same exact call succeeds on retry). Simply try again.

**Stitch design has no HTML, only an image** → Stitch sometimes generates a screenshot without HTML. The bot retries once automatically after a short delay; if it's still missing, that generation was genuinely image-only — try `/design` again.

**Memory (`/remember`) or `/ask` seem to silently do nothing** → check the relevant service is actually running: `pm2 list` on the Droplet should show `hindsight` (or the relevant process) as `online` with a low, non-climbing restart count.

**"EBADENGINE" warnings during `npm install`** → harmless on this system; some packages want Node 20+ while the Droplet runs Node 18, but the specific features used here don't hit the gap. Confirmed safe via direct testing.

**A new Node package throws "File is not defined"** → Node 18 doesn't expose the `File` global the way Node 20+ does. Fix: `globalThis.File = require('node:buffer').File;` before importing whatever needs it.

**`crontab -e` asks you to pick an editor** → normal on a fresh box; select `nano` (usually option `1`). Add your line at the bottom, save with `Ctrl+O` then Enter, exit with `Ctrl+X`. Confirm it saved with `crontab -l`.

---

## 20. Disaster Recovery

The full rebuild runbook (exact install commands, credential setup steps, IAM configuration, and internal file paths) is kept private rather than published here, since it's effectively a complete infrastructure map. In broad terms: every script is version-controlled and backed up on a schedule, every credential is stored with minimal necessary permissions and locked-down file access, and the system can be reconstructed from those backups plus fresh credentials on a new server in well under a day.

## 21. Key Decisions & Pivots — Why We Ended Up Here

A brief record of the non-obvious choices, so a future reader doesn't re-litigate settled ground.

**⚠️ Every specific model name in this document (`gemini-3.1-flash-lite`, `mistral-small-2506`, `mimo-v2.5-pro`, `dreamshaperXL_v21TurboDPMSDE`, etc.) is a snapshot of what was current and correct as of this build.** AI providers rename, deprecate, and re-tier models often — this exact system already got burned once by trusting a `-latest` alias that silently pointed at a far more rate-limited model than expected. Before assuming any pinned model name in this document still exists or still has the same free-tier limits, verify it directly against the provider's current documentation rather than trusting this document blindly on that specific point.

- **Memory: Groq → Mem0 → Hindsight, LLM: Groq → Mistral.** Groq's free tier looked ideal (fast, generous by request-count) but its 6,000-tokens/**minute** cap was too small for Hindsight's fact-extraction prompt. Mem0 was tried as an alternative but added a heavier dependency footprint (Qdrant) than this box comfortably supports. Landed on Hindsight + Mistral (`litellm` transport, not the naive OpenAI-compatibility shim that caused Groq's specific failure).
- **Stitch auth: API key → Service Account → OAuth (Desktop app).** API keys were confirmed, via direct testing, to be rejected outright by Stitch's real generation endpoints ("Expected OAuth2 access token..."). A service account worked but its projects were invisible in the user's own browser (separate Google identity). Device-flow OAuth was tried next but rejected the required `cloud-platform` scope. Desktop-app loopback flow was the one that actually worked end-to-end.
- **Gemini model selection: `-latest` aliases → explicit dated/tiered model names.** `-latest` aliases silently resolve to Google's newest model, which can carry a far smaller free-tier daily cap than older, equally-capable models. Pin explicit names for anything relied upon.
- **PC service reliability: manual restart → in-process watchdog → external OS-level supervisor.** Ollama and ComfyUI were found to silently die (most often after PC sleep), causing `/image` and local-model chat to hang with no feedback. A periodic health-check-and-relaunch loop was added directly into `local_executor.js` — but this had an unavoidable blind spot: if the executor process itself died (confirmed for real: every `node.exe` process vanished at once, likely a reboot, and nothing brought it back for ~20 hours), nothing was left running to notice. A second, genuinely independent layer was added on top — a Windows Task Scheduler task that checks on the executor every 5 minutes from *outside* Node entirely, closing the gap regardless of what caused the outage.
- **Deploy method: multi-line scripts → single-line base64 pastes.** A multi-line script pasted directly into the DigitalOcean web console caused the console session to disconnect. Every deploy since uses a single, complete, base64-encoded one-liner instead.

---

## 22. Credential-to-Service Map

| Credential | Powers |
|---|---|
| Telegram bot token | Reading/sending all Telegram messages |
| Substack session cookie (`substack_sid.txt`) | Pushing article drafts, checking for duplicates |
| Gemini API key | Chat, `/local`/`/drive` translation, `/ask`, Hindsight's embeddings, backlog trend/gap research |
| Mistral API key | Hindsight's memory fact-extraction |
| MiMo (Xiaomi) API key | `/design`'s Approve & Build code generation |
| Stitch service account key | Fallback UI-design generation (if your own OAuth token is absent) |
| Stitch OAuth refresh token | Primary UI-design generation, as your own identity |
| GitHub personal access token | Creating repos + pushing files for approved designs |
| Relay secret | Authenticating every bot ↔ Droplet ↔ PC request |

*(Live values are never written into documents like this one — only their purpose.)*
