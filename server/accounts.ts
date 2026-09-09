import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppDatabase, SqlExecutor } from './database.ts';

const derive = promisify(scrypt);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const connectionKeys = ['GITHUB_TOKEN', 'NOTION_TOKEN', 'SLACK_BOT_TOKEN'] as const;
export const identityProviders = ['google', 'github', 'slack'] as const;
export type IdentityProvider = typeof identityProviders[number];
export type User = { id: string; name: string };
type ConnectionPhase = 'github-install'|'github-authorize'|'slack-connect'|'notion-connect';

export class Accounts {
  private constructor(public db: AppDatabase, private key: Buffer) {
    if (key.length !== 32) throw new Error('Invalid credential encryption key.');
  }

  static async initialize(db: AppDatabase, key: Buffer) {
    const accounts = new Accounts(db, key);
    await db.batch([
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, provider TEXT NOT NULL, secret TEXT NOT NULL, PRIMARY KEY(user_id, provider))',
      'CREATE TABLE IF NOT EXISTS login_attempts (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS signup_attempts (source TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, PRIMARY KEY(provider, subject))',
      'CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS connection_oauth_states (hash TEXT PRIMARY KEY, phase TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, verifier TEXT NOT NULL, installation_id TEXT NOT NULL, expires INTEGER NOT NULL)',
    ]);
    return accounts;
  }

  private async userRecord(name: string, password: string) {
    const normalized = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._@+-]{2,99}$/.test(normalized)) throw new Error('Use a username of 3–100 letters, numbers, or . _ @ + - characters.');
    if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12–256 characters.');
    const salt = randomBytes(16).toString('hex');
    const value = await derive(password, salt, 64) as Buffer;
    return { user: { id: randomUUID(), name: normalized }, salt, password: value.toString('hex') };
  }

  async create(name: string, password: string): Promise<User> {
    const record = await this.userRecord(name, password);
    await this.db.run('INSERT INTO users VALUES (?,?,?,?)', record.user.id, record.user.name, record.salt, record.password);
    return record.user;
  }

  async ensurePasswordAccount(name: string, password: string) {
    const normalized = name.trim().toLowerCase();
    const existing = await this.db.get<User>('SELECT id,name FROM users WHERE name=?', normalized);
    return existing || this.create(normalized, password);
  }

  async register(source: string, name: string, password: string) {
    const now = Date.now(), key = hash(source || 'unknown');
    await this.db.transaction(async db => {
      await db.run('DELETE FROM signup_attempts WHERE expires<=?', now);
      const attempt = await db.get<{count:number}>('SELECT count FROM signup_attempts WHERE source=?', key);
      if ((attempt?.count || 0) >= 5) throw new Error('Too many sign-up attempts. Try again in 15 minutes.');
      await db.run('INSERT INTO signup_attempts VALUES (?,1,?) ON CONFLICT(source) DO UPDATE SET count=count+1', key, now + 900000);
    });
    const user = await this.create(name, password);
    return this.createSession(user);
  }

  async claimLocal(userId: string, tokens: Record<string,string>) {
    await this.db.transaction(async db => {
      if (await db.get("SELECT 1 AS found FROM user_settings WHERE owner='system' AND key='local-claimed'")) throw new Error('Local workspace was already assigned.');
      const rows = await db.all<{payload:string}>("SELECT payload FROM runs WHERE owner='local'");
      if (rows.some(row => ['collecting','executing'].includes(JSON.parse(row.payload).status))) throw new Error('Stop active work before claiming the local workspace.');
      await db.run("UPDATE runs SET owner=? WHERE owner='local'", userId);
      await db.run('INSERT INTO user_settings SELECT ?,key,payload FROM settings', userId);
      await db.run("INSERT OR REPLACE INTO user_settings SELECT ?,key,payload FROM user_settings WHERE owner='local'", userId);
      for (const key of connectionKeys) if (tokens[key]) await this.setConnectionWith(db, userId, key, tokens[key]);
      await db.run("INSERT INTO user_settings VALUES ('system','local-claimed',?)", JSON.stringify(userId));
    });
  }

  async login(name: string, password: string) {
    name = name.trim().toLowerCase();
    const now = Date.now();
    const row = await this.db.transaction(async db => {
      await db.run('DELETE FROM login_attempts WHERE expires<=?', now);
      const attempt = await db.get<{count:number}>('SELECT count FROM login_attempts WHERE name=?', name);
      const total = await db.get<{count:number}>('SELECT COALESCE(SUM(count),0) AS count FROM login_attempts');
      if ((attempt?.count || 0) >= 5 || (total?.count || 0) >= 30) throw new Error('Too many sign-in attempts. Try again in 15 minutes.');
      await db.run('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(name) DO UPDATE SET count=count+1', name, now + 900000);
      return db.get<User & {salt:string;password:string}>('SELECT * FROM users WHERE name=?', name);
    });
    const value = await derive(password, row?.salt || 'unregistered-account', 64) as Buffer;
    if (!row || !timingSafeEqual(value, Buffer.from(row.password, 'hex'))) throw new Error('Invalid username or password.');
    await this.db.run('DELETE FROM login_attempts WHERE name=?', name);
    return this.createSession(row);
  }

  private async createSessionWith(db: SqlExecutor, user: User) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    await db.run('DELETE FROM sessions WHERE expires<=?', Date.now());
    await db.run('INSERT INTO sessions VALUES (?,?,?,?)', hash(token), user.id, csrf, Date.now() + 8 * 3600000);
    return { token, csrf, user: {id:user.id, name:user.name} };
  }

  private createSession(user: User) { return this.db.transaction(db => this.createSessionWith(db, user)); }

  async beginOauth(provider: IdentityProvider, verifier: string, nonce: string) {
    const state = randomBytes(32).toString('hex');
    await this.db.transaction(async db => {
      await db.run('DELETE FROM oauth_states WHERE expires<=?', Date.now());
      await db.run('INSERT INTO oauth_states VALUES (?,?,?,?,?)', hash(state), provider, verifier, nonce, Date.now() + 10 * 60000);
    });
    return state;
  }

  async consumeOauth(provider: IdentityProvider, state: string) {
    if (!/^[a-f0-9]{64}$/.test(state)) return undefined;
    const stateHash = hash(state);
    return this.db.transaction(async db => {
      const row = await db.get<{verifier:string;nonce:string;expires:number}>('SELECT verifier,nonce,expires FROM oauth_states WHERE hash=? AND provider=?', stateHash, provider);
      await db.run('DELETE FROM oauth_states WHERE hash=?', stateHash);
      return row && row.expires > Date.now() ? {verifier:row.verifier, nonce:row.nonce} : undefined;
    });
  }

  async beginConnectionOauth(userId:string, sessionToken:string, phase:ConnectionPhase, verifier='', installationId='', sessionHash=hash(sessionToken)) {
    return this.db.transaction(async db => {
      const active = await db.get('SELECT 1 AS found FROM sessions WHERE hash=? AND user_id=? AND expires>?', sessionHash, userId, Date.now());
      if (!active) throw new Error('Sign in again before connecting GitHub.');
      const state = randomBytes(32).toString('hex');
      await db.run('DELETE FROM connection_oauth_states WHERE expires<=?', Date.now());
      await db.run('INSERT INTO connection_oauth_states VALUES (?,?,?,?,?,?,?)', hash(state), phase, userId, sessionHash, verifier, installationId, Date.now()+10*60000);
      return state;
    });
  }

  async consumeConnectionOauth(phase: ConnectionPhase, state:string) {
    if (!/^[a-f0-9]{64}$/.test(state)) return undefined;
    const stateHash = hash(state);
    return this.db.transaction(async db => {
      const row = await db.get<{user_id:string;session_hash:string;verifier:string;installation_id:string;expires:number}>(`SELECT connection_oauth_states.user_id,session_hash,verifier,installation_id,connection_oauth_states.expires
        FROM connection_oauth_states JOIN sessions ON sessions.hash=session_hash AND sessions.user_id=connection_oauth_states.user_id
        WHERE connection_oauth_states.hash=? AND phase=? AND connection_oauth_states.expires>? AND sessions.expires>?`, stateHash, phase, Date.now(), Date.now());
      await db.run('DELETE FROM connection_oauth_states WHERE hash=?', stateHash);
      return row;
    });
  }

  async socialLogin(provider: IdentityProvider, subject: string, preferredName: string, email = '') {
    if (!subject || subject.length > 500) throw new Error('Invalid provider identity.');
    return this.db.transaction(async db => {
      const found = await db.get<User>('SELECT users.id,users.name FROM identities JOIN users ON users.id=identities.user_id WHERE provider=? AND subject=?', provider, subject);
      if (found) return this.createSessionWith(db, found);
      let base = preferredName.trim().toLowerCase().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 70);
      if (base.length < 3) base = `${provider}-user`;
      let name = base, suffix = 1;
      while (await db.get('SELECT 1 AS found FROM users WHERE name=?', name)) name = `${base.slice(0, 90)}-${++suffix}`;
      const user: User = {id:randomUUID(), name};
      await db.run('INSERT INTO users VALUES (?,?,?,?)', user.id, name, randomBytes(16).toString('hex'), randomBytes(64).toString('hex'));
      await db.run('INSERT INTO identities VALUES (?,?,?,?)', provider, subject, user.id, email.slice(0, 320) || null);
      return this.createSessionWith(db, user);
    });
  }

  async session(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db.get<User & {csrf:string}>('SELECT users.id, users.name, sessions.csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?', hash(token), Date.now());
  }

  async logout(token: string) { await this.db.run('DELETE FROM sessions WHERE hash=?', hash(token)); }

  private encrypt(userId: string, provider: string, token: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${provider}`));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
  }

  private async setConnectionWith(db: SqlExecutor, userId: string, provider: string, token: string) {
    if (!(connectionKeys as readonly string[]).includes(provider)) throw new Error('Unsupported connection.');
    if (!token) return void await db.run('DELETE FROM connections WHERE user_id=? AND provider=?', userId, provider);
    await db.run('INSERT INTO connections VALUES (?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET secret=excluded.secret', userId, provider, this.encrypt(userId, provider, token));
  }

  async setConnection(userId: string, provider: string, token: string) { await this.setConnectionWith(this.db, userId, provider, token); }

  async credentials(userId: string): Promise<Record<string,string>> {
    const result: Record<string,string> = {};
    const rows = await this.db.all<{provider:string;secret:string}>('SELECT provider,secret FROM connections WHERE user_id=?', userId);
    for (const row of rows) {
      const [iv,tag,encrypted] = row.secret.split('.').map(value => Buffer.from(value,'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(`${userId}:${row.provider}`)); decipher.setAuthTag(tag);
      result[row.provider] = Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
    }
    return result;
  }
}

export async function encryptionKey(path: string, db: AppDatabase, env: NodeJS.ProcessEnv = process.env) {
  const configured = (env.PROMISEGUARD_CREDENTIAL_KEY || '').trim();
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== configured.replace(/=+$/, '')) throw new Error('PROMISEGUARD_CREDENTIAL_KEY must be one base64-encoded 32-byte key.');
    return key;
  }
  if (db.isRemote) throw new Error('PROMISEGUARD_CREDENTIAL_KEY is required with Turso so encrypted connections survive restarts.');
  if (!existsSync(path)) {
    const table = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'");
    if (table && await db.get('SELECT 1 AS found FROM connections LIMIT 1')) throw new Error('Credential key is missing. Restore data/credentials.key from backup before starting.');
    writeFileSync(path, randomBytes(32), {mode:0o600,flag:'wx'});
  }
  return readFileSync(path);
}
