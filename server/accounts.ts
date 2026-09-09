import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
const derive = promisify(scrypt);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const connectionKeys = ['GITHUB_TOKEN', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN'] as const;
export const identityProviders = ['google', 'github', 'slack'] as const;
export type IdentityProvider = typeof identityProviders[number];
export type User = { id: string; name: string };
export class Accounts {
  constructor(public db: DatabaseSync, private key: Buffer) {
    if (key.length !== 32) throw new Error('Invalid credential encryption key.');
    db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, provider TEXT NOT NULL, secret TEXT NOT NULL, PRIMARY KEY(user_id, provider));
      CREATE TABLE IF NOT EXISTS login_attempts (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signup_attempts (source TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, PRIMARY KEY(provider, subject));
      CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_oauth_states (hash TEXT PRIMARY KEY, phase TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, verifier TEXT NOT NULL, installation_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  async create(name: string, password: string): Promise<User> {
    name = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._@+-]{2,99}$/.test(name)) throw new Error('Use a username of 3–100 letters, numbers, or . _ @ + - characters.');
    if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12–256 characters.');
    const salt = randomBytes(16).toString('hex');
    const value = await derive(password, salt, 64) as Buffer;
    const user = { id: randomUUID(), name };
    this.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user.id, name, salt, value.toString('hex'));
    return user;
  }
  async ensurePasswordAccount(name: string, password: string) {
    const normalized = name.trim().toLowerCase();
    const existing = this.db.prepare('SELECT id,name FROM users WHERE name=?').get(normalized) as User|undefined;
    return existing || this.create(normalized,password);
  }
  async register(source: string, name: string, password: string) {
    const now = Date.now(), key = hash(source || 'unknown');
    this.db.prepare('DELETE FROM signup_attempts WHERE expires<=?').run(now);
    const attempt = this.db.prepare('SELECT count FROM signup_attempts WHERE source=?').get(key) as {count:number}|undefined;
    if ((attempt?.count || 0) >= 5) throw new Error('Too many sign-up attempts. Try again in 15 minutes.');
    this.db.prepare('INSERT INTO signup_attempts VALUES (?,1,?) ON CONFLICT(source) DO UPDATE SET count=count+1').run(key,now+900000);
    const user = await this.create(name,password);
    return this.createSession(user);
  }
  claimLocal(userId: string, tokens: Record<string,string>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM user_settings WHERE owner='system' AND key='local-claimed'").get()) throw new Error('Local workspace was already assigned.');
      const active = (this.db.prepare("SELECT payload FROM runs WHERE owner='local'").all() as {payload:string}[]).some(r => ['collecting','executing'].includes(JSON.parse(r.payload).status));
      if (active) throw new Error('Stop active work before claiming the local workspace.');
      this.db.prepare("UPDATE runs SET owner=? WHERE owner='local'").run(userId);
      this.db.prepare('INSERT INTO user_settings SELECT ?,key,payload FROM settings').run(userId);
      this.db.prepare("INSERT OR REPLACE INTO user_settings SELECT ?,key,payload FROM user_settings WHERE owner='local'").run(userId);
      for (const key of connectionKeys) if (tokens[key]) this.setConnection(userId, key, tokens[key]);
      this.db.prepare("INSERT INTO user_settings VALUES ('system','local-claimed',?)").run(JSON.stringify(userId));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async login(name: string, password: string) {
    name = name.trim().toLowerCase();
    const now = Date.now();
    this.db.prepare('DELETE FROM login_attempts WHERE expires <= ?').run(now);
    const attempt = this.db.prepare('SELECT count FROM login_attempts WHERE name=?').get(name) as {count:number}|undefined;
    const total = this.db.prepare('SELECT COALESCE(SUM(count),0) AS count FROM login_attempts').get() as {count:number};
    if ((attempt?.count || 0) >= 5 || total.count >= 30) throw new Error('Too many sign-in attempts. Try again in 15 minutes.');
    this.db.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(name) DO UPDATE SET count=count+1').run(name, now + 900000);
    const row = this.db.prepare('SELECT * FROM users WHERE name=?').get(name) as (User & {salt:string;password:string})|undefined;
    const value = await derive(password, row?.salt || 'unregistered-account', 64) as Buffer;
    if (!row || !timingSafeEqual(value, Buffer.from(row.password, 'hex'))) throw new Error('Invalid username or password.');
    this.db.prepare('DELETE FROM login_attempts WHERE name=?').run(name);
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    return this.createSession(row);
  }
  private createSession(user: User) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(token), user.id, csrf, Date.now() + 8 * 3600000);
    return { token, csrf, user: {id:user.id, name:user.name} };
  }
  beginOauth(provider: IdentityProvider, verifier: string, nonce: string) {
    const state = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM oauth_states WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO oauth_states VALUES (?,?,?,?,?)').run(hash(state), provider, verifier, nonce, Date.now() + 10 * 60000);
    return state;
  }
  consumeOauth(provider: IdentityProvider, state: string) {
    if (!/^[a-f0-9]{64}$/.test(state)) return undefined;
    const stateHash = hash(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT verifier,nonce,expires FROM oauth_states WHERE hash=? AND provider=?').get(stateHash, provider) as {verifier:string;nonce:string;expires:number}|undefined;
      this.db.prepare('DELETE FROM oauth_states WHERE hash=?').run(stateHash);
      this.db.exec('COMMIT');
      return row && row.expires > Date.now() ? {verifier:row.verifier, nonce:row.nonce} : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  beginConnectionOauth(userId:string, sessionToken:string, phase:'github-install'|'github-authorize', verifier='', installationId='', sessionHash=hash(sessionToken)) {
    const active=this.db.prepare('SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires>?').get(sessionHash,userId,Date.now());
    if(!active) throw new Error('Sign in again before connecting GitHub.');
    const state=randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM connection_oauth_states WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO connection_oauth_states VALUES (?,?,?,?,?,?,?)').run(hash(state),phase,userId,sessionHash,verifier,installationId,Date.now()+10*60000);
    return state;
  }
  consumeConnectionOauth(phase:'github-install'|'github-authorize', state:string) {
    if(!/^[a-f0-9]{64}$/.test(state)) return undefined;
    const stateHash=hash(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare(`SELECT connection_oauth_states.user_id,session_hash,verifier,installation_id,connection_oauth_states.expires
        FROM connection_oauth_states JOIN sessions ON sessions.hash=session_hash AND sessions.user_id=connection_oauth_states.user_id
        WHERE connection_oauth_states.hash=? AND phase=? AND connection_oauth_states.expires>? AND sessions.expires>?`).get(stateHash,phase,Date.now(),Date.now()) as {user_id:string;session_hash:string;verifier:string;installation_id:string;expires:number}|undefined;
      this.db.prepare('DELETE FROM connection_oauth_states WHERE hash=?').run(stateHash);
      this.db.exec('COMMIT');
      return row;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  socialLogin(provider: IdentityProvider, subject: string, preferredName: string, email = '') {
    if (!subject || subject.length > 500) throw new Error('Invalid provider identity.');
    const found = this.db.prepare('SELECT users.id,users.name FROM identities JOIN users ON users.id=identities.user_id WHERE provider=? AND subject=?').get(provider, subject) as User|undefined;
    if (found) return this.createSession(found);
    let base = preferredName.trim().toLowerCase().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 70);
    if (base.length < 3) base = `${provider}-user`;
    let name = base, suffix = 1;
    while (this.db.prepare('SELECT 1 FROM users WHERE name=?').get(name)) name = `${base.slice(0, 90)}-${++suffix}`;
    const user: User = {id:randomUUID(), name};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user.id, name, randomBytes(16).toString('hex'), randomBytes(64).toString('hex'));
      this.db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(provider, subject, user.id, email.slice(0, 320) || null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.createSession(user);
  }
  session(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db.prepare('SELECT users.id, users.name, sessions.csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(hash(token), Date.now()) as (User & {csrf:string})|undefined;
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)); }
  setConnection(userId: string, provider: string, token: string) {
    if (!(connectionKeys as readonly string[]).includes(provider)) throw new Error('Unsupported connection.');
    if (!token) { this.db.prepare('DELETE FROM connections WHERE user_id=? AND provider=?').run(userId, provider); return; }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${provider}`));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const secret = [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
    this.db.prepare('INSERT INTO connections VALUES (?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET secret=excluded.secret').run(userId, provider, secret);
  }
  credentials(userId: string): Record<string,string> {
    const result: Record<string,string> = {};
    const rows = this.db.prepare('SELECT provider,secret FROM connections WHERE user_id=?').all(userId) as {provider:string;secret:string}[];
    for (const row of rows) {
      const [iv,tag,encrypted] = row.secret.split('.').map(s => Buffer.from(s,'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(`${userId}:${row.provider}`)); decipher.setAuthTag(tag);
      result[row.provider] = Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
    }
    return result;
  }
}
export function encryptionKey(path = 'data/credentials.key', db?: DatabaseSync) {
  if (!existsSync(path)) {
    const table = db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'").get();
    if (table && db!.prepare('SELECT 1 FROM connections LIMIT 1').get()) throw new Error('Credential key is missing. Restore data/credentials.key from backup before starting.');
    writeFileSync(path, randomBytes(32), {mode:0o600,flag:'wx'});
  }
  return readFileSync(path);
}
