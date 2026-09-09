# PromiseGuard

A local commitment-reconciliation workspace using Gemini, GitHub, Notion, and Slack. It gathers linked evidence, proposes an exact repair for review, and verifies each approved external change. Current implementation uses access tokens for one operator; OAuth and multi-tenant hosting are not implemented.

![PromiseGuard workspace showing a recorded, verified synthetic demonstration](docs/assets/workspace.png)

## Run locally

Requires Node 22.13+ with built-in SQLite support. SQLite may print an experimental-feature notice on Node 22.

```bash
git clone https://github.com/Webghost01-NG/promiseguard-demo.git
cd promiseguard-demo
npm ci
cp .env.example .env
# Fill in .env before starting (see Credentials below).
npm run build
npm start
```

Open http://127.0.0.1:4317. The server binds only to loopback. Rebuild after editing frontend files; restart after server edits. Do not expose this local single-user server publicly.

## Credentials

```bash
nano .env
```

Fill in `GEMINI_API_KEY`, `GITHUB_TOKEN`, `NOTION_TOKEN`, and `SLACK_BOT_TOKEN`. The file is Git-ignored and must remain private. Tokens are reloaded for provider requests, so saving updated tokens does not require a server restart. The browser receives credential presence and connection results, never the tokens themselves. Click Connections → Check connections to verify authentication. Gemini model-list access does not prove generation quota.

## Prepare actual demo records

Use a GitHub repository you control and whose issues the token can access. The project’s `promiseguard-demo` repository contains an explicitly synthetic demonstration issue. Create an engineering issue you want the app to analyze. The app does not create initial demo records or send setup messages automatically.

On your shared Notion demo page, add plain paragraphs explaining the customer commitment and linking its required GitHub issue. Add exactly one separate plain paragraph beginning `Delivery status:`. This paragraph is the only Notion block the app may replace after approval. Nested blocks are deliberately rejected to avoid silent incomplete evidence collection. This implements the status update on the plain page already created, without requiring a database schema.

In your chosen public Slack channel, ensure the bot is a member. Use a discussion about the same blocker, then use **Copy link** on the discussion message. Paste the entire link; do not retype the timestamp. **Check Slack thread** verifies access and preserves the exact thread link. Reply links containing `thread_ts` resolve to their parent discussion. The app reads that specific thread and posts its approved escalation into that thread.

Slack is checked before an analysis run is created. A missing message produces a targeted error without saving new targets or starting Gemini. A successful read verifies access, not whether that discussion is relevant to the GitHub issue.

Enter the issue URL, Notion page URL, Slack channel link/ID, Slack discussion link, owner, and selected Gemini model. Analyze sends relevant source text to Gemini but makes no writes to the three workflow apps. Review the exact proposed changes, check the authorization checkbox, then apply. Dismiss a no-longer-needed review before starting another run.

## Execution and recovery

SQLite stores evidence, versioned plan content, action state, returned record IDs, and verification observations in `data/`. Treat it as private workspace data; it is Git-ignored. Approval is bound to a hash of the plan, evidence, and targets. Source changes invalidate the plan. The server executes one run at a time, survives browser disconnects, and marks interrupted writes as unknown after a restart.

An unknown write is reconciled against the original provider identity and exact target/content before any retry. Absence from a lookup never automatically authorizes repeating an ambiguous write. When ambiguity cannot be resolved, the run remains partial and new runs are blocked until the operator resolves the external state. This is a deliberate availability tradeoff to prevent blind duplication. There is no universal exactly-once or cross-app transaction guarantee.

Verified actions are rechecked on resume. Notion stale-field checks are best effort; its block update is not a cross-service conditional transaction. If another actor changes a record between a read and a write, a race remains. Slack may normalize text; a mismatch is surfaced as unverified rather than hidden. Rate limits stop a run with a provider message; the user resumes after the indicated interval. There are no background unbounded retries.

Gemini returns a bounded classification and exact source quotations. Code validates source references, quotes, and required evidence, but cannot prove the model's semantic inference. Operator review remains required. An open GitHub issue by itself does not establish a broken commitment.

## Checks

```bash
npm test
npm run build
```

Tests cover target restrictions, evidence grounding, immutable approval content, no-action decisions, and durable restart behavior. Test data is explicitly synthetic unit-test material. The application has no mocked provider path. Live mutation tests must be approved and results reported separately from local tests.

## Source layout

- `src/`: React operator workspace and responsive styles.
- `server/domain.ts`: target validation, evidence/plan types, grounded assessment checks.
- `server/providers.ts`: real provider REST adapters, collection, analysis, writes and read-back.
- `server/coordinator.ts`: approval, execution, recovery and completion rules.
- `server/store.ts`: local SQLite persistence.
- `server/index.ts`: loopback HTTP server, same-origin/session checks, static frontend.
- `tests/`: local invariant and persistence checks.

Provider references: [GitHub issue comments](https://docs.github.com/en/rest/issues/comments), [Notion block update](https://developers.notion.com/reference/update-a-block), [Slack discussion reads](https://docs.slack.dev/reference/methods/conversations.replies/), [Slack posting](https://docs.slack.dev/reference/methods/chat.postMessage/), [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

## Current scope

This first workflow requires GitHub, Notion, and Slack together, plus Gemini. GitHub-only workflows and optional connectors are proposed follow-up work, not implemented capabilities. The public repository publishes source code; it does not make the local server a hosted multi-user service.
