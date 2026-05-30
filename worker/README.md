# handoff worker

The short-URL service behind a handoff: a single Cloudflare Worker + KV (capsule bodies) + D1
(feedback threads). Stores a markdown handoff doc, returns a short URL, serves **raw markdown
to agents** and a **rendered page to humans**, and collects **typed feedback** that the
originating agent can pull back in. Runs comfortably on the Cloudflare free tier.

## API

**Capsule**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/` | Create. Body = markdown. Returns the short URL (plain text), or JSON with `Accept: application/json`. |
| `GET` | `/<slug>` | Raw markdown (`text/markdown`, `nosniff`) — for agents. |
| `GET` | `/<slug>?view` | Rendered HTML (CSP-locked) — for humans; includes the feedback thread + reply form. |
| `GET` | `/<slug>.md` | Raw markdown (alias). |
| `DELETE` | `/<slug>` | Delete capsule (and its feedback); requires header `X-Delete-Key` (returned at creation). |

**Feedback** — kinds: `question · correction · approval · concern · idea · impl_note · comment`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/<slug>/feedback` | Add a reply. Form body → `303` back to `?view#fb`; JSON `{kind,body,author?,contact?}` → `201 {id,kind,created}`. |
| `GET` | `/<slug>/feedback` | List replies as JSON (default), or a markdown digest with `?format=md` / `Accept: text/markdown`. |
| `DELETE` | `/<slug>/feedback/<id>` | Owner-only soft-hide; requires the capsule's `X-Delete-Key`. |

`contact` (optional "notify me" handle) is private — returned only to the capsule owner
(send `X-Delete-Key`), never in public lists or the markdown digest.

Create options: `?ttl=<seconds>` or `X-TTL` (clamped to 60s–1yr, default 30d);
`X-Skip-Scan: 1` or `?skipscan` to bypass the server-side secret scan.

```bash
# publish
URL=$(curl -s --data-binary @handoff.md https://YOUR-DOMAIN/)
# read (agent)        curl "$URL"
# read (human)        open "$URL?view"
# reply (agent)       curl -X POST "$URL/feedback" -H 'content-type: application/json' \
#                          -d '{"kind":"correction","body":"step 3 is stale"}'
# pull replies back   curl "$URL/feedback?format=md"
```

## Deploy

```bash
npm install

# 1. create the KV namespace, paste the printed id into wrangler.toml (id = "...")
npx wrangler kv namespace create HANDOFFS

# 2. create the D1 database for feedback, paste its id into wrangler.toml,
#    then apply the schema (local for `npm run dev`, remote for production):
npx wrangler d1 create handoff-db
npx wrangler d1 execute handoff-db --local  --file=schema.sql
npx wrangler d1 execute handoff-db --remote --file=schema.sql

# 3. deploy
npx wrangler deploy

# 4. custom domain: add the zone to Cloudflare, then uncomment the [[routes]]
#    block in wrangler.toml (pattern = "your-domain", custom_domain = true) and re-deploy.
```

## Local dev

```bash
npm run dev          # http://127.0.0.1:8787 — KV + D1 are simulated locally, no ids needed
```

## Notes / roadmap
- Secret scan is conservative (mirrors `skills/share-handoff/publish.sh`); opt out per-request.
- Feedback is **rate-limited** (20 replies/hour per hashed IP per capsule), capped at 8 KiB, and
  rendered as **escaped plain text** (never through the markdown renderer) so a reply can't inject HTML.
- The rendered view sets a strict CSP: scripts only run from one per-response nonce (the copy
  buttons), forms post only to this origin — so a malicious handoff or reply can't run JS in a viewer's browser.
- Not yet: burn-after-read, password-protected pastes, image/attachment support, push notifications for `contact`.
