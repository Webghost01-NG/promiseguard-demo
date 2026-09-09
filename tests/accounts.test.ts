import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Store } from '../server/store.ts';
import { Accounts, encryptionKey } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { workflowGrantMeta, workflowToken } from '../server/workflow-oauth.ts';
import { buildGrant, GithubInstallationRequired, githubToken } from '../server/github-connection.ts';
import { redact } from '../server/providers.ts';
import type { Run } from '../server/domain.ts';
const password = 'synthetic-test-password-only';
function run(id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'): Run {
  return {id,createdAt:'2026-09-09',updatedAt:'2026-09-09',status:'review',targets:{issueUrl:'https://github.com/unit/fixture/issues/1',commitmentIssueUrl:'https://github.com/unit/fixture/issues/2',notionPageUrl:'',slackChannel:'',slackThread:'',owner:'Unit',model:'unit'},actions:[],events:[]};
}
test('passwords are salted; sessions expire and logout revokes them', async () => {
  const store = new Store(':memory:'); const accounts = new Accounts(store.db,randomBytes(32));
  try {
    await accounts.create('alice',password); await accounts.create('bobby',password);
    const rows = store.db.prepare('SELECT password FROM users').all() as {password:string}[];
    assert.notEqual(rows[0].password,rows[1].password); assert.notEqual(rows[0].password,password);
    await assert.rejects(accounts.login('alice','incorrect'));
    const signed = await accounts.login('alice',password); assert.equal(accounts.session(signed.token)?.name,'alice');
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM sessions').all()).includes(signed.token),false);
    accounts.logout(signed.token); assert.equal(accounts.session(signed.token),undefined);
    const next = await accounts.login('alice',password);store.db.exec('UPDATE sessions SET expires=0');assert.equal(accounts.session(next.token),undefined);
  } finally {store.db.close();}
});
test('operator bootstrap is idempotent and does not replace its password', async () => {
  const store = new Store(':memory:'); const accounts = new Accounts(store.db,randomBytes(32));
  try {
    const first=await accounts.ensurePasswordAccount('Admin.User',password);
    const again=await accounts.ensurePasswordAccount('admin.user','a-different-password');
    assert.equal(first.id,again.id);
    assert.equal((await accounts.login('admin.user',password)).user.id,first.id);
    await assert.rejects(accounts.login('admin.user','a-different-password'),/Invalid/);
  } finally {store.db.close();}
});
test('sign-in attempts are limited including unknown accounts', async () => {
  const store = new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try {for(let i=0;i<5;i++)await assert.rejects(accounts.login('unknown',password),/Invalid/);await assert.rejects(accounts.login('unknown',password),/Too many/);}finally{store.db.close();}
});
test('public registration is rate limited even when validation fails', async () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try {
    for(let i=0;i<5;i++) await assert.rejects(accounts.register('one-source','x','short'),/username/);
    await assert.rejects(accounts.register('one-source','valid-user',password),/Too many sign-up attempts/);
  } finally {store.db.close();}
});
test('social identities create one stable account and OAuth state is single use', () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try {
    const state=accounts.beginOauth('google','unit-verifier','unit-nonce');
    assert.deepEqual(accounts.consumeOauth('google',state),{verifier:'unit-verifier',nonce:'unit-nonce'});
    assert.equal(accounts.consumeOauth('google',state),undefined);
    const first=accounts.socialLogin('github','12345','Alice Dev','alice@example.test');
    const again=accounts.socialLogin('github','12345','A Changed Name','changed@example.test');
    const otherProvider=accounts.socialLogin('google','12345','Alice Dev','alice@example.test');
    assert.equal(first.user.id,again.user.id);
    assert.notEqual(first.user.id,otherProvider.user.id);
    assert.notEqual(first.user.name,otherProvider.user.name);
    assert.equal(accounts.session(first.token)?.id,first.user.id);
    const rows=store.db.prepare('SELECT provider,subject,email FROM identities ORDER BY provider').all().map(row=>({...row}));
    assert.deepEqual(rows,[{provider:'github',subject:'12345',email:'alice@example.test'},{provider:'google',subject:'12345',email:'alice@example.test'}]);
  } finally {store.db.close();}
});
test('workflow OAuth state is bound to one active user session and phase', async () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try {
    const alice=await accounts.create('alice',password),bob=await accounts.create('bobby',password);
    const a=await accounts.login(alice.name,password),b=await accounts.login(bob.name,password);
    const install=accounts.beginConnectionOauth(alice.id,a.token,'github-install');
    assert.equal(accounts.consumeConnectionOauth('github-authorize',install),undefined);
    const next=accounts.beginConnectionOauth(alice.id,a.token,'github-install');
    const saved=accounts.consumeConnectionOauth('github-install',next)!;
    assert.equal(saved.user_id,alice.id);assert.notEqual(saved.session_hash,b.token);assert.equal(accounts.consumeConnectionOauth('github-install',next),undefined);
    const revoked=accounts.beginConnectionOauth(alice.id,a.token,'github-install');accounts.logout(a.token);
    assert.equal(accounts.consumeConnectionOauth('github-install',revoked),undefined);
    assert.throws(()=>accounts.beginConnectionOauth(alice.id,b.token,'github-install'),/Sign in again/);
    const active=await accounts.login(alice.name,password);
    for(const phase of ['slack-connect','notion-connect'] as const){const state=accounts.beginConnectionOauth(alice.id,active.token,phase);assert.equal(accounts.consumeConnectionOauth(phase,state)?.user_id,alice.id);assert.equal(accounts.consumeConnectionOauth(phase,state),undefined);}
  } finally {store.db.close();}
});
test('encrypted tokens cannot be read by another user or moved between owners', () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try {
    accounts.setConnection('alice','GITHUB_TOKEN','synthetic-secret-for-unit-test');
    assert.deepEqual(accounts.credentials('bob'),{});
    const raw=store.db.prepare('SELECT secret FROM connections').get() as {secret:string};assert.ok(!raw.secret.includes('synthetic-secret'));
    store.db.prepare('INSERT INTO connections VALUES (?,?,?)').run('bob','GITHUB_TOKEN',raw.secret);
    assert.throws(()=>accounts.credentials('bob'));
    accounts.setConnection('alice','GITHUB_TOKEN','');assert.deepEqual(accounts.credentials('alice'),{});
    assert.throws(()=>accounts.setConnection('alice','GEMINI_API_KEY','x'));
  }finally{store.db.close();}
});
test('workflow OAuth metadata exposes workspace labels without grant secrets', () => {
  const slack=JSON.stringify({kind:'slack-oauth',accessToken:'hidden-slack',refreshToken:'hidden-refresh',expiresAt:0,teamId:'T1',teamName:'Unit Slack',botUserId:'B1'});
  const notion=JSON.stringify({kind:'notion-oauth',accessToken:'hidden-notion',refreshToken:'hidden-refresh',expiresAt:0,workspaceId:'N1',workspaceName:'Unit Notion',botId:'B2'});
  assert.deepEqual(workflowGrantMeta(slack),{type:'oauth',label:'Unit Slack'});
  assert.deepEqual(workflowGrantMeta(notion),{type:'oauth',label:'Unit Notion'});
  assert.equal(JSON.stringify([workflowGrantMeta(slack),workflowGrantMeta(notion)]).includes('hidden-'),false);
  assert.equal(workflowGrantMeta('manual-token'),undefined);
  assert.equal(redact('provider echoed hidden-slack and hidden-refresh',{SLACK_BOT_TOKEN:slack}),'provider echoed [redacted] and [redacted]');
});
test('GitHub authorization recovers every existing App installation and its selected repositories', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const path=new URL(String(input)).pathname+new URL(String(input)).search;
    if(path==='/user')return Response.json({id:7});
    if(path==='/user/installations?per_page=100&page=1')return Response.json({total_count:2,installations:[{id:42},{id:84}]});
    if(path==='/user/installations/42/repositories?per_page=100&page=1')return Response.json({total_count:1,repositories:[{full_name:'unit/one'}]});
    if(path==='/user/installations/84/repositories?per_page=100&page=1')return Response.json({total_count:2,repositories:[{full_name:'unit/two'},{full_name:'unit/one'}]});
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  try {
    const grant=await buildGrant({access_token:'unit-access',refresh_token:'unit-refresh',expires_in:60,refresh_token_expires_in:120});
    assert.deepEqual(grant.installationIds,[42,84]);assert.equal(grant.installationId,42);assert.deepEqual(grant.repositories,['unit/one','unit/two']);
    globalThis.fetch=async input=>new URL(String(input)).pathname==='/user'?Response.json({id:7}):Response.json({total_count:0,installations:[]});
    await assert.rejects(buildGrant({access_token:'unit-access'}),GithubInstallationRequired);
  } finally {globalThis.fetch=original;}
});
test('concurrent GitHub token use performs one refresh and preserves installation access', async () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));const original=globalThis.fetch;let refreshes=0;
  accounts.setConnection('alice','GITHUB_TOKEN',JSON.stringify({kind:'github-app-user',accessToken:'expired-access',refreshToken:'active-refresh',expiresAt:Date.now()-1,refreshExpiresAt:Date.now()+3600000,githubUserId:7,installationId:42,installationIds:[42],repositories:['unit/old']}));
  globalThis.fetch=async input=>{
    const url=new URL(String(input));
    if(url.hostname==='github.com'){refreshes++;return Response.json({access_token:'fresh-access',refresh_token:'next-refresh',expires_in:3600,refresh_token_expires_in:7200});}
    if(url.pathname==='/user')return Response.json({id:7});
    if(url.pathname==='/user/installations/42')return Response.json({id:42});
    if(url.pathname==='/user/installations/42/repositories')return Response.json({total_count:1,repositories:[{full_name:'unit/current'}]});
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };
  try {
    assert.deepEqual(await Promise.all([githubToken(accounts,'alice',{clientId:'unit-id',clientSecret:'unit-secret',slug:'unit'}),githubToken(accounts,'alice',{clientId:'unit-id',clientSecret:'unit-secret',slug:'unit'})]),['fresh-access','fresh-access']);
    assert.equal(refreshes,1);const saved=JSON.parse(accounts.credentials('alice').GITHUB_TOKEN);assert.equal(saved.accessToken,'fresh-access');assert.deepEqual(saved.repositories,['unit/current']);
  } finally {globalThis.fetch=original;store.db.close();}
});
test('concurrent Slack token use performs one rotation and saves the replacement grant', async () => {
  const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));const original=globalThis.fetch;let refreshes=0;
  accounts.setConnection('alice','SLACK_BOT_TOKEN',JSON.stringify({kind:'slack-oauth',accessToken:'expired-access',refreshToken:'active-refresh',expiresAt:Date.now()-1,teamId:'T1',teamName:'Unit Slack',botUserId:'B1'}));
  globalThis.fetch=async input=>{const url=new URL(String(input));if(url.hostname!=='slack.com')throw new Error(`Unexpected Slack request: ${url.href}`);refreshes++;return Response.json({ok:true,access_token:'fresh-access',refresh_token:'next-refresh',expires_in:3600});};
  try {
    assert.deepEqual(await Promise.all([workflowToken(accounts,'alice','slack',{clientId:'unit-id',clientSecret:'unit-secret'}),workflowToken(accounts,'alice','slack',{clientId:'unit-id',clientSecret:'unit-secret'})]),['fresh-access','fresh-access']);
    assert.equal(refreshes,1);const saved=JSON.parse(accounts.credentials('alice').SLACK_BOT_TOKEN);assert.equal(saved.accessToken,'fresh-access');assert.equal(saved.refreshToken,'next-refresh');
  } finally {globalThis.fetch=original;store.db.close();}
});
test('owner scope prevents reading, updating, and overwriting another user’s settings or runs', () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-scope-'));const path=join(dir,'db');const a=new Store(path,'alice'),b=new Store(path,'bob');
  try {a.save(run());a.setSetting('targets',{private:'alice'});assert.deepEqual(b.list(),[]);assert.equal(b.setting('targets'),null);assert.throws(()=>b.get(run().id),/not found/);assert.throws(()=>b.save({...run(),status:'dismissed'}),/not found/);assert.equal(a.get(run().id).status,'review');b.setSetting('targets',{private:'bob'});assert.deepEqual(a.setting('targets'),{private:'alice'});}finally{a.db.close();b.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('missing encryption key fails closed instead of replacing keys for existing credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-key-'));const store=new Store(':memory:');const accounts=new Accounts(store.db,randomBytes(32));
  try{accounts.setConnection('alice','GITHUB_TOKEN','unit');assert.throws(()=>encryptionKey(join(dir,'missing'),store.db),/missing/);}finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('HTTP authentication and ownership protect every workspace entry point', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-http-'));const path=join(dir,'db');const {server,accounts}=createApp(path,randomBytes(32),0);
  const alice=await accounts.create('alice',password);const bobby=await accounts.create('bobby',password);
  const owned=new Store(path,alice.id);owned.save(run());owned.setSetting('targets',{private:'alice'});owned.db.close();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address() as {port:number};const base=`http://127.0.0.1:${addr.port}`;
  const request=(path:string,method='GET',data?:unknown,cookie='',csrf='',origin=base)=>fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-PromiseGuard-Session':csrf},body:data===undefined?undefined:JSON.stringify(data)});
  async function login(name:string){const r=await request('/api/login','POST',{name,password});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')!.split(';')[0];assert.match(r.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);const boot=await(await request('/api/bootstrap','GET',undefined,cookie)).json();return{cookie,csrf:boot.session,boot};}
  try {
    const providers=await request('/api/auth/providers');assert.equal(providers.status,200);assert.deepEqual(await providers.json(),{google:false,github:false,slack:false});
    const missing=await request('/api/auth/google/start');assert.equal(missing.status,302);assert.match(missing.headers.get('location') || '',/^\/?\?auth_error=/);
    for(const p of ['/api/bootstrap','/api/runs'])assert.equal((await request(p)).status,401);
    const signup=await request('/api/signup','POST',{name:'charlie',password});assert.equal(signup.status,201);assert.match(signup.headers.get('set-cookie') || '',/HttpOnly; SameSite=Strict/);
    const signedBoot=await request('/api/bootstrap','GET',undefined,(signup.headers.get('set-cookie') || '').split(';')[0]);assert.equal(signedBoot.status,200);assert.equal((await signedBoot.json()).user.name,'charlie');
    assert.equal((await request('/api/signup','POST',{name:'charlie',password})).status,400);
    assert.equal((await request('/api/login','POST',{name:'alice',password},'','','https://evil.example')).status,403);
    const a=await login('alice'),b=await login('bobby');assert.equal(a.boot.runs.length,1);assert.deepEqual(b.boot.runs,[]);assert.equal(b.boot.targets,null);assert.equal(b.boot.configured.GITHUB_TOKEN,false);
    for(const action of ['approve','dismiss']){const r=await request(`/api/runs/${run().id}/${action}`,'POST',{planHash:'unit'},b.cookie,b.csrf);assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'Run not found.'});}
    assert.equal((await request('/api/connections/save','POST',{provider:'GITHUB_TOKEN',token:'unit'},b.cookie,a.csrf)).status,403);
    assert.equal((await request('/api/runs','GET',undefined,b.cookie,a.csrf)).status,403);
    assert.equal((await request('/api/connections/save','POST',{provider:'GITHUB_TOKEN',token:'synthetic-http-secret'},b.cookie,b.csrf)).status,200);
    const boot=await(await request('/api/bootstrap','GET',undefined,b.cookie)).json();assert.equal(boot.configured.GITHUB_TOKEN,true);assert.ok(!JSON.stringify(boot).includes('synthetic-http-secret'));
    const aboot=await(await request('/api/bootstrap','GET',undefined,a.cookie)).json();assert.equal(aboot.configured.GITHUB_TOKEN,false);
    assert.equal((await request('/api/connections/github/disconnect','POST',{},b.cookie,b.csrf)).status,200);
    assert.equal((await(await request('/api/bootstrap','GET',undefined,b.cookie)).json()).configured.GITHUB_TOKEN,false);
    assert.equal((await(await request('/api/bootstrap','GET',undefined,a.cookie)).json()).configured.GITHUB_TOKEN,false);
    for(const [provider,key] of [['slack','SLACK_BOT_TOKEN'],['notion','NOTION_TOKEN']] as const){assert.equal((await request('/api/connections/save','POST',{provider:key,token:`synthetic-${provider}`},b.cookie,b.csrf)).status,200);assert.equal((await request(`/api/connections/${provider}/disconnect`,'POST',{},b.cookie,b.csrf)).status,200);assert.equal((await(await request('/api/bootstrap','GET',undefined,b.cookie)).json()).configured[key],false);}
    accounts.setConnection(bobby.id,'GITHUB_TOKEN',JSON.stringify({kind:'github-app-user',accessToken:'hidden-access',refreshToken:'hidden-refresh',expiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+7200000,githubUserId:7,installationId:42,repositories:['unit/fixture']}));
    const prior={id:process.env.GITHUB_APP_CLIENT_ID,secret:process.env.GITHUB_APP_CLIENT_SECRET,slug:process.env.GITHUB_APP_SLUG,slackId:process.env.SLACK_CLIENT_ID,slackSecret:process.env.SLACK_CLIENT_SECRET,notionId:process.env.NOTION_CLIENT_ID,notionSecret:process.env.NOTION_CLIENT_SECRET};
    process.env.GITHUB_APP_CLIENT_ID='unit-client';process.env.GITHUB_APP_CLIENT_SECRET='unit-secret';process.env.GITHUB_APP_SLUG='unit-app';
    process.env.SLACK_CLIENT_ID='unit-slack';process.env.SLACK_CLIENT_SECRET='unit-slack-secret';process.env.NOTION_CLIENT_ID='unit-notion';process.env.NOTION_CLIENT_SECRET='unit-notion-secret';
    try {
      const reconnect=await request('/api/connections/github/start','GET',undefined,b.cookie);assert.equal(reconnect.status,302);assert.match(reconnect.headers.get('location')||'',/^https:\/\/github\.com\/login\/oauth\/authorize\?/);assert.match(reconnect.headers.get('location')||'',/code_challenge=/);
      const recover=await request('/api/connections/github/start','GET',undefined,a.cookie);assert.equal(recover.status,302);assert.match(recover.headers.get('location')||'',/^https:\/\/github\.com\/login\/oauth\/authorize\?/);assert.match(recover.headers.get('location')||'',/code_challenge=/);
      const reconnectUrl=new URL(reconnect.headers.get('location')!);const state=reconnectUrl.searchParams.get('state')!;const connectionCookie=(reconnect.headers.get('set-cookie')||'').split(';')[0];
      const cancelled=await request(`/api/connections/github/callback?state=${state}&error=access_denied`,'GET',undefined,`${b.cookie}; ${connectionCookie}`);assert.equal(cancelled.status,302);assert.match(decodeURIComponent(cancelled.headers.get('location')||''),/connection_error=GitHub authorization was cancelled/);
      const repositories=await request('/api/connections/github/repositories','GET',undefined,b.cookie);assert.equal(repositories.status,302);assert.match(repositories.headers.get('location')||'',/^https:\/\/github\.com\/apps\/unit-app\/installations\/new\?state=/);
      const meta=await(await request('/api/bootstrap','GET',undefined,b.cookie)).json();assert.deepEqual(meta.githubConnection,{type:'github-app',repositories:['unit/fixture'],installationId:42});assert.ok(!JSON.stringify(meta).includes('hidden-access'));assert.ok(!JSON.stringify(meta).includes('hidden-refresh'));
      assert.deepEqual(meta.workflowOauth,{slack:true,notion:true});
      for(const provider of ['slack','notion'] as const){const started=await request(`/api/connections/${provider}/start`,'GET',undefined,b.cookie);assert.equal(started.status,302);assert.match(started.headers.get('location')||'',provider==='slack'?/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/:/^https:\/\/api\.notion\.com\/v1\/oauth\/authorize\?/);assert.match(started.headers.get('set-cookie')||'',/Path=\/api;/);const target=new URL(started.headers.get('location')!);assert.equal(target.searchParams.get('redirect_uri'),provider==='slack'?`${base}/api/auth/slack/callback/connection`:`${base}/api/connections/notion/callback`);const state=target.searchParams.get('state')!;const oauthCookie=(started.headers.get('set-cookie')||'').split(';')[0];const callback=provider==='slack'?'/api/auth/slack/callback/connection':'/api/connections/notion/callback';const cancelled=await request(`${callback}?state=${state}&error=access_denied`,'GET',undefined,`${b.cookie}; ${oauthCookie}`);assert.equal(cancelled.status,302);assert.match(cancelled.headers.get('set-cookie')||'',/Path=\/api;/);assert.match(decodeURIComponent(cancelled.headers.get('location')||''),new RegExp(`${provider==='slack'?'Slack':'Notion'} authorization was cancelled`));}
    } finally {
      if(prior.id===undefined)delete process.env.GITHUB_APP_CLIENT_ID;else process.env.GITHUB_APP_CLIENT_ID=prior.id;
      if(prior.secret===undefined)delete process.env.GITHUB_APP_CLIENT_SECRET;else process.env.GITHUB_APP_CLIENT_SECRET=prior.secret;
      if(prior.slug===undefined)delete process.env.GITHUB_APP_SLUG;else process.env.GITHUB_APP_SLUG=prior.slug;
      if(prior.slackId===undefined)delete process.env.SLACK_CLIENT_ID;else process.env.SLACK_CLIENT_ID=prior.slackId;
      if(prior.slackSecret===undefined)delete process.env.SLACK_CLIENT_SECRET;else process.env.SLACK_CLIENT_SECRET=prior.slackSecret;
      if(prior.notionId===undefined)delete process.env.NOTION_CLIENT_ID;else process.env.NOTION_CLIENT_ID=prior.notionId;
      if(prior.notionSecret===undefined)delete process.env.NOTION_CLIENT_SECRET;else process.env.NOTION_CLIENT_SECRET=prior.notionSecret;
    }
    assert.equal((await request('/api/logout','POST',{},b.cookie,b.csrf)).status,200);assert.equal((await request('/api/bootstrap','GET',undefined,b.cookie)).status,401);
    assert.equal((await request('/.env')).status,404);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
test('legacy data requires an explicit one-time claim and preserves run payloads',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-legacy-'));const path=join(dir,'db');const legacy=new Store(path);const accounts=new Accounts(legacy.db,randomBytes(32));
  try {
    legacy.save(run());legacy.db.prepare('INSERT INTO settings VALUES (?,?)').run('targets',JSON.stringify({private:'legacy'}));
    legacy.setSetting('new-local-setting',{private:'local-scoped'});
    const before=(legacy.db.prepare('SELECT payload FROM runs').get() as {payload:string}).payload;
    const alice=await accounts.create('alice',password),bob=await accounts.create('bobby',password);
    const a=new Store(path,alice.id),b=new Store(path,bob.id);
    try{assert.deepEqual(a.list(),[]);assert.equal(a.setting('targets'),null);accounts.claimLocal(alice.id,{GITHUB_TOKEN:'synthetic-imported-token'});assert.equal(a.list().length,1);assert.deepEqual(a.setting('targets'),{private:'legacy'});assert.deepEqual(a.setting('new-local-setting'),{private:'local-scoped'});assert.deepEqual(b.list(),[]);assert.deepEqual(accounts.credentials(bob.id),{});assert.equal(accounts.credentials(alice.id).GITHUB_TOKEN,'synthetic-imported-token');assert.equal((legacy.db.prepare('SELECT payload FROM runs').get() as {payload:string}).payload,before);assert.throws(()=>accounts.claimLocal(bob.id,{}),/already assigned/);}finally{a.db.close();b.db.close();}
  }finally{legacy.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('terminal provisioning imports only into the named owner without printing the password', () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-cli-'));const path=join(dir,'data','promiseguard.sqlite');
  // Provisioning creates its own private data directory in the temporary workspace.
  try {
    writeFileSync(join(dir,'.env'),'GITHUB_TOKEN=synthetic-cli-token\n');
    const output=execFileSync(resolve('node_modules/.bin/tsx'),[resolve('scripts/create-account.ts'),'cli-owner','--claim-local'],{cwd:dir,input:password,encoding:'utf8'});
    assert.match(output,/Created account cli-owner/);assert.ok(!output.includes(password));assert.ok(!output.includes('synthetic-cli-token'));
    const store=new Store(path);try{const user=store.db.prepare('SELECT id FROM users WHERE name=?').get('cli-owner') as {id:string};const accounts=new Accounts(store.db,encryptionKey(join(dir,'data','credentials.key'),store.db));assert.equal(accounts.credentials(user.id).GITHUB_TOKEN,'synthetic-cli-token');}finally{store.db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('public runtime requires an exact HTTPS origin and secure session cookie', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-public-'));
  const path=join(dir,'nested','promiseguard.sqlite');
  assert.throws(()=>createApp(path,randomBytes(32),443,'http://example.test'),/HTTPS origin/);
  assert.throws(()=>createApp(path,randomBytes(32),443,'https://user@example.test/path'),/HTTPS origin/);
  const {server,accounts}=createApp(path,randomBytes(32),443,'https://promiseguard.example');
  await accounts.create('public-user',password);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const request=(path:string,method='GET',data?:unknown,host='promiseguard.example',origin='https://promiseguard.example',extraHeaders:Record<string,string>={})=>new Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:any}>((resolve,reject)=>{
    const payload=data === undefined ? '' : JSON.stringify(data);
    const req=httpRequest({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:host,Origin:origin,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...extraHeaders}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);res.on('end',()=>{let parsed;try{parsed=JSON.parse(raw);}catch{parsed=raw;}resolve({status:res.statusCode||0,headers:res.headers,body:parsed});});
    });
    req.on('error',reject);if(payload)req.write(payload);req.end();
  });
  try {
    const health=await request('/api/health');
    assert.equal(health.status,200);
    assert.deepEqual(health.body,{status:'ok'});
    assert.equal(health.headers['strict-transport-security'],'max-age=31536000; includeSubDomains');
    assert.equal((await request('/api/health','GET',undefined,'evil.example')).status,403);
    const login=await request('/api/login','POST',{name:'public-user',password});
    const cookies=login.headers['set-cookie'];
    assert.equal((Array.isArray(cookies) ? cookies : [cookies || '']).some(value=>value.includes('; Secure')),true);
    assert.equal((await request('/api/login','POST',{name:'public-user',password},'promiseguard.example','https://evil.example')).status,403);
    const oauthReturn=await request('/missing-after-oauth','GET',undefined,'promiseguard.example','',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});
    assert.equal(oauthReturn.status,404);
    assert.equal((await request('/api/health','GET',undefined,'promiseguard.example','',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'})).status,403);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
  }
});
