/**
 * Ziggy Windows Local Command Executor  (simple runner)
 * =======================================================
 * Runs on your Windows PC. Polls the Droplet relay for commands and runs them.
 *
 * NOTE: Translation from plain English into a command now happens on the
 * Droplet bot (using Gemini), which also handles safety confirmation for
 * risky commands. By the time a command reaches here, it is already a real
 * Windows command that has been approved, so this script just runs it.
 *
 * A single-instance port lock prevents duplicate copies running at once.
 */

const { exec } = require('child_process');
const http = require('http');

const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const ALLOWED_USER_ID = 0; // YOUR_TELEGRAM_USER_ID_HERE — replace 0 with your real numeric Telegram ID
const RELAY_PORT = 3000; // change if you like — cloud_agent.py and telegram_bot.js must use the same value
const RELAY_GET = `http://YOUR_DROPLET_IP_HERE:${RELAY_PORT}/get_local`;
const RELAY_SECRET = "YOUR_RELAY_SECRET_HERE"; // must match cloud_agent.py's RELAY_SECRET exactly — this crosses the public internet, so it genuinely needs it

const MUTEX_PORT = 49352;

// ---- Image generation via ComfyUI ----
// ComfyUI must already be running (double-click run_nvidia_gpu.bat) before
// an /image command arrives — this just talks to its local API.
const COMFYUI_URL = "http://127.0.0.1:8188";
const CHECKPOINT_NAME = "dreamshaperXL_v21TurboDPMSDE.safetensors"; // change if using a different checkpoint file

// ---- Watchdog: relaunches Ollama/ComfyUI if they've silently died ----
// (e.g. after the PC sleeps — this has happened twice tonight already).
// Runs a health check every ~30 poll cycles (~30s), with a cooldown so a
// service that's still booting (ComfyUI takes 15-20s) doesn't get
// relaunched repeatedly while it's mid-startup.
const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_EXE = '"C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Programs\\Ollama\\ollama.exe" serve';
const COMFYUI_LAUNCH = 'cmd /c cd /d C:\\AI\\ComfyUI && .\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --fast fp16_accumulation';
const WATCHDOG_INTERVAL_POLLS = 30; // ~30 seconds, given the 1s poll loop
const RELAUNCH_COOLDOWN_MS = 45000; // don't re-attempt a relaunch within 45s of the last one

let pollCount = 0;
let lastOllamaRelaunch = 0;
let lastComfyRelaunch = 0;

async function pingWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        return res.ok || res.status < 500; // any real response means it's alive
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function runWatchdogCheck() {
    const now = Date.now();

    const ollamaAlive = await pingWithTimeout(`${OLLAMA_URL}/api/tags`);
    if (!ollamaAlive && (now - lastOllamaRelaunch > RELAUNCH_COOLDOWN_MS)) {
        lastOllamaRelaunch = now;
        console.log('[watchdog] Ollama not responding — relaunching');
        exec(OLLAMA_EXE, { windowsHide: true });
        sendTelegramMessage("🐕 Watchdog: Ollama wasn't responding, relaunching it now.");
    }

    const comfyAlive = await pingWithTimeout(`${COMFYUI_URL}/system_stats`);
    if (!comfyAlive && (now - lastComfyRelaunch > RELAUNCH_COOLDOWN_MS)) {
        lastComfyRelaunch = now;
        console.log('[watchdog] ComfyUI not responding — relaunching');
        exec(COMFYUI_LAUNCH, { windowsHide: true });
        sendTelegramMessage("🐕 Watchdog: ComfyUI wasn't responding, relaunching it now (takes ~15-20s to be ready).");
    }
}


