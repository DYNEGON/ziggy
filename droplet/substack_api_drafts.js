const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARTICLES_DIR = path.join(__dirname, 'articles_pending');
// Where posted articles get moved to. Sibling of "articles" (not nested), so
// the pipeline never re-reads them. This Drive path syncs to the PC too.
const DRIVE_ARCHIVE = 'gdrive:Ziggy/articles_drafted';
const SID_FILE = path.join(__dirname, 'substack_sid.txt');
const USER_API_URL = 'https://your-brand.substack.com/api/v1/user';
const SUBSTACK_API_URL = 'https://your-brand.substack.com/api/v1/drafts';
const EXISTING_POSTS_URL = 'https://your-brand.substack.com/api/v1/drafts?limit=25';

// Helper to generate clean SEO metadata (<60 char title, 140 char meta description)
function generateSeoMetadata(title, bodyText) {
    // 1. Create SEO title (< 60 chars)
    let seoTitle = title;
    if (seoTitle.length > 58) {
        // Take part before colon or dash if available and concise
        const parts = seoTitle.split(/[:–—]/);
        if (parts[0] && parts[0].trim().length <= 58) {
            seoTitle = parts[0].trim();
        } else {
            seoTitle = seoTitle.substring(0, 56).trim() + '...';
        }
    }

    // 2. Create SEO Description (50-155 chars) from first paragraph
    const paragraphs = bodyText.split('\n\n').filter(p => p && !p.startsWith('#'));
    let firstPara = paragraphs[0] || '';
    firstPara = firstPara.replace(/[*#`]/g, '').trim();

    let seoDesc = firstPara;
    if (seoDesc.length > 152) {
        seoDesc = seoDesc.substring(0, 149).trim() + '...';
    } else if (seoDesc.length < 50) {
        seoDesc = `${title}: An authoritative breakdown and strategic guide.`;
    }

    return { seoTitle, seoDesc };
}


// Normalise a title for comparison: lowercase, collapse whitespace, trim.
// This makes matching forgiving of trivial case/spacing differences.
function normaliseTitle(t) {
    return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Fetch the set of titles already on Substack (both drafts and published).
async function fetchExistingTitles(sid) {
    const existing = new Set();
    try {
        const res = await fetch(EXISTING_POSTS_URL, {
            headers: { 'Cookie': `substack.sid=${sid}` }
        });
        if (!res.ok) {
            console.log(`[-] Could not fetch existing posts (status ${res.status}). Proceeding without dedup.`);
            return existing;
        }
        const data = await res.json();
        const posts = Array.isArray(data) ? data : (data.posts || []);
        for (const p of posts) {
            if (p.draft_title) existing.add(normaliseTitle(p.draft_title));
            if (p.title) existing.add(normaliseTitle(p.title));
        }
        console.log(`[+] Found ${existing.size} existing title(s) already on Substack (drafts + published).`);
    } catch (e) {
        console.log(`[-] Error fetching existing posts: ${e.message}. Proceeding without dedup.`);
    }
    return existing;
}

async function main() {
    console.log('[*] Substack Direct REST API Drafter (With Full SEO Optimization)');

    let sid = process.env.SUBSTACK_SID;
    if (!sid && fs.existsSync(SID_FILE)) {
        sid = fs.readFileSync(SID_FILE, 'utf8').trim();
    }

    if (!sid) {
        console.error('[-] Error: Missing Substack session ID (substack.sid).');
        return;
    }

    console.log('[*] Fetching Substack author ID...');
    let authorId = null;
    try {
        const uRes = await fetch(USER_API_URL, {
            headers: { 'Cookie': `substack.sid=${sid}` }
        });
        if (uRes.ok) {
            const uData = await uRes.json();
            authorId = uData.id;
            console.log(`[+] Found Author ID: ${authorId} (${uData.name || uData.email})`);
        }
    } catch (e) {
        console.log('[-] Could not fetch author ID:', e.message);
    }

    // Fetch titles already on Substack so we can skip duplicates.
    const existingTitles = await fetchExistingTitles(sid);

    if (!fs.existsSync(ARTICLES_DIR)) {
        console.error('[-] No articles folder found.');
        return;
    }

    const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md')).sort();
    console.log(`[*] Found ${files.length} local article file(s) to consider.`);

    let pushed = 0;
    let skipped = 0;

    for (const file of files) {
        const filePath = path.join(ARTICLES_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        let title = path.basename(file, '.md');
        const bodyLines = [];

        for (const line of lines) {
            if (line.startsWith('# ') && bodyLines.length === 0) {
                title = line.substring(2).trim();
            } else {
                bodyLines.push(line);
            }
        }
        const bodyText = bodyLines.join('\n').trim();

        // Skip if this title already exists on Substack (draft or published).
        if (existingTitles.has(normaliseTitle(title))) {
            console.log(`\n[=] SKIP (already on Substack): "${title.slice(0, 50)}..."`);
            skipped++;
            continue;
        }

        const { seoTitle, seoDesc } = generateSeoMetadata(title, bodyText);

        console.log(`\n[*] POST /api/v1/drafts -> "${title.slice(0, 50)}..."`);
        console.log(`    -> SEO Title (${seoTitle.length} chars): "${seoTitle}"`);
        console.log(`    -> SEO Desc  (${seoDesc.length} chars): "${seoDesc.slice(0, 70)}..."`);

        const bylines = authorId ? [{ id: authorId, is_guest: false }] : [];

        try {
            const res = await fetch(SUBSTACK_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `substack.sid=${sid}`
                },
                body: JSON.stringify({
                    draft_title: title,
                    draft_body: bodyText,
                    draft_subtitle: seoDesc,
                    search_engine_title: seoTitle,
                    search_engine_description: seoDesc,
                    draft_bylines: bylines,
                    type: 'newsletter'
                })
            });

            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                console.log(`    [+] SUCCESS! Draft & SEO metadata created instantly (ID: ${data.id || 'Saved'}).`);
                pushed++;

                // Move the posted article out of the folder so it is never re-pushed.
                // We use execFileSync with an ARGUMENT ARRAY (not a shell string), so
                // filenames with apostrophes, dashes, and spaces are passed verbatim
                // and never mangled by shell quoting. rclone moves it in Drive (which
                // syncs to the PC); then we remove the local Droplet copy.
                // If archiving fails, we warn but do not stop.
                try {
                    execFileSync('rclone', [
                        'moveto',
                        `gdrive:Ziggy/articles_pending/${file}`,
                        `${DRIVE_ARCHIVE}/${file}`
                    ], { stdio: 'pipe' });
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // remove local Droplet copy
                    console.log(`    [>] Moved to articles_drafted (now a Substack draft).`);
                } catch (archiveErr) {
                    const msg = (archiveErr.stderr ? archiveErr.stderr.toString() : archiveErr.message) || '';
                    console.log(`    [-] Warning: could not archive "${file}": ${msg.slice(0, 150)}`);
                }
            } else {
                const errText = await res.text();
                console.log(`    [-] API Error (${res.status}): ${errText}`);
            }
        } catch (err) {
            console.log(`    [-] Network Error: ${err.message}`);
        }
    }

    console.log(`\n[*] Done. Pushed ${pushed} new draft(s), skipped ${skipped} already on Substack.`);
}

main().catch(console.error);
