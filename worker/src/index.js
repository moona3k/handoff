/**
 * handoff — a short-URL service for portable AI agent context handoffs.
 *
 * Routes:
 *   POST   /              body = markdown handoff doc  -> { url, view_url, delete_key }
 *   GET    /<slug>        -> raw markdown   (for agents; text/markdown, nosniff)
 *   GET    /<slug>?view   -> rendered HTML  (for humans; CSP-locked)
 *   GET    /<slug>.md     -> raw markdown   (alias)
 *   DELETE /<slug>        + header X-Delete-Key  -> delete
 *   GET    /              -> landing page
 *
 * Create options (query param or header):
 *   ttl=<seconds> | X-TTL        expiry, clamped to [60, 31536000], default 30 days
 *   skipscan      | X-Skip-Scan  bypass the server-side secret scan
 *   Accept: application/json     -> JSON response instead of bare URL text
 *
 * Storage: a single KV namespace bound as HANDOFFS (value = markdown,
 * metadata = { created, deleteKeyHash, bytes }).
 */

import { marked } from 'marked';

// Unambiguous base-57 alphabet (no 0/O/1/l/I) for human-friendly slugs.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SLUG_LEN = 6;
const DEFAULT_TTL = 60 * 60 * 24 * 30; // 30 days
const MIN_TTL = 60; // KV minimum expirationTtl
const MAX_TTL = 60 * 60 * 24 * 365; // 1 year
const MAX_BYTES = 1024 * 1024; // 1 MiB — handoffs should be summaries, not dumps

const SECRET_PATTERNS = [
  /(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|client[_-]?secret|bearer)["' ]*[:=][ "']*[A-Za-z0-9/_+-]{16,}/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (pathname === '/') {
      if (method === 'POST') return cors(await handleCreate(request, env, url));
      if (method === 'GET' || method === 'HEAD') return landing(url);
      return text('method not allowed', 405);
    }
    if (pathname === '/health') return text('ok', 200);
    if (pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n', 200);
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });

    const slug = pathname.slice(1).replace(/\.md$/, '');
    if (!isSlug(slug)) return notFound();

    if (method === 'DELETE') return handleDelete(slug, request, env);
    if (method !== 'GET' && method !== 'HEAD') return text('method not allowed', 405);

    const { value, metadata } = await env.HANDOFFS.getWithMetadata(slug);
    if (value === null) return notFound();

    if (url.searchParams.has('view')) return renderView(slug, value, metadata, url);

    return cors(
      new Response(method === 'HEAD' ? null : value, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'public, max-age=60',
        },
      }),
    );
  },
};

async function handleCreate(request, env, url) {
  const body = await readBody(request);
  if (!body) return text('empty body', 400);

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BYTES) return text(`payload too large: ${bytes} bytes (max ${MAX_BYTES})`, 413);

  const skip = request.headers.get('x-skip-scan') === '1' || url.searchParams.has('skipscan');
  if (!skip) {
    const hits = scanSecrets(body);
    if (hits.length) {
      return text(
        'Possible secrets detected — not stored. Redact, or resend with header `X-Skip-Scan: 1`:\n' +
          hits.join('\n'),
        422,
      );
    }
  }

  const ttl = clampTtl(url.searchParams.get('ttl') ?? request.headers.get('x-ttl'));
  const slug = await uniqueSlug(env);
  const deleteKey = randomToken(16);
  const metadata = {
    created: new Date().toISOString(),
    deleteKeyHash: await sha256hex(deleteKey),
    bytes,
  };
  await env.HANDOFFS.put(slug, body, { expirationTtl: ttl, metadata });

  const link = `${url.origin}/${slug}`;
  const payload = {
    url: link,
    raw_url: link,
    view_url: `${link}?view`,
    slug,
    delete_key: deleteKey,
    bytes,
    expires_in: ttl,
  };

  const extraHeaders = { 'x-delete-key': deleteKey, 'x-view-url': payload.view_url };
  if ((request.headers.get('accept') || '').includes('application/json')) {
    return json(payload, 201, extraHeaders);
  }
  // Default: bare URL on stdout so `URL=$(curl ...)` just works.
  return new Response(link + '\n', {
    status: 201,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders },
  });
}

async function handleDelete(slug, request, env) {
  const { value, metadata } = await env.HANDOFFS.getWithMetadata(slug);
  if (value === null) return notFound();
  const key = request.headers.get('x-delete-key') || '';
  if (!key || !metadata || (await sha256hex(key)) !== metadata.deleteKeyHash) {
    return text('invalid or missing X-Delete-Key', 403);
  }
  await env.HANDOFFS.delete(slug);
  return text('deleted', 200);
}

// --- helpers -----------------------------------------------------------------

async function readBody(request) {
  // Treat the request body as the raw paste, like paste.rs/c-net — this is what
  // `curl --data-binary @file` sends (with a urlencoded content-type, which we ignore).
  // Only multipart/form-data is parsed as fields, for `-F content=@file` convenience.
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const v = form.get('content') ?? form.get('file') ?? form.get('f') ?? form.get('paste') ?? '';
    return (typeof v === 'string' ? v : '').trim();
  }
  return (await request.text()).trim();
}

