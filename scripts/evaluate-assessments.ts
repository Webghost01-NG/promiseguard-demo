import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assessmentEvaluationCases, type ExpectedDecision } from './assessment-evaluation-cases.ts';
import { Providers } from '../server/providers.ts';

type EvaluationResult = {
  id: string;
  expected: ExpectedDecision;
  actual?: ExpectedDecision;
  passed: boolean;
  attempts: number;
  apiRetries: number;
  latencyMs: number;
  error?: string;
};

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run evaluate -- [--model MODEL] [--threshold 0.75] [--interval-ms 5000] [--output artifacts/evaluation.json]');
  process.exit(0);
}

const model = argument('--model') || process.env.PROMISEGUARD_EVAL_MODEL || assessmentEvaluationCases[0].targets.model;
if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('The evaluation model ID is invalid.');
const threshold = Number(argument('--threshold') || '0.75');
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('The evaluation threshold must be between 0 and 1.');
const intervalMs = Number(argument('--interval-ms') || '5000');
if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) throw new Error('The evaluation interval must be an integer between 0 and 60000 milliseconds.');
const output = resolve(argument('--output') || `artifacts/evaluation-${new Date().toISOString().replaceAll(':', '-')}.json`);

class MeasuredProviders extends Providers {
  attempts = 0;

  override async request(provider: 'GitHub' | 'Notion' | 'Slack' | 'Gemini', path: string, method = 'GET', body?: unknown) {
    if (provider === 'Gemini' && path.endsWith(':generateContent')) this.attempts++;
    return super.request(provider, path, method, body);
  }
}

const results: EvaluationResult[] = [];
for (const [index, evaluation] of assessmentEvaluationCases.entries()) {
  if (index > 0 && intervalMs > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs));
  const providers = new MeasuredProviders();
  const started = performance.now();
  let apiRetries = 0;
  while (true) {
    try {
      const assessment = await providers.analyze(evaluation.snapshot, { ...evaluation.targets, model });
      const passed = assessment.decision === evaluation.expectedDecision;
      results.push({ id: evaluation.id, expected: evaluation.expectedDecision, actual: assessment.decision, passed, attempts: providers.attempts, apiRetries, latencyMs: Math.round(performance.now() - started) });
      console.log(`[${index + 1}/${assessmentEvaluationCases.length}] ${passed ? 'PASS' : 'FAIL'} ${evaluation.id}: expected ${evaluation.expectedDecision}, received ${assessment.decision}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown evaluation failure';
      if (apiRetries === 0 && /Gemini: UNAVAILABLE\b/.test(message)) {
        apiRetries++;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10000));
        continue;
      }
      results.push({ id: evaluation.id, expected: evaluation.expectedDecision, passed: false, attempts: providers.attempts, apiRetries, latencyMs: Math.round(performance.now() - started), error: message.slice(0, 300) });
      console.log(`[${index + 1}/${assessmentEvaluationCases.length}] ERROR ${evaluation.id}: ${message}`);
      break;
    }
  }
}

const decisions: ExpectedDecision[] = ['repair', 'no_change', 'clarify'];
const correct = results.filter(result => result.passed).length;
const report = {
  schemaVersion: 1,
  evaluatedAt: new Date().toISOString(),
  model,
  threshold,
  intervalMs,
  corpus: { total: assessmentEvaluationCases.length, synthetic: true },
  metrics: {
    correct,
    accuracy: correct / results.length,
    errors: results.filter(result => result.error).length,
    transientApiRetries: results.reduce((sum, result) => sum + result.apiRetries, 0),
    correctedAfterValidationRetry: results.filter(result => result.passed && result.attempts > 1).length,
    totalGeminiRequests: results.reduce((sum, result) => sum + result.attempts, 0),
    latencyMs: {
      total: results.reduce((sum, result) => sum + result.latencyMs, 0),
      average: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length),
      maximum: Math.max(...results.map(result => result.latencyMs)),
    },
    byExpectedDecision: Object.fromEntries(decisions.map(decision => {
      const matching = results.filter(result => result.expected === decision);
      return [decision, { total: matching.length, correct: matching.filter(result => result.passed).length }];
    })),
    confusionMatrix: Object.fromEntries(decisions.map(expected => [expected, Object.fromEntries(decisions.map(actual => [actual, results.filter(result => result.expected === expected && result.actual === actual).length]))])),
  },
  results,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`\nAccuracy: ${correct}/${results.length} (${(report.metrics.accuracy * 100).toFixed(1)}%)`);
console.log(`Validation retries: ${results.filter(result => result.attempts > 1).length}; API/validation errors: ${report.metrics.errors}`);
console.log(`Report: ${output}`);
if (report.metrics.errors > 0 || report.metrics.accuracy < threshold) process.exitCode = 1;
