# Changelog

All notable changes to Multigravity Elysium are documented here.

This project follows [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).

---

## [0.1.1] — 2026-07-12

### 🐛 Bug Fixes

#### `fix(local-ls): Anthropic 5-hour quota showing 100% when no IDE model is active`
- **Root cause**: When the local language server scan found no Claude/GPT model configs (because no Anthropic model was open in an IDE window), `remaining5h` defaulted to `1.0` (100% remaining). This fake value was then merged on top of the real remote API value, overwriting the actual usage percentage.
- **Fix**: Removed the `?? 1.0` fallback in `local_ls.ts`. When no configs are found for a pool, `remaining5h` stays `null` — the merge logic already correctly treats `null` as "no local data, keep the remote value".

#### `fix(local-ls): Local language server quota data silently failing (sync lag)`
- **Root cause**: The Antigravity language server runs its local API over **HTTPS** (with a self-signed certificate). The dashboard was querying it over plain **HTTP**, resulting in a `400 Bad Request: Client sent an HTTP request to an HTTPS server` error on every poll cycle. This meant the dashboard never received real-time local quota data and always fell back to the slower, cached remote API.
- **Fix**: Updated `queryUserStatus` in `local_ls.ts` to try HTTPS first (`rejectUnauthorized: false` for local self-signed certs) with a soft HTTP fallback, matching the actual protocol the language server uses.

#### `fix(setup): Fully automated setup-daemon.sh — no more manual churn`
- **Root cause**: `setup-daemon.sh` had three critical gaps: (1) it blindly overwrote the production database with an empty workspace placeholder, erasing all accounts; (2) it did not clean up the old `com.antigravity.quota-dashboard` Launch Agent, causing port `39281` conflicts and restart loops; (3) it used `npx next start` which spawned an untracked process wrapper, breaking launchd's PID supervision.
- **Fix**:
  - Added smart database migration logic: preserves an existing populated target DB, migrates from the old daemon folder if available, and syncs back to the source directory.
  - Added automatic port `39281` cleanup before loading the new agent.
  - Added automatic unloading and disabling of the old conflicting Launch Agent.
  - Changed `start.sh` to run `node node_modules/next/dist/bin/next start` directly so launchd tracks the correct PID and `KeepAlive` works properly.
  - Added `npx prisma migrate deploy` to the setup pipeline so the database schema is always applied fresh after a build.

---

## [0.1.0] — 2026-07-12

### 🎉 Initial Public Release

#### Features
- **Multi-account dashboard** — Connect any number of Google accounts; each gets a live quota card refreshed every 60 seconds
- **Gemini + Anthropic quota tracking** — Separate progress bars for both AI pools
- **5-Hour and Weekly windows** — Distinct bars and reset countdowns for both quota windows
- **Weekly Exhausted state** — Red indicator with countdown to Monday reset
- **Health status dots** — Per-account liveness indicator (healthy / degraded / error)
- **Ping button** — Manually triggers the 5-hour countdown window for any account; dot shows ping state (active / expired / failed / never)
- **Antigravity V2 integration** *(optional)* — "Activate in V2" button switches the active IDE account; pulsing "V2 Active" badge on the current account
- **Secure Google OAuth login** — PKCE (S256) flow; refresh tokens encrypted at rest with AES-256-GCM
- **Background scheduler** — `node-cron` polls quota data every 60 seconds without browser interaction
- **macOS daemon setup** — `setup-daemon.sh` installs a LaunchAgent for auto-start on login
- **Chat interface** — Bonus page for multi-account AI chat (experimental)

#### Tech Stack
- Next.js 16 (App Router) · React 19 · TypeScript 5
- Tailwind CSS v4 · shadcn/ui · Lucide React
- TanStack Query v5 · Prisma 7 · SQLite
- AES-256-GCM encryption · Google OAuth 2.0 + PKCE

#### Security
- No credentials stored in plain text
- Refresh tokens encrypted with a user-generated `ENCRYPTION_KEY`
- Access tokens kept in server memory only — never persisted
- `.env.local` and database files gitignored
