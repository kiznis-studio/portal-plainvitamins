// D1-compatible adapter wrapping better-sqlite3
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...params: unknown[]): {
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<D1Result<T>>;
    run(): Promise<{ success: boolean; meta: Record<string, unknown> }>;
  };
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<{ success: boolean; meta: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

function normalizeParams(sql: string): string {
  return sql.replace(/\?(\d+)/g, '?');
}

function openDatabase(dbPath: string): InstanceType<typeof Database> {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.prepare('SELECT 1').get();
    try { db.pragma('journal_mode = DELETE'); } catch { /* :ro mount, expected */ }
    return db;
  } catch (err: any) {
    if (!err?.message?.includes('readonly database')) throw err;
    const tmpPath = join('/tmp', `d1-heal-${basename(dbPath)}`);
    console.warn(`[d1-adapter] WAL mode detected on ${dbPath} — copying to ${tmpPath} and fixing`);
    copyFileSync(dbPath, tmpPath);
    if (existsSync(dbPath + '-wal')) copyFileSync(dbPath + '-wal', tmpPath + '-wal');
    if (existsSync(dbPath + '-shm')) copyFileSync(dbPath + '-shm', tmpPath + '-shm');
    const fixDb = new Database(tmpPath);
    fixDb.pragma('journal_mode = DELETE');
    fixDb.close();
    const db = new Database(tmpPath, { readonly: true });
    console.warn(`[d1-adapter] Self-healed: ${dbPath} → ${tmpPath} (journal_mode=DELETE)`);
    return db;
  }
}

export function createD1Adapter(dbPath: string): D1Database {
  const db = openDatabase(dbPath);
  return {
    prepare(sql: string): D1PreparedStatement {
      const stmt = db.prepare(normalizeParams(sql));
      function makeBindResult(params: unknown[]) {
        return {
          async first<T = unknown>(): Promise<T | null> {
            const row = stmt.get(...params);
            return (row as T) ?? null;
          },
          async all<T = unknown>(): Promise<D1Result<T>> {
            const rows = stmt.all(...params);
            return { results: rows as T[], success: true, meta: {} };
          },
          async run() {
            stmt.run(...params);
            return { success: true, meta: {} };
          },
        };
      }
      return {
        bind(...params: unknown[]) { return makeBindResult(params); },
        async first<T = unknown>(): Promise<T | null> {
          const row = stmt.get();
          return (row as T) ?? null;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all();
          return { results: rows as T[], success: true, meta: {} };
        },
        async run() {
          stmt.run();
          return { success: true, meta: {} };
        },
      };
    },
  };
}
