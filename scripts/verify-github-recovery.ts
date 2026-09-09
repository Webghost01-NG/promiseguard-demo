import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { githubIssue, marker, type Action, type Run } from '../server/domain.ts';
import { credentials, Providers } from '../server/providers.ts';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const issueUrl = argument('--issue');
if (!issueUrl) throw new Error('Pass --issue with a dedicated synthetic GitHub issue URL.');
const issue = githubIssue(issueUrl);
const output = resolve(argument('--output') || `artifacts/github-recovery-${new Date().toISOString().replaceAll(':', '-')}.json`);
const providers = new Providers();

const cleanupId = argument('--cleanup');
if (cleanupId) {
  if (!/^\d+$/.test(cleanupId)) throw new Error('The cleanup comment ID must contain digits only.');
  const [actor, comment] = await Promise.all([
    providers.request('GitHub', '/user'),
    providers.request('GitHub', `/repos/${issue.owner}/${issue.repo}/issues/comments/${cleanupId}`),
  ]);
  const safeMarker = /^\[SYNTHETIC RECOVERY TEST\][\s\S]*\nPromiseGuard run recovery-[a-f\d-]+$/.test(comment.body || '');
  if (!safeMarker || comment.user?.id !== actor.id || !comment.issue_url?.endsWith(`/issues/${issue.number}`)) throw new Error('Cleanup refused: the record is not an owned PromiseGuard recovery fixture on the selected issue.');
  const raw = credentials().GITHUB_TOKEN;
  let token = raw;
  try { token = JSON.parse(raw).accessToken || ''; } catch {}
  const response = await fetch(`https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/comments/${cleanupId}`, {
    method: 'DELETE',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status !== 204) throw new Error(`GitHub cleanup failed with HTTP ${response.status}.`);
  console.log(JSON.stringify({ cleaned: true, provider: 'GitHub', recordId: cleanupId }));
  process.exit(0);
}

if (!process.argv.includes('--apply')) throw new Error('This check creates one real synthetic comment. Review the issue and rerun with --apply.');

const actor = await providers.request('GitHub', '/user');
const runId = `recovery-${randomUUID()}`;
const body = `[SYNTHETIC RECOVERY TEST]\n\nThis record proves that PromiseGuard can recover an accepted provider write after losing its response identity. It does not report customer work or authorize an engineering change.\n\n${marker(runId)}`;
const run: Run = {
  id: runId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'partial',
  targets: { issueUrl, commitmentIssueUrl: `${issueUrl}#synthetic-recovery-only`, notionPageUrl: '', slackChannel: '', slackThread: '', owner: 'Recovery test', model: 'not-used' },
  snapshot: { evidence: [], fingerprint: '', githubActor: actor.id },
  actions: [],
  events: [],
};
const submitted: Action = { id: `${runId}:github`, provider: 'GitHub', title: 'Synthetic recovery proof', target: issueUrl, body, status: 'in_flight' };
const accepted = await providers.write(run, submitted);

// Simulate a stop after GitHub accepted the write but before its returned ID was
// persisted. Recovery receives only the approved actor, target and exact body.
const recovered: Action = { ...submitted, status: 'unknown' };
const recoveredId = await providers.reconcile(run, recovered);
if (!recoveredId || recoveredId !== accepted.id) throw new Error('Recovery did not resolve the exact accepted GitHub record.');
recovered.externalId = recoveredId;
recovered.url = accepted.url;
recovered.status = 'verified';
recovered.verifiedAt = new Date().toISOString();
if (!await providers.verify(run, recovered)) throw new Error('The recovered GitHub record failed independent read-back.');
const exactMatches = (await providers.githubComments(issue.path)).filter(comment => comment.user?.id === actor.id && comment.body === body);
if (exactMatches.length !== 1) throw new Error(`Expected one exact provider record after recovery; found ${exactMatches.length}.`);

const report = {
  schemaVersion: 1,
  performedAt: new Date().toISOString(),
  synthetic: true,
  failurePoint: 'Provider accepted the write before its returned identity was persisted.',
  provider: 'GitHub',
  issueUrl,
  recordId: recoveredId,
  recordUrl: accepted.url,
  exactMatches: exactMatches.length,
  verified: true,
  verifiedAt: recovered.verifiedAt,
  bodySha256: createHash('sha256').update(body).digest('hex'),
  cleanup: `npm run recovery:github -- --issue ${issueUrl} --cleanup ${recoveredId}`,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${output}`);
