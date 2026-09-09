import { Accounts } from './accounts.ts';

export type WorkflowProvider = 'slack' | 'notion';
type WorkflowKey = 'SLACK_BOT_TOKEN' | 'NOTION_TOKEN';
type WorkflowConfig = { clientId: string; clientSecret: string };
type SlackGrant = { kind: 'slack-oauth'; accessToken: string; refreshToken: string; expiresAt: number; teamId: string; teamName: string; botUserId: string };
type NotionGrant = { kind: 'notion-oauth'; accessToken: string; refreshToken: string; expiresAt: number; workspaceId: string; workspaceName: string; botId: string };
type WorkflowGrant = SlackGrant | NotionGrant;

const locks = new WeakMap<Accounts, Map<string, Promise<string>>>();
const keys: Record<WorkflowProvider, WorkflowKey> = { slack: 'SLACK_BOT_TOKEN', notion: 'NOTION_TOKEN' };

function basic(config: WorkflowConfig) {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

function parseGrant(raw: string): WorkflowGrant | undefined {
  try {
    const grant = JSON.parse(raw) as WorkflowGrant;
    return ['slack-oauth', 'notion-oauth'].includes(grant.kind) ? grant : undefined;
  } catch {
    return undefined;
  }
}

function connectionLock(accounts: Accounts, userId: string, provider: WorkflowProvider, work: () => Promise<string>) {
  let accountLocks = locks.get(accounts);
  if (!accountLocks) { accountLocks = new Map(); locks.set(accounts, accountLocks); }
  const lockKey = `${userId}:${provider}`;
  const active = accountLocks.get(lockKey) || Promise.resolve('');
  const pending = active.catch(() => '').then(work).finally(() => {
    if (accountLocks!.get(lockKey) === pending) accountLocks!.delete(lockKey);
  });
  accountLocks.set(lockKey, pending);
  return pending;
}

export function workflowOauthConfig(env = process.env): Record<WorkflowProvider, WorkflowConfig> {
  return {
    slack: { clientId: (env.SLACK_CLIENT_ID || '').trim(), clientSecret: (env.SLACK_CLIENT_SECRET || '').trim() },
    notion: { clientId: (env.NOTION_CLIENT_ID || '').trim(), clientSecret: (env.NOTION_CLIENT_SECRET || '').trim() }
  };
}

export function workflowOauthAvailable(config = workflowOauthConfig()) {
  return Object.fromEntries(Object.entries(config).map(([provider, value]) => [provider, Boolean(value.clientId && value.clientSecret)]));
}

export function workflowGrantMeta(raw: string) {
  const grant = parseGrant(raw);
  if (grant?.kind === 'slack-oauth') return { type: 'oauth' as const, label: grant.teamName || grant.teamId };
  if (grant?.kind === 'notion-oauth') return { type: 'oauth' as const, label: grant.workspaceName || grant.workspaceId };
  return undefined;
}

export function workflowAuthorizeUrl(provider: WorkflowProvider, state: string, redirectUri: string, config = workflowOauthConfig()[provider]) {
  if (!config.clientId || !config.clientSecret) throw new Error(`${provider === 'slack' ? 'Slack' : 'Notion'} connection OAuth is not configured.`);
  if (provider === 'slack') {
    const query = new URLSearchParams({ client_id: config.clientId, scope: 'channels:history,chat:write', redirect_uri: redirectUri, state });
    return new URL(`https://slack.com/oauth/v2/authorize?${query}`);
  }
  const query = new URLSearchParams({ owner: 'user', client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', state });
  return new URL(`https://api.notion.com/v1/oauth/authorize?${query}`);
}

export async function exchangeWorkflowCode(provider: WorkflowProvider, code: string, redirectUri: string, config = workflowOauthConfig()[provider]) {
  if (!code) throw new Error(`${provider === 'slack' ? 'Slack' : 'Notion'} authorization was cancelled.`);
  if (provider === 'slack') {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST', headers: { Accept: 'application/json', Authorization: basic(config), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, redirect_uri: redirectUri }), signal: AbortSignal.timeout(20000)
    });
    const token = await response.json() as any;
    if (!response.ok || token.ok !== true || !token.access_token) throw new Error(`Slack did not complete the connection: ${token.error || `HTTP ${response.status}`}.`);
    const grant: SlackGrant = { kind: 'slack-oauth', accessToken: token.access_token, refreshToken: token.refresh_token || '', expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0, teamId: token.team?.id || '', teamName: token.team?.name || '', botUserId: token.bot_user_id || '' };
    return grant;
  }
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST', headers: { Accept: 'application/json', Authorization: basic(config), 'Content-Type': 'application/json', 'Notion-Version': '2026-03-11' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }), signal: AbortSignal.timeout(20000)
  });
  const token = await response.json() as any;
  if (!response.ok || !token.access_token) throw new Error(`Notion did not complete the connection: ${token.message || token.code || `HTTP ${response.status}`}.`);
  const grant: NotionGrant = { kind: 'notion-oauth', accessToken: token.access_token, refreshToken: token.refresh_token || '', expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0, workspaceId: token.workspace_id || '', workspaceName: token.workspace_name || '', botId: token.bot_id || '' };
  return grant;
}

