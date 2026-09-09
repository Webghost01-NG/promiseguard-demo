# Verification status — 9 September 2026

## Current checks

- **24 local tests pass.** Coverage includes bounded targets, source quotations, approval-plan identity, SQLite recovery, unknown-write classification, Slack timestamp precision, parent-thread query handling, mismatched channels, and malformed copied links.
- **TypeScript and production build pass.** Production dependency audit reports no known vulnerabilities.
- **Optional integration UI:** all four combinations passed at 1440, 768, 390 and 320 pixels (16 checks), without browser errors or horizontal overflow.
- **Earlier UI checks:** 35 viewport checks passed during the redesign. The Slack fix additionally passed browser checks at 1440, 768, 390, and 320 pixels, including actionable errors, conversion to a readable message link, and clearing an outdated success indicator after editing. No browser errors or horizontal overflow were observed.
- **Live Slack validation:** the saved failed timestamp was rejected with `thread_not_found`; the original demo discussion was readable. Its two-microsecond timestamp difference identifies a different message, not rounding performed by the parser. The application never guesses a nearby message.
- **Pre-analysis failure:** an actual invalid Slack thread returned HTTP 400 without starting Gemini, adding a run, or replacing saved targets.
- **Live read-back:** all three external records belonging to the saved completed demonstration were independently read and matched the recorded GitHub, Notion, and Slack actions during this fix. No additional repair writes were sent.
- **Initial security checks:** cross-origin and missing-session mutations were rejected, `.env` was not served, and credentials were absent from source and frontend output. Private runtime data and credentials remain Git-ignored.
- **Setup script:** invocation without `--apply` was rejected before any external action. The public script now requires explicit repository, page, channel, and owner arguments instead of hardcoded private-workspace destinations.

## Demonstration provenance

Dedicated synthetic issue, Notion paragraphs, and Slack discussion were created with the participant’s authorization. Their identities are retained privately in `data/demo-records.json`. A real Gemini assessment reached review; a later saved run completed, and the external results have now passed read-back verification. This is a synthetic scenario executed against real providers, not evidence of real customer impact.

The latest failed analysis is retained as history. Its GitHub target differs from the original demo issue, so the fix does not silently replace it with demo targets. Select the intended discussion and use **Check Slack thread** before starting another analysis.

## Remaining work and limits

Actual interrupted-repair recovery has not yet been exercised against live providers. Local recovery tests are not a substitute for that test. Broader model decision quality remains unmeasured.

GitHub-only mode and optional Notion/Slack are implemented. Live GitHub-only collection succeeded with Notion and Slack credentials absent; only GitHub requests were made. The completed legacy plan retained its approval hash. Local tests cover all four destination combinations and one-action recovery. No new live repair writes were performed for this feature. Other limits include one local operator/process, bounded pagination, flat Notion pages, and best-effort stale-write prevention. Unknown external outcomes can require manual investigation. Publishing this source does not deploy or expose the local server.

See [UI design review](ui-design-review.md) for the interface reference review and design decisions.
