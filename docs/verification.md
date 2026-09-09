# Verification status — 10 September 2026

This page separates repeatable checks from live observations and pending external work. See the [architecture and reliability brief](reliability.md) for trust boundaries, execution state, and failure behavior.

## Repeatable checks

- `npm test`: 48 passed; the credential-gated Turso persistence test skipped.
- Turso credentials exported + `npm test`: 49/49 passed. Local fixtures stayed in local SQLite; the one remote test used random IDs, closed and reopened the database, verified encrypted credentials and owner-scoped state, then deleted its records.
- `npm run build`: TypeScript and the Vite production build passed.
- `npm audit --omit=dev`: zero known production dependency vulnerabilities.
- Real Gemini evaluation: 22/24 decisions correct (91.7%), above the 75% gate, with zero API/validation errors. Repair 8/8, no-change 8/8, clarify 6/8.
- Responsive interface checks previously passed at 1440, 768, 390, and 320 pixels without horizontal overflow or browser console errors.

## Live production observations

- `https://promiseguard-7yoq.onrender.com/` and `/api/health` returned HTTP 200.
- Responses included Content Security Policy, one-year HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
- Render reports one non-suspended Node web service on the free plan. Turso stores durable accounts, encrypted grants, settings, sessions, and run history across deploys.
- `/api/auth/providers` reports Google, GitHub, and Slack enabled. Each sign-in start endpoint returned a provider authorization URL with PKCE and its exact production HTTPS callback.
- A prior completed synthetic demonstration was independently read back from GitHub, Notion, and Slack without sending another repair.
- Controlled GitHub recovery discarded an accepted comment ID, found exactly one matching provider record, and independently verified [comment 5610265017](https://github.com/Webghost01-NG/promiseguard-demo/issues/1#issuecomment-5610265017).

## Audit correction

During the Turso audit, local fixtures initially inherited the exported production database variables. The run was stopped; six exact synthetic identities, two exact fixture runs, one fixture setting, and their related rows were removed. Cleanup queries found zero matching synthetic identities, run IDs, or settings. [PR #41](https://github.com/Webghost01-NG/promiseguard-demo/pull/41) now pins local fixtures to SQLite and permits only the randomized, self-cleaning durability test to use Turso. A full Turso-enabled run then passed.

## Pending evidence

- Google Safe Browsing false-positive review: [issue #31](https://github.com/Webghost01-NG/promiseguard-demo/issues/31).
- Judge-ready three-app receipt: [issue #35](https://github.com/Webghost01-NG/promiseguard-demo/issues/35).
- Two-minute submission package: [issue #37](https://github.com/Webghost01-NG/promiseguard-demo/issues/37).

Synthetic GitHub issues [#1](https://github.com/Webghost01-NG/promiseguard-demo/issues/1) and [#22](https://github.com/Webghost01-NG/promiseguard-demo/issues/22) are demo records, not unresolved product defects.
