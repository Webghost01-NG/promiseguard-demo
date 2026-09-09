import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubIssue, notionId, slackTarget, slackMessageUrl, validateTargets, validateAssessment, planActions, planHash, slackText, type Run, type Evidence } from '../server/domain.ts';
import { Store } from '../server/store.ts';
import { requiresReconciliation } from '../server/coordinator.ts';
import { citationCatalog, groundCitationSelection, Providers } from '../server/providers.ts';

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
test('citation verification tolerates presentation-only typography and whitespace', () => {
  const assessment=fixture().assessment!;
  const styled={...assessment,citations:[
    {...assessment.citations[0],quote:'Release — blocked'},
    {...assessment.citations[1],quote:'Acceptance\u00a0check is failing.'}
  ]};
  const sources=[{...evidence[0],text:'Release - blocked'},evidence[1]];
  assert.deepEqual(validateAssessment(styled,sources),styled);
  assert.throws(()=>validateAssessment({...styled,citations:[{...styled.citations[0],quote:'Acceptance check has passed.'},styled.citations[1]]},sources));
});
test('Gemini citation selections resolve to exact bounded source passages', () => {
  const sources: Evidence[] = [
    { ...evidence[0], text: `  Customer promise — preserve punctuation.\n${'A'.repeat(750)} final sentence.` },
    evidence[1],
  ];
  const catalog = citationCatalog(sources);
  assert.ok(catalog.length >= 3);
  assert.ok(catalog.every(candidate => candidate.quote.length <= 600 && sources.find(source => source.id === candidate.evidenceId)!.text.includes(candidate.quote)));
  const selected = groundCitationSelection({ ...fixture().assessment, citations: [{ citationId: catalog[0].citationId }, { citationId: catalog.at(-1)!.citationId }] }, catalog) as {citations:{evidenceId:string;quote:string}[]};
  assert.deepEqual(selected.citations, [{ evidenceId: catalog[0].evidenceId, quote: catalog[0].quote }, { evidenceId: catalog.at(-1)!.evidenceId, quote: catalog.at(-1)!.quote }]);
  assert.throws(() => groundCitationSelection({ ...fixture().assessment, citations: [{ citationId: 'invented' }] }, catalog), /not in the evidence catalog/);
});
test('analysis asks Gemini for catalog IDs and returns server-owned source quotations', async () => {
  const providers = new Providers(() => ({}));
  let calls = 0;
  providers.request = async (_provider, _path, _method, body) => {
    calls++;
    const prompt = JSON.parse((body as any).contents[0].parts[0].text);
    const commitment = prompt.citationCatalog.find((candidate: any) => candidate.evidenceId === 'notion:commitment');
    const engineering = prompt.citationCatalog.find((candidate: any) => candidate.evidenceId === 'github:issue');
    assert.ok(commitment?.citationId && engineering?.citationId);
    assert.deepEqual((body as any).generationConfig.responseSchema.properties.citations.items.properties.citationId.enum, prompt.citationCatalog.map((candidate: any) => candidate.citationId));
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      decision: 'repair', summary: 'The acceptance gate remains blocked.', blocker: 'Acceptance check is failing.', nextAction: 'Investigate the acceptance check.',
      citations: [{ citationId: commitment.citationId }, { citationId: engineering.citationId }],
    }) }] } }] };
  };
  const run = fixture();
  const result = await providers.analyze(run.snapshot!, run.targets);
  assert.equal(calls, 1);
  assert.deepEqual(result.citations, evidence.map(source => ({ evidenceId: source.id, quote: source.text })));
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

