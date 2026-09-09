# User OAuth onboarding

Google, GitHub, and Slack authentication create isolated user workspaces on first sign-in. Local password accounts, encrypted per-user integration tokens and owner-scoped runs/settings remain supported. OAuth for workflow connections is a separate phase.

Users should sign in, connect GitHub, select repositories, and start a GitHub-only analysis. Connecting Notion or Slack should remain optional. Each run must use connections belonging to its authenticated user/workspace, never fall back to the operator's tokens.

## Provider setup

- **GitHub:** register a GitHub App with selected repository access and issue read/write permissions. Use its user authorization flow where actions are performed on behalf of the user. Current adapters use `/user` to bind approval to the author; installation tokens cannot simply replace the current token without adapting identity checks. [GitHub App and OAuth App differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).
- **Slack:** register installation OAuth with only the scopes needed for supported discussion reads and replies. Store the resulting workspace/bot identity alongside the token and preserve channel membership checks. [Slack installation OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).
- **Notion:** create a public OAuth connection with content permissions needed for reading evidence and updating the approved status paragraph. Let the user select accessible pages during authorization. [Notion public connections](https://developers.notion.com/guides/get-started/public-connections).
- **Gemini:** use a server-side application API key with an explicit service budget. End users do not receive that key; model usage is billed to the configured project.

## Identity authentication implemented

- Authorization code flow with PKCE, one-time state, browser binding and ten-minute expiry.
- Google and Slack OIDC issuer, signature, audience, nonce and token response validation through `openid-client`.
- GitHub identity lookup through its OAuth web flow and immutable numeric user ID.
- No automatic account linking by email. A provider identity always resolves to its existing account or creates a new one.
- Social sign-in access tokens are not reused as workflow credentials. GitHub workflow access and Slack bot access are connected separately.

## Workflow connections

GitHub App installation, Slack bot OAuth, and Notion public OAuth are available from **Connections**. Each grant belongs to the signed-in PromiseGuard account. GitHub lets the installer select repositories; Notion lets the installer select pages; Slack installs into the workspace selected on Slack's authorization screen.

GitHub and Gemini are required for analysis. Notion and Slack are optional and only need to be connected when a run uses them. Provider cancellation returns the user to **Connections** without replacing an existing grant.

The deployed URL and registered app credentials are prerequisites for working redirects. Missing providers are shown as setup pending while configured providers remain usable. Legacy run ownership is assigned only by the explicit terminal import command.

Password derivation and authenticated token encryption use [Node crypto](https://nodejs.org/api/crypto.html). The production Render origin, provider callbacks, secure cookies, and OAuth start flows are configured and verified; the current production evidence and remaining limits are recorded in the [reliability brief](reliability.md).
