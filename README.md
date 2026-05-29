# handoff

**Hand off an AI agent session to anyone, in one command.**

Turn the context of a coding-agent session into a short URL, send it to a colleague — or
their agent, in *any* harness (Claude Code, Codex, Cursor, Cline, Aider, …) — and they pick
up exactly where you left off. Free, open source, no lock-in.

```
you$  (in your agent)  "hand off this session"
      → https://ctxhop.dev/aB3dE

them$ (in their agent) "read https://ctxhop.dev/aB3dE and continue"
      → their agent fetches it and resumes
```

> Built because *standing* project context is solved (AGENTS.md) and cross-tool *memory* is
> workable (MCP), but portable **session handoff** had no simple, harness-independent answer.
> This is the small, boring, works-everywhere answer: a documented Markdown schema + a tiny
> publish/fetch flow + an optional self-hosted short-URL service.

## Three parts

| Part | What it is |
|---|---|
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | The **handoff document schema** — a tool-agnostic Markdown format any LLM can read cold. The portable core; useful on its own. |
| [`skills/`](skills/) | Two Claude Code skills: **`share-handoff`** (compose → secret-scan → publish → URL) and **`ingest-handoff`** (fetch → resume, treating content as data not commands). The `publish.sh` + schema also work from any other harness. |
| [`worker/`](worker/) | An optional **self-hosted short-URL service** (Cloudflare Worker + KV): branded short links, raw-for-agents + rendered-for-humans, expiry, server-side secret scan, delete keys. Free tier. |

You don't need the worker — `share-handoff` falls back to a **secret GitHub gist** or a
public **paste.rs** URL. The worker just gives you a branded link you own end to end.

## Quickstart (no infrastructure)

```bash
# install the skills into Claude Code
./scripts/install-skills.sh

# then, in any session:  "hand off this session"
#   → secret gist by default; --public-paste for a paste.rs link
```

## Quickstart (your own short domain)

```bash
cd worker
npm install
npx wrangler kv namespace create HANDOFFS   # paste id into wrangler.toml
npx wrangler deploy                          # add a custom domain in wrangler.toml
# then point the skills at it:
export HANDOFF_ENDPOINT=https://your-domain  # share-handoff now uses your service
```

## How publishing chooses a backend
`share-handoff`/`publish.sh` resolves in this order: explicit flag (`--gist` /
`--public-paste` / `--endpoint`) → `$HANDOFF_ENDPOINT` (your worker) → secret gist.

## Security
- **Secrets:** both the publish script and the worker scan for obvious keys/tokens and
  refuse to publish unless you opt out. Still: never put credentials in a handoff.
- **Prompt injection:** receivers treat a fetched handoff as *context, not instructions*.
- **Privacy:** prefer secret gists or your own worker for sensitive context; share links
  over trusted channels. The worker sets a strict CSP so a malicious doc can't run JS in a viewer's browser.

## License
MIT © 2026 moona3k
