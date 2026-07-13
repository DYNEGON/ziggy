// ============================================================
//  Ziggy Telegram bot  (menu + pipeline + generate)
//  - Only program that reads the Telegram mailbox.
//  - /local ...     -> run a command on your PC.
//  - /model         -> tap a button to pick your brain.
//  - plain message  -> goes to the active brain.
//  - /generate      -> write articles on your PC via Ollama (qwen3.5:9b).
//  - /run_pipeline  -> pull articles from Drive + push Substack drafts (on Droplet).
//  - /run_notes     -> advance the organic Notes campaign (on Droplet).
// ============================================================

const { exec, execSync } = require('child_process');
const fs = require('fs');
const CAMPAIGN_STATE_FILE = '/root/Ziggy/campaign_state.json';

const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const ALLOWED_USER_ID = 0; // YOUR_TELEGRAM_USER_ID_HERE — replace 0 with your real numeric Telegram ID
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";
const MIMO_API_KEY = "YOUR_MIMO_API_KEY_HERE"; // from platform.xiaomimimo.com
const STITCH_CREDENTIALS_FILE = "/root/Ziggy/stitch-credentials.json"; // service account key — API keys don't work for Stitch's real endpoints, confirmed

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const RELAY_PORT = 3000; // change if you like — cloud_agent.py and local_executor.js must use the same value
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/send`; // the brain (cloud_agent.py)
const RELAY_SECRET = "YOUR_RELAY_SECRET_HERE"; // must match cloud_agent.py's RELAY_SECRET exactly
const PROJECT_DIR = "/root/Ziggy";

// Full paths on your Windows PC (used by /generate, sent through /local).
const PC_PYTHON = "C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Programs\\Python\\Python313\\python.exe";
const PC_PIPELINE = "C:\\Users\\YOUR_USERNAME\\Documents\\Antigravity\\Ziggy\\pipeline.py";

let offset = 0;

// Cloud brains start with "gemini". Others are local Ollama tags.
// Resets to Flash if the bot restarts.
// IMPORTANT: "-latest" aliases silently point at Google's newest model,
// which on the free tier can carry a tiny daily cap (e.g. gemini-3.5-flash
// = 20 requests/day — we hit that wall). gemini-3.1-flash-lite has by far
// the most generous free-tier budget (500 requests/day, 250K tokens/min),
// so it's used as the default and the safe fallback everywhere.
let activeModel = "gemini-3.1-flash-lite";

// The model used to translate /local requests. Purpose-built for translation,
// fast, and rarely overloaded. Same generous-limit model as the default above.
const TRANSLATE_MODEL = "gemini-3.1-flash-lite";

const MODELS = [
    { label: "☁️ Gemini Flash-Lite, high-volume", id: "gemini-3.1-flash-lite" },
    { label: "☁️ Gemini 2.5 Flash, fast reasoning", id: "gemini-2.5-flash" },
    { label: "☁️ Gemini Pro, deep research", id: "gemini-pro-latest" },
    { label: "☁️ MiMo V2.5 Pro, app development", id: "mimo-v2.5-pro" },
    { label: "🖥️ Qwen 3.5 9B, creative writing", id: "qwen3.5:9b" },
    { label: "🖥️ Llama 3.1 8B, coding & technical", id: "llama3.1:8b" },
    { label: "🖥️ DeepSeek R1 8B, math & reasoning", id: "deepseek-r1:8b" },
    { label: "🖥️ Gemma 4 e4b, document analysis", id: "gemma4:e4b" }
];

function isCloud(model) { return model.startsWith("gemini") || model.startsWith("mimo"); }

async function tg(method, body = {}) {
    try {
        const res = await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await res.json();
    } catch (e) {
        return { ok: false };
    }
}

async function sendMessage(chatId, text, extra = {}) {
    const MAX_LEN = 4000;
    for (let i = 0; i < text.length; i += MAX_LEN) {
        await tg('sendMessage', Object.assign({
            chat_id: chatId,
            text: text.slice(i, i + MAX_LEN)
        }, i === 0 ? extra : {}));
    }
}

async function forwardToRelay(text) {
    try {
        const res = await fetch(RELAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': RELAY_SECRET },
            body: JSON.stringify({ message: text })
        });
        return res.ok;
    } catch (e) {
        return false;
    }
}

// Low-level single call to a Gemini model. Returns { text } on success,
// { retry: true } on a 503 "high demand", or { error } on anything else.
async function geminiCall(prompt, model) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }, 20000); // Gemini calls can legitimately take a few seconds; 20s is generous but bounded.
        const data = await res.json().catch(() => ({}));
        if (data.error) {
            if (data.error.code === 503) return { retry: true };
            if (data.error.code === 429) return { quotaExceeded: true };
            return { error: data.error.message || 'Google API error' };
        }
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return { text: text || "No response generated." };
    } catch (err) {
        if (err.name === 'AbortError') return { retry: true }; // timed out — treat like a transient failure, retry/fallback kicks in
        return { error: 'Network error: ' + err.message };
    }
}

// Low-level single call to a MiMo model (Xiaomi). Uses their OpenAI-compatible
// chat completions endpoint, but note the auth header is "api-key", NOT
// "Authorization: Bearer" — different convention from Gemini/OpenAI.
async function mimoCall(prompt, model) {
    try {
        const res = await fetchWithTimeout("https://api.xiaomimimo.com/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': MIMO_API_KEY
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }]
            })
        }, 30000); // MiMo Pro is a reasoning model — can genuinely take longer than Gemini Flash
        const data = await res.json().catch(() => ({}));
        if (data.error) {
            const code = data.error.code || res.status;
            if (code === 429) return { quotaExceeded: true };
            if (code === 503 || code === 529) return { retry: true };
            return { error: data.error.message || 'MiMo API error' };
        }
        const text = data.choices?.[0]?.message?.content;
        return { text: text || "No response generated." };
    } catch (err) {
        if (err.name === 'AbortError') return { retry: true };
        return { error: 'Network error: ' + err.message };
    }
}

// Resilient Gemini call: retries on 503 ("high demand"), and if the chosen
// model stays overloaded, falls back to the lighter flash-lite model.
async function askGeminiRaw(prompt, model) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await geminiCall(prompt, model);
        if (r.text) return r.text;
        if (r.error) return `⚠️ ${r.error}`;
        if (r.quotaExceeded) break; // daily budget gone — retrying won't help, go straight to fallback
        // r.retry === true -> wait briefly and try again
        await new Promise(res => setTimeout(res, 1500));
    }
    // Overloaded or out of quota: fall back to flash-lite (generous free-tier budget).
    if (model !== TRANSLATE_MODEL) {
        const fb = await geminiCall(prompt, TRANSLATE_MODEL);
        if (fb.text) return fb.text;
    }
    return "⚠️ The model is very busy or out of quota right now. Please try again in a moment.";
}

// MiMo has no natural in-family fallback here, so retries just retry, then
// give up cleanly rather than falling back to an unrelated provider.
async function askMimoRaw(prompt, model) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await mimoCall(prompt, model);
        if (r.text) return r.text;
        if (r.error) return `⚠️ ${r.error}`;
        if (r.quotaExceeded) return "⚠️ MiMo quota exceeded for now. Please try again later.";
        await new Promise(res => setTimeout(res, 1500));
    }
    return "⚠️ MiMo is very busy right now. Please try again in a moment.";
}

// Single entrypoint used everywhere else in the bot — routes to the right
// provider based on the model id's prefix, so callers don't need to know
// which cloud service a given model actually lives on.
async function askGemini(prompt, model) {
    if (model.startsWith("mimo")) return askMimoRaw(prompt, model);
    return askGeminiRaw(prompt, model);
}

// Run a shell command ON THE DROPLET and send its output back to Telegram.
function runOnDroplet(chatId, cmd) {
    exec(cmd, { cwd: PROJECT_DIR, maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, async (err, stdout, stderr) => {
        let out = ((stdout || '') + (stderr || '')).trim();
        if (err && !out) out = 'Error: ' + err.message;
        if (!out) out = '(finished, no output)';
        await sendMessage(chatId, "📋 Result:\n" + out.slice(0, 3800));
    });
}

// Faster rclone: --fast-list cuts round-trips, --drive-skip-gdocs avoids Google Docs.
const RCLONE_FLAGS = "--fast-list --drive-skip-gdocs";

// Pull articles from Drive into the LOCAL folder, clearing stale copies first so
// the Droplet never works from out-of-date files (the cause of earlier duplicates).
// Returns the shell command as a string.
function pullArticlesCmd() {
    return `mkdir -p ${PROJECT_DIR}/articles_pending && rm -f ${PROJECT_DIR}/articles_pending/*.md && rclone copy gdrive:Ziggy/articles_pending ${PROJECT_DIR}/articles_pending ${RCLONE_FLAGS}`;
}

// Run a sequence of {label, cmd} steps, sending a progress message before each,
// and the combined output at the end. Keeps you informed instead of silent.
function runStaged(chatId, steps) {
    let combined = "";
    function next(i) {
        if (i >= steps.length) {
            sendMessage(chatId, "📋 Result:\n" + (combined.trim() || "(finished, no output)").slice(0, 3800));
            return;
        }
        const step = steps[i];
        sendMessage(chatId, step.label);
        exec(step.cmd, { cwd: PROJECT_DIR, maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
            const out = ((stdout || '') + (stderr || '')).trim();
            if (out) combined += out + "\n";
            if (err && !out) combined += "Error: " + err.message + "\n";
            next(i + 1);
        });
    }
    next(0);
}

function modelMenu() {
    return {
        reply_markup: {
            inline_keyboard: MODELS.map(m => [
                { text: m.label, callback_data: "setmodel:" + m.id }
            ])
        }
    };
}

// Telegram's "typing..." indicator only lasts ~5 seconds before it silently
// disappears. For anything that might take longer (Drive lookups, memory
// recall, a slow model), this keeps re-sending it every 4s so the chat
// never goes quiet and looks frozen. Call the returned function to stop.
function startTyping(chatId) {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const interval = setInterval(() => {
        tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    }, 4000);
    return () => clearInterval(interval);
}

// ---- Layer 2 awareness: conversational memory via Hindsight ----
// Hindsight runs locally on the Droplet (127.0.0.1:8888), using Mistral
// (via litellm) for fact-extraction and Gemini for embeddings. It remembers
// things across separate Telegram conversations.
const HINDSIGHT_URL = "http://127.0.0.1:8888";
const HINDSIGHT_BANK = "YOUR_USERNAME"; // single-user memory bank — any short identifier works, just keep it consistent

// fetch() has no built-in timeout, so a stuck or slow server can hang a
// request forever with no error and no fallback. This wraps fetch with a
// hard time limit — past it, the request is aborted and treated as failed,
// so callers can gracefully continue without memory rather than hang.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// For calls that can't take an AbortSignal (like the Stitch SDK's own
// methods, which go through an internal MCP transport we don't control).
// Doesn't cancel the underlying request, but stops OUR code from waiting
// forever and reports a clear error instead of silently hanging.
function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs))
    ]);
}

// Fetch memories relevant to the current message. Fails silently (returns
// "") if Hindsight isn't running, or is too slow — chat still works
// without memory rather than hanging indefinitely.
async function recallMemory(query) {
    try {
        const res = await fetchWithTimeout(`${HINDSIGHT_URL}/v1/default/banks/${HINDSIGHT_BANK}/memories/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, max_tokens: 1000 })
        }, 8000);
        if (!res.ok) return "";
        const data = await res.json();
        const results = data.results || [];
        if (results.length === 0) return "";
        return results.map(r => `- ${r.text}`).join('\n');
    } catch (e) {
        return ""; // Hindsight not reachable or too slow — carry on without memory.
    }
}

// Store this exchange for future recall. Fire-and-forget (async=true) so
// it never slows down or blocks the reply to the user. Still timed out so
// it can't leave a dangling request hanging in the background forever.
function retainMemory(userText, replyText) {
    fetchWithTimeout(`${HINDSIGHT_URL}/v1/default/banks/${HINDSIGHT_BANK}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            items: [{
                content: `User said: ${userText}\nAssistant replied: ${replyText}`,
                context: "Telegram chat with Ziggy bot"
            }],
            async: true
        })
    }, 8000).catch(() => { /* Hindsight not reachable or too slow — safe to ignore */ });
}