function isSlug(s) {
  return /^[A-Za-z0-9]{3,32}$/.test(s);
}

function randomToken(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

async function uniqueSlug(env) {
  for (let i = 0; i < 5; i++) {
    const slug = randomToken(SLUG_LEN);
    if ((await env.HANDOFFS.get(slug)) === null) return slug;
  }
  return randomToken(SLUG_LEN + 2); // extremely unlikely fallback
}

function clampTtl(raw) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(Math.max(n, MIN_TTL), MAX_TTL);
}

function scanSecrets(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (SECRET_PATTERNS.some((re) => re.test(line))) {
      hits.push(`  line ${i + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
  return hits;
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cors(resp) {
  resp.headers.set('access-control-allow-origin', '*');
  resp.headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  resp.headers.set('access-control-allow-headers', 'content-type, x-ttl, x-skip-scan, x-delete-key, accept');
  return resp;
}

function text(body, status = 200, headers = {}) {
  return new Response(body + (body.endsWith('\n') ? '' : '\n'), {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function notFound() {
  return text('not found — this handoff does not exist or has expired', 404);
}

// --- HTML --------------------------------------------------------------------

const CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: #1a1a1a; background: #fafafa; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #161616; } }
.wrap { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
.bar { display: flex; gap: 12px; align-items: center; font-size: 13px; opacity: .7;
  margin-bottom: 28px; padding-bottom: 14px; border-bottom: 1px solid rgba(128,128,128,.25); }
.bar a { color: inherit; }
.brand { font-weight: 700; letter-spacing: -.02em; opacity: 1; margin-right: auto; }
.md h1,.md h2,.md h3 { line-height: 1.25; letter-spacing: -.01em; margin: 1.6em 0 .5em; }
.md h1 { font-size: 1.8em; } .md h2 { font-size: 1.4em; padding-bottom: .2em;
  border-bottom: 1px solid rgba(128,128,128,.2); }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
  background: rgba(128,128,128,.16); padding: .15em .4em; border-radius: 4px; }
.md pre { background: rgba(128,128,128,.12); padding: 14px 16px; border-radius: 8px;
  overflow: auto; } .md pre code { background: none; padding: 0; }
.md blockquote { margin: 1em 0; padding: .2em 1em; border-left: 3px solid rgba(128,128,128,.4);
  opacity: .85; } .md table { border-collapse: collapse; } .md td,.md th {
  border: 1px solid rgba(128,128,128,.3); padding: 6px 10px; }
.md a { color: #2f6feb; } pre.cli { background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow:auto }
`;

function htmlShell(title, inner) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">${inner}</div></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } },
  );
}

function renderView(slug, md, metadata, url) {
  const rawUrl = `${url.origin}/${slug}`;
  const created = metadata?.created ? new Date(metadata.created).toISOString().slice(0, 16).replace('T', ' ') : '';
  const bodyHtml = marked.parse(md);
  const bar = `<div class="bar"><span class="brand">handoff</span>
    <span>${created ? created + ' UTC' : ''}</span>
    <a href="${escapeHtml(rawUrl)}">raw&nbsp;↧</a></div>`;
  return htmlShell(`handoff · ${slug}`, bar + `<article class="md">${bodyHtml}</article>`);
}

function landing(url) {
  const host = url.host;
  const inner = `
    <div class="bar"><span class="brand">handoff</span><span>portable AI agent context handoff</span></div>
    <article class="md">
      <h1>handoff</h1>
      <p>Turn an AI agent session into a short URL. Send it to a colleague — or their agent, in
      any harness — so they can pick up exactly where you left off. Free, open source, no lock-in.</p>
      <h2>Publish</h2>
      <pre class="cli">curl --data-binary @handoff.md https://${host}/</pre>
      <p>Returns a short URL like <code>https://${host}/aB3dE</code>. Options:
      <code>?ttl=&lt;seconds&gt;</code> to set expiry, header <code>X-Skip-Scan: 1</code> to bypass the
      secret scan, <code>Accept: application/json</code> for a JSON response with a delete key.</p>
      <h2>Read</h2>
      <pre class="cli"># agents (raw markdown)
curl https://${host}/aB3dE

# humans (rendered)
open https://${host}/aB3dE?view</pre>
      <h2>What it does for you</h2>
      <ul>
        <li>Short URLs · raw markdown for agents, rendered view for humans</li>
        <li>Server-side secret scan (rejects obvious keys/tokens unless you opt out)</li>
        <li>Expiring by default · delete key returned at creation</li>
        <li>Self-hostable on the Cloudflare free tier</li>
      </ul>
      <p><a href="https://github.com/moona3k/handoff">Source &amp; the handoff doc schema on GitHub →</a></p>
    </article>`;
  return htmlShell('handoff — portable AI agent context handoff', inner);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
