# Proposed demonstration records

These are synthetic hackathon records, not real customer commitments. A dedicated demonstration using this content has been created and exercised. Each new setup must use its own actual resource links; no API response is simulated.

GitHub issue title: `[DEMO] CSV export acceptance check fails on quoted customer names`

GitHub issue body:

> Synthetic PromiseGuard demonstration. The customer export rollout depends on this issue passing acceptance. The CSV export produces a malformed row when a customer name contains a quote. The acceptance check is still failing. Keep this issue open until that check passes. No delivery date has been approved.

Notion page content, as separate plain paragraphs:

> Synthetic PromiseGuard demonstration. The customer commitment is to make the CSV export ready for rollout after its required acceptance check passes. The engineering dependency is the GitHub issue linked below.

> Required engineering issue: INSERT THE ACTUAL CREATED ISSUE URL

> Delivery status: Ready for rollout

Slack discussion message:

> [SYNTHETIC DEMO] The CSV export acceptance check still fails on quoted customer names. The required GitHub issue is open: INSERT THE ACTUAL CREATED ISSUE URL. The Notion commitment currently says ready for rollout, but the acceptance gate has not passed. The engineering owner needs to investigate the failing case; no new delivery date is approved.

Expected assessment: the stated readiness contradicts the explicit acceptance gate. Proposed repair should set delivery status to at risk, record a bounded engineering handoff, and notify the thread. It must not close the issue, invent a delivery date, or claim the export is fixed.

Creating the Slack discussion and posting repair notifications require explicit authorization. The app's approved repair does not authorize creating these setup records automatically.

## Optional setup script

Prepare a blank, shared Notion page and a public Slack channel with the bot added. After approving the creation of one issue, the Notion paragraphs, and one Slack message, run:

```bash
npx tsx scripts/seed-demo.ts --apply \
  --repo OWNER/REPO \
  --notion-page YOUR_NOTION_PAGE_URL \
  --slack-channel YOUR_CHANNEL_ID \
  --owner "Responsible person"
```

Replace these placeholders with resources you control. This script makes real external writes. It stores returned identities locally in `data/demo-records.json`; keep that file private. It refuses to reuse a state file from another or legacy setup. Existing demonstration links can be entered directly in the application without rerunning setup.

## Controlled GitHub recovery proof

The recovery command creates one clearly labeled synthetic comment, deliberately discards the returned comment ID, reconciles the unknown action against the exact issue, actor, and approved body, and verifies that exactly one provider record exists. Use only a dedicated demo issue:

```bash
npm run recovery:github -- --apply --issue https://github.com/OWNER/REPO/issues/NUMBER
```

The credential-free report under `artifacts/` includes the provider record link, verification timestamp, exact-match count, body hash, and a guarded cleanup command. Cleanup refuses any comment that is not an owned PromiseGuard recovery fixture on the selected issue.

The controlled run on 9 September 2026 recovered and independently verified exactly one record: [GitHub comment 5610265017](https://github.com/Webghost01-NG/promiseguard-demo/issues/1#issuecomment-5610265017). The approved body hash was `830c16be6cccf262dead069282196b1a74980f1e270753d70687658aa59920c7`.