// ---- Layer 1 awareness: give chat a live snapshot of the actual pipeline ----
// This is NOT memory and NOT search. It just reads the real files/state that
// already exist on this Droplet, so the bot never has to say "I don't have
// access to your systems" about systems it is, in fact, sitting right next to.
function getPipelineStatus() {
    return new Promise((resolve) => {
        const lines = [];

        // Active Notes campaign, if any.
        try {
            const state = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_FILE, 'utf8'));
            if (state.active_campaign) {
                const c = state.active_campaign;
                const notesPosted = (c.notes || []).filter(n => n.posted).length;
                const notesTotal = (c.notes || []).length;
                if (c.awaiting_publish_confirm) {
                    lines.push(`Active Notes campaign: "${c.article_title}" — all ${notesTotal} teaser notes sent, WAITING for you to publish and confirm.`);
                } else {
                    lines.push(`Active Notes campaign: "${c.article_title}" — ${notesPosted}/${notesTotal} teaser notes sent so far.`);
                }
            } else {
                lines.push("No active Notes campaign right now.");
            }
            const completed = (state.completed_campaigns || []).length;
            lines.push(`${completed} article(s) have completed a full Notes campaign and been published so far.`);
        } catch (e) {
            lines.push("Notes campaign state: not available.");
        }

        // Article counts — read from GOOGLE DRIVE directly (the real source of
        // truth), not the Droplet's local copy, which can drift out of sync
        // (e.g. a leftover test file the local folder still has but Drive doesn't).
        exec(
            'rclone lsf gdrive:Ziggy/articles_pending --include "*.md" ; echo "---SPLIT---" ; ' +
            'rclone lsf gdrive:Ziggy/articles_drafted --include "*.md"',
            { timeout: 15000 },
            (err, stdout) => {
                try {
                    const [pendingOut, draftedOut] = (stdout || '').split('---SPLIT---');
                    const countLines = (s) => (s || '').split('\n').filter(l => l.trim().endsWith('.md')).length;
                    const pending = countLines(pendingOut);
                    const drafted = countLines(draftedOut);
                    lines.push(`Articles (from Drive, the real source of truth): ${pending} written and waiting to be pushed as Substack drafts, ${drafted} already drafted on Substack.`);
                } catch (e) {
                    lines.push("Article counts: not available right now.");
                }
                resolve(lines.join('\n'));
            }
        );
    });
}

