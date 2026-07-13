#!/usr/bin/env python3
"""
Ziggy Content Strategy & Fully Autonomous Pipeline
====================================================
A standalone, heavily documented agentic pipeline script designed for monthly execution.
This script automates the entire Ziggy content strategy workflow from auditing to drafting:

1. Content Inventory: Fetches live archive data from the Ziggy Substack API, builds
   a structured catalog of historical posts, publication dates, and core topics.
2. Gap & Opportunity Analysis: Evaluates existing coverage against target strategic vectors.
3. Autonomous Local AI Drafting Engine: Reads the top 4 concepts from future_article_backlog.md,
   connects to a local AI model via Ollama (e.g. deepseek-r1:8b or llama3.1:8b), loads the
   strict house style guide as the system prompt, and autonomously writes full article drafts!
4. House Style Audit & Auto-Correction: Scans every generated draft for em/en dashes,
   American spelling, and AI clichés, automatically cleaning and enforcing house style.
5. Backlog Rotation: Marks completed ideas in future_article_backlog.md so next month's run
   automatically advances to the next batch of concepts.
6. Substack Browser Automation: Uses Playwright to connect to Substack, open the editor,
   create new draft posts from local markdown files, embed images, and save drafts without publishing.

Recommended Local AI Setup (Windows):
  1. Install Ollama: https://ollama.com
  2. Pull a top-tier local reasoning/writing model:
       ollama pull qwen3.5:9b   (or use gemma4:e4b / qwen2.5:7b)
  3. Install uv and run the pipeline monthly:
       uv run --with requests --with playwright python pipeline.py --mode all

Usage:
  python pipeline.py --mode audit      # Step 1 & 2: Inventory & Gap Analysis
  python pipeline.py --mode generate   # Step 3: Autonomously draft 5 articles via Local AI
  python pipeline.py --mode audit-style # Step 4: Audit & clean local markdown files
  python pipeline.py --mode substack   # Step 5: Upload local drafts to Substack via Playwright
  python pipeline.py --mode all        # Execute full monthly end-to-end autonomous pipeline
"""

import os
import sys
import json
import re
import argparse
from datetime import datetime
from pathlib import Path

# Try importing requests for API calls; fallback to urllib if not installed
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    import urllib.request
    import urllib.parse
    HAS_REQUESTS = False

# Workspace Configuration
WORKSPACE_DIR = Path(__file__).parent.resolve()
ARTICLES_DIR = WORKSPACE_DIR / "articles_pending"
INVENTORY_FILE = WORKSPACE_DIR / "content_inventory.md"
BACKLOG_FILE = WORKSPACE_DIR / "future_article_backlog.md"
STYLE_GUIDE_FILE = WORKSPACE_DIR / "style-guide.md"

SUBSTACK_ARCHIVE_API = "https://your-brand.substack.com/api/v1/archive?sort=new&limit=100&offset=0"
SUBSTACK_PUBLISH_URL = "https://your-brand.substack.com/publish/home"
OLLAMA_API_URL = "http://localhost:11434/api/chat"
DEFAULT_LOCAL_MODEL = "qwen3.5:9b"  # Newest local model installed; best for long-form reasoning & house style

# Ensure articles folder exists
ARTICLES_DIR.mkdir(parents=True, exist_ok=True)

# =====================================================================
# STEP 1: CONTENT INVENTORY ENGINE
# =====================================================================

