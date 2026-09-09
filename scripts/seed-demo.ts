import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Providers } from '../server/providers.ts';
import { Store } from '../server/store.ts';
import { githubIssue, notionId } from '../server/domain.ts';

// Explicitly authorized synthetic demonstration, documented in docs/demo-scenario.md.
// This script is opt-in and is never called by the application.
if (!process.argv.includes('--apply')) throw new Error('Review docs/demo-scenario.md and pass --apply only after approval to create these external records.');
const providers = new Providers();
function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? '' : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Supply --${name}. See docs/demo-scenario.md.`);
  return value;
}
const repo = argument('repo');
const issuePath = githubIssue(`https://github.com/${repo}/issues/1`).path.replace(/\/1$/, '');
const pageId = notionId(argument('notion-page'));
const channel = argument('slack-channel');
if (!/^C[A-Z0-9]+$/.test(channel)) throw new Error('Supply a public Slack channel ID.');
const owner = argument('owner');
const scope = { repo, pageId, channel, owner };
const path = 'data/demo-records.json';
mkdirSync('data', { recursive: true, mode: 0o700 });
const records = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { scope };
if (JSON.stringify(records.scope) !== JSON.stringify(scope)) throw new Error('Existing demo records belong to a different or legacy setup. Keep them intact and reuse their links; use a fresh local data directory for a new demonstration.');
function save() { writeFileSync(path, JSON.stringify(records, null, 2), { mode: 0o600 }); }
const title = '[DEMO] CSV export acceptance check fails on quoted customer names';
if (!records.issueUrl) {
  const issues = await providers.request('GitHub', `${issuePath}?state=all&per_page=100`) as unknown as any[];
  const existing = issues.find(issue => issue.title === title);
  const issue = existing || await providers.request('GitHub', issuePath, 'POST', {
    title,
    body: 'Synthetic PromiseGuard demonstration. The customer export rollout depends on this issue passing acceptance. The CSV export produces a malformed row when a customer name contains a quote. The acceptance check is still failing. Keep this issue open until that check passes. No delivery date has been approved.',
  });
  records.issueUrl = issue.html_url;
  save();
  console.log(`Demo issue ready: ${records.issueUrl}`);
}
if (!records.notionReady) {
  const blocks = await providers.notionBlocks(pageId);
  const text = blocks.map(b => (b[b.type]?.rich_text || []).map((r: any) => r.plain_text || r.text?.content || '').join('')).join('\n');
  if (!text.includes('Synthetic PromiseGuard demonstration.')) {
    const paragraphs = [
      'Synthetic PromiseGuard demonstration. The customer commitment is to make the CSV export ready for rollout after its required acceptance check passes. The engineering dependency is the GitHub issue linked below.',
      `Required engineering issue: ${records.issueUrl}`,
      'Delivery status: Ready for rollout',
    ];
    await providers.request('Notion', `/blocks/${pageId}/children`, 'PATCH', { children: paragraphs.map(content => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } })) });
  }
  records.notionReady = true;
  save();
  console.log('Notion demo paragraphs ready.');
}
if (!records.slackThread) {
  const history = await providers.request('Slack', `/conversations.history?channel=${channel}&limit=100`);
  const text = `[SYNTHETIC DEMO] The CSV export acceptance check still fails on quoted customer names. The required GitHub issue is open: ${records.issueUrl}. The Notion commitment currently says ready for rollout, but the acceptance gate has not passed. The engineering owner needs to investigate the failing case; no new delivery date is approved.`;
  const existing = history.messages?.find((m: any) => m.text === text || m.text?.startsWith('[SYNTHETIC DEMO] The CSV export acceptance check still fails'));
  const message = existing || await providers.request('Slack', '/chat.postMessage', 'POST', { channel, text, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false });
  records.slackThread = message.ts;
  save();
  console.log('Slack synthetic demo discussion ready.');
}
const targets = {
  issueUrl: records.issueUrl,
  notionPageUrl: `https://app.notion.com/p/PromiseGuard-Demo-${pageId.replaceAll('-', '')}`,
  slackChannel: channel,
  slackThread: records.slackThread,
  owner,
  model: 'gemini-3.1-flash-lite',
};
const store = new Store();
store.setSetting('targets', targets);
store.db.close();
console.log('Actual demo record links saved as the default workflow targets.');