// ---- Guarded /local: translate English -> Windows command, confirm risky ones ----

// Pending commands awaiting a Run/Cancel tap. Keyed by a short id.
const pendingCommands = {}; // id -> { cmd, target: 'pc' | 'droplet' }
let pendingCounter = 0;

// Words that mean a command could delete, wipe, or disrupt the PC. If a
// translated command contains any of these, we ask for confirmation first.
const RISKY_PATTERN = /(\bdel\b|\berase\b|\brmdir\b|\brd\b|\brm\b|remove-item|\bri\b|\bformat\b|\bshutdown\b|\brestart\b|diskpart|\bcipher\b|takeown|reg\s+delete|clear-recyclebin|\bnet\s+user\b|fsutil|bcdedit|\battrib\b|\/f\b|\/s\s+\/q|taskkill|\bpurge\b|\bdelete\b|deletefile)/i;

function isRisky(cmd) {
    return RISKY_PATTERN.test(cmd || "");
}

// Ask Gemini to turn plain English into a single Windows command.
// Returns { cmd, explanation } or null.
async function translateToCommand(english) {
    const prompt =
        "You are a Windows command translator. Convert the user's plain-English request " +
        "into a single Windows CMD command (chains with && are allowed). " +
        "Reply with ONLY raw JSON, no markdown fences, in exactly this format:\n" +
        '{"cmd": "the windows command", "explanation": "short human description"}\n' +
        'If it cannot be done as a command, reply {"cmd": "", "explanation": "why not"}.\n\n' +
        "Examples:\n" +
        '"open notepad" -> {"cmd": "start notepad", "explanation": "Opening Notepad"}\n' +
        '"open chrome and go to substack" -> {"cmd": "start chrome https://substack.com", "explanation": "Opening Substack in Chrome"}\n' +
        '"open notepad and type help" -> {"cmd": "echo help > %TEMP%\\\\dyn_note.txt && notepad %TEMP%\\\\dyn_note.txt", "explanation": "Opening Notepad with help in it"}\n' +
        '"what is my ip" -> {"cmd": "ipconfig", "explanation": "Showing network settings"}\n\n' +
        'User request: "' + english + '"';

    const raw = await askGemini(prompt, TRANSLATE_MODEL);
    try {
        const clean = (raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(clean);
        if (parsed && typeof parsed.cmd === "string") return parsed;
    } catch (e) {
        // fall through
    }
    return null;
}

// Ask Gemini to turn plain English into a single rclone command for Google
// Drive (the "gdrive:" remote). Same shape as translateToCommand, but scoped
// to Drive filesystem operations — NOT content search (that's /ask's job).
async function translateToRcloneCommand(english) {
    const prompt =
        "You are an rclone command translator for a Google Drive remote called \"gdrive:\". " +
        "The main working folder is gdrive:Ziggy/, with subfolders articles_pending, " +
        "articles_drafted, and articles_published. Convert the user's plain-English request " +
        "into a single rclone command (chains with && are allowed) — mkdir, copy, moveto, " +
        "lsf, etc. rclone cannot search file CONTENTS, only names/paths, so if the request " +
        "needs finding files by topic/content, reply with cmd \"\" and explain that /ask " +
        "should be used first to find the files, then /drive to move/copy them by name. " +
        "Reply with ONLY raw JSON, no markdown fences, in exactly this format:\n" +
        '{"cmd": "the rclone command", "explanation": "short human description"}\n' +
        'If it cannot be done, reply {"cmd": "", "explanation": "why not"}.\n\n' +
        "Examples:\n" +
        '"make a new folder called Research" -> {"cmd": "rclone mkdir \\"gdrive:Ziggy/Research\\"", "explanation": "Creating the Research folder"}\n' +
        '"list my published articles" -> {"cmd": "rclone lsf \\"gdrive:Ziggy/articles_published\\"", "explanation": "Listing published articles"}\n' +
        '"copy The Magnesium Trap.md into a new folder called Supplements" -> {"cmd": "rclone mkdir \\"gdrive:Ziggy/Supplements\\" && rclone copy \\"gdrive:Ziggy/articles_published/The Magnesium Trap.md\\" \\"gdrive:Ziggy/Supplements/\\"", "explanation": "Creating Supplements folder and copying the file into it"}\n' +
        '"find files about cortisol" -> {"cmd": "", "explanation": "rclone can\'t search file contents — use /ask to find which articles mention cortisol, then /drive to move/copy them by name"}\n\n' +
        'User request: "' + english + '"';

    const raw = await askGemini(prompt, TRANSLATE_MODEL);
    try {
        const clean = (raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(clean);
        if (parsed && typeof parsed.cmd === "string") return parsed;
    } catch (e) {
        // fall through
    }
    return null;
}

// Loads the saved Stitch project ID, or creates a new project on first use
// and saves its ID so every future /design call reuses the same project.
// Mints a real, short-lived OAuth2 access token from the service account
// key. The Stitch SDK reads STITCH_ACCESS_TOKEN + GOOGLE_CLOUD_PROJECT
// directly (confirmed from its actual source — it does NOT read
// GOOGLE_APPLICATION_CREDENTIALS itself), so this has to happen every call.
// ---- Approved design -> MiMo implementation -> new GitHub repo ----
const GITHUB_TOKEN = "YOUR_GITHUB_TOKEN_HERE"; // from github.com/settings/tokens, needs the "repo" scope
const pendingDesigns = {}; // id -> { prompt, htmlUrl } — awaiting Approve & Build
const pendingDesignPrompts = {}; // id -> prompt — awaiting new-vs-existing project choice

function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

async function githubRequest(path, method, body) {
    const res = await fetchWithTimeout(`https://api.github.com${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    }, 15000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub API error (${res.status}): ${data.message || 'unknown error'}`);
    return data;
}

// Creates a brand-new repo for this one approved design. Returns {owner, repo, htmlUrl}.
async function createGithubRepo(name) {
    const repoName = `${slugify(name)}-${Math.random().toString(16).slice(2, 8)}`;
    const data = await githubRequest('/user/repos', 'POST', {
        name: repoName,
        private: true,
        auto_init: true, // creates an initial commit/default branch so file pushes have something to build on
        description: `Auto-generated from a Ziggy /design approval: "${name}"`
    });
    return { owner: data.owner.login, repo: data.name, htmlUrl: data.html_url };
}

// Pushes one file to a repo (create-or-update, per GitHub's Contents API).
async function pushFileToGithub(owner, repo, path, content, message) {
    const contentBase64 = Buffer.from(content, 'utf8').toString('base64');
    await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, 'PUT', {
        message,
        content: contentBase64
    });
}

// Asks MiMo to turn a Stitch-generated design's HTML into clean, real
// implementation files, as strict JSON so it's reliably parseable.
async function designToCode(htmlContent, originalPrompt) {
    const prompt =
        "You are an expert front-end developer. Below is auto-generated HTML from a design " +
        "tool (Google Stitch), for a UI originally described as: \"" + originalPrompt + "\". " +
        "Turn it into clean, production-quality implementation files (proper semantic HTML, " +
        "separated CSS, and any needed JS — keep it to a small, sensible number of files, a " +
        "single-page static site is fine unless the design clearly needs more).\n\n" +
        "Reply with ONLY raw JSON, no markdown fences, in exactly this format:\n" +
        '{"files": [{"path": "index.html", "content": "..."}, {"path": "style.css", "content": "..."}], "commit_message": "short description"}\n\n' +
        "Design HTML:\n" + htmlContent.slice(0, 15000); // cap length to keep the prompt reasonable

    const raw = await askGemini(prompt, "mimo-v2.5-pro");
    const clean = (raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean); // let this throw — caller handles the error clearly
    if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
        throw new Error("MiMo didn't return any files");
    }
    return parsed;
}

