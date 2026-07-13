/**
 * Ziggy Autonomous Organic Notes Campaign & Telegram Publishing Scheduler
 * =========================================================================
 * Adheres strictly to the STAR Marketing Framework (created by David Chadderton) and Ziggy Editorial Standards:
 * - Targets Socialisers, Thinkers, Adventurers, and Realists.
 * - Enforces zero dashes, British English, and no banned vocabulary.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'campaign_state.json');
const ARTICLES_DIR = path.join(__dirname, 'articles_drafted');

const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const ALLOWED_USER_ID = 0; // YOUR_TELEGRAM_USER_ID_HERE — replace 0 with your real numeric Telegram ID

async function sendTelegramNotification(text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = {
        chat_id: ALLOWED_USER_ID,
        text: text,
        parse_mode: 'Markdown'
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        console.log('[+] Sent Telegram notification.');
    } catch (e) {
        console.error('[-] Telegram send error:', e.message);
    }
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function sanitizeLinguisticStandards(text) {
    let clean = text
        .replace(/[—–]/g, ', ') // Zero em/en dashes under any circumstances
        .replace(/,\s*,/g, ',')
        .replace(/it could be argued that /gi, '')
        .replace(/game-changer/gi, 'structural shift')
        .replace(/impactful/gi, 'effective')
        .replace(/delve into/gi, 'examine')
        .replace(/delve/gi, 'examine')
        .replace(/it's worth noting that /gi, '')
        .replace(/needless to say, /gi, '')
        .replace(/at the end of the day, /gi, '');
    return clean.trim();
}

/**
 * Generates 2 to 4 organic, authoritative Notes matching STAR mindsets.
 */
function generateOrganicCampaign(articleTitle) {
    const noteCount = randomInt(2, 4);
    console.log(`[*] Generating organic campaign with ${noteCount} Notes mapped to STAR mindsets...`);

    const cleanTitle = sanitizeLinguisticStandards(articleTitle);

    const notePool = [
        {
            type: "Personal Spark",
            targetMindset: "Socialiser & Adventurer",
            text: `I spent this morning reviewing setups around "${cleanTitle}" and noticed the exact same blind spot across three different operations. No hesitation. No little disclaimer. No internal alarm bell. Everyone just copies the default template.`
        },
        {
            type: "Counter-Intuitive Observation",
            targetMindset: "Thinker & Realist",
            text: `A quick look at ${cleanTitle}: most standard guidance relies on assumptions from two to three years ago. Operators spend thousands on tools to solve a problem that disappears the moment you inspect the underlying inputs (usually right around the time the quarterly invoice arrives).`
        },
        {
            type: "Authoritative Insight",
            targetMindset: "Thinker & Realist",
            text: `If your workflow relies on standard shortcuts here, you are already behind. Long-term durability comes from owning your infrastructure and understanding the mechanics rather than leasing a black box.`
        },
        {
            type: "Audience Question",
            targetMindset: "Socialiser & Adventurer",
            text: `Curious how other operators handle this: when evaluating your own pipeline around ${cleanTitle}, what is the single biggest operational bottleneck you encounter?`
        }
    ];

    const selectedNotes = notePool.slice(0, noteCount).map(n => ({
        ...n,
        text: sanitizeLinguisticStandards(n.text)
    }));

    const scheduledNotes = [];
    let currentDayOffset = 0.0;

    for (let i = 0; i < selectedNotes.length; i++) {
        if (i > 0) {
            currentDayOffset += randomFloat(0.75, 1.5);
        } else {
            currentDayOffset = randomFloat(0.01, 0.15);
        }

        scheduledNotes.push({
            id: i + 1,
            type: selectedNotes[i].type,
            targetMindset: selectedNotes[i].targetMindset,
            text: selectedNotes[i].text,
            scheduledDayOffset: parseFloat(currentDayOffset.toFixed(2)),
            posted: false,
            postedAt: null
        });
    }

    const finalNoteDay = scheduledNotes[scheduledNotes.length - 1].scheduledDayOffset;
    const reminderDayOffset = parseFloat((finalNoteDay + randomFloat(0.75, 1.0)).toFixed(2));

    return {
        noteCount: noteCount,
        notes: scheduledNotes,
        reminderDayOffset: reminderDayOffset
    };
}

