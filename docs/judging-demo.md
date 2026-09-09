# PromiseGuard judging package

This package is the recording plan for a two-minute hackathon demonstration. Use only explicitly synthetic records and keep every browser tab free of tokens, secrets, and private customer content.

## One-sentence pitch

PromiseGuard compares a customer commitment with the engineering evidence in GitHub and optional team context in Slack, asks Gemini for a source-grounded assessment, and applies a human-approved repair to GitHub, Notion, and Slack with independent read-back receipts.

## Two-minute script

| Time | Screen action | Spoken line |
| --- | --- | --- |
| 0:00–0:12 | Open the prepared Notion commitment and GitHub engineering issue side by side. | “A promise says this export is ready. The engineering issue shows that quoted customer names still fail. Teams usually discover this contradiction after the customer does.” |
| 0:12–0:25 | Open PromiseGuard and show the selected GitHub issue, Notion page, and Slack discussion. | “PromiseGuard reads only the records I select. GitHub supplies engineering evidence, Notion holds the customer-facing promise, and Slack adds the exact team discussion.” |
| 0:25–0:42 | Select **Analyze evidence** and reveal the Evidence tab. Point to the citations. | “Gemini classifies the situation, but it cannot write to any app. PromiseGuard accepts the assessment only when its quotations match server-owned passages from both the commitment and engineering evidence.” |
| 0:42–0:57 | Open Proposed changes and show each destination and exact body. | “The application constructs these bounded actions: a GitHub handoff, a Notion status correction, and a Slack reply. The model cannot redirect them.” |
| 0:57–1:10 | Check the approval box and select **Approve and apply**. | “Nothing changes until I review and approve this exact plan. Approval is bound to the evidence, targets, and action text with a hash.” |
| 1:10–1:30 | Let execution finish; open the receipt and each provider link. | “PromiseGuard writes each approved action, reads it back independently, and records its external ID and verification time. A partial or uncertain write stays visible instead of being reported as success.” |
| 1:30–1:44 | Show the completed receipt with all three providers and verified timestamps. | “Now the commitment, engineering handoff, and team discussion agree, and this receipt proves where every repair landed.” |
| 1:44–1:54 | Show the evaluation line in the reliability brief. | “Our 24-case real-Gemini suite scored 91.7 percent. Every repair and no-change case passed; the two misses were conservative no-change decisions that could not trigger writes.” |
| 1:54–2:00 | Show the controlled recovery comment link. | “We also discarded a real GitHub response ID, recovered the exact write without duplicating it, and verified it. PromiseGuard turns scattered promises into reviewed, auditable action.” |

## Evidence to prepare

- A clearly labeled synthetic Notion page with one plain `Delivery status:` paragraph and a link to the engineering issue.
- A clearly labeled synthetic GitHub issue whose comments contain concrete, conflicting engineering evidence.
- A clearly labeled synthetic Slack thread about the same blocker, with the PromiseGuard bot already in the channel.
- A signed-in PromiseGuard account with all three workflow integrations connected through OAuth.
- A fresh analysis or an already-completed three-provider run whose receipt shows three external record IDs and three verification timestamps.
- The [architecture and reliability brief](reliability.md), opened at the measured-evidence section.
- The [controlled recovery record](https://github.com/Webghost01-NG/promiseguard-demo/issues/1#issuecomment-5610265017).

Do one rehearsal before recording. Confirm that the links open the intended synthetic records and that no tab exposes provider credentials, personal messages, unrelated repositories, or browser password-manager prompts.

## Architecture frame

Use the diagram in the [architecture and reliability brief](reliability.md#system-boundary). Describe its boundary in one sentence: the browser selects evidence and grants approval; the server holds encrypted credentials, validates Gemini citations, performs bounded writes, and verifies each provider independently.

## Judge evidence map

| Claim | Proof to show |
| --- | --- |
| The problem is real and understandable | One commitment and one conflicting engineering record |
| Three external apps have distinct jobs | Notion promise, GitHub evidence/handoff, Slack discussion/notification |
| AI output is controlled | Exact citations, structured decision, application-owned actions, approval hash |
| The result is auditable | External record IDs, links, states, and verification timestamps in the receipt |
| The system was evaluated | 22/24 real-Gemini cases correct; repair 8/8 and no-change 8/8 |
| Failure recovery is concrete | Real GitHub recovery record found exactly once after its returned ID was discarded |
| The project is reproducible | Public repository, README setup, verification status, privacy policy, and architecture brief |

## Recording fallback

Open the free Render service at least two minutes before the judging session and complete one health check. Keep a completed receipt and the recovery record open in separate tabs.

If Render is waking, begin with the prepared provider records and architecture frame, then return to the live app. If Gemini or a workflow provider is unavailable, show the completed receipt and run history; explain the visible failure state and independent verification rather than attempting an unbounded retry. Never substitute invented provider IDs, screenshots, or results.

## Submission links

- Live app: <https://promiseguard-7yoq.onrender.com>
- Source: <https://github.com/Webghost01-NG/promiseguard-demo>
- Setup and product guide: [README](../README.md)
- Architecture and reliability: [docs/reliability.md](reliability.md)
- Verification record: [docs/verification.md](verification.md)
- Privacy policy: <https://promiseguard-7yoq.onrender.com/privacy.html>
- Terms: <https://promiseguard-7yoq.onrender.com/terms.html>

## Final capture gate

Record and publish the final demonstration only after both conditions hold:

1. Google Safe Browsing no longer blocks the production hostname, tracked in [issue #31](https://github.com/Webghost01-NG/promiseguard-demo/issues/31).
2. One real OAuth-based GitHub + Notion + Slack synthetic run has a complete judge-readable receipt, tracked in [issue #35](https://github.com/Webghost01-NG/promiseguard-demo/issues/35).

Do not claim that PromiseGuard fixes the underlying engineering issue, invents delivery dates, or provides a cross-provider transaction. It reconciles the documented promise, creates approved handoffs and status changes, and proves the state of each attempted action.