async function mintStitchAccessToken() {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
        keyFile: STITCH_CREDENTIALS_FILE,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Couldn't mint a Stitch access token — check the service account key and its granted role.");
    return token;
}

// Full setup needed before any Stitch SDK call: the Node 18 File polyfill,
// a freshly-minted access token, and the SDK import itself. Every code path
// that touches Stitch goes through this so the setup only lives in one place.
const STITCH_OAUTH_TOKEN_FILE = "/root/Ziggy/stitch-oauth-token.json"; // your own Google identity, not the service account

// Mints a fresh access token from your saved OAuth refresh token (acting
// as YOU, not the service account) — this is what makes Stitch projects
// show up in your own stitch.withgoogle.com dashboard.
async function mintStitchUserAccessToken() {
    const { refresh_token, client_id, client_secret } = JSON.parse(fs.readFileSync(STITCH_OAUTH_TOKEN_FILE, 'utf8'));
    const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' })
    }, 10000);
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(`Couldn't refresh your Stitch OAuth token: ${data.error || 'unknown error'}`);
    return data.access_token;
}

async function initStitch() {
    if (typeof globalThis.File === 'undefined') {
        globalThis.File = require('node:buffer').File;
    }
    // Use your own OAuth identity if it's been set up (stitch_oauth_setup.js),
    // otherwise fall back to the service account.
    const accessToken = fs.existsSync(STITCH_OAUTH_TOKEN_FILE)
        ? await mintStitchUserAccessToken()
        : await mintStitchAccessToken();
    process.env.STITCH_ACCESS_TOKEN = accessToken;
    process.env.GOOGLE_CLOUD_PROJECT = "YOUR_GCP_PROJECT_ID_HERE";
    delete process.env.STITCH_API_KEY;
    const { stitch } = await import('@google/stitch-sdk');
    return stitch;
}

// Generates a screen in the given project and sends the result to Telegram
// (with an Approve & Build button if HTML came through, or a clear
// image-only note if it didn't).
async function generateAndSendDesign(chatId, stitch, project, prompt) {
    const screen = await withTimeout(project.generate(prompt), 60000, "Screen generation");
    let [imageUrl, htmlUrl] = await Promise.all([
        withTimeout(screen.getImage(), 15000, "Fetching the screenshot"),
        withTimeout(screen.getHtml(), 15000, "Fetching the HTML")
    ]);
    if (!htmlUrl) {
        // HTML sometimes lags a moment behind the screenshot — one retry
        // before concluding it's genuinely image-only.
        await new Promise(r => setTimeout(r, 4000));
        htmlUrl = await withTimeout(screen.getHtml(), 15000, "Re-checking for HTML").catch(() => "");
    }

    if (htmlUrl) {
        const designId = String(++pendingCounter);
        pendingDesigns[designId] = { prompt, htmlUrl };
        await tg('sendPhoto', {
            chat_id: chatId,
            photo: imageUrl,
            caption: `${prompt}\n\nFull HTML: ${htmlUrl}`.slice(0, 1024),
            reply_markup: { inline_keyboard: [[
                { text: "✅ Approve & Build", callback_data: `build:${designId}` }
            ]] }
        });
    } else {
        await tg('sendPhoto', {
            chat_id: chatId,
            photo: imageUrl,
            caption: `${prompt}\n\n(No HTML was generated for this screen — image only. Try /design again for a version with buildable HTML.)`.slice(0, 1024)
        });
    }
}