function acquireSingleInstanceLock() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200);
            res.end('Ziggy_Executor_Active');
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[-] Another instance is already running on port ${MUTEX_PORT}. Exiting.`);
                process.exit(0);
            } else {
                console.error('[-] Mutex server error:', err.message);
                resolve(false);
            }
        });
        server.listen(MUTEX_PORT, '127.0.0.1', () => {
            console.log(`[+] Single instance lock acquired on port ${MUTEX_PORT}.`);
            resolve(true);
        });
    });
}

async function sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ALLOWED_USER_ID, text: text, parse_mode: 'Markdown' })
        });
    } catch (e) {
        console.error('[-] Telegram send error:', e.message);
    }
}

// Standard SDXL txt2img workflow in ComfyUI's API format — the same graph
// the ComfyUI web UI builds visually: load checkpoint -> encode prompt
// (positive + negative) -> sample -> decode -> save.
function buildWorkflow(prompt, negativePrompt = "blurry, low quality, distorted, watermark") {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    return {
        "3": {
            class_type: "KSampler",
            inputs: {
                seed, steps: 8, cfg: 2, // DreamShaper XL Turbo wants few steps, low CFG
                sampler_name: "dpmpp_sde", scheduler: "karras", denoise: 1.0,
                model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0]
            }
        },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CHECKPOINT_NAME } },
        "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
        "7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["4", 1] } },
        "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
        "9": { class_type: "SaveImage", inputs: { filename_prefix: "ziggy", images: ["8", 0] } }
    };
}

// Submit the workflow, poll until it's done, return the finished PNG as a Buffer.
async function generateImage(prompt, onProgress) {
    const workflow = buildWorkflow(prompt);
    const clientId = "ziggy_" + Date.now();

    const submitRes = await fetch(`${COMFYUI_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });
    if (!submitRes.ok) {
        const errText = await submitRes.text().catch(() => '');
        throw new Error(`ComfyUI rejected the request: ${errText.slice(0, 300)}`);
    }
    const { prompt_id } = await submitRes.json();
    if (!prompt_id) throw new Error("ComfyUI didn't return a prompt_id");

    // Generation is normally a few seconds on a 12GB card with a turbo
    // checkpoint; cap the total wait so a stuck ComfyUI can't hang forever.
    const maxWaitMs = 90000;
    const pollEveryMs = 1500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs) {
        await new Promise(r => setTimeout(r, pollEveryMs));
        if (onProgress) onProgress();

        const histRes = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
        if (!histRes.ok) continue;
        const hist = await histRes.json();
        const entry = hist[prompt_id];
        if (!entry) continue; // not finished yet

        const images = entry.outputs?.["9"]?.images;
        if (!images || images.length === 0) {
            throw new Error("ComfyUI finished but produced no image (check its console for errors)");
        }

        const { filename, subfolder, type } = images[0];
        const viewUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}&type=${encodeURIComponent(type || 'output')}`;
        const imgRes = await fetch(viewUrl);
        if (!imgRes.ok) throw new Error("Generated, but couldn't download the image file from ComfyUI");
        const arrayBuffer = await imgRes.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    throw new Error(`Timed out after ${maxWaitMs / 1000}s waiting for ComfyUI. Is it running? (double-click run_nvidia_gpu.bat)`);
}

// Upload an image buffer to Telegram as a photo.
async function sendTelegramPhoto(caption, imageBuffer) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', String(ALLOWED_USER_ID));
    form.append('caption', caption.slice(0, 1024));
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'ziggy.png');

    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Telegram rejected the photo upload: ${errText.slice(0, 300)}`);
    }
}

// Full flow: generate + upload, with progress pings so it never looks frozen.
async function generateAndSendImage(prompt) {
    await sendTelegramMessage(`🎨 Generating: "${prompt}"...`);
    let pings = 0;
    try {
        const imageBuffer = await generateImage(prompt, () => {
            pings++;
            if (pings % 4 === 0) sendTelegramMessage("🎨 Still rendering...");
        });
        await sendTelegramPhoto(prompt, imageBuffer);
    } catch (e) {
        console.error('[-] Image generation error:', e.message);
        await sendTelegramMessage(`⚠️ Image generation failed: ${e.message}`);
    }
}

// Run a command on this PC and report the result back to Telegram.
function executeShellCommand(cmd, timeout = 20000) {
    console.log(`[+] Executing: ${cmd}`);
    exec(cmd, { cwd: __dirname, timeout: timeout, windowsHide: true }, async (err, stdout, stderr) => {
        if (err) {
            console.error('[-] Execution error:', err.message);
            await sendTelegramMessage(`❌ *PC error:* ${err.message.slice(0, 500)}`);
        } else {
            const output = (stdout || stderr || '').trim();
            if (output) {
                await sendTelegramMessage(`💻 *PC output:*\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\``);
            } else {
                await sendTelegramMessage(`✅ *Done.*`);
            }
        }
    });
}

async function poll() {
    try {
        const res = await fetch(RELAY_GET, { headers: { 'X-Auth-Token': RELAY_SECRET } });
        if (res.ok) {
            const data = await res.json();
            if (data.command) {
                if (data.command.startsWith('IMAGE_GEN:')) {
                    const prompt = data.command.slice('IMAGE_GEN:'.length).trim();
                    generateAndSendImage(prompt); // fire-and-forget; sends its own progress + result
                } else {
                    executeShellCommand(data.command);
                }
            }
        }
    } catch (err) {
        // Droplet unreachable; back off a little before retrying.
        await new Promise(r => setTimeout(r, 4000));
    }

    // Watchdog: every ~30 poll cycles, check Ollama + ComfyUI are still alive
    // and relaunch either one that's silently died (e.g. after PC sleep).
    pollCount++;
    if (pollCount % WATCHDOG_INTERVAL_POLLS === 0) {
        runWatchdogCheck().catch(() => { /* never let a watchdog error kill the poll loop */ });
    }

    setTimeout(poll, 1000);
}

async function main() {
    await acquireSingleInstanceLock();
    console.log('[*] Ziggy Local Executor (simple runner) active and listening...');
    poll();
}

main().catch(console.error);