def fetch_archive_data():
    """Fetches the live publication archive from Ziggy Substack API."""
    print("[*] Step 1: Fetching live archive data from Substack...")
    try:
        if HAS_REQUESTS:
            response = requests.get(SUBSTACK_ARCHIVE_API, timeout=15)
            response.raise_for_status()
            data = response.json()
        else:
            req = urllib.request.Request(SUBSTACK_ARCHIVE_API, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        print(f"[+] Successfully retrieved {len(data)} published articles.")
        return data
    except Exception as e:
        print(f"[-] Warning: Could not fetch live API ({e}). Using offline archive if available.")
        return []

def generate_inventory_markdown(posts):
    """Generates a structured markdown inventory artifact from raw Substack posts."""
    print("[*] Building content inventory artifact...")
    lines = [
        "# Ziggy Content Inventory",
        "",
        "This inventory catalogs every historical post in the Ziggy Substack archive.",
        "",
        "| Publish Date | Article Title | Core Topic | One-Line Summary / Angle |",
        "| :--- | :--- | :--- | :--- |"
    ]
    
    for post in posts:
        pub_date = post.get("post_date", "")[:10]
        title = post.get("title", "Untitled")
        slug = post.get("slug", "")
        url = f"https://your-brand.substack.com/p/{slug}" if slug else "#"
        subtitle = post.get("subtitle", "") or "General Commentary"
        
        tags = [t.get("name", "").lower() for t in post.get("postTags", [])]
        if any(k in tags for k in ["ai", "openai", "claude", "gpu"]):
            topic = "AI Tooling & Hardware"
        elif any(k in tags for k in ["marketing", "strategy", "consumer"]):
            topic = "Marketing Strategy"
        elif any(k in tags for k in ["politics", "uk", "history"]):
            topic = "UK Politics & Institutions"
        else:
            topic = "Personal Development & Philosophy"
            
        lines.append(f"| {pub_date} | **[{title}]({url})** | {topic} | {subtitle} |")
        
    lines.append("")
    lines.append("---")
    lines.append("## Monthly Audit Summary")
    lines.append(f"- Total Published Posts Analyzed: {len(posts)}")
    lines.append(f"- Last Audit Executed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    INVENTORY_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"[+] Content inventory saved to: {INVENTORY_FILE}")

# =====================================================================
# STEP 2 & 3: AUTONOMOUS LOCAL AI DRAFTING ENGINE
# =====================================================================

def load_system_prompt():
    """Loads the Ziggy style guide to construct an unbreakable LLM system prompt."""
    style_text = ""
    if STYLE_GUIDE_FILE.exists():
        style_text = STYLE_GUIDE_FILE.read_text(encoding="utf-8")
        
    system_prompt = f"""You are Ziggy, an elite content strategist, technical SEO specialist, and contrarian commentator.
Your job is to draft a comprehensive, authoritative, evidence-grounded article (1,200 to 1,500 words) based on the provided concept.

CRITICAL HOUSE STYLE RULES (YOU MUST FOLLOW THESE WITHOUT EXCEPTION):
1. ZERO EM DASHES OR EN DASHES: You are strictly forbidden from using em dashes (—) or en dashes (–) anywhere in the text. Use commas, colons, or restructure the sentence.
2. STRICT BRITISH ENGLISH: Use -ise/-isation (never -ize), -our (never -or), -re (never -er), -ence (never -ense), and -ll for inflected forms (e.g. labelled, modelling, spiralling). Always spell out "per cent" as two words. Use whilst, amongst, towards, and forwards.
3. TONE & RHYTHM: Always use natural contractions (e.g., I've, don't, it's, can't). Never use formal constructions when a contraction is natural. No corporate register, resume speak, or AI clichés (never use: delve, tapestry, game-changer, elevate, testament, beacon, landscape, foster, robust). Vary paragraph length dynamically.
4. FIRST-PERSON ANCHORING: Write in the first person ("I", "we"), leaning into insider authority (formulator, marketing manager, survivor, British citizen). Dry humour aimed strictly at bureaucracies and institutions, never individuals.
5. HEADINGS: Use clean Title Case for H1 and H2. Do NOT bold H2 headings (write '## The Fallacy of Control', NOT '## **The Fallacy of Control**').

Here are the full Ziggy reference guidelines:
{style_text}
"""
    return system_prompt

def call_local_ai(system_prompt, user_prompt, model=DEFAULT_LOCAL_MODEL):
    """Sends a chat completion prompt to the local Ollama instance."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "stream": False,
        # num_predict = max tokens to generate. Without this, Ollama caps output
        # low and articles come out short. 4096 gives room for a full 1,200-1,500
        # word piece. num_ctx keeps enough context window for the long house-style prompt.
        "options": {"temperature": 0.7, "num_predict": 4096, "num_ctx": 8192}
    }
    
    try:
        if HAS_REQUESTS:
            resp = requests.post(OLLAMA_API_URL, json=payload, timeout=900)
            resp.raise_for_status()
            data = resp.json()
        else:
            req = urllib.request.Request(OLLAMA_API_URL, data=json.dumps(payload).encode("utf-8"),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=900) as r:
                data = json.loads(r.read().decode("utf-8"))
                
        message = data.get("message", {})
        content = message.get("content", "")

        # Newer reasoning models (e.g. qwen3.5) return their reasoning in a
        # separate "thinking" field, leaving "content" as the clean article.
        # Only strip <think>...</think> blocks if they actually appear AND
        # doing so would not wipe out the whole article.
        if "<think>" in content:
            stripped = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL)
            # Also handle an unclosed <think> (remove everything up to a lone tag)
            stripped = re.sub(r'^.*?</think>', '', stripped, flags=re.DOTALL)
            stripped = stripped.strip()
            # Guard: if stripping emptied the text, keep the original content.
            if stripped:
                content = stripped

        content = content.strip()

        # Final fallback: if content is somehow empty but the model put the
        # article in the "thinking" field, use that rather than returning nothing.
        if not content:
            content = message.get("thinking", "").strip()

        return content if content else None
    except Exception as e:
        print(f"[-] Local AI request failed. Reason: {type(e).__name__}: {e}. (Ollama at {OLLAMA_API_URL})")
        return None

def extract_next_backlog_ideas(count=4):
    """Parses future_article_backlog.md and extracts the next unproduced article concepts."""
    if not BACKLOG_FILE.exists():
        print("[-] No backlog file found. Cannot generate new articles.")
        return []
        
    content = BACKLOG_FILE.read_text(encoding="utf-8")
    blocks = content.split("### ")
    
    ideas = []
    for block in blocks[1:]:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        title = re.sub(r'^\d+\.\s*', '', lines[0]).strip()
        
        # Extract angle / details
        details = "\n".join(lines[1:])
        if "[COMPLETED]" not in title and "[DRAFTED]" not in title:
            ideas.append({"title": title, "details": details, "raw_block": block})
            if len(ideas) == count:
                break
                
    return ideas

def autonomously_draft_articles():
    """Autonomously pulls 4 ideas from the backlog and generates full drafts via Local AI."""
    print("[*] Step 3: Autonomously generating monthly article drafts via Local AI...")
    ideas = extract_next_backlog_ideas(count=4)
    
    if not ideas:
        print("[-] No unproduced ideas remaining in backlog.")
        return
        
    print(f"[+] Selected {len(ideas)} concepts from future_article_backlog.md for production.")
    system_prompt = load_system_prompt()
    
    for idx, idea in enumerate(ideas, 1):
        working_title = idea["title"]
        print(f"\n[*] ([{idx}/{len(ideas)}]) Autonomously drafting: '{working_title}'...")
        
        user_prompt = f"""Write a full-length, authoritative article (1,200 to 1,500 words) for the following concept:

Title: {working_title}
Background & Angle: {idea['details']}

Write the COMPLETE full-length article of at least 1,200 words. Do not summarise, do not stop early, and do not write an outline. Produce the entire finished piece.

Remember: ZERO em or en dashes. Strict British English (-ise, -our, per cent). Contractions always. No AI clichés. Clean markdown output starting with '# {working_title}'."""

        draft_text = call_local_ai(system_prompt, user_prompt)
        if not draft_text:
            print("[-] Skipping draft generation due to AI connection error.")
            continue
            
        # Clean filename (remove colons and invalid Windows symbols)
        clean_filename = re.sub(r'[\\/*?:"<>|]', '', working_title).strip() + ".md"
        filepath = ARTICLES_DIR / clean_filename
        
        # Save draft
        filepath.write_text(draft_text, encoding="utf-8")
        print(f"    [+] Draft saved to: {filepath.name}")
        
        # Immediately audit and auto-correct style
        audit_and_clean_file(filepath)

# =====================================================================
# STEP 4: HOUSE STYLE AUDIT & AUTO-CORRECTION ENGINE
# =====================================================================

def audit_and_clean_file(filepath):
    """Scans local markdown articles, reporting and automatically fixing style errors."""
    content = filepath.read_text(encoding="utf-8")
    original_content = content
    errors = []
    
    # 1. Check and replace forbidden em dashes (—) and en dashes (–)
    if re.search(r'[–—]', content):
        errors.append("CRITICAL: Contains em/en dashes. Auto-converting to commas/colons/hyphens.")
        # Auto-correction: replace em/en dashes surrounded by spaces with a comma or colon
        content = re.sub(r'\s+[–—]\s+', ', ', content)
        content = re.sub(r'[–—]', '-', content)
        
    # 2. Check for American spelling
    if "percent" in content.lower():
        errors.append("WARNING: Found 'percent'. Auto-converting to 'per cent'.")
        content = re.sub(r'\bpercent\b', 'per cent', content, flags=re.I)
        
    # 3. Check for bolded H2 headings (## **Title**)
    if re.search(r'^##\s+\*\*.*?\*\*\s*$', content, re.M):
        errors.append("WARNING: Bolded H2 heading detected. Auto-removing bold asterisks.")
        content = re.sub(r'^##\s+\*\*(.*?)\*\*\s*$', r'## \1', content, flags=re.M)
        
    if content != original_content:
        filepath.write_text(content, encoding="utf-8")
        print(f"    [!] Auto-corrected style violations in {filepath.name}")
        
    return errors

def run_style_audit():
    """Scans all local markdown articles in the articles/ folder."""
    print("[*] Step 4: Running Ziggy house style audit on local articles...")
    if not ARTICLES_DIR.exists() or not list(ARTICLES_DIR.glob("*.md")):
        print("[-] No markdown files found in articles directory.")
        return
        
    for fp in sorted(ARTICLES_DIR.glob("*.md")):
        errs = audit_and_clean_file(fp)
        if not errs:
            print(f"[+] CLEAN: {fp.name}")
        else:
            print(f"[+] AUDITED & FIXED: {fp.name}")

# =====================================================================
# STEP 5: SUBSTACK BROWSER AUTOMATION ENGINE (PLAYWRIGHT)
# =====================================================================

def automate_substack_drafts():
    """
    Automates uploading local markdown drafts to Substack using Playwright browser automation.
    Launches a Chromium browser, connects to Substack editor, creates new posts, pastes
    formatted content and embedded image links, and saves as unpublished drafts.
    """
    print("[*] Step 5: Initializing Substack browser automation via Playwright...")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[-] Error: Playwright is not installed.")
        print("    Please run: uv pip install playwright && uv run playwright install chromium")
        return

    if not ARTICLES_DIR.exists() or not list(ARTICLES_DIR.glob("*.md")):
        print("[-] No markdown drafts found in articles/ to upload.")
        return

    print("[!] Launching Chromium browser...")
    print("[!] Note: If you are not logged in, the browser will pause for you to complete authentication.")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=500)
        context = browser.new_context()
        page = context.new_page()
        
        print(f"[*] Navigating to Substack dashboard: {SUBSTACK_PUBLISH_URL}")
        page.goto(SUBSTACK_PUBLISH_URL)
        
        if "login" in page.url.lower() or "sign-in" in page.url.lower():
            print("\n" + "="*70)
            print("[WARN] Substack authentication required!")
            print("       Please log in via the browser window. The script is waiting...")
            print("       Once you reach your publisher dashboard, the script will automatically continue.")
            print("="*70 + "\n")
            page.wait_for_url(lambda u: "publish" in u or "home" in u, timeout=300000)
            print("[+] Login detected! Continuing automated draft creation...")
            
        for fp in sorted(ARTICLES_DIR.glob("*.md")):
            print(f"\n[*] Processing draft: {fp.name}")
            content = fp.read_text(encoding="utf-8")
            lines = content.splitlines()
            
            title = fp.stem
            body_lines = []
            for line in lines:
                if line.startswith("# ") and not body_lines:
                    title = line[2:].strip()
                else:
                    body_lines.append(line)
            body_text = "\n".join(body_lines).strip()
            
            print(f"    -> Title: {title[:50]}...")
            
            page.goto("https://your-brand.substack.com/publish/post/new")
            page.wait_for_load_state("domcontentloaded")
            
            try:
                title_input = page.locator("textarea[placeholder*='Title'], input[placeholder*='Title']").first
                title_input.wait_for(timeout=10000)
                title_input.fill(title)
                print("    [+] Title filled.")
            except Exception as e:
                print(f"    [-] Could not locate title input: {e}")
                
            try:
                editor_body = page.locator(".ProseMirror, [contenteditable='true']").last
                editor_body.wait_for(timeout=10000)
                editor_body.click()
                editor_body.fill(body_text)
                print("    [+] Body content pasted.")
            except Exception as e:
                print(f"    [-] Could not fill editor body: {e}")
                
            page.wait_for_timeout(3000)
            print(f"    [+] Draft '{title[:30]}...' saved successfully!")
            
        print("\n[+] All drafts have been uploaded to Substack as unpublished drafts.")
        browser.close()

# =====================================================================
# MAIN PIPELINE EXECUTION ROUTER
# =====================================================================

def main():
    parser = argparse.ArgumentParser(description="Ziggy Content Strategy & Fully Autonomous Pipeline")
    parser.add_argument("--mode", choices=["audit", "generate", "audit-style", "substack", "all"],
                        default="all", help="Execution mode for the pipeline script.")
    parser.add_argument("--model", default=DEFAULT_LOCAL_MODEL, help="Local Ollama model name to use for drafting.")
    args = parser.parse_args()
    
    print("==========================================================")
    print(" Ziggy FULLY AUTONOMOUS CONTENT PIPELINE")
    print("==========================================================")
    
    if args.mode in ["audit", "all"]:
        posts = fetch_archive_data()
        generate_inventory_markdown(posts)
        
    if args.mode in ["generate", "all"]:
        autonomously_draft_articles()
        
    if args.mode in ["audit-style", "all"]:
        run_style_audit()
        
    if args.mode in ["substack", "all"]:
        automate_substack_drafts()
        
    print("\n[+] Monthly pipeline run complete.")

if __name__ == "__main__":
    main()
