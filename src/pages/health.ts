import type { APIRoute } from 'astro';
import { inflightRequests, eventLoopLag, responseCache } from '../middleware';
import { getQueryCacheSize } from '../lib/db';

export const prerender = false;

const startTime = Date.now();

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env || {};

  // Check all DBs in runtime.env (works for single-DB and multi-DB portals)
  const dbResults: Record<string, boolean> = {};
  for (const [key, db] of Object.entries(env)) {
    if (db && typeof (db as any).prepare === 'function') {
      try {
        const row = await (db as any).prepare('SELECT 1 AS ok').first();
        dbResults[key] = row?.ok === 1;
      } catch {
        dbResults[key] = false;
      }
    }
  }

  const allDbOk = Object.keys(dbResults).length > 0 && Object.values(dbResults).every(v => v);
  const mem = process.memoryUsage();
  const status = allDbOk ? 'ok' : 'degraded';

  return new Response(JSON.stringify({
    status,
    uptime: Math.round((Date.now() - startTime) / 1000),
    memMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    eventLoopLagMs: Math.round(eventLoopLag * 100) / 100,
    responseCacheSize: responseCache.size,
    queryCacheSize: getQueryCacheSize(),
    inflight: inflightRequests,
    dbs: dbResults,
  }), {
    status: allDbOk ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