function githubOnlyFixture(): Run {
  const run = fixture();
  run.targets = { ...run.targets, notionPageUrl: '', slackChannel: '', slackThread: '', commitmentIssueUrl: 'https://github.com/fixture/repo/issues/2' };
  run.snapshot!.evidence = [
    { id: 'github:commitment', provider: 'GitHub', title: 'Unit commitment', text: 'The release depends on the linked issue.', url: run.targets.commitmentIssueUrl! },
    evidence[1],
  ];
  delete run.snapshot!.notionStatus;
  delete run.snapshot!.slackActor;
  run.assessment!.citations = run.snapshot!.evidence.map(e => ({ evidenceId: e.id, quote: e.text }));
  return run;
}
test('GitHub-only targets require neither Notion nor Slack fields', () => {
  const { notionPageUrl, slackChannel, slackThread, ...input } = githubOnlyFixture().targets;
  const targets = validateTargets(input);
  assert.equal(targets.notionPageUrl, '');
  assert.equal(targets.slackChannel, '');
  assert.equal(targets.slackThread, '');
});
test('the commitment source must be explicit, unique, and separate from engineering', () => {
  const targets = githubOnlyFixture().targets;
  assert.throws(() => validateTargets({ ...targets, commitmentIssueUrl: '' }));
  assert.throws(() => validateTargets({ ...targets, commitmentIssueUrl: targets.issueUrl }));
  assert.throws(() => validateTargets({ ...targets, notionPageUrl: fixture().targets.notionPageUrl }));
  assert.throws(() => validateTargets({ ...targets, commitmentIssueUrl: 'https://evil.example/issues/2' }));
});
test('partial Slack selection is rejected rather than silently ignored', () => {
  const targets = githubOnlyFixture().targets;
  assert.throws(() => validateTargets({ ...targets, slackChannel: 'CUNITTEST' }));
  assert.throws(() => validateTargets({ ...targets, slackThread: '1700000000.000001' }));
});
test('GitHub-only repair needs both commitment and engineering citations', () => {
  const run = githubOnlyFixture();
  assert.deepEqual(validateAssessment(run.assessment, run.snapshot!.evidence), run.assessment);
  for (const citation of run.assessment!.citations) assert.throws(() => validateAssessment({ ...run.assessment, citations: [citation] }, run.snapshot!.evidence));
});
test('Notion status alone cannot substitute for the documented commitment', () => {
  const run = fixture();
  const status = { id: 'notion:status', provider: 'Notion', title: 'Unit status', text: 'Ready', url: run.targets.notionPageUrl };
  assert.throws(() => validateAssessment({ ...run.assessment, citations: [{ evidenceId: status.id, quote: status.text }, run.assessment!.citations[1]] }, [...evidence, status]));
});
test('all four integration combinations plan only their selected destinations', () => {
  for (const notion of [false, true]) for (const slack of [false, true]) {
    const run = notion ? fixture() : githubOnlyFixture();
    run.targets.slackChannel = slack ? 'CUNITTEST' : '';
    run.targets.slackThread = slack ? '1700000000.000001' : '';
    validateTargets(run.targets);
    const actions = planActions(run);
    assert.deepEqual(actions.map(a => a.provider), ['GitHub', ...(notion ? ['Notion'] : []), ...(slack ? ['Slack'] : [])]);
    if (slack && !notion) assert.doesNotMatch(actions.at(-1)!.body, /Commitment marked at risk;/);
  }
});
test('changing the integration selection invalidates approval', () => {
  const run = fixture(); run.actions = planActions(run);
  const hash = planHash(run);
  run.targets.slackChannel = ''; run.targets.slackThread = '';
  assert.notEqual(planHash(run), hash);
});
test('GitHub-only recovery preserves the single action without inventing other destinations', () => {
  const run = githubOnlyFixture(); run.actions = planActions(run); run.status = 'executing'; run.actions[0].status = 'in_flight';
  const store = new Store(':memory:'); store.save(run); store.recover();
  const recovered = store.get(run.id);
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.actions.length, 1);
  assert.equal(recovered.actions[0].status, 'unknown');
  assert.equal(recovered.snapshot!.notionStatus, undefined);
  assert.equal(recovered.snapshot!.slackActor, undefined);
  store.db.close();
});
