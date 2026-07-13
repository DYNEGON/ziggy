#!/usr/bin/env node
/**
 * Ziggy Backlog Research
 * ==========================
 * Run daily by cron. Checks how many un-drafted ideas remain in
 * future_article_backlog.md; if it's running low, researches new ones
 * using Gemini with real-time Google Search grounding — split between
 * genuine content gaps (cross-checked against what's already published)
 * and early-stage trends (before they peak, so Ziggy is first out).
 *
 * Nothing gets added automatically — proposed ideas are sent to Telegram
 * with an Approve/Discard button. The bot (telegram_bot.js) handles the
 * button tap and writes to Drive only on approval.
 */

const { execSync } = require('child_process');
const fs = require('fs');

const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const ALLOWED_USER_ID = 0; // YOUR_TELEGRAM_USER_ID_HERE — replace 0 with your real numeric Telegram ID
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";
const RESEARCH_MODEL = "gemini-3.1-flash-lite"; // reliable free-tier daily limit
const LOW_THRESHOLD = 2; // trigger research when 2 or fewer un-drafted ideas remain
const IDEAS_TO_PROPOSE = 6;
const STATE_FILE = "/root/Ziggy/backlog_research_state.json";
const PENDING_FILE = "/root/Ziggy/pending_backlog_proposal.json"; // read by the bot on approval

function rcloneCat(remotePath) {
    try {
        return execSync(`rclone cat "${remotePath}"`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
        return null;
    }
}

function countRemainingIdeas(content) {
    const blocks = content.split('### ');
    let count = 0;
    for (const block of blocks.slice(1)) {
        const firstLine = (block.split('\n')[0] || '').trim();
        if (!firstLine.includes('[COMPLETED]') && !firstLine.includes('[DRAFTED]')) count++;
    }
    return count;
}

async function sendTelegramMessage(text, extra = {}) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ALLOWED_USER_ID, text, parse_mode: 'Markdown', ...extra })
    });
}

async function researchNewIdeas(inventoryContent, backlogContent) {
    const prompt =
        "You are a content strategist researching new article ideas for a Substack newsletter " +
        "([YOUR-BRAND] — covers AI/tech, supplement industry insider knowledge, marketing/GEO strategy, " +
        "and UK institutional commentary, written by a formulator and marketer). " +
        "Below is what's already been published and what's already queued — do NOT repeat these topics.\n\n" +
        `ALREADY PUBLISHED:\n${(inventoryContent || 'none available').slice(0, 6000)}\n\n` +
        `ALREADY QUEUED:\n${(backlogContent || 'none').slice(0, 3000)}\n\n` +
        `Using real, current web search, find ${IDEAS_TO_PROPOSE} new article ideas, split into two kinds:\n` +
        "1. GAP ideas — genuine angles nobody in this space is covering well right now.\n" +
        "2. TREND ideas — something rising but NOT yet mainstream/peaked, so being early matters. " +
        "Explicitly look for the earliest real signal, not something already saturated in headlines.\n\n" +
        "Reply with ONLY raw JSON, no markdown fences, in exactly this format:\n" +
        '{"ideas": [{"title": "...", "details": "the angle, why it matters, why now", "type": "gap"|"trend"}]}';

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${RESEARCH_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }]
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API error');
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.ideas || !Array.isArray(parsed.ideas) || parsed.ideas.length === 0) {
        throw new Error("Gemini didn't return any ideas");
    }
    return parsed.ideas;
}

async function main() {
    console.log("[*] Checking backlog...");
    const backlogContent = rcloneCat("gdrive:Ziggy/future_article_backlog.md");
    if (backlogContent === null) {
        console.log("[-] Couldn't read the backlog file — aborting.");
        return;
    }

    const remaining = countRemainingIdeas(backlogContent);
    console.log(`[*] ${remaining} un-drafted idea(s) remaining.`);

    if (remaining > LOW_THRESHOLD) {
        console.log("[+] Plenty remaining — nothing to do.");
        return;
    }

    // Don't re-propose if a proposal is already sitting unanswered.
    if (fs.existsSync(PENDING_FILE)) {
        console.log("[*] A proposal is already pending approval — skipping this run.");
        return;
    }

    console.log("[*] Backlog running low — researching new ideas...");
    const inventoryContent = rcloneCat("gdrive:Ziggy/content_inventory.md");
    const ideas = await researchNewIdeas(inventoryContent, backlogContent);

    fs.writeFileSync(PENDING_FILE, JSON.stringify({ ideas, proposedAt: new Date().toISOString() }));

    const lines = ideas.map((idea, i) => {
        const tag = idea.type === 'trend' ? '📈 TREND' : '🔍 GAP';
        return `*${i + 1}. ${idea.title}* _(${tag})_\n${idea.details}`;
    });

    await sendTelegramMessage(
        `📋 *Backlog running low (${remaining} left)* — here's what I found:\n\n${lines.join('\n\n')}`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Add all to backlog", callback_data: "addbacklog" },
                    { text: "❌ Discard", callback_data: "discardbacklog" }
                ]]
            }
        }
    );

    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastProposedAt: new Date().toISOString() }));
    console.log("[+] Proposal sent to Telegram, awaiting approval.");
}

main().catch(e => {
    console.error("[!] Backlog research failed:", e.message);
});
