---
handoff_schema_version: "1.0"
created_at: "2026-05-29T14:30:00Z"
created_by: "claude-code"
project: "my-api-refactor"
repo: "https://github.com/org/repo"
branch: "feat/refactor-auth"
commit: "a3f9c12"
---

# Handoff: replace JWT auth with session tokens

## Mission
Replace JWT auth with server-side session tokens because JWT revocation is unreliable in
our setup (we can't invalidate a token before it expires). Goal: a user can log in, hit a
protected route, and log out — and logout must immediately invalidate the session.

## Current State
- `src/auth/jwt.ts` deleted.
- `src/auth/session.ts` created with core logic (not yet wired into the app).
- `auth.test.ts` currently failing (expected — nothing is wired up).
- Migration `0042_session_table.sql` written but NOT yet run.

## Completed Steps
1. Audited all JWT call sites — 7 files, listed in `docs/jwt-callsites.md`.
2. Chose `express-session` + Redis as the store (see Key Decisions).
3. Wrote session middleware in `src/auth/session.ts`.
4. Updated `src/middleware/auth.ts` to use the new session check.

## Immediate Next Steps
1. Run the migration: `npm run db:migrate`.
2. Wire `session.ts` into `app.ts` (replace lines 34–41).
3. Update the 7 call sites in `docs/jwt-callsites.md`.
4. Fix the failing tests in `auth.test.ts`.
5. Manual smoke test: login → protected route → logout.

## Key Decisions / ADRs
- **Session store: Redis via `connect-redis`.** Rationale: already in our infra, low ops cost.
- **Cookies:** `httpOnly`, `sameSite: strict`, `secure` in prod.
- **Rejected:** Passport.js (too much abstraction for our needs); staying on JWT (the whole point).

## Constraints and Rules
- Node 18 only.
- Do not touch `src/legacy/` — frozen pending a separate project.
- Exported functions need JSDoc.

## Relevant Files
- `src/auth/session.ts` — the new implementation.
- `src/middleware/auth.ts:12` — where the session check is invoked.
- `docs/jwt-callsites.md` — the 7 files still to update.

## Environment and Commands
```bash
npm install
cp .env.example .env   # set REDIS_URL and SESSION_SECRET
npm run dev            # :3000
npm test               # jest
```

## Open Questions
- Session expiry: 24h or 7d? Product hasn't decided.
- Redis connection pooling not tuned — may need work under load.

## Context Scratchpad
Saw on first run: `Error: Redis client must be connected before calling .connect()`.
Fixed by awaiting `client.connect()` before passing it to the store — do not revert this.
