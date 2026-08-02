<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Quota Calculation & Sync Rules

When working on quota calculations, tracking, parsing, or proxy interception logic, you MUST follow these constraints:

1. **Window Classification Invariant**:
   * The **5-Hour Limit** can *never* exceed a 5-hour reset window ($5 / 24 = 0.208$ days).
   * The **Weekly Limit** starts at 7 days and decreases as the week progresses. Late in the week, its reset delay can drop below 36 hours.
   * To classify buckets from the local language server (which only provides a `resetTime` date), use the constant `MIN_WEEKLY_RESET_DAYS = 0.5` (12 hours).
   * Any reset time greater than 12 hours is guaranteed to be a Weekly limit.

2. **Database Null-Preservation Rule**:
   * If a local language server scan returns `null` for a pool's 5-hour limit (e.g. no candidate models are active in the response), do *not* backfill it using the weekly limit or default it to a fake value (like `1.0` or `0`). 
   * Leave it as `null` so that the merge layer preserves the last known-good remote or cached 5-hour limit.

3. **MITM Proxy Interception Path Gates**:
   * The MITM proxies intercept traffic directed to `cloudcode-pa.googleapis.com`.
   * You MUST maintain explicit path checks to bypass token-swapping for quota/metadata requests (specifically `/v1internal:loadCodeAssist` and `/v1internal:retrieveUserQuotaSummary`) to prevent duplicate account quota pollution in the database.

4. **Change Maintenance**:
   * Every time you modify or fix quota parsing, calculation, or synchronization logic, you MUST document it by appending a new entry to the historical log: `docs/quota_issues_history.md` following its template.

5. **Daemon Rebuild & Restart Rule**:
   * The dashboard runs as a background service/daemon. Editing source files does *not* automatically update the running app.
   * Every time you complete codebase changes (such as fixing a bug or implementing a feature), you MUST run `bash setup-daemon.sh --yes` to rebuild Next.js, migrate the database, and restart the background daemon process so changes take effect immediately.

---

## ⚠️ CRITICAL: Two Separate Instances — Do NOT Confuse Them

This repository (`antigravity-dashboard/`) is the **source code** only. It is **NOT** what runs locally or on the server.

| | Local running instance | Server running instance |
|---|---|---|
| **Location** | `~/.multigravity-elysium/` | `/home/unigate/apps/multigravity-elysium/` |
| **Port** | `39281` | `39281` (localhost on server) |
| **Database** | `~/.multigravity-elysium/prisma/dev.db` | `/home/unigate/apps/multigravity-elysium/prisma/dev.db` |
| **Env** | `~/.multigravity-elysium/.env.local` | `/home/unigate/apps/multigravity-elysium/.env.local` |
| **Process** | node PID on port 39281 (`lsof -i :39281`) | PM2 app `multigravity-elysium` |

### What this means for agents

- **NEVER** query `antigravity-dashboard/prisma/dev.db` to inspect live accounts. It is a stale development database with ~8 accounts and does not reflect reality.
- **ALWAYS** query the real DB at `~/.multigravity-elysium/prisma/dev.db` locally, or via `curl http://localhost:39281/api/accounts` (with BypassSandbox).
- The real account count as of 2026-08-02 is **14 accounts**, all `Google AI Pro`, all healthy.
- To query the **server** DB: `ssh-unigate.sh "curl -s http://localhost:39281/api/accounts"`.

### Credential migration (local → server)

To sync fresh credentials after re-authenticating expired accounts:
1. **Export**: `curl -X POST http://localhost:39281/api/accounts/export -d '{"password":"<pw>"}'`
2. **Import on server** with upsert: `ssh-unigate.sh "curl -X POST http://localhost:39281/api/accounts/import -d '{\"bundle\":\"...\",\"password\":\"<pw>\",\"upsert\":true}'"` 
3. **Restart**: `ssh-unigate.sh "pm2 restart multigravity-elysium"`

The import route supports `upsert: true` which **updates** refresh tokens for existing accounts (instead of skipping them) — critical for fixing `invalid_grant` errors after token expiry.