async function runSchedulerCycle() {
    console.log(`\n[*] Ziggy Organic Campaign Scheduler - ${new Date().toISOString()}`);

    let state = { active_campaign: null, completed_campaigns: [] };
    if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }

    if (!state.active_campaign) {
        if (!fs.existsSync(ARTICLES_DIR)) return;
        const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md'));
        // Only consider articles that haven't had a campaign yet.
        const candidates = files.filter(f => !state.completed_campaigns.includes(f));

        if (candidates.length === 0) {
            console.log('[-] All articles have completed their organic Notes campaigns.');
            return;
        }

        // Pick RANDOMLY (not alphabetically) so the posting order has no
        // detectable pattern.
        const unteased = candidates[Math.floor(Math.random() * candidates.length)];

        const title = path.basename(unteased, '.md');
        const plan = generateOrganicCampaign(title);

        state.active_campaign = {
            article_file: unteased,
            article_title: title,
            started_at: Date.now(),
            note_count: plan.noteCount,
            notes: plan.notes,
            reminder_day_offset: plan.reminderDayOffset,
            reminder_sent: false
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        console.log(`[+] Created new ${plan.noteCount}-Note organic campaign for: "${title}"`);
    }

    const campaign = state.active_campaign;
    const daysElapsed = (Date.now() - campaign.started_at) / (1000 * 60 * 60 * 24);

    console.log(`[*] Active Campaign: "${campaign.article_title}" (${daysElapsed.toFixed(2)} days elapsed)`);

    for (const note of campaign.notes) {
        if (!note.posted && daysElapsed >= note.scheduledDayOffset) {
            console.log(`[!] Sending Note #${note.id}/${campaign.note_count} (${note.type}) to Telegram`);
            console.log(`    "${note.text}"`);

            // Send the actual note text to Telegram so you can copy and paste it
            // straight into Substack Notes. The text is in its own code block for
            // easy one-tap copying on mobile.
            const noteMsg =
                `📝 *Note ${note.id} of ${campaign.note_count}* — ready to post\n` +
                `_Campaign: ${campaign.article_title}_\n` +
                `_Style: ${note.type} • Audience: ${note.targetMindset}_\n\n` +
                `Copy and paste this into Substack Notes:\n\n` +
                "```\n" + note.text + "\n```";
            await sendTelegramNotification(noteMsg);

            note.posted = true;
            note.postedAt = Date.now();
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }
    }

    // 1. If a finished campaign is waiting for the user to confirm they published,
    //    do nothing further. Everything pauses here until they tap the button.
    if (state.active_campaign && state.active_campaign.awaiting_publish_confirm) {
        console.log('[*] Waiting for you to confirm the article was published. Paused.');
        return;
    }

    const allPosted = campaign.notes.every(n => n.posted);
    if (allPosted && !campaign.reminder_sent && daysElapsed >= campaign.reminder_day_offset) {
        console.log('[!] All organic Notes sent. Sending publish reminder with confirm button...');

        const msg = `🚀 *Time to Publish Your Article!*\n\nI've sent you all *${campaign.note_count} teaser Notes* for this campaign to post on Substack. Now the article itself is ready:\n\n📰 *${campaign.article_title}*\n\n👉 Head to your Substack Drafts tab and hit *Publish*, then tap the button below to move on to the next campaign.`;

        // Send with a tappable confirm button. The BOT handles the tap and clears
        // the campaign; the article_file is embedded so the bot knows which one.
        await sendTelegramNotification(msg, {
            inline_keyboard: [[
                { text: "✅ Published — next campaign", callback_data: "pubdone" }
            ]]
        });

        // Enter the waiting state. Do NOT clear the campaign or start a new one yet.
        campaign.reminder_sent = true;
        campaign.awaiting_publish_confirm = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
}

if (require.main === module) {
    runSchedulerCycle();
}

module.exports = { runSchedulerCycle, sanitizeLinguisticStandards };
