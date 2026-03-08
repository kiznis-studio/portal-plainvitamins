import type { APIRoute } from 'astro';
import { inflightRequests, eventLoopLag, cacheWarmed, cacheWarmedAt, getCacheStats } from '../middleware';
import { getQueryCacheSize } from '../lib/db';
import { dbMeta } from '../lib/d1-adapter';

export const prerender = false;

const startTime = Date.now();

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env || {};

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
  const cacheStats = getCacheStats();

  return new Response(JSON.stringify({
    status: allDbOk ? 'ok' : 'degraded',
    uptime: Math.round((Date.now() - startTime) / 1000),
    memMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    eventLoopLagMs: Math.round(eventLoopLag * 100) / 100,
    inflight: inflightRequests,
    dbs: dbResults,
    cache: {
      warmed: cacheWarmed,
      warmedAt: cacheWarmedAt,
      response: {
        size: cacheStats.size,
        maxSize: cacheStats.maxSize,
        hitRate: cacheStats.hitRate,
        totalHits: cacheStats.totalHits,
        totalMisses: cacheStats.totalMisses,
        top10: cacheStats.top10,
      },
      query: {
        size: getQueryCacheSize(),
      },
    },
    db: {
      mmapSizeMB: Math.round(dbMeta.mmapSize / 1048576),
      fileSizeMB: Math.round(dbMeta.fileSizeBytes / 1048576),
    },
  }), {
    status: allDbOk ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
