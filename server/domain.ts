import { createHash } from 'node:crypto';
import { z } from 'zod';

export const targetSchema = z.object({
  issueUrl: z.string().url(),
  commitmentIssueUrl: z.string().trim().optional(),
  notionPageUrl: z.string().trim().default(''),
  slackChannel: z.string().trim().default(''),
  slackThread: z.string().trim().default(''),
  owner: z.string().trim().min(1).max(100),
  model: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});
export type Targets = z.infer<typeof targetSchema>;
export type Evidence = { id: string; provider: string; title: string; text: string; url: string };
export type Snapshot = {
  evidence: Evidence[];
  fingerprint: string;
  notionStatus?: { id: string; text: string };
  githubActor: number;
  slackActor?: string;
};
export const assessmentSchema = z.object({
  decision: z.enum(['repair', 'no_change', 'clarify']),
  summary: z.string().min(1).max(1600),
  blocker: z.string().max(800),
  nextAction: z.string().max(800),
  citations: z.array(z.object({ evidenceId: z.string(), quote: z.string().min(1).max(700) })).max(12),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type Action = {
  id: string;
  provider: 'GitHub' | 'Notion' | 'Slack';
  title: string;
  target: string;
  body: string;
  status: 'pending' | 'in_flight' | 'unknown' | 'blocked' | 'verified';
  externalId?: string;
  url?: string;
  error?: string;
  verifiedAt?: string;
};
export type Run = {
  id: string;
  createdAt: string;
  updatedAt: string;
  targets: Targets;
  status: 'collecting' | 'review' | 'no_change' | 'clarify' | 'executing' | 'partial' | 'completed' | 'failed' | 'stale' | 'dismissed';
  snapshot?: Snapshot;
  assessment?: Assessment;
  actions: Action[];
  planHash?: string;
  approvedAt?: string;
  error?: string;
  events: { at: string; text: string }[];
};
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function githubIssue(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match || url.username || url.password) {
    throw new Error('Use a GitHub issue URL, such as https://github.com/OWNER/REPO/issues/NUMBER.');
  }
  return { owner: match[1], repo: match[2], number: match[3], path: `/repos/${match[1]}/${match[2]}/issues/${match[3]}` };
}
export function notionId(value: string) {
  let path = value;
  if (value.startsWith('http')) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)notion\.(so|site|com)$/.test(url.hostname)) throw new Error('Use a Notion page URL.');
    path = url.pathname;
  }
  const match = path.match(/([a-f\d]{8}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{12})\/?$/i);
  if (!match) throw new Error('The Notion page URL must contain its page ID.');
  return match[1].replaceAll('-', '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}
export function slackTarget(channel: string, thread: string) {
  let channelId = channel.trim();
  if (channelId.startsWith('http')) {
    const url = new URL(channelId);
    if (url.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(url.hostname) || url.username || url.password) throw new Error('Use a Slack channel URL or ID.');
    channelId = url.pathname.match(/\/(C[A-Z0-9]+)(?:\/|$)/)?.[1] || '';
  }
  let timestamp = thread.trim();
  if (timestamp.startsWith('http')) {
    const url = new URL(timestamp);
    if (url.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(url.hostname) || url.username || url.password) throw new Error('Use a Slack message link copied from the message menu.');
    const linkedChannel = url.pathname.match(/^\/archives\/(C[A-Z0-9]+)\//)?.[1];
    if (linkedChannel !== channelId || (url.searchParams.has('cid') && url.searchParams.get('cid') !== channelId)) throw new Error('The Slack message must belong to the selected channel.');
    const digits = url.pathname.match(/\/p(\d{16})\/?$/)?.[1];
    if (!digits) throw new Error('Copy the Slack message link using the message menu, not the channel address.');
    // A reply permalink carries the parent thread timestamp in its query string.
    // Keep both values as strings: floating-point conversion loses message identity.
    timestamp = url.searchParams.has('thread_ts') ? url.searchParams.get('thread_ts')! : `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  }
  if (!/^C[A-Z0-9]+$/.test(channelId) || !/^\d{10}\.\d{6}$/.test(timestamp)) throw new Error('Provide the public Slack channel and use Copy link on its discussion message. Raw timestamps need all six decimal digits.');
  return { channelId, timestamp };
}
export function slackMessageUrl(channelId: string, timestamp: string) {
  const target = slackTarget(channelId, timestamp);
  return `https://app.slack.com/archives/${target.channelId}/p${target.timestamp.replace('.', '')}`;
}
export function validateTargets(value: unknown): Targets {
  const targets = targetSchema.parse(value);
  githubIssue(targets.issueUrl);
  if (targets.notionPageUrl) {
    notionId(targets.notionPageUrl);
    if (targets.commitmentIssueUrl) throw new Error('Choose one commitment source: a GitHub issue or a Notion page.');
  } else {
    if (!targets.commitmentIssueUrl) throw new Error('Add the GitHub issue documenting the commitment, or select a Notion commitment page.');
    const commitment = githubIssue(targets.commitmentIssueUrl);
    if (commitment.path.toLowerCase() === githubIssue(targets.issueUrl).path.toLowerCase()) throw new Error('Choose separate commitment and engineering issues so their evidence can be compared.');
  }
  if (Boolean(targets.slackChannel) !== Boolean(targets.slackThread)) throw new Error('To include Slack, provide both its channel and discussion link. Otherwise leave both empty.');
  if (targets.slackChannel) slackTarget(targets.slackChannel, targets.slackThread);
  return targets;
}
export function validateAssessment(value: unknown, evidence: Evidence[]): Assessment {
  const assessment = assessmentSchema.parse(value);
  const used = new Set<string>();
  for (const citation of assessment.citations) {
    const source = evidence.find(item => item.id === citation.evidenceId);
    if (!source || !source.text.includes(citation.quote)) throw new Error('Gemini returned a citation that could not be verified against the source. No plan was approved.');
    used.add(source.id);
  }
  const commitmentId = evidence.some(e => e.id === 'notion:commitment') ? 'notion:commitment' : 'github:commitment';
  const engineeringCited = [...used].some(id => id === 'github:issue' || /^github:\d+$/.test(id));
  if (assessment.decision === 'repair' && (!assessment.blocker.trim() || !assessment.nextAction.trim() || !used.has(commitmentId) || !engineeringCited)) {
    throw new Error('A repair requires a blocker, a next action, and exact citations from both the selected commitment and engineering evidence.');
  }
  return assessment;
}
export function marker(runId: string) { return `PromiseGuard run ${runId}`; }
export function slackText(text: string) { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
export function planActions(run: Run): Action[] {
  if (!run.snapshot || !run.assessment || run.assessment.decision !== 'repair') return [];
  const a = run.assessment;
  const sources = [...new Set(a.citations.map(c => run.snapshot!.evidence.find(e => e.id === c.evidenceId)!.url))];
  const refs = sources.join('\n');
  const tag = marker(run.id);
  const actions: Action[] = [
    { id: `${run.id}:github`, provider: 'GitHub', title: 'Record the engineering handoff', target: run.targets.issueUrl, body: `Customer commitment at risk\n\n${a.summary}\n\nBlocker: ${a.blocker}\nNext action for ${run.targets.owner}: ${a.nextAction}\n\nEvidence:\n${refs}\n\n${tag}`, status: 'pending' },
  ];
  if (run.targets.notionPageUrl) {
    if (!run.snapshot.notionStatus) throw new Error('The selected Notion status was not collected.');
    actions.push({ id: `${run.id}:notion`, provider: 'Notion', title: 'Update the delivery status paragraph', target: run.targets.notionPageUrl, body: `Delivery status: At risk\n${a.blocker}\nNext action for ${run.targets.owner}: ${a.nextAction}\n${tag}`, status: 'pending' });
  }
  if (run.targets.slackChannel) {
    const lead = run.targets.notionPageUrl ? 'Commitment marked at risk; engineering handoff recorded.' : 'Engineering handoff recorded for a commitment at risk.';
    actions.push({ id: `${run.id}:slack`, provider: 'Slack', title: 'Notify the discussion with the next action', target: slackMessageUrl(run.targets.slackChannel, run.targets.slackThread), body: slackText(`${lead}\n\n${a.summary}\n\nOwner: ${run.targets.owner}\nNext action: ${a.nextAction}\nThe engineering blocker remains open.\n\nEvidence:\n${refs}\n\n${tag}`), status: 'pending' });
  }
  return actions;
}
export function planHash(run: Run) {
  return digest({ targets: run.targets, evidence: run.snapshot, assessment: run.assessment, actions: run.actions.map(({ id, provider, target, body }) => ({ id, provider, target, body })) });
}
