# Production audit — 10 September 2026

This audit covers the public Render deployment, current source and Git history, account and OAuth boundaries, durable storage, automated checks, dependency health, and the remaining judging gates. It is a focused engineering review, not an independent penetration test or provider certification.

## Result

No unresolved P0 or P1 application-code defect was found. The latest audited deployment serves the PromiseGuard favicon and application, returns a healthy API response, keeps anonymous workspace data closed, rejects a cross-origin registration request, and constructs valid authorization starts for GitHub, Notion, and Slack.

Two release gates remain. Google still classifies part of the production hostname as unsafe, and the empty durable workspace does not yet contain a real three-provider run. These require Google review processing and one user authorizing their own workflow accounts; neither can be completed by changing application code or inventing provider evidence.

## Findings

| Severity | Finding | Evidence | Disposition |
| --- | --- | --- | --- |
| Release blocker | Google Safe Browsing still reports some pages as unsafe and sets the social-engineering/phishing indicator. | Current Site Status response; [issue #31](https://github.com/Webghost01-NG/promiseguard-demo/issues/31) | External review pending. Keep the final public recording gated until Google clears the hostname. |
| Evidence blocker | The production database has three accounts, zero saved workflow connections, and zero runs. | Read-only Turso count on 10 September 2026; [issue #35](https://github.com/Webghost01-NG/promiseguard-demo/issues/35) | A user must sign in, authorize GitHub, Notion, and Slack, then run the labeled synthetic scenario once. The product paths are ready. |
| Operational | The free Render plan uses one instance and may sleep when idle. | Render service API and observed plan | Wake the app before judging and retain a completed receipt as the provider-outage fallback. |
| Product limitation | Password accounts have no self-service reset. | Account implementation and product guide | Social sign-in is available. Treat password recovery as post-hackathon work. |
| Hardening | Bootstrap admin variables remain useful for operator access after the account already exists. | Deployment configuration and idempotent account test | Remove the two bootstrap variables after access is safely transferred; this is not required for the demo and should not be changed while the operator relies on them. |

The repository’s issues #1 and #22 are labeled synthetic provider fixtures. They are not product defects and should remain available for a repeatable demonstration.

## Security checks

- Pattern scanning found no private key, GitHub, Slack, Google, or Notion credential signature in tracked files or committed Git blobs.
- Provider grants are encrypted per user with AES-256-GCM and authenticated with the user ID and provider name. Secrets are never returned in bootstrap metadata.
- Passwords use salted scrypt hashes. Login and registration attempts are rate limited. Sessions expire after eight hours and use HttpOnly, SameSite cookies; public cookies are Secure.
- Social OAuth uses one-time expiring state. Google and Slack also validate OIDC issuer, audience, nonce, and PKCE; GitHub binds its immutable numeric user ID.
- Workflow OAuth state is tied to the active user session. GitHub repository access, Slack bot access, and Notion page access are separate from identity sign-in.
- Mutating workspace APIs require the exact public origin, JSON content, active session, and session-bound CSRF value. Anonymous `/api/bootstrap` returned 401 and a foreign-origin `/api/signup` returned 403.
- Static paths stay below the built application directory. Production responses include CSP, one-year HSTS, frame denial, no-referrer, MIME-sniffing protection, and no-store API caching.
- Source scanning found no dynamic evaluation or production child-process execution.
- `npm audit --omit=dev` reports zero known production dependency vulnerabilities.

## Functional and reliability checks

- `npm test`: 48 passed and the credential-gated Turso test skipped. A separate approved run with Turso credentials passed all 49 tests and cleaned its randomized records.
- `npm run build`: TypeScript checking and the Vite production build passed.
- Real Gemini evaluation: 22/24 correct (91.7%), including repair 8/8 and no-change 8/8, with zero API or schema-validation errors. The two ambiguous misses returned the conservative `no_change` decision.
- Controlled provider recovery found one accepted GitHub write by exact issue, actor, and body after its returned ID was discarded, then independently verified [the recovered record](https://github.com/Webghost01-NG/promiseguard-demo/issues/1#issuecomment-5610265017).
- Production `/`, `/favicon.svg`, `/api/health`, and `/api/auth/providers` returned 200. The favicon was served as `image/svg+xml`, and all three social sign-in providers reported enabled.
- An authenticated production probe returned GitHub, Notion, and Slack authorization redirects with client IDs present and the exact production HTTPS callback paths. The probe then revoked its PromiseGuard session without completing or modifying any provider grant.

## Remaining release procedure

1. In Google Search Console, use the verified production property’s **Security issues** report as the source of truth. If the review is still processing, wait for Google’s result instead of resubmitting it.
2. After Google clears the hostname, sign in to PromiseGuard and open **Connections**.
3. Connect GitHub and select the synthetic demo repository. Connect Notion and select only the labeled demo page. Connect Slack and choose the demo workspace; invite the bot to the selected public channel.
4. Run one GitHub + Notion + Slack synthetic reconciliation, review the exact actions, approve it, and confirm that the receipt shows three provider record IDs and three verification timestamps.
5. Follow the [two-minute judging package](judging-demo.md) for rehearsal and final capture. Keep secrets and unrelated account content outside the recording.
