import { defineMiddleware } from 'astro:middleware';
import { existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isbot } from 'isbot';
import { createD1Adapter } from './lib/d1-adapter';
import { warmQueryCache } from './lib/db';

// --- DB initialization (single-DB template — multi-DB portals customize this section) ---
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/portal.db';
let db: ReturnType<typeof createD1Adapter> | null = null;
function getDb() {
  if (!db) {
    if (!existsSync(DATABASE_PATH)) return null as any;
    db = createD1Adapter(DATABASE_PATH);
  }
  return db;
}

// --- Inflight tracking (metrics only — no rate limiting) ---
// We don't rate-limit bots. Fast renders + CF edge cache handle the load.
// These counters exist for /health metrics and TRM demand scoring.
let inflightHuman = 0;
let inflightBot = 0;

// --- Event loop lag tracking ---
let eventLoopLag = 0;
const lagInterval = setInterval(() => {
  const start = performance.now();
  setImmediate(() => { eventLoopLag = performance.now() - start; });
}, 1000);
lagInterval.unref();

// --- Rolling demand metrics (15s window) ---
interface RequestSample { ts: number; latency: number; }
const samples: RequestSample[] = [];
const WINDOW_MS = 15000;

function recordRequest(latencyMs: number) {
  const now = Date.now();
  samples.push({ ts: now, latency: latencyMs });
  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
}

function getRollingMetrics() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
  if (samples.length === 0) return { requestRate: 0, avgLatency: 0 };
  const latencySum = samples.reduce((sum, s) => sum + s.latency, 0);
  return {
    requestRate: Math.round(samples.length / (WINDOW_MS / 1000) * 100) / 100,
    avgLatency: Math.round(latencySum / samples.length),
  };
}

// --- Cache warming ---
let cacheWarmed = false;
let cacheWarmedAt: string | null = null;
let warmingPromise: Promise<void> | null = null;

async function ensureWarmed(): Promise<void> {
  if (cacheWarmed) return;
  if (!warmingPromise) {
    warmingPromise = (async () => {
      const database = getDb();
      if (!database) { cacheWarmed = true; return; }
      try {
        await warmQueryCache(database);
        cacheWarmedAt = new Date().toISOString();
      } catch (err) {
        console.error('[cache] Warming failed:', err);
      }
      cacheWarmed = true;
    })();
  }
  await warmingPromise;
}

// Start warming immediately at module load (before first healthcheck)
ensureWarmed();

// --- Compressed LRU response cache ---
interface CacheEntry {
  compressed: Buffer;
  headers: Record<string, string>;
  hits: number;
  size: number; // uncompressed size for stats
}
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = parseInt(process.env.CACHE_ENTRIES || '5000', 10);
let totalHits = 0;
let totalMisses = 0;

function getCachedResponse(key: string): Response | null {
  const entry = responseCache.get(key);
  if (!entry) { totalMisses++; return null; }
  // LRU: move to end (most recently used)
  responseCache.delete(key);
  entry.hits++;
  responseCache.set(key, entry);
  totalHits++;
  try {
    const html = gunzipSync(entry.compressed);
    // Safety: verify decompressed content starts with HTML
    const prefix = html.subarray(0, 15).toString();
    if (!prefix.includes('<!') && !prefix.includes('<html')) {
      console.error(`[cache] Corrupt entry for ${key} — purging`);
      responseCache.delete(key);
      return null; // Fall through to fresh render
    }
    return new Response(html, {
      headers: { ...entry.headers, 'X-Cache': 'HIT' },
    });
  } catch (e) {
    // Decompress failed — corrupt cache entry, purge it
    console.error(`[cache] Decompress failed for ${key}: ${(e as Error).message}`);
    responseCache.delete(key);
    return null; // Fall through to fresh render
  }
}

function cacheResponse(key: string, body: string, headers: Record<string, string>) {
  // Only cache valid HTML responses
  if (!body || body.length < 50 || (!body.startsWith('<!') && !body.startsWith('<html'))) {
    return; // Don't cache empty, tiny, or non-HTML responses
  }
  if (responseCache.has(key)) responseCache.delete(key);
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
  try {
    const compressed = gzipSync(body, { level: 6 });
    const { 'Content-Length': _, ...safeHeaders } = headers;
    responseCache.set(key, { compressed, headers: safeHeaders, hits: 0, size: body.length });
  } catch {
    // Compression failed — skip caching, not critical
  }
}

// --- Cache stats (for health endpoint) ---
function getCacheStats() {
  const entries: Array<{ url: string; hits: number }> = [];
  for (const [key, entry] of responseCache) {
    entries.push({ url: key, hits: entry.hits });
  }
  entries.sort((a, b) => b.hits - a.hits);
  return {
    size: responseCache.size,
    maxSize: MAX_CACHE_ENTRIES,
    totalHits,
    totalMisses,
    hitRate: (totalHits + totalMisses) > 0
      ? Math.round((totalHits / (totalHits + totalMisses)) * 1000) / 1000
      : 0,
    top10: entries.slice(0, 10),
  };
}

export { inflightHuman, inflightBot, eventLoopLag, responseCache, cacheWarmed, cacheWarmedAt, getCacheStats, getRollingMetrics };

// --- PORTAL-SPECIFIC: Edge TTL per path pattern ---
// Generic regex covers all known entity paths across all portals.
// Override per-portal in each portal's middleware copy if needed.
function getEdgeTtl(path: string): number {
  if (path.match(/^\/(provider|employer|school|facility|drug|breed|county|city|metro|state|airport|lender|system|occupation|company|chapter|product)\//)) return 86400;
  if (path.match(/^\/(rankings|guides)\//)) return 21600;
  return 3600;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  (context.locals as any).runtime = { env: { DB: getDb() } };

  // Health endpoint: available during warming (returns warming status)
  if (path === '/health') {
    if (!cacheWarmed) {
      ensureWarmed();
      return new Response(JSON.stringify({ status: 'warming' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    return next();
  }

  if (path.startsWith('/_astro/') || path.startsWith('/favicon') || path.startsWith('/_cluster')) return next();

  // Block all non-health requests until cache is warmed
  if (!cacheWarmed) await ensureWarmed();

  if (context.request.method === 'GET') {
    const cacheKey = path + context.url.search;
    const cached = getCachedResponse(cacheKey);
    if (cached) return cached;

    const ua = context.request.headers.get('user-agent') || '';
    const isBotUA = isbot(ua);

    // Track inflight counts (for /health metrics + TRM demand scoring)
    if (isBotUA) inflightBot++;
    else inflightHuman++;

    const start = performance.now();
    try {
      const response = await next();
      const elapsed = performance.now() - start;
      recordRequest(elapsed);
      if (elapsed > 500) {
        console.warn(`[slow] ${path} ${Math.round(elapsed)}ms lag=${Math.round(eventLoopLag)}ms`);
      }

      if (response.status === 200) {
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/html') || ct.includes('xml')) {
          const ttl = ct.includes('xml') ? 86400 : getEdgeTtl(path);
          const body = await response.text();
          const headers: Record<string, string> = {
            'Content-Type': ct,
            'Cache-Control': `public, max-age=300, s-maxage=${ttl}`,
          };
          cacheResponse(cacheKey, body, headers);
          // MISS: always serve uncompressed — Caddy/CF handle compression
          // (serving pre-gzipped buffers causes double-compression issues)
          return new Response(body, { headers: { ...headers, 'X-Cache': 'MISS' } });
        }
      }
      return response;
    } finally {
      if (isBotUA) inflightBot--;
      else inflightHuman--;
    }
  }

  return next();
});
