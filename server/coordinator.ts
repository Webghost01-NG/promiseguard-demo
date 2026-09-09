import { randomUUID } from 'node:crypto';
import { planActions, planHash, type Run, type Targets } from './domain.ts';
import { Providers, ProviderError } from './providers.ts';
import { Store } from './store.ts';

export function requiresReconciliation(status: string) { return ['unknown', 'in_flight'].includes(status); }
export class Coordinator {
  busy = false;
  constructor(public store: Store, public providers: Providers) {}
  async event(run: Run, text: string) {
    run.events.push({ at: new Date().toISOString(), text });
    await this.store.save(run);
  }
  async start(targets: Targets): Promise<Run> {
    if (this.busy || (await this.store.list()).some(r => ['collecting', 'review', 'executing', 'partial'].includes(r.status))) throw new Error('Finish or dismiss the current run before analyzing another commitment.');
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), createdAt: now, updatedAt: now, targets, status: 'collecting', actions: [], events: [] };
    await this.event(run, 'Reading the selected commitment and supporting evidence.');
    this.busy = true;
    void this.analyze(run).finally(() => { this.busy = false; });
    return run;
  }
  async analyze(run: Run) {
    try {
      run.snapshot = await this.providers.collect(run.targets);
      await this.event(run, `Collected ${run.snapshot.evidence.length} source records. Asking Gemini to assess the commitment.`);
      run.assessment = await this.providers.analyze(run.snapshot, run.targets);
      run.actions = planActions(run);
      run.planHash = planHash(run);
      run.status = run.assessment.decision === 'repair' ? 'review' : run.assessment.decision;
      await this.event(run, run.status === 'review' ? `Evidence checked. Review ${run.actions.length} proposed change${run.actions.length === 1 ? '' : 's'} before execution.` : run.status === 'no_change' ? 'No repair proposed. No external changes were made.' : 'More context is needed. No external changes were made.');
    } catch (error) {
      run.status = 'failed'; run.error = await this.providers.redact((error as Error).message);
      await this.event(run, 'Analysis stopped. No external changes were made.');
    }
  }
  async approve(id: string, hash: string): Promise<Run> {
    if (this.busy) throw new Error('A run is already active.');
    const run = await this.store.get(id);
    if (!['review', 'partial'].includes(run.status)) throw new Error('This run is not awaiting approval or recovery.');
    if (!hash || hash !== run.planHash || hash !== planHash(run)) throw new Error('The reviewed plan has changed. Refresh before approving.');
    run.approvedAt ||= new Date().toISOString();
    run.error = undefined;
    run.status = 'executing';
    await this.event(run, 'Repair approved. Checking source state before proceeding.');
    this.busy = true;
    void this.execute(run).finally(() => { this.busy = false; });
    return run;
  }
  async dismiss(id: string) {
    if (this.busy) throw new Error('Wait for the active request to finish.');
    const run = await this.store.get(id);
    if (!['review', 'partial', 'stale', 'failed', 'clarify'].includes(run.status)) throw new Error('This run cannot be dismissed.');
    if (run.actions.some(a => requiresReconciliation(a.status))) throw new Error('An external write has an unknown outcome. Resume to reconcile it before starting a new run.');
    run.status = 'dismissed';
    await this.event(run, 'Run dismissed. Previously verified external changes remain in place.');
    return run;
  }
  async execute(run: Run) {
    try {
      // Recover crash/timeout outcomes before any new mutation or stale-plan decision.
      for (const action of run.actions.filter(a => requiresReconciliation(a.status))) {
        const id = await this.providers.reconcile(run, action);
        if (!id) throw new Error(`${action.provider}: the previous write could not be confirmed. No retry was sent. Check the actual record and retry reconciliation after access is restored.`);
        action.externalId = id; action.status = 'verified'; action.error = undefined; action.verifiedAt = new Date().toISOString();
        await this.event(run, `${action.provider}: recovered the previous write from provider state.`);
      }
      const current = await this.providers.collect(run.targets, run);
      if (current.githubActor !== run.snapshot!.githubActor || current.slackActor !== run.snapshot!.slackActor || current.fingerprint !== run.snapshot!.fingerprint || current.notionStatus?.id !== run.snapshot!.notionStatus?.id) {
        run.status = 'stale'; throw new Error('Source evidence or connection identity changed after review. Dismiss this plan and analyze the latest records.');
      }
      const notionAction = run.actions.find(a => a.provider === 'Notion');
      if (notionAction) {
        const expectedStatus = notionAction.status === 'verified' ? notionAction.body : run.snapshot!.notionStatus?.text;
        if (!current.notionStatus || current.notionStatus.text !== expectedStatus) {
          run.status = 'stale'; throw new Error('The Notion delivery status changed after review. Analyze it again before making further changes.');
        }
      }
      for (const action of run.actions) {
        if (action.status === 'verified') {
          if (!await this.providers.verify(run, action)) throw new Error(`${action.provider}: a previously verified result has changed. No further writes were made.`);
          continue;
        }
        action.status = 'in_flight'; action.error = undefined;
        await this.event(run, `${action.provider}: submitting the approved change.`);
        try {
          const result = await this.providers.write(run, action);
          action.externalId = result.id; action.url = result.url;
          await this.store.save(run); // Persist external identity before attempting read-back.
          if (!await this.providers.verify(run, action)) throw new ProviderError(`${action.provider}: write response received, but read-back does not match.`, true);
          action.status = 'verified'; action.verifiedAt = new Date().toISOString();
          await this.event(run, `${action.provider}: change independently read back and verified.`);
        } catch (error) {
          action.status = action.externalId || !(error instanceof ProviderError) || error.uncertain ? 'unknown' : 'blocked';
          action.error = await this.providers.redact((error as Error).message);
          throw error;
        }
      }
      // Final receipt requires a fresh check of every planned external result.
      for (const action of run.actions) if (!await this.providers.verify(run, action)) throw new Error(`${action.provider}: final verification failed. Completion has not been claimed.`);
      run.status = 'completed';
      await this.event(run, `All ${run.actions.length} planned change${run.actions.length === 1 ? '' : 's'} verified. The engineering blocker still needs resolution.`);
    } catch (error) {
      if (run.status !== 'stale') run.status = 'partial';
      run.error = await this.providers.redact((error as Error).message);
      await this.event(run, 'Execution paused. Verified progress is saved; completion has not been claimed.');
    }
  }
}
