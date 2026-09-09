import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
async function accountStore(key = randomBytes(32)) {
  const store = await Store.open(':memory:');
  return { store, accounts: await Accounts.initialize(store.db, key) };
}
test('passwords are salted; sessions expire and logout revokes them', async () => {
  const {store,accounts}=await accountStore();
  try {
    await accounts.create('alice',password); await accounts.create('bobby',password);
    const rows = await store.db.all<{password:string}>('SELECT password FROM users');
    assert.notEqual(rows[0].password,rows[1].password); assert.notEqual(rows[0].password,password);
    await assert.rejects(accounts.login('alice','incorrect'));
    const signed = await accounts.login('alice',password); assert.equal((await accounts.session(signed.token))?.name,'alice');
    assert.equal(JSON.stringify(await store.db.all('SELECT * FROM sessions')).includes(signed.token),false);
    await accounts.logout(signed.token); assert.equal(await accounts.session(signed.token),undefined);
    const next = await accounts.login('alice',password);await store.db.run('UPDATE sessions SET expires=0');assert.equal(await accounts.session(next.token),undefined);
  } finally {await store.db.close();}
});
test('operator bootstrap is idempotent and does not replace its password', async () => {
  const {store,accounts}=await accountStore();
  try {
    const first=await accounts.ensurePasswordAccount('Admin.User',password);
    const again=await accounts.ensurePasswordAccount('admin.user','a-different-password');
    assert.equal(first.id,again.id);
    assert.equal((await accounts.login('admin.user',password)).user.id,first.id);
    await assert.rejects(accounts.login('admin.user','a-different-password'),/Invalid/);
  } finally {await store.db.close();}
});
test('sign-in attempts are limited including unknown accounts', async () => {
  const {store,accounts}=await accountStore();
  try {for(let i=0;i<5;i++)await assert.rejects(accounts.login('unknown',password),/Invalid/);await assert.rejects(accounts.login('unknown',password),/Too many/);}finally{await store.db.close();}
});
test('public registration is rate limited even when validation fails', async () => {
  const {store,accounts}=await accountStore();
  try {
    for(let i=0;i<5;i++) await assert.rejects(accounts.register('one-source','x','short'),/username/);
    await assert.rejects(accounts.register('one-source','valid-user',password),/Too many sign-up attempts/);
  } finally {await store.db.close();}
});
test('social identities create one stable account and OAuth state is single use', async () => {
  const {store,accounts}=await accountStore();
  try {
    const state=await accounts.beginOauth('google','unit-verifier','unit-nonce');
    assert.deepEqual(await accounts.consumeOauth('google',state),{verifier:'unit-verifier',nonce:'unit-nonce'});
    assert.equal(await accounts.consumeOauth('google',state),undefined);
    const first=await accounts.socialLogin('github','12345','Alice Dev','alice@example.test');
    const again=await accounts.socialLogin('github','12345','A Changed Name','changed@example.test');
    const otherProvider=await accounts.socialLogin('google','12345','Alice Dev','alice@example.test');
    assert.equal(first.user.id,again.user.id);
    assert.notEqual(first.user.id,otherProvider.user.id);
    assert.notEqual(first.user.name,otherProvider.user.name);
    assert.equal((await accounts.session(first.token))?.id,first.user.id);
    const rows=await store.db.all('SELECT provider,subject,email FROM identities ORDER BY provider');
    assert.deepEqual(rows,[{provider:'github',subject:'12345',email:'alice@example.test'},{provider:'google',subject:'12345',email:'alice@example.test'}]);
  } finally {await store.db.close();}
});
test('workflow OAuth state is bound to one active user session and phase', async () => {
  const {store,accounts}=await accountStore();
  try {
    const alice=await accounts.create('alice',password),bob=await accounts.create('bobby',password);
    const a=await accounts.login(alice.name,password),b=await accounts.login(bob.name,password);
    const install=await accounts.beginConnectionOauth(alice.id,a.token,'github-install');
    assert.equal(await accounts.consumeConnectionOauth('github-authorize',install),undefined);
    const next=await accounts.beginConnectionOauth(alice.id,a.token,'github-install');
    const saved=(await accounts.consumeConnectionOauth('github-install',next))!;
    assert.equal(saved.user_id,alice.id);assert.notEqual(saved.session_hash,b.token);assert.equal(await accounts.consumeConnectionOauth('github-install',next),undefined);
    const revoked=await accounts.beginConnectionOauth(alice.id,a.token,'github-install');await accounts.logout(a.token);
    assert.equal(await accounts.consumeConnectionOauth('github-install',revoked),undefined);
    await assert.rejects(accounts.beginConnectionOauth(alice.id,b.token,'github-install'),/Sign in again/);
    const active=await accounts.login(alice.name,password);
    for(const phase of ['slack-connect','notion-connect'] as const){const state=await accounts.beginConnectionOauth(alice.id,active.token,phase);assert.equal((await accounts.consumeConnectionOauth(phase,state))?.user_id,alice.id);assert.equal(await accounts.consumeConnectionOauth(phase,state),undefined);}
  } finally {await store.db.close();}
});
test('encrypted tokens cannot be read by another user or moved between owners', async () => {
  const {store,accounts}=await accountStore();
  try {
    await accounts.setConnection('alice','GITHUB_TOKEN','synthetic-secret-for-unit-test');
    assert.deepEqual(await accounts.credentials('bob'),{});
    const raw=(await store.db.get<{secret:string}>('SELECT secret FROM connections'))!;assert.ok(!raw.secret.includes('synthetic-secret'));
    await store.db.run('INSERT INTO connections VALUES (?,?,?)','bob','GITHUB_TOKEN',raw.secret);
    await assert.rejects(accounts.credentials('bob'));
    await accounts.setConnection('alice','GITHUB_TOKEN','');assert.deepEqual(await accounts.credentials('alice'),{});
    await assert.rejects(accounts.setConnection('alice','GEMINI_API_KEY','x'));
  }finally{await store.db.close();}
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
  const {store,accounts}=await accountStore();const original=globalThis.fetch;let refreshes=0;
  await accounts.setConnection('alice','GITHUB_TOKEN',JSON.stringify({kind:'github-app-user',accessToken:'expired-access',refreshToken:'active-refresh',expiresAt:Date.now()-1,refreshExpiresAt:Date.now()+3600000,githubUserId:7,installationId:42,installationIds:[42],repositories:['unit/old']}));
  globalThis.fetch=async input=>{
    const url=new URL(String(input));
    if(url.hostname==='github.com'){refreshes++;return Response.json({access_token:'fresh-access',refresh_token:'next-refresh',expires_in:3600,refresh_token_expires_in:7200});}
    if(url.pathname==='/user')return Response.json({id:7});
    if(url.pathname==='/user/installations/42/repositories')return Response.json({total_count:1,repositories:[{full_name:'unit/current'}]});
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };
  try {
    assert.deepEqual(await Promise.all([githubToken(accounts,'alice',{clientId:'unit-id',clientSecret:'unit-secret',slug:'unit'}),githubToken(accounts,'alice',{clientId:'unit-id',clientSecret:'unit-secret',slug:'unit'})]),['fresh-access','fresh-access']);
    assert.equal(refreshes,1);const saved=JSON.parse((await accounts.credentials('alice')).GITHUB_TOKEN);assert.equal(saved.accessToken,'fresh-access');assert.deepEqual(saved.repositories,['unit/current']);
  } finally {globalThis.fetch=original;await store.db.close();}
});
test('concurrent Slack token use performs one rotation and saves the replacement grant', async () => {
  const {store,accounts}=await accountStore();const original=globalThis.fetch;let refreshes=0;
  await accounts.setConnection('alice','SLACK_BOT_TOKEN',JSON.stringify({kind:'slack-oauth',accessToken:'expired-access',refreshToken:'active-refresh',expiresAt:Date.now()-1,teamId:'T1',teamName:'Unit Slack',botUserId:'B1'}));
  globalThis.fetch=async input=>{const url=new URL(String(input));if(url.hostname!=='slack.com')throw new Error(`Unexpected Slack request: ${url.href}`);refreshes++;return Response.json({ok:true,access_token:'fresh-access',refresh_token:'next-refresh',expires_in:3600});};
  try {
    assert.deepEqual(await Promise.all([workflowToken(accounts,'alice','slack',{clientId:'unit-id',clientSecret:'unit-secret'}),workflowToken(accounts,'alice','slack',{clientId:'unit-id',clientSecret:'unit-secret'})]),['fresh-access','fresh-access']);
    assert.equal(refreshes,1);const saved=JSON.parse((await accounts.credentials('alice')).SLACK_BOT_TOKEN);assert.equal(saved.accessToken,'fresh-access');assert.equal(saved.refreshToken,'next-refresh');
  } finally {globalThis.fetch=original;await store.db.close();}
});
test('owner scope prevents reading, updating, and overwriting another user’s settings or runs', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-scope-'));const path=join(dir,'db');const root=await Store.open(path),a=root.scoped('alice'),b=root.scoped('bob');
  try {await a.save(run());await a.setSetting('targets',{private:'alice'});assert.deepEqual(await b.list(),[]);assert.equal(await b.setting('targets'),null);await assert.rejects(b.get(run().id),/not found/);await assert.rejects(b.save({...run(),status:'dismissed'}),/not found/);assert.equal((await a.get(run().id)).status,'review');await b.setSetting('targets',{private:'bob'});assert.deepEqual(await a.setting('targets'),{private:'alice'});}finally{await root.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('missing encryption key fails closed instead of replacing keys for existing credentials',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-key-'));const {store,accounts}=await accountStore();
  try{await accounts.setConnection('alice','GITHUB_TOKEN','unit');await assert.rejects(encryptionKey(join(dir,'missing'),store.db,{}),/missing/);}finally{await store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('HTTP authentication and ownership protect every workspace entry point', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-http-'));const path=join(dir,'db');const {server,accounts}=await createApp(path,randomBytes(32),0);
  const alice=await accounts.create('alice',password);const bobby=await accounts.create('bobby',password);
  const owned=new Store(accounts.db,alice.id);await owned.save(run());await owned.setSetting('targets',{private:'alice'});
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
    await accounts.setConnection(bobby.id,'GITHUB_TOKEN',JSON.stringify({kind:'github-app-user',accessToken:'hidden-access',refreshToken:'hidden-refresh',expiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+7200000,githubUserId:7,installationId:42,repositories:['unit/fixture']}));
    const prior={id:process.env.GITHUB_APP_CLIENT_ID,secret:process.env.GITHUB_APP_CLIENT_SECRET,slug:process.env.GITHUB_APP_SLUG,slackId:process.env.SLACK_CLIENT_ID,slackSecret:process.env.SLACK_CLIENT_SECRET,notionId:process.env.NOTION_CLIENT_ID,notionSecret:process.env.NOTION_CLIENT_SECRET};
    process.env.GITHUB_APP_CLIENT_ID='unit-client';process.env.GITHUB_APP_CLIENT_SECRET='unit-secret';process.env.GITHUB_APP_SLUG='unit-app';
    process.env.SLACK_CLIENT_ID='unit-slack';process.env.SLACK_CLIENT_SECRET='unit-slack-secret';process.env.NOTION_CLIENT_ID='unit-notion';process.env.NOTION_CLIENT_SECRET='unit-notion-secret';
    try {
      const reconnect=await request('/api/connections/github/start','GET',undefined,b.cookie);assert.equal(reconnect.status,302);assert.match(reconnect.headers.get('location')||'',/^https:\/\/github\.com\/login\/oauth\/authorize\?/);assert.match(reconnect.headers.get('location')||'',/code_challenge=/);
      const recover=await request('/api/connections/github/start','GET',undefined,a.cookie);assert.equal(recover.status,302);assert.match(recover.headers.get('location')||'',/^https:\/\/github\.com\/login\/oauth\/authorize\?/);assert.match(recover.headers.get('location')||'',/code_challenge=/);
      const reconnectUrl=new URL(reconnect.headers.get('location')!);const state=reconnectUrl.searchParams.get('state')!;const connectionCookie=(reconnect.headers.get('set-cookie')||'').split(';')[0];
      const cancelled=await request(`/api/connections/github/callback?state=${state}&error=access_denied`,'GET',undefined,`${b.cookie}; ${connectionCookie}`);assert.equal(cancelled.status,302);const cancelledUrl=new URL(cancelled.headers.get('location')!,base);assert.equal(cancelledUrl.searchParams.get('connection'),'github');assert.match(cancelledUrl.searchParams.get('connection_error')||'',/GitHub did not grant access/);
      const repositories=await request('/api/connections/github/repositories','GET',undefined,b.cookie);assert.equal(repositories.status,302);assert.match(repositories.headers.get('location')||'',/^https:\/\/github\.com\/apps\/unit-app\/installations\/new\?state=/);
      const meta=await(await request('/api/bootstrap','GET',undefined,b.cookie)).json();assert.deepEqual(meta.githubConnection,{type:'github-app',repositories:['unit/fixture'],installationId:42});assert.ok(!JSON.stringify(meta).includes('hidden-access'));assert.ok(!JSON.stringify(meta).includes('hidden-refresh'));
      assert.deepEqual(meta.workflowOauth,{slack:true,notion:true});
      for(const provider of ['slack','notion'] as const){const started=await request(`/api/connections/${provider}/start`,'GET',undefined,b.cookie);assert.equal(started.status,302);assert.match(started.headers.get('location')||'',provider==='slack'?/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/:/^https:\/\/api\.notion\.com\/v1\/oauth\/authorize\?/);assert.match(started.headers.get('set-cookie')||'',/Path=\/api;/);const target=new URL(started.headers.get('location')!);assert.equal(target.searchParams.get('redirect_uri'),provider==='slack'?`${base}/api/auth/slack/callback/connection`:`${base}/api/connections/notion/callback`);const state=target.searchParams.get('state')!;const oauthCookie=(started.headers.get('set-cookie')||'').split(';')[0];const callback=provider==='slack'?'/api/auth/slack/callback/connection':'/api/connections/notion/callback';const cancelled=await request(`${callback}?state=${state}&error=access_denied`,'GET',undefined,`${b.cookie}; ${oauthCookie}`);assert.equal(cancelled.status,302);assert.match(cancelled.headers.get('set-cookie')||'',/Path=\/api;/);const cancelledUrl=new URL(cancelled.headers.get('location')!,base);assert.equal(cancelledUrl.searchParams.get('connection'),provider);assert.match(cancelledUrl.searchParams.get('connection_error')||'',new RegExp(`${provider==='slack'?'Slack':'Notion'} did not grant access`));}
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
  const dir=mkdtempSync(join(tmpdir(),'pg-legacy-'));const path=join(dir,'db');const legacy=await Store.open(path);const accounts=await Accounts.initialize(legacy.db,randomBytes(32));
  try {
    await legacy.save(run());await legacy.db.run('INSERT INTO settings VALUES (?,?)','targets',JSON.stringify({private:'legacy'}));
    await legacy.setSetting('new-local-setting',{private:'local-scoped'});
    const before=(await legacy.db.get<{payload:string}>('SELECT payload FROM runs'))!.payload;
    const alice=await accounts.create('alice',password),bob=await accounts.create('bobby',password);
    const a=legacy.scoped(alice.id),b=legacy.scoped(bob.id);
    assert.deepEqual(await a.list(),[]);assert.equal(await a.setting('targets'),null);await accounts.claimLocal(alice.id,{GITHUB_TOKEN:'synthetic-imported-token'});assert.equal((await a.list()).length,1);assert.deepEqual(await a.setting('targets'),{private:'legacy'});assert.deepEqual(await a.setting('new-local-setting'),{private:'local-scoped'});assert.deepEqual(await b.list(),[]);assert.deepEqual(await accounts.credentials(bob.id),{});assert.equal((await accounts.credentials(alice.id)).GITHUB_TOKEN,'synthetic-imported-token');assert.equal((await legacy.db.get<{payload:string}>('SELECT payload FROM runs'))!.payload,before);await assert.rejects(accounts.claimLocal(bob.id,{}),/already assigned/);
  }finally{await legacy.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('terminal provisioning imports only into the named owner without printing the password', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-cli-'));const path=join(dir,'data','promiseguard.sqlite');
  // Provisioning creates its own private data directory in the temporary workspace.
  try {
    writeFileSync(join(dir,'.env'),'GITHUB_TOKEN=synthetic-cli-token\n');
    const output=execFileSync(resolve('node_modules/.bin/tsx'),[resolve('scripts/create-account.ts'),'cli-owner','--claim-local'],{cwd:dir,input:password,encoding:'utf8'});
    assert.match(output,/Created account cli-owner/);assert.ok(!output.includes(password));assert.ok(!output.includes('synthetic-cli-token'));
    const store=await Store.open(path);try{const user=(await store.db.get<{id:string}>('SELECT id FROM users WHERE name=?','cli-owner'))!;const accounts=await Accounts.initialize(store.db,await encryptionKey(join(dir,'data','credentials.key'),store.db,{}));assert.equal((await accounts.credentials(user.id)).GITHUB_TOKEN,'synthetic-cli-token');}finally{await store.db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('public runtime requires an exact HTTPS origin and secure session cookie', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pg-public-'));
  const path=join(dir,'nested','promiseguard.sqlite');
  await assert.rejects(createApp(path,randomBytes(32),443,'http://example.test'),/HTTPS origin/);
  await assert.rejects(createApp(path,randomBytes(32),443,'https://user@example.test/path'),/HTTPS origin/);
  const {server,accounts}=await createApp(path,randomBytes(32),443,'https://promiseguard.example');
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

test('Turso persists account and owner-scoped workspace data', { skip: !process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN }, async () => {
  const key=randomBytes(32),suffix=randomUUID(),name=`remote-${suffix}`;let userId='',active=true;
  let store=await Store.open('unused-for-turso','local',process.env),accounts=await Accounts.initialize(store.db,key);
  try {
    const user=await accounts.create(name,password);userId=user.id;
    await accounts.setConnection(user.id,'GITHUB_TOKEN','synthetic-remote-secret');
    const scoped=store.scoped(user.id),record=run(suffix);await scoped.save(record);await scoped.setSetting('targets',{durable:true});

    await store.db.close();active=false;
    store=await Store.open('unused-for-turso','local',process.env);active=true;
    accounts=await Accounts.initialize(store.db,key);
    const reopened=store.scoped(user.id);
    assert.equal((await accounts.login(name,password)).user.id,user.id);
    assert.equal((await accounts.credentials(user.id)).GITHUB_TOKEN,'synthetic-remote-secret');
    assert.equal((await reopened.get(record.id)).id,record.id);
    assert.deepEqual(await reopened.setting('targets'),{durable:true});
  } finally {
    if(!active){store=await Store.open('unused-for-turso','local',process.env);active=true;}
    if(userId)await store.db.transaction(async db=>{await db.run('DELETE FROM connections WHERE user_id=?',userId);await db.run('DELETE FROM sessions WHERE user_id=?',userId);await db.run('DELETE FROM identities WHERE user_id=?',userId);await db.run('DELETE FROM user_settings WHERE owner=?',userId);await db.run('DELETE FROM runs WHERE owner=?',userId);await db.run('DELETE FROM users WHERE id=?',userId);});
    await store.db.close();
  }
});
