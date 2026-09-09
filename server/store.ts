import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import type { Run } from './domain.ts';

export class Store {
  db: DatabaseSync;
  constructor(path = 'data/promiseguard.sqlite') {
    if (path !== ':memory:') mkdirSync('data', { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);');
  }
  save(run: Run) {
    run.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO runs (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id, JSON.stringify(run));
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id) as { payload: string } | undefined;
    if (!row) throw new Error('Run not found.');
    return JSON.parse(row.payload);
  }
  list(): Run[] {
    return (this.db.prepare('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100').all() as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  setting(key: string): unknown {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key=?').get(key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, JSON.stringify(value));
  }
  recover() {
    for (const run of this.list()) {
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
