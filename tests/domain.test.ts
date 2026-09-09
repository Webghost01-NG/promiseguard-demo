import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubIssue, notionId, slackTarget, slackMessageUrl, validateAssessment, planActions, planHash, slackText, type Run, type Evidence } from '../server/domain.ts';
import { Store } from '../server/store.ts';
import { requiresReconciliation } from '../server/coordinator.ts';

// Explicit unit-test fixtures only. No fake provider is used by the application.
const evidence: Evidence[] = [
  { id: 'notion:commitment', provider: 'Notion', title: 'Unit fixture', text: 'The release depends on the linked issue.', url: 'https://notion.so/00000000000000000000000000000001' },
  { id: 'github:issue', provider: 'GitHub', title: 'Unit fixture', text: 'Acceptance check is failing.', url: 'https://github.com/fixture/repo/issues/1' },
];
function fixture(): Run {
  return {
    id: 'unit-test', createdAt: '2026-09-09', updatedAt: '2026-09-09', status: 'review', events: [], actions: [],
    targets: { issueUrl: 'https://github.com/fixture/repo/issues/1', notionPageUrl: 'https://notion.so/00000000000000000000000000000001', slackChannel: 'CUNITTEST', slackThread: '1700000000.000001', owner: 'Test owner', model: 'gemini-2.5-flash' },
    snapshot: { evidence, fingerprint: 'fixture-fingerprint', notionStatus: { id: 'fixture-status', text: 'Delivery status: On track' }, githubActor: 1, slackActor: 'UNITUSER' },
    assessment: { decision: 'repair', summary: 'Unit-test contradiction.', blocker: 'Acceptance check is failing.', nextAction: 'Investigate the acceptance check.', citations: [{ evidenceId: evidence[0].id, quote: evidence[0].text }, { evidenceId: evidence[1].id, quote: evidence[1].text }] },
  };
}
test('GitHub targets cannot redirect credentials to another host or accept pull requests', () => {
  for (const url of ['https://evil.example/o/r/issues/1', 'https://github.com.evil.example/o/r/issues/1', 'https://user@github.com/o/r/issues/1', 'http://github.com/o/r/issues/1', 'https://github.com/o/r/pull/1']) assert.throws(() => githubIssue(url));
  assert.equal(githubIssue('https://github.com/o/r/issues/42').number, '42');
});
test('Notion page IDs are parsed without accepting unrelated hosts', () => {
  assert.equal(notionId('https://app.notion.com/p/Demo-3d616ba8283980f299b8da67f1f9df32?x=1'), '3d616ba8-2839-80f2-99b8-da67f1f9df32');
  assert.throws(() => notionId('https://evil.example/3d616ba8283980f299b8da67f1f9df32'));
});
test('Slack links preserve timestamp precision and enforce the selected channel', () => {
  assert.equal(slackTarget('CUNITTEST', 'https://test.slack.com/archives/CUNITTEST/p1700000000000001').timestamp, '1700000000.000001');
  assert.throws(() => slackTarget('COTHER', 'https://test.slack.com/archives/CUNITTEST/p1700000000000001'));
});
test('an invented citation cannot authorize a repair', () => {
  const assessment = fixture().assessment!;
  assert.throws(() => validateAssessment({ ...assessment, citations: [{ evidenceId: 'notion:commitment', quote: 'invented evidence' }] }, evidence));
  assert.throws(() => validateAssessment({ ...assessment, citations: [{ evidenceId: 'missing', quote: evidence[0].text }] }, evidence));
  assert.deepEqual(validateAssessment(assessment, evidence), assessment);
});
test('repair requires evidence from both the commitment and engineering issue', () => {
  const assessment = fixture().assessment!;
  assert.throws(() => validateAssessment({ ...assessment, citations: assessment.citations.slice(0, 1) }, evidence));
});
test('no-change and clarification outcomes cannot generate external actions', () => {
  for (const decision of ['no_change', 'clarify'] as const) {
    const run = fixture(); run.assessment!.decision = decision;
    assert.deepEqual(planActions(run), []);
  }
});
test('approval hash binds action content, evidence and targets, not mutable progress', () => {
  const run = fixture(); run.actions = planActions(run);
  const hash = planHash(run);
  run.actions[0].status = 'verified'; run.actions[0].externalId = 'unit-external';
  assert.equal(planHash(run), hash);
  run.actions[0].body += 'unapproved change';
  assert.notEqual(planHash(run), hash);
});
test('Slack generated text cannot introduce special mention markup', () => {
  assert.equal(slackText('<!channel> & <@U123>'), '&lt;!channel&gt; &amp; &lt;@U123&gt;');
});
test('SQLite recovery preserves verified writes and marks interrupted writes unknown', () => {
  const store = new Store(':memory:');
  const run = fixture(); run.actions = planActions(run); run.status = 'executing';
  run.actions[0].status = 'verified'; run.actions[0].externalId = 'unit-comment';
  run.actions[1].status = 'in_flight';
  store.save(run); store.recover();
  const recovered = store.get(run.id);
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.actions[0].externalId, 'unit-comment');
  assert.equal(recovered.actions[0].status, 'verified');
  assert.equal(recovered.actions[1].status, 'unknown');
  assert.equal(recovered.actions[2].status, 'pending');
  store.db.close();
});
test('interrupted analysis stops without leaving a permanently active run', () => {
  const store = new Store(':memory:'); const run = fixture(); run.status = 'collecting';
  store.save(run); store.recover();
  assert.equal(store.get(run.id).status, 'failed');
  assert.deepEqual(store.get(run.id).actions, []);
  store.db.close();
});
test('ambiguous writes must reconcile instead of being treated as fresh actions', () => {
  assert.equal(requiresReconciliation('unknown'), true);
  assert.equal(requiresReconciliation('in_flight'), true);
  assert.equal(requiresReconciliation('pending'), false);
});

