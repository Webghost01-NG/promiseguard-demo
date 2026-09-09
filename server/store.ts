import { AppDatabase } from './database.ts';
import type { Run } from './domain.ts';

export class Store {
  constructor(public readonly db: AppDatabase, public readonly owner = 'local') {}
  static async open(path = 'data/promiseguard.sqlite', owner = 'local', env: NodeJS.ProcessEnv = process.env) {
    const db = await AppDatabase.open(path, env);
    await db.batch([
      'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, owner TEXT NOT NULL DEFAULT \'local\')',
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS user_settings (owner TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,key))',
    ]);
    const columns = await db.all<{ name: string }>('PRAGMA table_info(runs)');
    if (!columns.some(column => column.name === 'owner')) await db.run("ALTER TABLE runs ADD COLUMN owner TEXT NOT NULL DEFAULT 'local'");
    return new Store(db, owner);
  }
  scoped(owner: string) { return new Store(this.db, owner); }
  async save(run: Run) {
    run.updatedAt = new Date().toISOString();
    const result = await this.db.run('INSERT INTO runs (id,payload,owner) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE runs.owner=excluded.owner', run.id, JSON.stringify(run), this.owner);
    if (!result.changes) throw new Error('Run not found.');
  }
  async get(id: string): Promise<Run> {
    const row = await this.db.get<{ payload: string }>('SELECT payload FROM runs WHERE id=? AND owner=?', id, this.owner);
    if (!row) throw new Error('Run not found.');
    return JSON.parse(row.payload);
  }
  async list(): Promise<Run[]> {
    return (await this.db.all<{ payload: string }>('SELECT payload FROM runs WHERE owner=? ORDER BY rowid DESC LIMIT 100', this.owner)).map(row => JSON.parse(row.payload));
  }
  async setting(key: string): Promise<unknown> {
    const row = await this.db.get<{ payload: string }>('SELECT payload FROM user_settings WHERE key=? AND owner=?', key, this.owner);
    return row ? JSON.parse(row.payload) : null;
  }
  async setSetting(key: string, value: unknown) {
    await this.db.run('INSERT INTO user_settings (owner,key,payload) VALUES (?,?,?) ON CONFLICT(owner,key) DO UPDATE SET payload=excluded.payload', this.owner, key, JSON.stringify(value));
  }
  async recover() {
    const rows = await this.db.all<{payload:string}>('SELECT payload FROM runs WHERE owner=?', this.owner);
    for (const {payload} of rows) {
      const run: Run = JSON.parse(payload);
      if (run.status === 'collecting') {
        run.status = 'failed'; run.error = 'Analysis was interrupted. Start a new analysis; no writes were made.'; await this.save(run);
      }
      if (run.status === 'executing') {
        run.status = 'partial';
        run.error = 'The application restarted. Review and resume to reconcile unfinished actions.';
        for (const action of run.actions) if (action.status === 'in_flight') action.status = 'unknown';
        await this.save(run);
      }
    }
  }
}
