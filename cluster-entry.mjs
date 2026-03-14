import cluster from 'node:cluster';
import http from 'node:http';

const MIN_WORKERS = 1;
const MAX_WORKERS = parseInt(process.env.WORKERS_MAX || '4', 10);
let targetWorkers = parseInt(process.env.WORKERS || '1', 10);

if (cluster.isPrimary) {
  console.log(`[cluster] Primary ${process.pid} starting ${targetWorkers} workers`);
  for (let i = 0; i < targetWorkers; i++) cluster.fork();

  const gracefullyShuttingDown = new Set();

  cluster.on('exit', (worker, code, signal) => {
    if (gracefullyShuttingDown.has(worker.id)) {
      gracefullyShuttingDown.delete(worker.id);
      console.log(`[cluster] Worker ${worker.process.pid} shut down gracefully`);
      return;
    }
    console.warn(`[cluster] Worker ${worker.process.pid} crashed (${signal || code}), restarting`);
    if (Object.keys(cluster.workers).length < targetWorkers) {
      cluster.fork();
    }
  });

  const mgmtPort = parseInt(process.env.MGMT_PORT || '4322', 10);
  const TRM_SECRET = process.env.TRM_SECRET || '';

  http.createServer((req, res) => {
    if (TRM_SECRET && req.headers['x-trm-secret'] !== TRM_SECRET) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url, `http://localhost:${mgmtPort}`);

    if (req.method === 'GET' && url.pathname === '/_cluster/status') {
      const workerPids = Object.values(cluster.workers).map(w => w.process.pid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workers: workerPids.length,
        targetWorkers,
        minWorkers: MIN_WORKERS,
        maxWorkers: MAX_WORKERS,
        pids: workerPids,
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/_cluster/scale') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { workers: desired } = JSON.parse(body);
          const clamped = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, desired));
          const current = Object.keys(cluster.workers).length;

          if (clamped > current) {
            for (let i = 0; i < clamped - current; i++) cluster.fork();
            console.log(`[cluster] Scaling UP ${current} -> ${clamped}`);
          } else if (clamped < current) {
            const workers = Object.values(cluster.workers);
            const toKill = workers.slice(-(current - clamped));
            for (const w of toKill) {
              gracefullyShuttingDown.add(w.id);
              w.send('graceful-shutdown');
              setTimeout(() => { if (!w.isDead()) w.kill(); }, 10000);
            }
            console.log(`[cluster] Scaling DOWN ${current} -> ${clamped}`);
          }
          targetWorkers = clamped;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ previous: current, target: clamped }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }).listen(mgmtPort, '127.0.0.1');

  console.log(`[cluster] Management endpoint on :${mgmtPort}`);
} else {
  process.on('message', msg => {
    if (msg === 'graceful-shutdown') {
      console.log(`[cluster] Worker ${process.pid} shutting down gracefully`);
      setTimeout(() => process.exit(0), 5000);
    }
  });

  await import('./dist/server/entry.mjs');
}