test('Slack copied links tolerate surrounding whitespace without changing precision', () => {
  assert.deepEqual(slackTarget(' CUNITTEST ', ' https://app.slack.com/archives/CUNITTEST/p1788937843944739 '), { channelId: 'CUNITTEST', timestamp: '1788937843.944739' });
  assert.notEqual(slackMessageUrl('CUNITTEST', '1788937843.944739'), slackMessageUrl('CUNITTEST', '1788937843.944737'));
});
test('Slack reply links select their explicit parent thread', () => {
  assert.equal(slackTarget('https://app.slack.com/client/TUNIT/CUNITTEST', 'https://test.slack.com/archives/CUNITTEST/p1788937900000001?thread_ts=1788937843.944739&cid=CUNITTEST').timestamp, '1788937843.944739');
});
test('Slack malformed parent timestamps and inconsistent channels cannot silently fall back', () => {
  for (const query of ['thread_ts=', 'thread_ts=1788937843.9447', 'thread_ts=invalid', 'cid=COTHER', 'thread_ts=1788937843.944739&cid=COTHER']) {
    assert.throws(() => slackTarget('CUNITTEST', `https://test.slack.com/archives/CUNITTEST/p1788937900000001?${query}`));
  }
});
test('Slack rejects channel-only URLs and credential-bearing or unrelated links', () => {
  for (const link of ['https://test.slack.com/archives/CUNITTEST', 'https://test.slack.com/archives/CUNITTEST/p123', 'https://user@test.slack.com/archives/CUNITTEST/p1788937843944739', 'https://slack.com.evil.example/archives/CUNITTEST/p1788937843944739']) assert.throws(() => slackTarget('CUNITTEST', link));
});
test('Slack canonical links round-trip all six fractional digits', () => {
  for (const timestamp of ['1788937843.000001', '1788937843.944739', '1788937843.999999']) {
    const url = slackMessageUrl('CUNITTEST', timestamp);
    assert.equal(slackTarget('CUNITTEST', url).timestamp, timestamp);
  }
});
