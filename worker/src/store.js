/**
 * store.js — core capsule + feedback operations and shared helpers.
 *
 * The HTTP routes (index.js) and the MCP tools (mcp.js) both call into here, so
 * the security rules live in exactly ONE place: secret scan on create, feedback
 * size cap, rate-limit, owner-key checks, and the contact-is-owner-only rule.
 *
 * These functions are transport-agnostic: they take `env` + plain args and return
 * plain data or a small string/`{error}` status. Response/HTML building stays in
 * index.js; MCP content shaping stays in mcp.js.
 */

// Unambiguous base-57 alphabet (no 0/O/1/l/I) for human-friendly slugs/keys.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const SLUG_LEN = 6;
export const DEFAULT_TTL = 60 * 60 * 24 * 30; // 30 days
export const MIN_TTL = 60; // KV minimum expirationTtl
export const MAX_TTL = 60 * 60 * 24 * 365; // 1 year
export const MAX_BYTES = 1024 * 1024; // 1 MiB — handoffs are summaries, not dumps
export const MAX_FEEDBACK_BYTES = 8 * 1024; // 8 KiB per reply
export const RATE_LIMIT_PER_HOUR = 20; // replies per hashed-IP per capsule per hour
// `comment` first => default-selected dropdown option and validation fallback.
export const FEEDBACK_KINDS = ['comment', 'question', 'correction', 'approval', 'concern', 'idea', 'impl_note'];

