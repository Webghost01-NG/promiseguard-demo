import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import type { Run } from './domain.ts';

export class Store {
  db: DatabaseSync;
  constructor(path = 'data/promiseguard.sqlite', public readonly owner = 'local') {
    if (path !== ':memory:') mkdirSync('data', { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);');
    if (!(this.db.prepare('PRAGMA table_info(runs)').all() as {name:string}[]).some(c => c.name === 'owner')) this.db.exec("ALTER TABLE runs ADD COLUMN owner TEXT NOT NULL DEFAULT 'local'");
    this.db.exec('CREATE TABLE IF NOT EXISTS user_settings (owner TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,key));');
  }
  save(run: Run) {
    run.updatedAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO runs (id,payload,owner) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE runs.owner=excluded.owner').run(run.id, JSON.stringify(run), this.owner);
    if (!result.changes) throw new Error('Run not found.');
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id=? AND owner=?').get(id, this.owner) as { payload: string } | undefined;
    if (!row) throw new Error('Run not found.');
    return JSON.parse(row.payload);
  }
  list(): Run[] {
    return (this.db.prepare('SELECT payload FROM runs WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(this.owner) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  setting(key: string): unknown {
    const row = this.db.prepare('SELECT payload FROM user_settings WHERE key=? AND owner=?').get(key, this.owner) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO user_settings (owner,key,payload) VALUES (?,?,?) ON CONFLICT(owner,key) DO UPDATE SET payload=excluded.payload').run(this.owner, key, JSON.stringify(value));
  }
  recover() {
    const rows = this.db.prepare('SELECT payload FROM runs WHERE owner=?').all(this.owner) as {payload:string}[];
    for (const {payload} of rows) {
      const run: Run = JSON.parse(payload);
      if (run.status === 'collecting') {
        run.status = 'failed'; run.error = 'Analysis was interrupted. Start a new analysis; no writes were made.'; this.save(run);
      }
      if (run.status === 'executing') {
        run.status = 'partial';
        run.error = 'The application restarted. Review and resume to reconcile unfinished actions.';
        for (const action of run.actions) if (action.status === 'in_flight') action.status = 'unknown';
        this.save(run);
      }
    }
  }
}
