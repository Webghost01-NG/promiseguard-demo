# User OAuth onboarding — implementation plan

OAuth is planned, not implemented. Current `.env` tokens belong to one local operator. Publishing the repository does not provide user accounts or a hosted service.

Users should sign in, connect GitHub, select repositories, and start a GitHub-only analysis. Connecting Notion or Slack should remain optional. Each run must use connections belonging to its authenticated user/workspace, never fall back to the operator's tokens.

## Provider setup

- **GitHub:** register a GitHub App with selected repository access and issue read/write permissions. Use its user authorization flow where actions are performed on behalf of the user. Current adapters use `/user` to bind approval to the author; installation tokens cannot simply replace the current token without adapting identity checks. [GitHub App and OAuth App differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).
- **Slack:** register installation OAuth with only the scopes needed for supported discussion reads and replies. Store the resulting workspace/bot identity alongside the token and preserve channel membership checks. [Slack installation OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).
- **Notion:** create a public OAuth connection with content permissions needed for reading evidence and updating the approved status paragraph. Let the user select accessible pages during authorization. [Notion public connections](https://developers.notion.com/guides/get-started/public-connections).
- **Gemini:** use a server-side application API key with an explicit service budget. End users do not receive that key; model usage is billed to the configured project.

## Required implementation

1. Choose the hosting URL and register exact callback URLs with each provider.
2. Implement application sign-in and server-side sessions before connecting accounts.
3. Bind authorization state to the initiating session; validate callbacks and exchange codes on the server.
4. Store encrypted credentials and provider identities per user/workspace. Enforce ownership on every run, connection, read and approval.
5. Support token expiry/refresh where applicable, disconnection and revoked access. Recheck identity during approval/recovery.
6. Verify two separate users cannot access each other's targets, evidence, tokens or actions; exercise installation, cancellation, expiry and reconnect against real providers.

The deployment URL and registered app credentials are prerequisites for working redirects. This document does not introduce callback endpoints, database changes or public hosting. Existing local credentials remain the prototype path until user isolation and OAuth are ready together.
