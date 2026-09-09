import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Run, Targets } from '../server/domain';
import './styles.css';

type Connection = { provider: string; status: string; detail: string; models?: { id: string; name: string }[] };
const initialTargets: Targets = { issueUrl: '', notionPageUrl: '', slackChannel: '', slackThread: '', owner: '', model: 'gemini-3.1-flash-lite' };
const labels: Record<string, string> = { collecting: 'Reading evidence', review: 'Ready for review', executing: 'Applying repair', partial: 'Needs attention', completed: 'Verified', no_change: 'No change needed', clarify: 'Needs context', failed: 'Analysis stopped', stale: 'Evidence changed', dismissed: 'Dismissed' };
function External({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href.startsWith('https://') ? href : undefined} target="_blank" rel="noreferrer">{children} <span aria-hidden="true">↗</span></a>;
}
function App() {
  const [userName, setUserName] = useState('');
  const [session, setSession] = useState('');
  const [targets, setTargets] = useState<Targets>(initialTargets);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tab, setTab] = useState<'workspace' | 'connections' | 'history'>('workspace');
  const [reviewView, setReviewView] = useState<'evidence' | 'changes' | 'activity'>('evidence');
  const [editing, setEditing] = useState(false);
  const [threadCheck, setThreadCheck] = useState('');
  const [sourceMode, setSourceMode] = useState<'github' | 'notion'>('github');
  const [includeSlack, setIncludeSlack] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const run = runs.find(r => r.id === selected);
  async function api(path: string, data?: unknown) {
    const response = await fetch(path, data === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PromiseGuard-Session': session }, body: JSON.stringify(data) });
    const value = await response.json();
    if (response.status === 401) { location.reload(); throw new Error('Please sign in again.'); }
    if (!response.ok) throw new Error(value.error || 'Request failed.');
    return value;
  }
  useEffect(() => {
    fetch('/api/bootstrap').then(r => { if (r.status === 401) { location.reload(); throw new Error('Please sign in again.'); } return r.json(); }).then(data => {
      if (data.error) throw new Error(data.error);
      setUserName(data.user.name); setSession(data.session); setTargets(data.targets || initialTargets); setSourceMode(data.targets?.notionPageUrl ? 'notion' : 'github'); setIncludeSlack(Boolean(data.targets?.slackChannel)); setRuns(data.runs);
      setSelected(data.runs[0]?.id || '');
      setConnections(['GitHub', 'Notion', 'Slack', 'Gemini'].map((provider, i) => ({ provider, status: data.configured[['GITHUB_TOKEN', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN', 'GEMINI_API_KEY'][i]] ? 'unchecked' : 'missing', detail: 'Check connections to verify access.' })));
      setLoaded(true);
    }).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    const poll = setInterval(() => {
      fetch('/api/runs', {headers:{'X-PromiseGuard-Session':session}}).then(r => { if (r.status === 401 || r.status === 403) { location.reload(); throw new Error('Please sign in again.'); } if (!r.ok) throw new Error('Could not refresh runs.'); return r.json(); }).then(data => { if (active) setRuns(data); }).catch(() => { if (active) setError('Connection to the local server was interrupted. Saved runs will resume when the server is available.'); });
    }, 2000);
    return () => { active = false; clearInterval(poll); };
  }, [loaded, session]);
  useEffect(() => { setReviewed(false); setReviewView('evidence'); }, [selected, run?.planHash]);
  async function perform(name: string, work: () => Promise<void>) {
    setBusy(name); setError('');
    try { await work(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  const running = runs.some(r => ['collecting', 'executing'].includes(r.status));
  const pending = runs.some(r => ['review', 'partial'].includes(r.status));
  const connected = connections.filter(c => c.status === 'connected').length;
  const models = connections.find(c => c.provider === 'Gemini')?.models?.filter(m => /gemini.*(flash|pro)/.test(m.id) && !/(image|tts|transcribe|robotics|customtools)/.test(m.id));
  function field(key: keyof Targets, value: string) { if (key === 'slackChannel' || key === 'slackThread') setThreadCheck(''); setTargets(t => ({ ...t, [key]: value })); }
  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    await perform('analyze', async () => {
      const input = { ...targets, notionPageUrl: sourceMode === 'notion' ? targets.notionPageUrl : '', commitmentIssueUrl: sourceMode === 'github' ? targets.commitmentIssueUrl : undefined, slackChannel: includeSlack ? targets.slackChannel : '', slackThread: includeSlack ? targets.slackThread : '' };
      const created = await api('/api/analyze', input);
      setTargets(created.targets); setRuns(rs => [created, ...rs]); setSelected(created.id); setEditing(false);
    });
  }
  function selectRun(id: string) { setReviewView('evidence'); setSelected(id); setTab('workspace'); setEditing(false); requestAnimationFrame(() => document.getElementById('review-workspace')?.scrollIntoView({ block: 'start' })); }
  async function approve() {
    if (!run) return;
    await perform('approve', async () => {
      const updated = await api(`/api/runs/${run.id}/approve`, { planHash: run.planHash });
      setRuns(rs => rs.map(r => r.id === updated.id ? updated : r));
      setReviewed(false);
    });
  }
  const verified = run?.actions.filter(a => a.status === 'verified').length || 0;
  const activeTargets = run?.targets || targets;
  const sourceNames = ['Notion', 'GitHub', 'Slack'];
  const selectedSources = ['GitHub', ...(activeTargets.notionPageUrl ? ['Notion'] : []), ...(activeTargets.slackChannel ? ['Slack'] : [])];
  const runTitle = run?.snapshot?.evidence.find(e => ['notion:commitment', 'github:commitment'].includes(e.id))?.title || 'Commitment analysis';
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <header className="app-header">
      <a className="brand" href="/" aria-label="PromiseGuard home"><span className="brand-mark" aria-hidden="true">↗</span>PromiseGuard<span className="brand-period">.</span></a>
      <nav aria-label="Main navigation">{(['workspace', 'history', 'connections'] as const).map(item => <button key={item} className={tab === item ? 'nav-item active' : 'nav-item'} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item === 'workspace' ? 'Workspace' : item === 'history' ? 'Run history' : 'Connections'}{item === 'connections' && <span className="nav-count">{connections.filter(c => c.status !== 'missing').length}</span>}</button>)}</nav>
      <div className="workspace-identity"><span className="workspace-avatar">{userName.slice(0,1).toUpperCase()}</span><div>{userName}<small>Your workspace</small></div><button className="text-button" onClick={() => perform('logout', async () => { await api('/api/logout', {}); location.reload(); })}>Sign out</button></div>
    </header>
    <main id="main-content">
      {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {!loaded && <p role="status" className="loading-state">Opening your workspace…</p>}
      {tab === 'workspace' && <>
        <section className="hero">
          <div className="hero-copy"><span className="eyebrow"><span className="square-dot" /> THE COMMITMENT CONTROL ROOM</span><h1>Promises, meet<br/><em>reality.</em></h1><p>Connect what was promised to what’s actually happening.<br className="desktop-break"/> Review the evidence. Make the next move.</p><a className="hero-link" href="#review-workspace">{run ? 'Open decision desk' : 'Link your first commitment'} <span aria-hidden="true">↗</span></a></div>
          <div className="workflow-map" aria-label="GitHub evidence with optional Notion and Slack context is assessed before approval and verification">
            <div className="map-caption"><span className="eyebrow">YOUR TOOLS. ONE CLEAR PICTURE.</span><span className="map-index">01 — 03</span></div>
            <div className="map-sources">{sourceNames.map((provider, i) => <div className="map-source" key={provider}><Provider name={provider}/><strong>{provider}</strong><small>{['Optional commitment', 'Required evidence', 'Optional context'][i]}</small></div>)}</div>
            <div className="map-lines" aria-hidden="true"><span/><span/><span/></div>
            <div className="map-decision"><span className="decision-icon" aria-hidden="true">✳</span><div><strong>Evidence assessment</strong><small>Gemini connects the facts</small></div><span className="map-arrow" aria-hidden="true">↓</span></div>
            <div className="map-outcome"><span className="square-dot"/><span>You approve.</span><strong>We apply & verify.</strong></div>
          </div>
        </section>
        <section className="metrics" aria-label="Workspace statistics"><div><span className="metric-label">AWAITING REVIEW</span><strong>{runs.filter(r => r.status === 'review').length.toString().padStart(2, '0')}</strong><span className="metric-description">{runs.some(r => r.status === 'review') ? 'Ready for your decision' : 'No reviews waiting'} <span className="orange">↗</span></span></div><div><span className="metric-label">VERIFIED REPAIRS</span><strong>{runs.filter(r => r.status === 'completed').length.toString().padStart(2, '0')}</strong><span className="metric-description">All planned changes confirmed</span></div><div><span className="metric-label">TOTAL RUNS</span><strong>{runs.length.toString().padStart(2, '0')}</strong><span className="metric-description">Every attempt stays on record</span></div><button className="metric-connection" onClick={() => setTab('connections')}><span className="provider-stack">{['GitHub', 'Notion', 'Slack', 'Gemini'].map(name => <Provider name={name} key={name}/>)}</span><strong>{connected === 4 ? 'All connections verified' : 'Your connected tools'}</strong><span>{connected === 4 ? 'Access checked this session' : 'Check connection access'} <span aria-hidden="true">↗</span></span></button></section>
        <div className="workspace-section-heading" id="review-workspace"><div><span className="eyebrow">THE WORKSPACE</span><h2>From signal to action<span className="orange">.</span></h2></div><button className="secondary" disabled={running || pending || Boolean(busy)} onClick={() => { setSelected(''); setEditing(true); setSourceMode('github'); setIncludeSlack(false); setThreadCheck(''); setTargets({ ...initialTargets, owner: targets.owner, model: targets.model }); }}>New analysis ↗</button></div>
        <div className="workspace-grid">
          <aside className="source-panel">
            <div className="section-title"><h3>Linked commitment</h3><span className="eyebrow">01</span></div>
            {run && !editing ? <>
              <div className="commitment-identity"><span className={`badge ${run.status}`}>{labels[run.status]}</span><h3>{runTitle}</h3><div className="owner-line"><span className="owner-avatar">{activeTargets.owner.slice(0, 1).toUpperCase()}</span><div><small>RESPONSIBLE OWNER</small><strong>{activeTargets.owner}</strong></div></div></div>
              <div className="source-list">{activeTargets.commitmentIssueUrl && <div className="source-row"><Provider name="GitHub"/><div><strong>Commitment issue</strong><small>The documented promise</small></div><External href={activeTargets.commitmentIssueUrl}><span className="sr-only">Open commitment issue</span></External></div>}{selectedSources.map(provider => { const source = run.snapshot?.evidence.find(e => provider === 'GitHub' ? e.id === 'github:issue' : e.provider === provider); const fallback = provider === 'GitHub' ? activeTargets.issueUrl : provider === 'Notion' ? activeTargets.notionPageUrl : activeTargets.slackThread; return <div className="source-row" key={provider}><Provider name={provider}/><div><strong>{provider}</strong><small>{source ? `${run.snapshot!.evidence.filter(e => e.provider === provider).length} evidence records collected` : 'Awaiting collection'}</small></div><External href={source?.url || fallback}><span className="sr-only">Open {provider} source</span></External></div>; })}</div>
              <div className="source-meta"><span>ANALYZED WITH</span><strong>{activeTargets.model}</strong><span>CREATED</span><strong>{new Date(run.createdAt).toLocaleString()}</strong></div>
              <button className="secondary full" onClick={() => { setTargets(run.targets); setSourceMode(run.targets.notionPageUrl ? 'notion' : 'github'); setIncludeSlack(Boolean(run.targets.slackChannel)); setThreadCheck(''); setEditing(true); }}>Edit source links <span aria-hidden="true">↗</span></button>
              {pending && <p className="form-help">Finish or dismiss the pending review before analyzing another commitment.</p>}
            </> : <form onSubmit={analyze}>
              <p className="form-intro">Start with GitHub. Add only the tools this commitment needs.</p>
              <fieldset className="source-options"><legend>Where is the commitment?</legend><label><input type="radio" name="commitment-source" checked={sourceMode === 'github'} onChange={() => setSourceMode('github')}/>GitHub issue</label><label><input type="radio" name="commitment-source" checked={sourceMode === 'notion'} onChange={() => setSourceMode('notion')}/>Notion page</label></fieldset>
              {sourceMode === 'github' && <><label htmlFor="commitment-issue">GitHub commitment issue</label><input id="commitment-issue" type="url" placeholder="Issue documenting the promise" value={targets.commitmentIssueUrl || ''} onChange={e => field('commitmentIssueUrl', e.target.value)} required/><p className="form-help">This issue should state the commitment and link its required engineering issue.</p></>}

              <label htmlFor="issue">GitHub engineering issue</label><input id="issue" type="url" placeholder="https://github.com/owner/repo/issues/1" value={targets.issueUrl} onChange={e => field('issueUrl', e.target.value)} required/>
              {sourceMode === 'notion' && <><label htmlFor="notion">Notion commitment page</label><input id="notion" type="url" placeholder="Paste your Notion page link" value={targets.notionPageUrl} onChange={e => field('notionPageUrl', e.target.value)} required/></>}
              <label className="optional-toggle"><input type="checkbox" checked={includeSlack} onChange={e => { setIncludeSlack(e.target.checked); setThreadCheck(''); }}/>Include Slack discussion and notification</label>
              {includeSlack && <><label htmlFor="channel">Slack channel URL or ID</label><input id="channel" placeholder="Channel link or C…" value={targets.slackChannel} onChange={e => field('slackChannel', e.target.value)} required/>
              <label htmlFor="thread">Slack discussion message link</label><input id="thread" aria-describedby="slack-link-help" placeholder="Message menu → Copy link" value={targets.slackThread} onChange={e => field('slackThread', e.target.value)} required/>
              <p className="form-help" id="slack-link-help">In Slack, open the discussion message menu → Copy link. Paste the full link to preserve its exact identity.</p>
              <button className="secondary full" type="button" disabled={!session || Boolean(busy) || !targets.slackChannel.trim() || !targets.slackThread.trim()} onClick={() => perform('thread-check', async () => {
                setThreadCheck('');
                const channel = targets.slackChannel; const thread = targets.slackThread;
                const result = await api('/api/slack/check', { channel, thread });
                setTargets(current => {
                  if (current.slackChannel !== channel || current.slackThread !== thread) return current;
                  return { ...current, slackChannel: result.channelId, slackThread: result.url };
                });
                setThreadCheck(`${result.channelId}|${result.url}`);
              })}>{busy === 'thread-check' ? 'Checking thread…' : 'Check Slack thread'}</button>
              {threadCheck === `${targets.slackChannel}|${targets.slackThread}` && <p className="form-help" role="status">Thread is readable. The exact message link is preserved.</p>}
              </>}<label htmlFor="owner">Responsible owner</label><input id="owner" placeholder="Name or team" value={targets.owner} onChange={e => field('owner', e.target.value)} maxLength={100} required/>
              <label htmlFor="model">Gemini model</label><select id="model" value={targets.model} onChange={e => field('model', e.target.value)}>{!models?.some(m => m.id === targets.model) && <option value={targets.model}>{targets.model}</option>}{models?.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select>
              <button className="primary full" type="submit" disabled={!loaded || Boolean(busy) || running || pending}>{busy === 'analyze' || running ? 'Analysis in progress…' : 'Analyze commitment ↗'}</button>
              <p className="form-help">Relevant source content is sent to Gemini. You review proposed changes before anything is written.</p>
              {pending && <p className="form-help warning">Finish or dismiss the pending run before starting another.</p>}
              {run && <button className="text-button" type="button" onClick={() => setEditing(false)}>Return to linked commitment</button>}
              {sourceMode === 'notion' && <details className="setup-details"><summary>Prepare your Notion page</summary><p>Use plain paragraphs for the promise and its required GitHub issue link. Add a separate paragraph beginning <strong>Delivery status:</strong>. Share the flat page with PromiseGuard. Only that status paragraph can be replaced after approval.</p></details>}
            </form>}
            <div className="source-footnote"><span aria-hidden="true">↳</span> Evidence collected from the exact records you select.</div>
          </aside>
          <section className="review-panel" aria-label="Commitment review">
            <div className="review-top"><span className="eyebrow">DECISION DESK</span>{run && <span className="run-reference">RUN / {run.id.slice(0, 8)}</span>}</div>
            {!run ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">◎</span><h3>Your next clear decision<br/>starts here.</h3><p>Link a commitment to uncover the evidence and review the next action.</p><div className="empty-steps"><span>01 / Collect</span><span>02 / Review</span><span>03 / Verify</span></div></div> : <>
              <div className="run-heading"><h3>{run.status === 'completed' ? 'The records are back in sync.' : ['partial', 'stale', 'dismissed', 'executing'].includes(run.status) ? labels[run.status] : run.assessment?.decision === 'repair' ? 'A promise needs your attention.' : run.assessment?.decision === 'no_change' ? 'The evidence supports this promise.' : run.assessment?.decision === 'clarify' ? 'A little more context is needed.' : labels[run.status]}</h3><span className={`badge ${run.status}`}>{labels[run.status]}</span></div>
              {run.error && <div className="alert warning">{run.error}</div>}
              {run.status === 'collecting' && <div className="analysis-progress" role="status"><span className="spinner"/>Reading the sources and assessing the commitment…</div>}
              <div className="review-tabs" role="group" aria-label="Review sections">{(['evidence', 'changes', 'activity'] as const).map(view => <button key={view} aria-pressed={reviewView === view} className={reviewView === view ? 'selected' : ''} onClick={() => setReviewView(view)}>{view === 'evidence' ? 'Evidence' : view === 'changes' ? (run.status === 'completed' ? 'Changes' : 'Proposed changes') : 'Activity'}<span>{view === 'evidence' ? run.assessment?.citations.length || 0 : view === 'changes' ? run.actions.length : run.events.length}</span></button>)}</div>
              <div className="review-content">
                {reviewView === 'evidence' && <>
                  {run.assessment ? <><span className="eyebrow">ASSESSMENT AT COLLECTION</span><p className="assessment-summary">{run.assessment.summary}</p>{run.assessment.blocker && <div className="blocker"><span className="blocker-icon" aria-hidden="true">!</span><div><strong>THE BLOCKER</strong><p>{run.assessment.blocker}</p></div></div>}<div className="section-title evidence-title"><h4>What the sources say</h4><span className="eyebrow">CITED EVIDENCE</span></div><div className="citation-list">{run.assessment.citations.map((c, i) => { const source = run.snapshot?.evidence.find(e => e.id === c.evidenceId); return <article className="citation" key={i}><div className="citation-heading"><Provider name={source?.provider || 'Source'}/><strong>{source?.provider || 'Source'}</strong><span className="citation-index">0{i + 1}</span></div><blockquote>“{c.quote}”</blockquote>{source && <External href={source.url}>{source.title}</External>}</article>; })}</div></> : <p className="muted">{run.status === 'collecting' ? 'Source citations will appear when the assessment is ready.' : 'No assessment was produced for this run. See Activity for the recorded details.'}</p>}
                  {run.actions.length > 0 && <div className="next-step"><div><span className="eyebrow">YOUR NEXT MOVE</span><strong>{run.status === 'completed' ? `${verified} verified changes, ready to inspect.` : `${run.actions.length} proposed changes, ready to inspect.`}</strong></div><button className="primary" onClick={() => setReviewView('changes')}>{run.status === 'completed' ? 'Inspect changes' : 'Review changes'} <span aria-hidden="true">↗</span></button></div>}
                </>}
                {reviewView === 'changes' && <><div className="changes-intro"><div><h4>{run.status === 'completed' ? 'What changed across your tools.' : 'Know exactly what will change.'}</h4><p>Exact text and destinations recorded for this run.</p></div><span className="verified-count">{verified}/{run.actions.length}<small>VERIFIED</small></span></div>{run.actions.length === 0 && <p className="muted">No external changes are proposed for this run.</p>}<div className="action-list">{run.actions.map((action, i) => <article className={`action-card ${action.status}`} key={action.id}><div className="action-top"><Provider name={action.provider}/><div><strong>{action.title}</strong><small>{action.provider} · Action {i + 1} of {run.actions.length}</small></div><span className={`badge ${action.status}`}>{action.status.replace('_', ' ')}</span></div>{action.provider === 'Notion' && run.snapshot?.notionStatus && <div className="before-status"><span>STATUS AT ANALYSIS</span><p>{run.snapshot.notionStatus.text}</p></div>}<pre tabIndex={0} aria-label={`${action.provider} proposed text`}>{action.body}</pre>{action.error && <p className="action-error">{action.error}</p>}<External href={action.url || action.target}>{action.status === 'verified' ? 'Inspect verified record' : 'Open destination'}</External></article>)}</div>
                  {['review', 'partial'].includes(run.status) && <div className="approval"><div className="approval-heading"><span className="eyebrow">THE DECISION IS YOURS</span><span aria-hidden="true">↗</span></div><label className="checkbox-label"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>I’ve reviewed these exact changes and authorize their execution.</label><button className="primary full" disabled={!reviewed || Boolean(busy) || running} onClick={approve}>{run.status === 'partial' ? 'Resume & verify remaining actions' : `Approve & apply ${run.actions.length} change${run.actions.length === 1 ? '' : 's'}`}</button><p>Each completed action is checked against the external record.</p></div>}
                  {run.status === 'completed' && <div className="completion"><strong>✓ {run.actions.length} change{run.actions.length === 1 ? '' : 's'} verified</strong><p>Every planned action was verified. The engineering blocker still needs resolution.</p></div>}
                </>}
                {reviewView === 'activity' && <><div className="section-title"><h4>A record of every step.</h4><span className="eyebrow">{run.events.length} EVENTS</span></div><ol className="timeline">{run.events.map((event, i) => <li key={i}><span className="timeline-dot"/><div><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><p>{event.text}</p></div></li>)}</ol></>}
              </div>
              <div className="review-footer"><span><span className="square-dot"/> {verified} of {run.actions.length} actions verified</span>{['review', 'partial', 'failed', 'stale', 'clarify'].includes(run.status) && <button className="text-button" disabled={Boolean(busy) || running} onClick={() => perform('dismiss', async () => { const updated = await api(`/api/runs/${run.id}/dismiss`, {}); setRuns(rs => rs.map(r => r.id === updated.id ? updated : r)); })}>Dismiss run</button>}</div>
            </>}
          </section>
        </div>
      </>}
      {tab === 'connections' && <section className="connections-page"><div className="page-heading"><span className="eyebrow">THE SOURCE OF TRUTH</span><h1>Good decisions.<br/><em>Connected tools.</em></h1><p>GitHub and Gemini get you started. Notion and Slack are optional for each run.</p></div><div className="section-toolbar"><h2>Your integrations <span className="inline-count">04</span></h2><button className="primary" disabled={!session || Boolean(busy)} onClick={() => perform('connections', async () => setConnections(await api('/api/connections', {})))}>{busy === 'connections' ? 'Checking access…' : 'Check connections ↗'}</button></div><div className="connection-grid">{connections.map(c => <article className="connection-card" key={c.provider}><div className="card-top"><Provider name={c.provider}/><span className={`badge ${c.status === 'missing' && ['Notion', 'Slack'].includes(c.provider) ? 'optional' : c.status}`}>{c.status === 'unchecked' ? 'Token saved · unchecked' : c.status === 'missing' && ['Notion', 'Slack'].includes(c.provider) ? 'Not connected · optional' : c.status}</span></div><h3>{c.provider}</h3><span className="eyebrow">{['Notion', 'Slack'].includes(c.provider) ? 'OPTIONAL' : 'REQUIRED'}</span><p>{({GitHub:'The engineering reality. Issues, blockers, and recovery handoffs.',Notion:'The customer promise. Commitments and delivery status.',Slack:'The team context. Discussions and owner notifications.',Gemini:'The reasoning layer. Evidence assessment and proposed changes.'} as Record<string,string>)[c.provider]}</p><div className="connection-detail">{c.detail}</div>{c.provider !== 'Gemini' && <ConnectionForm provider={c.provider} disabled={Boolean(busy) || running || pending} save={async token => { const provider = ({GitHub:'GITHUB_TOKEN',Notion:'NOTION_TOKEN',Slack:'SLACK_BOT_TOKEN'} as Record<string,string>)[c.provider]; await api('/api/connections/save', {provider,token}); setConnections(rows => rows.map(row => row.provider === c.provider ? {...row,status:token ? 'unchecked' : 'missing',detail:token ? 'Saved for your account. Check access to verify.' : 'Disconnected from your account.'} : row)); }}/>}</article>)}</div><details className="setup-note"><summary>Manage credentials and record access</summary><p>Save your own integration tokens here, then check access. Saved tokens are encrypted on the server and never returned to the browser. OAuth connection buttons will arrive in the next phase.</p><p>Gemini is configured by the server operator. Successful authentication does not guarantee access to every page, issue, or channel. Linked records are checked during analysis.</p></details></section>}
      {(tab === 'workspace' || tab === 'history') && <section className={tab === 'history' ? 'history history-page' : 'history'} id="recent-runs">{tab === 'history' && <div className="page-heading"><span className="eyebrow">THE PAPER TRAIL</span><h1>Every decision.<br/><em>Accounted for.</em></h1><p>Revisit the evidence, proposed changes, and outcome of every run.</p></div>}<div className="section-toolbar"><h2>{tab === 'history' ? 'All runs' : 'Recent runs'} <span className="inline-count">{runs.length.toString().padStart(2, '0')}</span></h2>{tab === 'workspace' && <button className="text-button" onClick={() => setTab('history')}>View history ↗</button>}</div>{!runs.length ? <div className="history-empty">Your first analysis will start the record.</div> : <div className="history-list"><div className="history-labels"><span>COMMITMENT</span><span>OWNER / CREATED</span><span>OUTCOME</span><span/></div>{(tab === 'history' ? runs : runs.slice(0, 4)).map(r => <button className={r.id === selected ? 'history-row selected' : 'history-row'} key={r.id} onClick={() => selectRun(r.id)}><strong>{r.snapshot?.evidence[0]?.title || 'Commitment analysis'}</strong><span className="history-meta">{r.targets.owner}<small>{new Date(r.createdAt).toLocaleString()}</small></span><span className={`badge ${r.status}`}>{labels[r.status]}</span><span aria-hidden="true">↗</span></button>)}</div>}</section>}
      <footer><a className="footer-brand" href="/">PromiseGuard<span className="orange">.</span></a><span>Evidence before action. Proof after.</span><span className="footer-local">PRIVATE WORKSPACE / V0.1</span></footer>
    </main>
  </div>;
}
function Provider({ name }: { name: string }) {
  return <span className={`provider-icon ${name.toLowerCase()}`} aria-hidden="true">{name === 'GitHub' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M8 20v-3c-4 1-5-2-5-2m13 5v-4c0-1-.4-2-1-2 3-.5 5-2 5-5 0-1.4-.4-2.4-1.3-3.4.3-1 .3-2.1-.2-3.1-1.4-.1-2.5.5-3.5 1.2a13 13 0 0 0-6 0C8 3 6.9 2.4 5.5 2.5c-.5 1-.5 2.1-.2 3.1C4.4 6.6 4 7.6 4 9c0 3 2 4.5 5 5-.6.5-1 1-1 2"/></svg> : name === 'Slack' ? '#' : name === 'Gemini' ? '✦' : name.slice(0, 1)}</span>;
}
function ConnectionForm({provider, disabled, save}: {provider:string;disabled:boolean;save:(token:string)=>Promise<void>}) {
  const [token,setToken] = useState(''), [error,setError] = useState(''), [saving,setSaving] = useState(false);
  async function submit(value:string) { setSaving(true); setError(''); try { await save(value); setToken(''); } catch(e) { setError((e as Error).message); } finally {setSaving(false);} }
  return <form className="connection-form" onSubmit={e => {e.preventDefault(); void submit(token);}}><label htmlFor={`token-${provider}`}>Your {provider} token</label><input id={`token-${provider}`} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} maxLength={8000}/><div className="connection-buttons"><button className="secondary" disabled={disabled || saving || !token.trim()} type="submit">Save token</button><button className="text-button" disabled={disabled || saving} type="button" onClick={() => void submit('')}>Disconnect</button></div>{error && <p role="alert">{error}</p>}</form>;
}
function Auth() {
  useEffect(() => { const restored = (event:PageTransitionEvent) => { if (event.persisted) location.reload(); }; addEventListener('pageshow',restored); return () => removeEventListener('pageshow',restored); }, []);
  const [state,setState] = useState<'loading'|'login'|'ready'>('loading');
  const [name,setName] = useState(''), [password,setPassword] = useState(''), [confirmPassword,setConfirmPassword] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [authMode,setAuthMode] = useState<'login'|'signup'>('signup');
  const [providers,setProviders] = useState<Record<string,boolean>>({});
  useEffect(() => {
    const authError = new URLSearchParams(location.search).get('auth_error');
    if (authError) { setError(authError); history.replaceState({},'',location.pathname); }
    Promise.all([fetch('/api/bootstrap'),fetch('/api/auth/providers')]).then(async ([workspace,available]) => {
      if (available.ok) setProviders(await available.json());
      if (workspace.ok) setState('ready'); else if (workspace.status === 401) setState('login'); else throw new Error('Could not open the workspace. Reload to retry.');
    }).catch(e => {setError(e.message);setState('login');});
  },[]);
  if (state === 'ready') return <App/>;
  async function submit(e:React.FormEvent) {
    e.preventDefault(); setError('');
    if (authMode === 'signup' && password !== confirmPassword) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const response=await fetch(authMode === 'signup' ? '/api/signup' : '/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password})});
      const data=await response.json(); if(!response.ok) throw new Error(data.error);
      setPassword(''); setConfirmPassword(''); setState('ready');
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const title=authMode === 'signup' ? 'Create your workspace' : 'Welcome back';
  return <main className="signin"><a className="brand" href="/">PromiseGuard<span className="orange">.</span></a><section><span className="eyebrow">YOUR COMMITMENTS. YOUR WORKSPACE.</span><h1>{title}<span className="orange">.</span></h1><p>Use Google, GitHub, or Slack, or create a PromiseGuard account directly.</p>{state === 'loading' ? <p role="status">Opening workspace…</p> : <><div className="social-auth" aria-label="Social sign in">{(['google','github','slack'] as const).map(provider => providers[provider] ? <a className="social-button" href={`/api/auth/${provider}/start`} key={provider}><Provider name={provider[0].toUpperCase()+provider.slice(1)}/><span>Continue with {provider[0].toUpperCase()+provider.slice(1)}</span></a> : <span className="social-button unavailable" aria-disabled="true" key={provider}><Provider name={provider[0].toUpperCase()+provider.slice(1)}/><span>{provider[0].toUpperCase()+provider.slice(1)} setup pending</span></span>)}</div><div className="auth-divider"><span>Or use a password</span></div><form onSubmit={submit}><label htmlFor="username">Username</label><input id="username" value={name} onChange={e => setName(e.target.value)} autoComplete="username" minLength={3} maxLength={100} required/><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} minLength={12} maxLength={256} required/>{authMode === 'signup' && <><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" minLength={12} maxLength={256} required/></>}{error && <p className="alert error" role="alert">{error}</p>}<button className="primary full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create workspace ↗' : 'Sign in ↗'}</button><button className="auth-switch" type="button" onClick={() => {setAuthMode(authMode === 'signup' ? 'login' : 'signup');setError('');setPassword('');setConfirmPassword('');}}>{authMode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></form><p className="auth-legal">By continuing, you agree to the <a href="/terms.html">Terms</a> and acknowledge the <a href="/privacy.html">Privacy Policy</a>.</p></>}</section></main>;
}
createRoot(document.getElementById('root')!).render(<Auth />);
