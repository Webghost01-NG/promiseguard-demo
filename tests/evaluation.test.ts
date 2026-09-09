import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, validateTargets } from '../server/domain.ts';
import { assessmentEvaluationCases } from '../scripts/assessment-evaluation-cases.ts';

test('assessment evaluation corpus is balanced, valid and explicitly synthetic', () => {
  assert.ok(assessmentEvaluationCases.length >= 24);
  assert.equal(new Set(assessmentEvaluationCases.map(item => item.id)).size, assessmentEvaluationCases.length);

  const counts = { repair: 0, no_change: 0, clarify: 0 };
  for (const item of assessmentEvaluationCases) {
    counts[item.expectedDecision]++;
    assert.match(item.id, /^[a-z0-9-]+$/);
    assert.ok(item.description.length >= 30);
    assert.ok(item.tags.length >= 2);
    assert.deepEqual(validateTargets(item.targets), item.targets);
    assert.equal(item.snapshot.fingerprint, digest(item.snapshot.evidence));
    assert.equal(item.snapshot.evidence.find(source => source.id === 'github:issue')?.url, item.targets.issueUrl);
    assert.ok(item.snapshot.evidence.some(source => source.id === 'notion:commitment' || source.id === 'github:commitment'));
    assert.ok(item.snapshot.evidence.every(source => source.url.includes('promiseguard-evaluation') || source.url.includes('notion.so') || source.url.includes('app.slack.com')));
    if (item.expectedDecision === 'repair') {
      assert.ok(item.tags.some(tag => ['contradiction', 'readiness', 'dated-promise', 'acceptance', 'validation', 'blocked-build', 'regression', 'external-blocker'].includes(tag)));
    }
  }
  assert.deepEqual(counts, { repair: 8, no_change: 8, clarify: 8 });
});

test('evaluation corpus covers optional integrations and adversarial evidence', () => {
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('github-only')));
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('notion')));
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('slack')));
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('prompt-injection')));
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('conflicting-evidence')));
  assert.ok(assessmentEvaluationCases.some(item => item.tags.includes('already-accurate')));
});
