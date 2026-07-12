# Changelog

All notable changes to Multigravity Elysium are documented here.

This project follows [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).

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