async function refreshWorkflowToken(accounts: Accounts, userId: string, provider: WorkflowProvider, config: WorkflowConfig) {
  const raw = (await accounts.credentials(userId))[keys[provider]] || '';
  const grant = parseGrant(raw);
  if (!grant || grant.kind !== `${provider}-oauth`) return raw;
  if (!grant.expiresAt || grant.expiresAt > Date.now() + 60000) return grant.accessToken;
  if (!grant.refreshToken) throw new Error(`${provider === 'slack' ? 'Slack' : 'Notion'} authorization expired. Reconnect it.`);
  const endpoint = provider === 'slack' ? 'https://slack.com/api/oauth.v2.access' : 'https://api.notion.com/v1/oauth/token';
  const response = await fetch(endpoint, provider === 'slack' ? {
    method: 'POST', headers: { Accept: 'application/json', Authorization: basic(config), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }), signal: AbortSignal.timeout(20000)
  } : {
    method: 'POST', headers: { Accept: 'application/json', Authorization: basic(config), 'Content-Type': 'application/json', 'Notion-Version': '2026-03-11' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }), signal: AbortSignal.timeout(20000)
  });
  const token = await response.json() as any;
  if (!response.ok || (provider === 'slack' && token.ok !== true) || !token.access_token) throw new Error(`${provider === 'slack' ? 'Slack' : 'Notion'} authorization was revoked or expired. Reconnect it.`);
  const refreshed = { ...grant, accessToken: token.access_token, refreshToken: token.refresh_token || grant.refreshToken, expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0 };
  await accounts.setConnection(userId, keys[provider], JSON.stringify(refreshed));
  return refreshed.accessToken;
}

export async function workflowToken(accounts: Accounts, userId: string, provider: WorkflowProvider, config = workflowOauthConfig()[provider]) {
  const raw = (await accounts.credentials(userId))[keys[provider]] || '';
  const grant = parseGrant(raw);
  if (!grant || grant.kind !== `${provider}-oauth`) return raw;
  if (!grant.expiresAt || grant.expiresAt > Date.now() + 60000) return grant.accessToken;
  return connectionLock(accounts, userId, provider, () => refreshWorkflowToken(accounts, userId, provider, config));
}

export async function disconnectWorkflow(accounts: Accounts, userId: string, provider: WorkflowProvider, config = workflowOauthConfig()[provider]) {
  return connectionLock(accounts, userId, provider, async () => {
    const raw = (await accounts.credentials(userId))[keys[provider]] || '';
    const grant = parseGrant(raw);
    if (grant?.kind === 'slack-oauth') {
      const response = await fetch('https://slack.com/api/auth.revoke', { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000) });
      const data = await response.json() as any;
      if (!response.ok || (data.ok !== true && !['invalid_auth', 'token_revoked', 'account_inactive'].includes(data.error))) throw new Error(`Slack could not revoke this connection: ${data.error || `HTTP ${response.status}`}.`);
    }
    if (grant?.kind === 'notion-oauth') {
      if (!config.clientId || !config.clientSecret) throw new Error('Notion connection OAuth is not configured.');
      const response = await fetch('https://api.notion.com/v1/oauth/revoke', { method: 'POST', headers: { Accept: 'application/json', Authorization: basic(config), 'Content-Type': 'application/json', 'Notion-Version': '2026-03-11' }, body: JSON.stringify({ token: grant.accessToken }), signal: AbortSignal.timeout(20000) });
      if (!response.ok && response.status !== 400) throw new Error(`Notion could not revoke this connection: HTTP ${response.status}.`);
    }
    await accounts.setConnection(userId, keys[provider], '');
    return '';
  });
}
