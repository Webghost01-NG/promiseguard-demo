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
  const alice=await accounts.create('alice',password);await accounts.create('bobby',password);
  const owned=new Store(path,alice.id);owned.save(run());owned.setSetting('targets',{private:'alice'});owned.db.close();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address() as {port:number};const base=`http://127.0.0.1:${addr.port}`;
  const request=(path:string,method='GET',data?:unknown,cookie='',csrf='',origin=base)=>fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-PromiseGuard-Session':csrf},body:data===undefined?undefined:JSON.stringify(data)});
  async function login(name:string){const r=await request('/api/login','POST',{name,password});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')!.split(';')[0];assert.match(r.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);const boot=await(await request('/api/bootstrap','GET',undefined,cookie)).json();return{cookie,csrf:boot.session,boot};}
  try {
    const providers=await request('/api/auth/providers');assert.equal(providers.status,200);assert.deepEqual(await providers.json(),{google:false,github:false,slack:false});
    const missing=await request('/api/auth/google/start');assert.equal(missing.status,302);assert.match(missing.headers.get('location') || '',/^\/?\?auth_error=/);
    for(const p of ['/api/bootstrap','/api/runs'])assert.equal((await request(p)).status,401);
    assert.equal((await request('/api/login','POST',{name:'alice',password},'','','https://evil.example')).status,403);
    const a=await login('alice'),b=await login('bobby');assert.equal(a.boot.runs.length,1);assert.deepEqual(b.boot.runs,[]);assert.equal(b.boot.targets,null);assert.equal(b.boot.configured.GITHUB_TOKEN,false);
    for(const action of ['approve','dismiss']){const r=await request(`/api/runs/${run().id}/${action}`,'POST',{planHash:'unit'},b.cookie,b.csrf);assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'Run not found.'});}
    assert.equal((await request('/api/connections/save','POST',{provider:'GITHUB_TOKEN',token:'unit'},b.cookie,a.csrf)).status,403);
    assert.equal((await request('/api/runs','GET',undefined,b.cookie,a.csrf)).status,403);
    assert.equal((await request('/api/connections/save','POST',{provider:'GITHUB_TOKEN',token:'synthetic-http-secret'},b.cookie,b.csrf)).status,200);
    const boot=await(await request('/api/bootstrap','GET',undefined,b.cookie)).json();assert.equal(boot.configured.GITHUB_TOKEN,true);assert.ok(!JSON.stringify(boot).includes('synthetic-http-secret'));
    const aboot=await(await request('/api/bootstrap','GET',undefined,a.cookie)).json();assert.equal(aboot.configured.GITHUB_TOKEN,false);
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
  const request=(path:string,method='GET',data?:unknown,host='promiseguard.example',origin='https://promiseguard.example')=>new Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:any}>((resolve,reject)=>{
    const payload=data === undefined ? '' : JSON.stringify(data);
    const req=httpRequest({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:host,Origin:origin,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,body:JSON.parse(raw)}));
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
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
  }
});
