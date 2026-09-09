# User OAuth onboarding — implementation plan

Provider OAuth is planned, not implemented. Local user accounts, sign-in sessions, encrypted per-user integration tokens and owner-scoped runs/settings are implemented. Accounts are provisioned through the terminal; public registration and hosting are not enabled.

Users should sign in, connect GitHub, select repositories, and start a GitHub-only analysis. Connecting Notion or Slack should remain optional. Each run must use connections belonging to its authenticated user/workspace, never fall back to the operator's tokens.

## Provider setup

- **GitHub:** register a GitHub App with selected repository access and issue read/write permissions. Use its user authorization flow where actions are performed on behalf of the user. Current adapters use `/user` to bind approval to the author; installation tokens cannot simply replace the current token without adapting identity checks. [GitHub App and OAuth App differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).
- **Slack:** register installation OAuth with only the scopes needed for supported discussion reads and replies. Store the resulting workspace/bot identity alongside the token and preserve channel membership checks. [Slack installation OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).
- **Notion:** create a public OAuth connection with content permissions needed for reading evidence and updating the approved status paragraph. Let the user select accessible pages during authorization. [Notion public connections](https://developers.notion.com/guides/get-started/public-connections).
- **Gemini:** use a server-side application API key with an explicit service budget. End users do not receive that key; model usage is billed to the configured project.

## Required implementation

1. **Prepared:** deploy to an exact HTTPS origin using the Render Blueprint. The actual service URL and provider registration still require the owner's Render and GitHub accounts.
2. **Implemented locally:** application sign-in and server-side sessions.
3. Bind authorization state to the initiating session; validate callbacks and exchange codes on the server.
4. **Implemented locally:** encrypted tokens per user and ownership checks on runs, connections, reads and approvals. OAuth grants still need provider installation identities and refresh metadata.
5. Support token expiry/refresh where applicable, disconnection and revoked access. Recheck identity during approval/recovery.
6. Verify two separate users cannot access each other's targets, evidence, tokens or actions; exercise installation, cancellation, expiry and reconnect against real providers.

The deployment URL and registered app credentials are prerequisites for working redirects. Callback endpoints and public hosting remain outstanding. The account-isolation implementation adds users, sessions, encrypted connections and scoped settings to SQLite; legacy run ownership is assigned only by the explicit terminal import command.

Password derivation and authenticated token encryption use [Node crypto](https://nodejs.org/api/crypto.html). This local foundation still needs HTTPS deployment settings, provider callbacks and real OAuth lifecycle verification before public use.
