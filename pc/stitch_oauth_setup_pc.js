// One-time authorization — run this ON YOUR PC (not the Droplet), since
// this flow needs a browser and a local callback server on the SAME
// machine. Opens a tiny local server, gives you a URL to visit, catches
// Google's redirect, and prints a refresh token for you to send to the
// Droplet.
//
// Usage: node stitch_oauth_setup_pc.js
// Then open the printed URL in your normal browser and approve.

const http = require('http');

const CLIENT_ID = "YOUR_OAUTH_CLIENT_ID_HERE";
const CLIENT_SECRET = "YOUR_OAUTH_CLIENT_SECRET_HERE";
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
        res.end("Authorization failed: " + error + ". You can close this tab.");
        console.error("\n[!] Google returned an error:", error);
        server.close();
        return;
    }
    if (!code) {
        res.end("Waiting for authorization...");
        return;
    }

    res.end("Authorized! You can close this tab and go back to the terminal.");
    server.close();

    try {
        console.log("\n[*] Exchanging the authorization code for tokens...");
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenRes.json();
        if (!tokenRes.ok || !tokens.refresh_token) {
            console.error("[!] Token exchange failed:", JSON.stringify(tokens));
            return;
        }

        console.log("\n" + "=".repeat(70));
        console.log("SUCCESS. Save this JSON block as stitch-oauth-token.json on your Droplet:");
        console.log("=".repeat(70));
        console.log(JSON.stringify({
            refresh_token: tokens.refresh_token,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        }, null, 2));
        console.log("=".repeat(70));
    } catch (e) {
        console.error("[!] Error during token exchange:", e.message);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',   // needed to get a refresh token, not just a short-lived one
        prompt: 'consent'         // forces a fresh refresh token even if you've authorized before
    }).toString();

    console.log("=".repeat(70));
    console.log("OPEN THIS URL IN YOUR BROWSER:");
    console.log(authUrl);
    console.log("=".repeat(70));
    console.log("\n[*] Waiting for you to approve in the browser...");
});
