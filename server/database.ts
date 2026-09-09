import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient, type Client, type InValue, type ResultSet, type Transaction } from '@tursodatabase/serverless/compat';

export type SqlValue = InValue;
export type SqlRow = Record<string, SqlValue>;
export type RunResult = { changes: number };

export interface SqlExecutor {
  get<T extends object = SqlRow>(sql: string, ...args: SqlValue[]): Promise<T | undefined>;
  all<T extends object = SqlRow>(sql: string, ...args: SqlValue[]): Promise<T[]>;
  run(sql: string, ...args: SqlValue[]): Promise<RunResult>;
}

class Mutex {
  private tail = Promise.resolve();
  async use<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }
}

function objectRows(result: ResultSet): SqlRow[] {
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as SqlRow);
}

function plainRow<T extends object>(row: T | undefined) {
  return row ? { ...row } as T : undefined;
}

export class AppDatabase implements SqlExecutor {
  private readonly mutex = new Mutex();
  private constructor(private local?: DatabaseSync, private remote?: Client) {}

  static async open(path: string, env: NodeJS.ProcessEnv = process.env) {
    const url = (env.TURSO_DATABASE_URL || '').trim();
    const authToken = (env.TURSO_AUTH_TOKEN || '').trim();
    if (Boolean(url) !== Boolean(authToken)) throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or neither.');
    if (url) {
      if (!url.startsWith('libsql://') && !url.startsWith('https://')) throw new Error('TURSO_DATABASE_URL must use libsql:// or https://.');
      const remote = createClient({ url, authToken });
      const database = new AppDatabase(undefined, remote);
      await database.get<{ ready: number }>('SELECT 1 AS ready');
      return database;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new AppDatabase(new DatabaseSync(path));
  }

  get isRemote() { return Boolean(this.remote); }

  private async unlockedGet<T extends object>(sql: string, args: SqlValue[]) {
    if (this.local) return plainRow(this.local.prepare(sql).get(...args as any[]) as T | undefined);
    const result = await this.remote!.execute(sql, args);
    return objectRows(result)[0] as T | undefined;
  }

  private async unlockedAll<T extends object>(sql: string, args: SqlValue[]) {
    if (this.local) return (this.local.prepare(sql).all(...args as any[]) as T[]).map(row => plainRow(row)!);
    return objectRows(await this.remote!.execute(sql, args)) as T[];
  }

  private async unlockedRun(sql: string, args: SqlValue[]) {
    if (this.local) return { changes: Number(this.local.prepare(sql).run(...args as any[]).changes) };
    return { changes: (await this.remote!.execute(sql, args)).rowsAffected };
  }

  get<T extends object = SqlRow>(sql: string, ...args: SqlValue[]) { return this.mutex.use(() => this.unlockedGet<T>(sql, args)); }
  all<T extends object = SqlRow>(sql: string, ...args: SqlValue[]) { return this.mutex.use(() => this.unlockedAll<T>(sql, args)); }
  run(sql: string, ...args: SqlValue[]) { return this.mutex.use(() => this.unlockedRun(sql, args)); }

  async batch(statements: Array<string | { sql: string; args?: SqlValue[] }>) {
    return this.mutex.use(async () => {
      if (this.local) {
        this.local.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of statements) {
            const sql = typeof statement === 'string' ? statement : statement.sql;
            const args = typeof statement === 'string' ? [] : statement.args || [];
            this.local.prepare(sql).run(...args as any[]);
          }
          this.local.exec('COMMIT');
        } catch (error) {
          try { this.local.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return;
      }
      await this.remote!.batch(statements, 'immediate');
    });
  }

  async transaction<T>(work: (db: SqlExecutor) => Promise<T>): Promise<T> {
    return this.mutex.use(async () => {
      if (this.local) {
        this.local.exec('BEGIN IMMEDIATE');
        const executor: SqlExecutor = {
          get: <R extends object = SqlRow>(sql: string, ...args: SqlValue[]) => this.unlockedGet<R>(sql, args),
          all: <R extends object = SqlRow>(sql: string, ...args: SqlValue[]) => this.unlockedAll<R>(sql, args),
          run: (sql: string, ...args: SqlValue[]) => this.unlockedRun(sql, args),
        };
        try { const result = await work(executor); this.local.exec('COMMIT'); return result; }
        catch (error) {
          try { this.local.exec('ROLLBACK'); } catch {}
          throw error;
        }
      }
      const transaction = await this.remote!.transaction('write');
      const executor = remoteTransactionExecutor(transaction);
      try { const result = await work(executor); await transaction.commit(); return result; }
      catch (error) {
        try { await transaction.rollback(); } catch {}
        throw error;
      }
      finally {
        try { transaction.close(); } catch {}
      }
    });
  }

  async close() {
    await this.mutex.use(async () => {
      if (this.local) this.local.close();
      else this.remote!.close();
    });
  }
}

function remoteTransactionExecutor(transaction: Transaction): SqlExecutor {
  const execute = async (sql: string, args: SqlValue[]) => transaction.execute({ sql, args });
  return {
    get: async <T extends object = SqlRow>(sql: string, ...args: SqlValue[]) => objectRows(await execute(sql, args))[0] as T | undefined,
    all: async <T extends object = SqlRow>(sql: string, ...args: SqlValue[]) => objectRows(await execute(sql, args)) as T[],
    run: async (sql: string, ...args: SqlValue[]) => ({ changes: (await execute(sql, args)).rowsAffected }),
  };
}
