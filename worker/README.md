# handoff worker

The short-URL service behind a handoff: a single Cloudflare Worker + one KV namespace.
Stores a markdown handoff doc, returns a short URL, serves **raw markdown to agents** and a
**rendered page to humans**. Runs comfortably on the Cloudflare free tier.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/` | Create. Body = markdown. Returns the short URL (plain text), or JSON with `Accept: application/json`. |
| `GET` | `/<slug>` | Raw markdown (`text/markdown`, `nosniff`) — for agents. |
| `GET` | `/<slug>?view` | Rendered HTML (CSP-locked) — for humans. |
| `GET` | `/<slug>.md` | Raw markdown (alias). |
| `DELETE` | `/<slug>` | Delete; requires header `X-Delete-Key` (returned at creation). |

Create options: `?ttl=<seconds>` or `X-TTL` (clamped to 60s–1yr, default 30d);
`X-Skip-Scan: 1` or `?skipscan` to bypass the server-side secret scan.

```bash
# publish
URL=$(curl -s --data-binary @handoff.md https://YOUR-DOMAIN/)
# read (agent)        curl "$URL"
# read (human)        open "$URL?view"
```

## Deploy

```bash
npm install

# 1. create the KV namespace, paste the printed id into wrangler.toml (id = "...")
npx wrangler kv namespace create HANDOFFS

# 2. deploy
npx wrangler deploy

# 3. custom domain: add the zone to Cloudflare, then uncomment the [[routes]]
#    block in wrangler.toml (pattern = "your-domain", custom_domain = true) and re-deploy.
```

## Local dev

```bash
npm run dev          # http://127.0.0.1:8787 — KV is simulated locally, no id needed
```

## Notes / roadmap
- Secret scan is conservative (mirrors `skills/share-handoff/publish.sh`); opt out per-request.
- The rendered view sets a strict CSP (no scripts) so a malicious handoff can't run JS in a viewer's browser.
- Not yet: rate limiting, burn-after-read, password-protected pastes, image/attachment support.
