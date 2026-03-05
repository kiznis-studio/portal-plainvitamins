// D1-compatible adapter wrapping better-sqlite3
// Exposes the same API as Cloudflare D1 so all existing db.ts functions work unchanged
// D1: db.prepare(sql).bind(...params).first<T>() / .all<T>() / .run()
// better-sqlite3: db.prepare(sql).get(...params) / .all(...params) / .run(...params)
// Key difference: D1 uses numbered params (?1, ?2), better-sqlite3 only works with unnamed (?)

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, statSync } from 'node:fs';
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

// Convert D1 numbered params (?1, ?2) to unnamed (?) for better-sqlite3
function normalizeParams(sql: string): string {
  return sql.replace(/\?(\d+)/g, '?');
}

// Auto-tune SQLite pragmas based on DB file size.
// Large DBs benefit from big mmap/cache; small DBs waste RAM with oversized buffers.
function applyPragmas(db: InstanceType<typeof Database>, dbPath: string) {
  let fileSizeMB = 0;
  try { fileSizeMB = statSync(dbPath).size / (1024 * 1024); } catch { /* use default tier */ }

  let cacheSize: number;  // negative = KB
  let mmapSize: number;

  if (fileSizeMB > 500) {        // getfoodfacts (2.8G), plaindoctor (2G), plaincharity (739M), namealmanac (548M)
    cacheSize = -65536;           // 64MB page cache
    mmapSize = 268435456;         // 256MB mmap
  } else if (fileSizeMB > 100) { // plaincars (412M), plainvitamins (205M), plainrecalls (151M), plainhospital (129M), plainenviro (120M)
    cacheSize = -32768;           // 32MB page cache
    mmapSize = 134217728;         // 128MB mmap
  } else if (fileSizeMB > 10) {  // plainworker (73M), plainschools (54M), wagedex (42M), plainzip (18M), etc.
    cacheSize = -16384;           // 16MB page cache
    mmapSize = 67108864;          // 64MB mmap
  } else {                        // plaincrime (5M), plainrent (4.5M), plaincost (860K), etc.
    cacheSize = -4096;            // 4MB page cache
    mmapSize = 16777216;          // 16MB mmap
  }

  try {
    db.pragma(`cache_size = ${cacheSize}`);
    db.pragma(`mmap_size = ${mmapSize}`);
    db.pragma('temp_store = MEMORY');
  } catch { /* non-critical — defaults are fine */ }
}

// Self-heal WAL mode databases on read-only mounts.
// WAL mode requires writing a WAL file even for reads, which fails on :ro mounts.
// Fix: copy to /tmp, convert to DELETE journal mode, use the copy.
function openDatabase(dbPath: string): InstanceType<typeof Database> {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Try a simple prepare to verify the DB is usable
    db.prepare('SELECT 1').get();
    // Try to force DELETE mode in case the DB is WAL but mount is writable
    try { db.pragma('journal_mode = DELETE'); } catch { /* :ro mount, expected */ }

    // Performance pragmas — auto-tuned to DB file size (session-level, not persisted)
    applyPragmas(db, dbPath);

    return db;
  } catch (err: any) {
    if (!err?.message?.includes('readonly database')) throw err;

    // WAL mode on :ro mount — self-heal by copying to /tmp
    const tmpPath = join('/tmp', `d1-heal-${basename(dbPath)}`);
    console.warn(`[d1-adapter] WAL mode detected on ${dbPath} — copying to ${tmpPath} and fixing`);
    copyFileSync(dbPath, tmpPath);
    // Also copy WAL/SHM files if they exist alongside the DB
    if (existsSync(dbPath + '-wal')) copyFileSync(dbPath + '-wal', tmpPath + '-wal');
    if (existsSync(dbPath + '-shm')) copyFileSync(dbPath + '-shm', tmpPath + '-shm');

    // Open writable copy and convert to DELETE mode
    const fixDb = new Database(tmpPath);
    fixDb.pragma('journal_mode = DELETE');
    fixDb.close();

    // Now open as readonly with auto-tuned performance pragmas
    const db = new Database(tmpPath, { readonly: true });
    applyPragmas(db, dbPath);

    console.warn(`[d1-adapter] Self-healed: ${dbPath} → ${tmpPath} (journal_mode=DELETE)`);
    return db;
  }
}

export function createD1Adapter(dbPath: string): D1Database {
  const db = openDatabase(dbPath);

  // Prepared statement cache — avoids recompiling SQL on every call
  const stmtCache = new Map<string, ReturnType<typeof db.prepare>>();
  function getStmt(sql: string): ReturnType<typeof db.prepare> {
    let s = stmtCache.get(sql);
    if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
    return s;
  }

  return {
    prepare(sql: string): D1PreparedStatement {
      const normalized = normalizeParams(sql);
      const stmt = getStmt(normalized);

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
        bind(...params: unknown[]) {
          return makeBindResult(params);
        },
        // Unbound versions (no params)
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
