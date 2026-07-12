# Contributing to Multigravity Elysium

First off — thanks for taking the time to contribute! This is a small personal project, but PRs and issues are welcome.

## Before You Start

- Check the [open issues](https://github.com/mbl9898/multigravity-elysium/issues) to see if your idea or bug is already tracked.
- For large changes, open an issue first to discuss the approach before investing time in code.

## Getting Set Up

```bash
git clone https://github.com/mbl9898/multigravity-elysium.git
cd multigravity-elysium
npm install
cp .env.local.example .env.local
# Fill in ENCRYPTION_KEY and NEXT_PUBLIC_APP_URL in .env.local
npx prisma generate
npx prisma migrate dev
npm run dev
```

The dev server starts on [http://localhost:39281](http://localhost:39281).

## Code Style

- **TypeScript strict mode** — no `any`, no `@ts-ignore` without a comment explaining why.
- **Lint before pushing**: `npm run lint` must pass with zero errors.
- **Type check**: `npx tsc --noEmit` must pass.
- Components go in `src/components/`, API logic goes in `src/lib/`, route handlers in `src/app/api/`.

## Pull Request Checklist

- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` completes successfully
- [ ] No secrets or personal data in the diff
- [ ] PR description explains *what* changed and *why*

## What We Accept

✅ Bug fixes  
✅ Performance improvements  
✅ Better error handling  
✅ Documentation improvements  
✅ New AI platform integrations (if the quota API structure is compatible)  
✅ UI/UX improvements  

❌ Features that add external network calls to non-Google services  
❌ Multi-user / authentication layers (out of scope for a personal tool)  
❌ Breaking changes to the database schema without a migration  

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add weekly quota trend chart
fix: correct 5-hour reset countdown calculation
docs: update setup instructions for Linux
chore: bump prisma to 7.1
```

## Questions?

Open a [GitHub Discussion](https://github.com/mbl9898/multigravity-elysium/discussions) — issues are for bugs and feature requests only.