async function runOnPC(chatId, cmd) {
    const ok = await forwardToRelay(`/local ${cmd}`);
    if (!ok) await sendMessage(chatId, "⚠️ Could not reach the relay.");
}


async function handleMessage(message) {
    const chatId = message.chat.id;
    const senderId = message.from.id;
    const text = (message.text || '').trim();

    if (senderId !== ALLOWED_USER_ID) return;
    if (!text) return;

    // /localraw <command> -> send the EXACT text to the PC, no AI translation.
    // Escape hatch for when you want to type a precise command yourself.
    if (text.toLowerCase().startsWith('/localraw')) {
        const cmd = text.slice('/localraw'.length).trim();
        if (!cmd) { await sendMessage(chatId, "Usage: /localraw <exact command>"); return; }
        await sendMessage(chatId, `🖥️ Running on PC (raw):\n\`${cmd}\``);
        await runOnPC(chatId, cmd);
        return;
    }

    // /local <plain English> -> Gemini translates it into a Windows command.
    // Safe commands run straight away; risky ones ask for confirmation first.
    if (text.toLowerCase().startsWith('/local')) {
        const request = text.slice('/local'.length).trim();
        if (!request) { await sendMessage(chatId, "Tell me what to do, e.g. /local open notepad"); return; }

        await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
        const action = await translateToCommand(request);

        if (!action || !action.cmd) {
            const why = action && action.explanation ? `\n(${action.explanation})` : "";
            await sendMessage(chatId, `⚠️ I couldn't turn that into a PC command.${why}`);
            return;
        }

        if (isRisky(action.cmd)) {
            // Store it and ask for a Run/Cancel tap.
            const id = String(++pendingCounter);
            pendingCommands[id] = { cmd: action.cmd, target: 'pc' };
            await sendMessage(chatId,
                `⚠️ *This looks risky.* Run it on your PC?\n\n\`${action.cmd}\`\n\n_${action.explanation || ''}_`,
                { reply_markup: { inline_keyboard: [[
                    { text: "✅ Run", callback_data: `run:${id}` },
                    { text: "❌ Cancel", callback_data: `cancel:${id}` }
                ]] } });
        } else {
            // Safe: run straight away, but show what it's running.
            await sendMessage(chatId, `🖥️ ${action.explanation || 'Running on PC'}:\n\`${action.cmd}\``);
            await runOnPC(chatId, action.cmd);
        }
        return;
    }

    // /drive <plain English> -> translate to an rclone command against your
    // Google Drive. Same guarded pattern as /local: safe operations (mkdir,
    // copy, list) run straight away; destructive ones (purge, delete) ask
    // for confirmation first. Can't search file CONTENTS — pair with /ask
    // for that (find the files by topic there, then use /drive to move them).
    if (text.toLowerCase().startsWith('/drive')) {
        const request = text.slice('/drive'.length).trim();
        if (!request) { await sendMessage(chatId, "Tell me what to do, e.g. /drive make a new folder called Research"); return; }

        await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
        const action2 = await translateToRcloneCommand(request);

        if (!action2 || !action2.cmd) {
            const why = action2 && action2.explanation ? `\n(${action2.explanation})` : "";
            await sendMessage(chatId, `⚠️ I couldn't turn that into a Drive command.${why}`);
            return;
        }

        if (isRisky(action2.cmd)) {
            const id = String(++pendingCounter);
            pendingCommands[id] = { cmd: action2.cmd, target: 'droplet' };
            await sendMessage(chatId,
                `⚠️ *This looks risky.* Run it on your Drive?\n\n\`${action2.cmd}\`\n\n_${action2.explanation || ''}_`,
                { reply_markup: { inline_keyboard: [[
                    { text: "✅ Run", callback_data: `run:${id}` },
                    { text: "❌ Cancel", callback_data: `cancel:${id}` }
                ]] } });
        } else {
            await sendMessage(chatId, `📁 ${action2.explanation || 'Running on Drive'}:\n\`${action2.cmd}\``);
            runOnDroplet(chatId, action2.cmd);
        }
        return;
    }

    // Write articles on your PC (Ollama). Runs on the PC via the /local pipe.
    if (text === '/generate') {
        await sendMessage(chatId,
            "✍️ Writing articles on your PC with qwen3.5:9b...\n" +
            "This can take several minutes. I'll send the result when it's done.");
        const ok = await forwardToRelay(`/local "${PC_PYTHON}" "${PC_PIPELINE}" --mode generate`);
        if (!ok) await sendMessage(chatId, "⚠️ Could not reach the relay.");
        return;
    }

    // Publishing pipeline (runs on the Droplet), with progress messages.
    // /run_pipeline: pull fresh from Drive, then push. Use when you've just generated.
    if (text === '/run_pipeline' || text === '/publish') {
        runStaged(chatId, [
            { label: "📥 Pulling latest articles from Drive...", cmd: pullArticlesCmd() },
            { label: "📤 Pushing new drafts to Substack...", cmd: `node ${PROJECT_DIR}/substack_api_drafts.js` },
            { label: "🔎 Updating the document search index...", cmd: `python3 ${PROJECT_DIR}/ingest_documents.py` }
        ]);
        return;
    }
    // /push: skip the slow Drive pull, just push whatever is already local. Fast.
    if (text === '/push') {
        runStaged(chatId, [
            { label: "📤 Pushing local drafts to Substack (no Drive pull)...", cmd: `node ${PROJECT_DIR}/substack_api_drafts.js` },
            { label: "🔎 Updating the document search index...", cmd: `python3 ${PROJECT_DIR}/ingest_documents.py` }
        ]);
        return;
    }
    // /sync: only pull from Drive, don't push. Use to refresh local copies.
    if (text === '/sync') {
        runStaged(chatId, [
            { label: "📥 Syncing articles from Drive...", cmd: pullArticlesCmd() }
        ]);
        return;
    }
    if (text === '/run_notes') {
        await sendMessage(chatId, "⚙️ Running the organic Notes campaign cycle...");
        runOnDroplet(chatId, `node ${PROJECT_DIR}/notes_campaign_manager.js`);
        return;
    }

    // /reindex: manually rebuild the document search index, without running
    // the full publish pipeline. Useful after editing the style guide or
    // backlog, which /run_pipeline wouldn't otherwise touch.
    // /remember <fact> -> explicitly store something in long-term memory,
    // rather than relying only on the automatic per-message retain.
    if (text.toLowerCase().startsWith('/remember')) {
        const fact = text.slice('/remember'.length).trim();
        if (!fact) { await sendMessage(chatId, "Usage: /remember <something to remember>"); return; }
        const stopTyping = startTyping(chatId);
        try {
            const res = await fetchWithTimeout(`${HINDSIGHT_URL}/v1/default/banks/${HINDSIGHT_BANK}/memories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: [{ content: fact, context: "Explicitly told to remember" }], async: false })
            }, 25000); // synchronous retain does real fact-extraction — give it real room
            stopTyping();
            if (res.ok) await sendMessage(chatId, "🧠 Got it, I'll remember that.");
            else await sendMessage(chatId, "⚠️ Couldn't reach memory storage. Is Hindsight running?");
        } catch (e) {
            stopTyping();
            const reason = e.name === 'AbortError' ? "it took too long to respond (over 25s)" : e.message;
            await sendMessage(chatId, `⚠️ Couldn't save that to memory: ${reason}`);
        }
        return;
    }

    // /design <description> -> asks whether to create a new Stitch project
    // or use an existing one, THEN generates the screen in whichever
    // project you pick.
    if (text.toLowerCase().startsWith('/design')) {
        const prompt = text.slice('/design'.length).trim();
        if (!prompt) { await sendMessage(chatId, "Usage: /design <description>, e.g. /design a login page with email and password fields"); return; }

        const promptId = String(++pendingCounter);
        pendingDesignPrompts[promptId] = prompt;
        await sendMessage(chatId, `Design: "${prompt}"\n\nWhich project should this go in?`, {
            reply_markup: { inline_keyboard: [[
                { text: "🆕 Create New Project", callback_data: `designnew:${promptId}` },
                { text: "📁 Use Existing Project", callback_data: `designlist:${promptId}` }
            ]] }
        });
        return;
    }

    if (text.toLowerCase().startsWith('/image')) {
        const prompt = text.slice('/image'.length).trim();
        if (!prompt) { await sendMessage(chatId, "Usage: /image <description>, e.g. /image a snow leopard on a rock at golden hour"); return; }
        await runOnPC(chatId, `IMAGE_GEN:${prompt}`);
        // The PC sends its own progress messages and the final photo directly —
        // no further action needed here.
        return;
    }

    if (text === '/reindex') {
        runStaged(chatId, [
            { label: "🔎 Rebuilding the document search index...", cmd: `python3 ${PROJECT_DIR}/ingest_documents.py` }
        ]);
        return;
    }

    // /ask <question> -> search the indexed articles/reference docs and have
    // Gemini answer grounded in what's actually been written, instead of
    // guessing from general knowledge.
    if (text.toLowerCase().startsWith('/ask')) {
        const question = text.slice('/ask'.length).trim();
        if (!question) { await sendMessage(chatId, "Usage: /ask <question>, e.g. /ask have I covered magnesium before?"); return; }

        await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
        await sendMessage(chatId, "🔎 Searching your articles and docs...");

        const escaped = question.replace(/"/g, '\\"');
        exec(`python3 ${PROJECT_DIR}/search_documents.py "${escaped}"`,
            { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
            async (err, stdout) => {
                let parsed;
                try { parsed = JSON.parse(stdout); } catch (e) { parsed = null; }

                if (err || !parsed || parsed.error) {
                    const reason = (parsed && parsed.error) || (err && err.message) || "unknown error";
                    await sendMessage(chatId, `⚠️ Couldn't search your documents: ${reason}`);
                    return;
                }

                const results = parsed.results || [];
                if (results.length === 0) {
                    await sendMessage(chatId, "No relevant content found in your indexed articles or docs.");
                    return;
                }

                // Build a grounded prompt: give Gemini the retrieved chunks and
                // ask it to answer ONLY from them, citing which article each
                // point comes from.
                const context = results.map((r, i) =>
                    `[Source ${i + 1}: "${r.source}" (${r.kind})]\n${r.text}`
                ).join('\n\n');

                const prompt =
                    `You are answering a question using ONLY the article/document excerpts below, ` +
                    `which are the user's own writing. Cite which source(s) you drew from by name. ` +
                    `If the excerpts don't actually answer the question, say so plainly rather than guessing.\n\n` +
                    `${context}\n\nQuestion: ${question}`;

                const reply = await askGemini(prompt, "gemini-flash-latest");
                await sendMessage(chatId, reply);
            }
        );
        return;
    }

    // Model menu.
    if (text === '/model' || text === '/models') {
        await sendMessage(chatId, "🧠 Pick a brain. Whatever you type next goes to it:", modelMenu());
        return;
    }

    // Help / status.
    if (text === '/start' || text === '/help') {
        await sendMessage(chatId,
            "🚀 agZiggy online.\n\n" +
            "• /model — pick which AI answers you\n" +
            "• Just type a message — goes to the active brain\n" +
            "• /local <plain English> — tell your PC what to do (risky actions ask first)\n" +
            "• /check — see whether your PC is currently online\n" +
            "• /drive <plain English> — organise your Google Drive (create folders, move/copy/rename files)\n" +
            "  ↳ _note: /drive can't search file CONTENTS, only names/locations. To find files by topic (\"which articles mention magnesium?\"), use /ask first — it already searches what's actually written. Then use /drive to file, copy, or move what /ask finds, by name._\n" +
            "• /localraw <command> — run an exact command on your PC (no translation)\n" +
            "• /generate — write new articles on your PC (Ollama)\n" +
            "• /run_pipeline — pull from Drive + push new drafts to Substack\n" +
            "• /push — push local drafts only (skips Drive, faster)\n" +
            "• /sync — just pull latest articles from Drive\n" +
            "• /run_notes — run the organic Notes campaign\n" +
            "• /ask <question> — search your articles/docs and get a grounded answer\n" +
            "• /reindex — manually rebuild the document search index\n" +
            "• /remember <fact> — explicitly store something in long-term memory\n" +
            "• /image <description> — generate an image on your PC (needs ComfyUI running)\n" +
            "• /design <description> — generate a UI screen with Google Stitch\n\n" +
            "_(chat also automatically remembers past conversations)_\n\n" +
            "_(the search index also rebuilds automatically after /run_pipeline and /push)_\n\n" +
            `Active brain right now: ${activeModel}`);
        return;
    }
    if (text === '/status') {
        await sendMessage(chatId, `🟢 Online. Active brain: ${activeModel}\nUptime: ${Math.round(process.uptime())}s`);
        return;
    }

    // /check -> is the PC currently on/connected? Useful when you're out
    // and want to know before trying /image, /local, /generate, etc.
    if (text === '/check') {
        try {
            const res = await fetchWithTimeout(`http://127.0.0.1:${RELAY_PORT}/pc_status`, {
                headers: { 'X-Auth-Token': RELAY_SECRET }
            }, 5000);
            const data = await res.json();
            if (data.online) {
                await sendMessage(chatId, `🟢 Your PC is online (last checked in ${data.seconds_ago}s ago).`);
            } else if (data.seconds_ago === null) {
                await sendMessage(chatId, "🔴 Your PC hasn't connected since the relay last restarted — likely off, or the executor isn't running.");
            } else {
                const mins = Math.round(data.seconds_ago / 60);
                await sendMessage(chatId, `🔴 Your PC looks offline — last seen ${mins < 1 ? Math.round(data.seconds_ago) + 's' : mins + 'm'} ago.`);
            }
        } catch (e) {
            await sendMessage(chatId, "⚠️ Couldn't reach the relay to check PC status.");
        }
        return;
    }

    // A normal message -> active brain, with live pipeline status AND
    // relevant past-conversation memories attached, so the bot actually
    // knows what's going on and remembers things I've told it before.
    // Show "typing..." right away and keep it alive through the whole
    // sequence (Drive check + memory recall + the model call), so there's
    // never a silent gap while it works.
    const stopTyping = startTyping(chatId);
    try {
        const status = await getPipelineStatus();
        const memories = await recallMemory(text);
        const memoryBlock = memories
            ? `\n\n[Relevant things you remember about the user from past conversations:\n${memories}]`
            : "";
        const withContext =
            `[Current Ziggy pipeline status — use this if relevant, otherwise ignore it:\n${status}]${memoryBlock}\n\n` +
            `User message: ${text}`;

        if (isCloud(activeModel)) {
            const reply = await askGemini(withContext, activeModel);
            stopTyping();
            await sendMessage(chatId, reply);
            retainMemory(text, reply);
        } else {
            stopTyping();
            const safePrompt = withContext.replace(/"/g, "'");
            await sendMessage(chatId, `🧠 Asking *${activeModel}* on your PC...`);
            const ok = await forwardToRelay(`/local ollama run ${activeModel} "${safePrompt}"`);
            if (!ok) await sendMessage(chatId, "⚠️ Could not reach the relay.");
            // Note: local-model replies stream back via the PC relay, not
            // captured here, so they aren't retained to memory for now.
        }
    } finally {
        stopTyping(); // safe to call twice; guarantees it never keeps running on an error
    }
}

async function handleCallback(cb) {
    const chatId = cb.message?.chat?.id;
    const senderId = cb.from?.id;
    const data = cb.data || "";

    if (senderId !== ALLOWED_USER_ID) return;

    // "Create New Project" chosen -> create a fresh Stitch project and
    // generate the design in it.
    if (data.startsWith("designnew:")) {
        const promptId = data.split(":")[1];
        const prompt = pendingDesignPrompts[promptId];
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        if (!prompt) { if (chatId) await sendMessage(chatId, "That request has expired. Please run /design again."); return; }
        delete pendingDesignPrompts[promptId];
        if (!chatId) return;

        const stopTyping = startTyping(chatId);
        try {
            const stitch = await withTimeout(initStitch(), 20000, "Stitch authentication");
            const project = await withTimeout(stitch.createProject(`Ziggy: ${prompt}`.slice(0, 80)), 30000, "Creating the Stitch project");
            await generateAndSendDesign(chatId, stitch, project, prompt);
        } catch (e) {
            await sendMessage(chatId, `⚠️ Design generation failed: ${e.message}`);
        } finally {
            stopTyping();
        }
        return;
    }

    // "Use Existing Project" chosen -> list real Stitch projects as buttons.
    if (data.startsWith("designlist:")) {
        const promptId = data.split(":")[1];
        const prompt = pendingDesignPrompts[promptId];
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        if (!prompt) { if (chatId) await sendMessage(chatId, "That request has expired. Please run /design again."); return; }
        if (!chatId) return;

        const stopTyping = startTyping(chatId);
        try {
            const stitch = await withTimeout(initStitch(), 20000, "Stitch authentication");
            const projects = await withTimeout(stitch.projects(), 20000, "Listing your Stitch projects");
            if (!projects || projects.length === 0) {
                stopTyping();
                await sendMessage(chatId, "You don't have any existing Stitch projects yet — creating a new one instead.");
                const project = await withTimeout(stitch.createProject(`Ziggy: ${prompt}`.slice(0, 80)), 30000, "Creating the Stitch project");
                delete pendingDesignPrompts[promptId];
                await generateAndSendDesign(chatId, stitch, project, prompt);
                return;
            }
            const buttons = projects.slice(0, 20).map(p => ([{
                text: (p.data?.title || `Project ${p.id}`).slice(0, 60),
                callback_data: `designuse:${promptId}:${p.id}`
            }]));
            stopTyping();
            await sendMessage(chatId, "Pick a project:", { reply_markup: { inline_keyboard: buttons } });
        } catch (e) {
            stopTyping();
            await sendMessage(chatId, `⚠️ Couldn't list your Stitch projects: ${e.message}`);
        }
        return;
    }

    // A specific existing project was picked -> generate the design there.
    if (data.startsWith("designuse:")) {
        const [, promptId, projectId] = data.split(":");
        const prompt = pendingDesignPrompts[promptId];
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        if (!prompt) { if (chatId) await sendMessage(chatId, "That request has expired. Please run /design again."); return; }
        delete pendingDesignPrompts[promptId];
        if (!chatId) return;

        const stopTyping = startTyping(chatId);
        try {
            const stitch = await withTimeout(initStitch(), 20000, "Stitch authentication");
            const project = stitch.project(projectId); // handle only, no API call
            await generateAndSendDesign(chatId, stitch, project, prompt);
        } catch (e) {
            await sendMessage(chatId, `⚠️ Design generation failed: ${e.message}`);
        } finally {
            stopTyping();
        }
        return;
    }

    // Approved design -> MiMo writes real implementation code -> pushed to
    // a brand-new GitHub repo.
    // Backlog research proposal — approve writes new ideas to the TOP of
    // future_article_backlog.md on Drive (pipeline.py drafts top-first, so
    // this is all that's needed to prioritise them); discard just clears it.
    if (data === "addbacklog" || data === "discardbacklog") {
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        const PENDING_FILE = "/root/Ziggy/pending_backlog_proposal.json";
        let pending;
        try {
            pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
        } catch (e) {
            if (chatId) await sendMessage(chatId, "No pending backlog proposal found (may have expired).");
            return;
        }

        if (data === "discardbacklog") {
            fs.unlinkSync(PENDING_FILE);
            if (chatId) await sendMessage(chatId, "❌ Discarded — no changes made to the backlog.");
            return;
        }

        const stopTyping = chatId ? startTyping(chatId) : null;
        try {
            const existing = execSync('rclone cat "gdrive:Ziggy/future_article_backlog.md"', { encoding: 'utf8', timeout: 30000 });
            const newBlocks = pending.ideas.map((idea, i) =>
                `### ${i + 1}. ${idea.title}\n${idea.details}\n`
            ).join('\n');

            const headerMatch = existing.match(/^(#[^\n]*\n)/);
            const combined = headerMatch
                ? headerMatch[1] + '\n' + newBlocks + '\n' + existing.slice(headerMatch[1].length)
                : newBlocks + '\n' + existing;

            const tmpFile = '/root/Ziggy/tmp_backlog_update.md';
            fs.writeFileSync(tmpFile, combined);
            execSync(`rclone copyto "${tmpFile}" "gdrive:Ziggy/future_article_backlog.md"`, { timeout: 30000 });
            fs.unlinkSync(tmpFile);
            fs.unlinkSync(PENDING_FILE);

            if (stopTyping) stopTyping();
            if (chatId) await sendMessage(chatId, `✅ Added ${pending.ideas.length} new idea(s) to the top of the backlog — they'll draft first.`);
        } catch (e) {
            if (stopTyping) stopTyping();
            if (chatId) await sendMessage(chatId, `⚠️ Couldn't update the backlog: ${e.message}`);
        }
        return;
    }

    if (data.startsWith("build:")) {
        const id = data.split(":")[1];
        const pending = pendingDesigns[id];
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        if (!pending) {
            if (chatId) await sendMessage(chatId, "That design has expired. Please run /design again.");
            return;
        }
        delete pendingDesigns[id];
        if (!chatId) return;

        const stopTyping = startTyping(chatId);
        try {
            await sendMessage(chatId, "🛠️ Fetching the design and handing it to MiMo...");
            const htmlRes = await fetchWithTimeout(pending.htmlUrl, {}, 15000);
            const htmlContent = await htmlRes.text();

            const built = await designToCode(htmlContent, pending.prompt);

            await sendMessage(chatId, `📦 MiMo wrote ${built.files.length} file(s). Creating a GitHub repo...`);
            const { owner, repo, htmlUrl: repoUrl } = await createGithubRepo(pending.prompt);

            for (const file of built.files) {
                await pushFileToGithub(owner, repo, file.path, file.content, built.commit_message || `Implement: ${pending.prompt}`);
            }

            stopTyping();
            await sendMessage(chatId, `✅ Done! Pushed to a new repo:\n${repoUrl}`);
        } catch (e) {
            stopTyping();
            await sendMessage(chatId, `⚠️ Build failed: ${e.message}`);
        }
        return;
    }

    // Confirm an article was published -> move it to articles_published and
    // complete the campaign so the next one can start.
    if (data === "pubdone" || data.startsWith("pubdone:")) {
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: "Marked as published" });
        try {
            const state = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_FILE, 'utf8'));
            if (state.active_campaign && state.active_campaign.awaiting_publish_confirm) {
                const file = state.active_campaign.article_file;
                const doneTitle = state.active_campaign.article_title || file;

                // Move the article from drafted -> published in Drive (syncs to PC).
                let moveNote = "";
                try {
                    require('child_process').execFileSync('rclone', [
                        'moveto',
                        `gdrive:Ziggy/articles_drafted/${file}`,
                        `gdrive:Ziggy/articles_published/${file}`
                    ], { stdio: 'pipe' });
                } catch (mvErr) {
                    moveNote = "\n(Note: couldn't move the file to articles_published — it may already have moved.)";
                }

                if (!Array.isArray(state.completed_campaigns)) state.completed_campaigns = [];
                if (!state.completed_campaigns.includes(file)) state.completed_campaigns.push(file);
                state.active_campaign = null;
                fs.writeFileSync(CAMPAIGN_STATE_FILE, JSON.stringify(state, null, 2));

                if (chatId) await sendMessage(chatId, `✅ *${doneTitle}* marked as published and filed away. The next campaign begins on the next daily cycle.${moveNote}`);
            } else {
                if (chatId) await sendMessage(chatId, "That campaign is already completed. Nothing to do.");
            }
        } catch (e) {
            if (chatId) await sendMessage(chatId, "⚠️ Couldn't update the campaign state: " + e.message);
        }
        return;
    }

    // Confirm (Run) or discard (Cancel) a pending risky command.
    if (data.startsWith("run:") || data.startsWith("cancel:")) {
        const [action, id] = data.split(":");
        const pending = pendingCommands[id];
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        if (!pending) {
            if (chatId) await sendMessage(chatId, "That command has expired. Please send the request again.");
            return;
        }
        delete pendingCommands[id];
        if (action === "run") {
            const where = pending.target === 'droplet' ? 'Drive' : 'PC';
            if (chatId) await sendMessage(chatId, `▶️ Running on ${where}:\n\`${pending.cmd}\``);
            if (chatId) {
                if (pending.target === 'droplet') runOnDroplet(chatId, pending.cmd);
                else await runOnPC(chatId, pending.cmd);
            }
        } else {
            if (chatId) await sendMessage(chatId, "❌ Cancelled. Nothing was run.");
        }
        return;
    }

    if (data.startsWith("setmodel:")) {
        activeModel = data.slice("setmodel:".length);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: "Switched to " + activeModel });
        if (chatId) {
            const where = isCloud(activeModel) ? "the cloud" : "your PC";
            await sendMessage(chatId, `✅ Active brain is now *${activeModel}* (${where}).\nType anything and it'll go there.`);
        }
    }
}

async function poll() {
    try {
        const data = await tg('getUpdates', { offset, timeout: 30 });
        if (data.ok && data.result) {
            for (const update of data.result) {
                offset = update.update_id + 1;
                if (update.message) await handleMessage(update.message);
                else if (update.callback_query) await handleCallback(update.callback_query);
            }
        }
    } catch (err) {
        await new Promise(r => setTimeout(r, 3000));
    }
    setTimeout(poll, 100);
}

console.log('[*] Ziggy bot (menu + pipeline + generate) started.');
poll();