const SECRET_PATTERNS = [
  /(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|client[_-]?secret|bearer)["' ]*[:=][ "']*[A-Za-z0-9/_+-]{16,}/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

// --- shared helpers ----------------------------------------------------------

export function isSlug(s) {
  return /^[A-Za-z0-9]{3,32}$/.test(s);
}

export function clip(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function randomToken(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function clampTtl(raw) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(Math.max(n, MIN_TTL), MAX_TTL);
}

export function normalizeKind(k) {
  k = (typeof k === 'string' ? k : '').trim().toLowerCase();
  return FEEDBACK_KINDS.includes(k) ? k : 'comment';
}

export function scanSecrets(text) {
  const hits = [];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      if (SECRET_PATTERNS.some((re) => re.test(line))) {
        hits.push(`  line ${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  return hits;
}

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Does `key` hash to the capsule's stored delete-key hash? (owner proof)
export async function ownerKeyMatches(metadata, key) {
  if (!key || !metadata || !metadata.deleteKeyHash) return false;
  return (await sha256hex(key)) === metadata.deleteKeyHash;
}

async function uniqueSlug(env) {
  for (let i = 0; i < 5; i++) {
    const slug = randomToken(SLUG_LEN);
    if ((await env.HANDOFFS.get(slug)) === null) return slug;
  }
  return randomToken(SLUG_LEN + 2); // extremely unlikely fallback
}

// --- capsule operations ------------------------------------------------------

/**
 * Create a capsule. Returns one of:
 *   { slug, deleteKey, bytes, ttl, created }
 *   { error: 'empty' } | { error: 'toolarge', bytes } | { error: 'secrets', hits }
 */
export async function createCapsule(env, { body, ttl, skipScan = false }) {
  body = (typeof body === 'string' ? body : '').trim();
  if (!body) return { error: 'empty' };

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BYTES) return { error: 'toolarge', bytes };

  if (!skipScan) {
    const hits = scanSecrets(body);
    if (hits.length) return { error: 'secrets', hits };
  }

  const finalTtl = clampTtl(ttl);
  const slug = await uniqueSlug(env);
  const deleteKey = randomToken(16);
  const created = new Date().toISOString();
  await env.HANDOFFS.put(slug, body, {
    expirationTtl: finalTtl,
    metadata: { created, deleteKeyHash: await sha256hex(deleteKey), bytes },
  });
  return { slug, deleteKey, bytes, ttl: finalTtl, created };
}

// Returns { markdown, metadata } or null.
export async function getCapsule(env, slug) {
  const { value, metadata } = await env.HANDOFFS.getWithMetadata(slug);
  if (value === null) return null;
  return { markdown: value, metadata };
}

// Returns 'ok' | 'notfound' | 'forbidden'. Also clears the capsule's feedback.
export async function deleteCapsule(env, slug, key) {
  const { value, metadata } = await env.HANDOFFS.getWithMetadata(slug);
  if (value === null) return 'notfound';
  if (!(await ownerKeyMatches(metadata, key))) return 'forbidden';
  await env.HANDOFFS.delete(slug);
  try {
    await env.DB.prepare('DELETE FROM feedback WHERE capsule = ?').bind(slug).run();
  } catch (_) {}
  return 'ok';
}

// --- feedback operations -----------------------------------------------------

/**
 * Add a reply. Returns:
 *   { id, kind, created }
 *   { error: 'notfound' } | { error: 'empty' } | { error: 'toolong' } | { error: 'ratelimited' }
 * Pass `ipHash` (sha256 of CF-Connecting-IP + slug) to enforce rate-limiting.
 */
export async function postFeedback(env, { slug, kind, body, author, contact, ipHash }) {
  const { value } = await env.HANDOFFS.getWithMetadata(slug);
  if (value === null) return { error: 'notfound' };

  kind = normalizeKind(kind);
  body = (typeof body === 'string' ? body : '').trim();
  author = clip(author, 80);
  contact = clip(contact, 200);

  if (!body) return { error: 'empty' };
  if (new TextEncoder().encode(body).length > MAX_FEEDBACK_BYTES) return { error: 'toolong' };

  if (ipHash) {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const rl = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created > ?')
      .bind(ipHash, since)
      .first();
    if ((rl?.n ?? 0) >= RATE_LIMIT_PER_HOUR) return { error: 'ratelimited' };
  }

  const id = randomToken(10);
  const created = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO feedback (id, capsule, kind, body, author, contact, created, ip_hash, hidden) VALUES (?,?,?,?,?,?,?,?,0)',
  )
    .bind(id, slug, kind, body, author || null, contact || null, created, ipHash || null)
    .run();
  return { id, kind, created };
}

// Ordered oldest-first. Excludes hidden unless includeHidden (owner view).
export async function listFeedback(env, slug, includeHidden = false) {
  const sql = includeHidden
    ? 'SELECT * FROM feedback WHERE capsule = ? ORDER BY created ASC'
    : 'SELECT * FROM feedback WHERE capsule = ? AND hidden = 0 ORDER BY created ASC';
  const { results } = await env.DB.prepare(sql).bind(slug).all();
  return results || [];
}

// Owner soft-hide of one reply. Returns 'ok' | 'notfound' | 'forbidden'.
export async function hideFeedback(env, slug, fid, key) {
  const { value, metadata } = await env.HANDOFFS.getWithMetadata(slug);
  if (value === null) return 'notfound';
  if (!(await ownerKeyMatches(metadata, key))) return 'forbidden';
  await env.DB.prepare('UPDATE feedback SET hidden = 1 WHERE id = ? AND capsule = ?').bind(fid, slug).run();
  return 'ok';
}

// Public projection of a feedback row (drops contact/ip_hash unless owner).
export function publicRow(r, owner) {
  const out = { id: r.id, kind: r.kind, body: r.body, author: r.author || null, created: r.created };
  if (owner) {
    out.contact = r.contact || null;
    out.hidden = !!r.hidden;
  }
  return out;
}

// Markdown digest for agent ingestion. Never includes contact.
export function feedbackMarkdown(slug, rows) {
  if (!rows.length) return `# Feedback for ${slug}\n\n_No feedback yet._\n`;
  const blocks = rows.map((r) => {
    const who = r.author ? ` by ${r.author}` : '';
    const when = r.created ? r.created.slice(0, 16).replace('T', ' ') + ' UTC' : '';
    return `## [${r.kind}]${who} — ${when}\n\n${r.body}\n`;
  });
  return `# Feedback for ${slug} (${rows.length})\n\n` + blocks.join('\n');
}
