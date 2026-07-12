# Security Policy

## Scope

Multigravity Elysium is a **local-only, personal monitoring tool**. It has no public-facing servers, no user accounts, and no multi-tenant surface. The attack surface is limited to:

- The local Next.js HTTP server (default: `localhost:39281`)
- Encrypted refresh tokens stored in a local SQLite database
- The `ENCRYPTION_KEY` in your `.env.local`

If you expose this dashboard publicly (e.g., behind an Nginx proxy), you are responsible for adding your own authentication layer.

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public GitHub issue.**

Instead, report it privately via:

1. **GitHub Private Vulnerability Reporting** (preferred):
   Go to [Security → Report a vulnerability](https://github.com/mbl9898/multigravity-elysium/security/advisories/new) and submit a private advisory.

2. **Email**: Open a GitHub Discussion mentioning you have a private security matter and request contact details.

Please include:
- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fix (optional but appreciated)

## Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within **48 hours** |
| Assessment | Within **7 days** |
| Fix + Release | Within **30 days** (depending on severity) |

## Known Limitations

- This tool uses **undocumented Google API endpoints** (`cloudcode-pa.googleapis.com`). These may change without notice and are outside the scope of security guarantees.
- The built-in OAuth client credentials are the same public native-app credentials used by the Antigravity IDE itself. They are not secret.
- Token encryption is only as strong as your `ENCRYPTION_KEY`. Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it safe.
