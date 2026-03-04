import { defineMiddleware } from 'astro:middleware';
import { existsSync } from 'node:fs';
import { isbot } from 'isbot';
import { createD1Adapter } from './lib/d1-adapter';

// --- DB initialization ---
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/portal.db';
let db: ReturnType<typeof createD1Adapter> | null = null;
function getDb() {
  if (!db) {
    if (!existsSync(DATABASE_PATH)) return null as any; // build time: no DB file
    db = createD1Adapter(DATABASE_PATH);
  }
  return db;
}

// --- Concurrency guard ---
let inflightRequests = 0;
const MAX_CONCURRENT = 15;

// --- Event loop lag tracking ---
let eventLoopLag = 0;
const lagInterval = setInterval(() => {
  const start = performance.now();
  setImmediate(() => { eventLoopLag = performance.now() - start; });
}, 1000);
lagInterval.unref();

// --- In-memory response cache (5min TTL, 500 entries) ---
const responseCache = new Map<string, { body: string; headers: Record<string, string>; expiry: number }>();
const CACHE_TTL = 300_000;
const MAX_CACHE_ENTRIES = 500;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (now > entry.expiry) responseCache.delete(key);
  }
}, 600_000);
cleanupInterval.unref();

function getCachedResponse(key: string): Response | null {
  const entry = responseCache.get(key);
  if (!entry || Date.now() > entry.expiry) {
    if (entry) responseCache.delete(key);
    return null;
  }
  return new Response(entry.body, {
    headers: { ...entry.headers, 'X-Cache': 'HIT' },
  });
}

function cacheResponse(key: string, body: string, headers: Record<string, string>) {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
  responseCache.set(key, { body, headers, expiry: Date.now() + CACHE_TTL });
}

export { inflightRequests, eventLoopLag, responseCache };

function getEdgeTtl(path: string): number {
  if (path.startsWith("/supplement/")) return 86400;
  if (path.startsWith("/ingredient/") || path.startsWith("/brand/")) return 86400;
  if (path.startsWith("/rankings/")) return 21600;
  return 3600;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  (context.locals as any).runtime = { env: { DB: getDb() } };
  if (path === '/health') return next();
  if (path.startsWith('/_astro/') || path.startsWith('/favicon')) return next();

  if (context.request.method === 'GET') {
    const cacheKey = path + context.url.search;
    const cached = getCachedResponse(cacheKey);
    if (cached) return cached;

    const ua = context.request.headers.get('user-agent') || '';
    const isBotUA = isbot(ua);
    if (!isBotUA && inflightRequests >= MAX_CONCURRENT) {
      return new Response('Service busy', {
        status: 503,
        headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
      });
    }

    if (!isBotUA) inflightRequests++;
    const start = performance.now();
    try {
      const response = await next();
      const elapsed = performance.now() - start;
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
          return new Response(body, { headers: { ...headers, 'X-Cache': 'MISS' } });
        }
      }
      return response;
    } finally {
      if (!isBotUA) inflightRequests--;
    }
  }

  return next();
});
