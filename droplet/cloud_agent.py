import asyncio
import os
import secrets
import time
import aiohttp
from aiohttp import web
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

BOT_TOKEN = os.environ.get("BOT_TOKEN", "YOUR_TELEGRAM_BOT_TOKEN_HERE")
ALLOWED_USER_ID = 0  # YOUR_TELEGRAM_USER_ID_HERE — replace 0 with your real numeric Telegram ID
SAFEWORD = "YOUR_SAFEWORD_HERE"  # pick your own — this must NEVER be a guessable word

# Shared secret required on every request. Without this, the relay port is open
# to the entire internet (confirmed: `ufw status` showed no firewall active),
# and behind it sits an agent capable of reading/writing/executing on this
# server. This is a real access control, not the safeword prompt rule
# (which only guides the AI's behaviour — it isn't a security boundary).
RELAY_SECRET = os.environ.get("RELAY_SECRET", "YOUR_RELAY_SECRET_HERE")
RELAY_PORT = 3000  # change if you like — telegram_bot.js and local_executor.js must use the same value

def check_auth(request):
    """Returns True if the request carries the correct secret header."""
    token = request.headers.get("X-Auth-Token", "")
    return secrets.compare_digest(token, RELAY_SECRET)

async def send_telegram_message(text: str):
    """Sends a message back to the Telegram user."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": ALLOWED_USER_ID,
        "text": text,
        "parse_mode": "Markdown"
    }
    async with aiohttp.ClientSession() as session:
        try:
            await session.post(url, json=payload)
        except Exception as e:
            print(f"[-] Telegram Send Error: {e}")

local_command_queue = []
last_pc_seen = None  # timestamp of the PC's most recent successful poll — used by /check

async def handle_agent_request(request):
    if not check_auth(request):
        return web.Response(status=401, text="Unauthorized")
    try:
        data = await request.json()
        message_text = data.get("message", "").strip()
        if not message_text:
            return web.Response(text="Empty message")

        print(f"[+] Received prompt: {message_text}")

        # --- COMMAND RELAY FOR PC ---
        if message_text.lower().startswith("/local"):
            command = message_text[6:].strip()
            local_command_queue.append(command)
            await send_telegram_message(f"📡 *Queued for PC:* `{command}`\n(Waiting for PC to connect...)")
            return web.Response(text="Queued for local executor")

        # --- CLOUD AGENT ---
        # 1. Model Selection
        model_name = "gemini-3.5-flash"
        if "USE PRO" in message_text.upper():
            model_name = "gemini-3.1-pro"
            message_text = message_text.replace("USE PRO", "").strip()

        await send_telegram_message(f"🧠 *Jules Cloud Agent Waking Up...*\nModel: `{model_name}`")

        # 3. Spawn the Agent and Execute
        config = LocalAgentConfig(
            system_instructions=(
                "You are an autonomous cloud developer running on a Linux Droplet. "
                "You have full capabilities to read, write, and execute commands. "
                f"CRITICAL RULE: You MUST NOT delete any files, directories, or databases UNLESS "
                f"the user's prompt explicitly includes the exact word '{SAFEWORD}'. "
                "If they ask to delete something without this word, refuse and remind them."
            ),
            capabilities=CapabilitiesConfig(),
            model=model_name
        )

        async with Agent(config) as agent:
            asyncio.create_task(run_agent_task(agent, message_text))

        return web.Response(text="Processing started")

    except Exception as e:
        print(f"[-] Handler Error: {e}")
        return web.Response(status=500, text=str(e))

async def handle_get_local(request):
    """Endpoint for the Windows PC to poll for /local commands."""
    global last_pc_seen
    if not check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    last_pc_seen = time.time()  # the PC is polling right now, so it's clearly on
    if not local_command_queue:
        return web.json_response({"command": None})

    command = local_command_queue.pop(0)
    return web.json_response({"command": command})

async def handle_pc_status(request):
    """Tells the bot whether the PC is currently online, based on how
    recently it last polled (it polls roughly once a second when on)."""
    if not check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    if last_pc_seen is None:
        return web.json_response({"online": False, "seconds_ago": None})
    seconds_ago = time.time() - last_pc_seen
    # Poll interval is ~1s; anything under 8s of silence is still "online" —
    # gives room for a slow network hiccup without a false "offline" report.
    return web.json_response({"online": seconds_ago < 8, "seconds_ago": round(seconds_ago, 1)})

async def handle_local_output(request):
    """Endpoint for the Windows PC to send execution results back to Telegram."""
    if not check_auth(request):
        return web.Response(status=401, text="Unauthorized")
    try:
        data = await request.json()
        output = data.get("output", "")
        if output:
            await send_telegram_message(f"💻 *PC Output:*\n```text\n{output[:3800]}\n```")
        return web.Response(text="Output relayed")
    except Exception as e:
        return web.Response(status=500, text=str(e))

async def run_agent_task(agent, prompt):
    """Executes the agent task in the background and sends the final output to Telegram."""
    try:
        response = await agent.chat(prompt)
        full_text = ""
        async for token in response:
            full_text += token

        max_len = 3900
        if not full_text:
            full_text = "*(Agent finished execution but returned no text)*"

        for i in range(0, len(full_text), max_len):
            chunk = full_text[i:i+max_len]
            await send_telegram_message(chunk)

    except Exception as e:
        await send_telegram_message(f"❌ *Agent Error:* {e}")

async def init_app():
    app = web.Application()
    app.router.add_post('/send', handle_agent_request)
    app.router.add_get('/get_local', handle_get_local)
    app.router.add_get('/pc_status', handle_pc_status)
    app.router.add_post('/send_local', handle_local_output)
    return app

if __name__ == '__main__':
    if RELAY_SECRET == "YOUR_RELAY_SECRET_HERE":
        print("[!] WARNING: RELAY_SECRET is still the placeholder — every request will be rejected until it's set.")
    print(f"[*] Jules Cloud Agent Server starting on port {RELAY_PORT}...")
    web.run_app(init_app(), host='0.0.0.0', port=RELAY_PORT)
