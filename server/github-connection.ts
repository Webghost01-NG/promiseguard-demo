import { createHash, randomBytes } from 'node:crypto';
import { Accounts } from './accounts.ts';

export type GithubGrant = {
  kind: 'github-app-user';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  githubUserId: number;
  installationId: number;
  installationIds?: number[];
  repositories: string[];
};

export class GithubInstallationRequired extends Error {}

type GithubConfig = { clientId: string; clientSecret: string; slug: string };
const refreshes = new WeakMap<Accounts, Map<string, Promise<string>>>();
const headers = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
});

async function github(path: string, token: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.message || `GitHub HTTP ${response.status}`);
  return data;
}

function parseGrant(raw: string) {
  try {
    const grant = JSON.parse(raw) as GithubGrant;
    return grant.kind === 'github-app-user' ? grant : undefined;
  } catch {
    return undefined;
  }
}

function grantLock(accounts: Accounts, userId: string, work: () => Promise<string>) {
  let accountRefreshes = refreshes.get(accounts);
  if (!accountRefreshes) {
    accountRefreshes = new Map();
    refreshes.set(accounts, accountRefreshes);
  }
  const active = accountRefreshes.get(userId) || Promise.resolve('');
  const pending = active.catch(() => '').then(work).finally(() => {
    if (accountRefreshes!.get(userId) === pending) accountRefreshes!.delete(userId);
  });
  accountRefreshes.set(userId, pending);
  return pending;
}

export function githubAppConfig(env = process.env): GithubConfig {
  return {
    clientId: (env.GITHUB_APP_CLIENT_ID || '').trim(),
    clientSecret: (env.GITHUB_APP_CLIENT_SECRET || '').trim(),
    slug: (env.GITHUB_APP_SLUG || '').trim()
  };
}

export function verifier() {
  return randomBytes(32).toString('base64url');
}

export function challenge(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export async function exchange(code: string, codeVerifier: string, redirectUri: string, config = githubAppConfig()) {
  const requestBody = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody,
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json() as any;
  if (!response.ok || !data.access_token) throw new Error(data.error_description || 'GitHub did not complete the connection.');
  return data;
}

export async function buildGrant(token: any, installation: number | number[] = 0): Promise<GithubGrant> {
  const user = await github('/user', token.access_token);
  let installationIds = Array.isArray(installation) ? installation : installation > 0 ? [installation] : [];
  if (!installationIds.length) {
    for (let page = 1; ; page++) {
      const result = await github(`/user/installations?per_page=100&page=${page}`, token.access_token);
      const pageIds = (result.installations || []).map((item: any) => Number(item.id)).filter((id: number) => Number.isSafeInteger(id) && id > 0);
      installationIds.push(...pageIds);
      if (installationIds.length >= result.total_count || !pageIds.length) break;
    }
    if (!installationIds.length) throw new GithubInstallationRequired('Install the GitHub App before authorizing repository access.');
  }
  const repositorySet = new Set<string>();
  for (const installationId of installationIds) {
    let collected = 0;
    for (let page = 1; ; page++) {
      const result = await github(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token.access_token);
      const names = (result.repositories || []).map((repository: any) => repository.full_name).filter(Boolean);
      names.forEach((name: string) => repositorySet.add(name));
      collected += names.length;
      if (collected >= result.total_count || !names.length) break;
    }
  }
  return {
    kind: 'github-app-user',
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: Date.now() + (token.expires_in || 28800) * 1000,
    refreshExpiresAt: Date.now() + (token.refresh_token_expires_in || 0) * 1000,
    githubUserId: user.id,
    installationId: installationIds[0],
    installationIds,
    repositories: [...repositorySet]
  };
}

export function grantMeta(raw: string) {
  const grant = parseGrant(raw);
  return grant ? { type: 'github-app' as const, repositories: grant.repositories, installationId: grant.installationId } : undefined;
}

async function refreshGithubToken(accounts: Accounts, userId: string, config: GithubConfig) {
  const raw = accounts.credentials(userId).GITHUB_TOKEN || '';
  const grant = parseGrant(raw);
  if (!grant) return raw;
  if (grant.expiresAt > Date.now() + 60000) return grant.accessToken;
  if (!grant.refreshToken || grant.refreshExpiresAt <= Date.now()) throw new Error('GitHub authorization expired. Reconnect GitHub.');
  const requestBody = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken
  });
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody,
    signal: AbortSignal.timeout(20000)
  });
  const token = await response.json() as any;
  if (!response.ok || !token.access_token) throw new Error('GitHub authorization was revoked or expired. Reconnect GitHub.');
  const refreshed = await buildGrant(token, grant.installationIds?.length ? grant.installationIds : grant.installationId);
  if (refreshed.githubUserId !== grant.githubUserId) throw new Error('GitHub connection identity changed. Reconnect GitHub.');
  accounts.setConnection(userId, 'GITHUB_TOKEN', JSON.stringify(refreshed));
  return refreshed.accessToken;
}

export async function githubToken(accounts: Accounts, userId: string, config = githubAppConfig()) {
  const raw = accounts.credentials(userId).GITHUB_TOKEN || '';
  const grant = parseGrant(raw);
  if (!grant) return raw;
  if (grant.expiresAt > Date.now() + 60000) return grant.accessToken;
  return grantLock(accounts, userId, () => refreshGithubToken(accounts, userId, config));
}

export async function disconnectGithub(accounts: Accounts, userId: string, config = githubAppConfig()) {
  return grantLock(accounts, userId, async () => {
    const raw = accounts.credentials(userId).GITHUB_TOKEN || '';
    const grant = parseGrant(raw);
    if (grant) {
      if (!config.clientId || !config.clientSecret) throw new Error('GitHub App connection is not configured.');
      const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/grant`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ access_token: grant.accessToken }),
        signal: AbortSignal.timeout(20000)
      });
      if (![204, 401, 404].includes(response.status)) {
        let message = `GitHub HTTP ${response.status}`;
        try { message = ((await response.json()) as any).message || message; } catch {}
        throw new Error(`GitHub could not revoke this authorization: ${message}`);
      }
    }
    accounts.setConnection(userId, 'GITHUB_TOKEN', '');
    return '';
  });
}
