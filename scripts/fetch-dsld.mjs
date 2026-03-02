#!/usr/bin/env node
/**
 * Fetch DSLD product data from NIH API — TWO-PHASE approach
 *
 * MUST run from a US IP (Aurora/Sentinel) — NIH API blocks non-US IPs.
 * Uses curl (not Node fetch) — AWS ELB blocks Node's TLS fingerprint.
 * NIH API rate-limits aggressively (~900 reqs triggers block).
 *
 * Phase 1: Bulk listing data via search-filter (few large requests)
 *   - 9 product types × 10K results each = ~90K products in 9 API calls
 *   - For types >10K: also fetch descending sort (covers first+last 10K each)
 *   - Output: dsld-products.ndjson (listing data: name, brand, type, ingredients list)
 *
 * Phase 2: Label detail enrichment (slow, low-concurrency)
 *   - Fetch label/{id} for each product with quantities, DV%, servings
 *   - Concurrency: 3, with 500ms delay between batches
 *   - Output: dsld-labels.ndjson (full label data)
 *   - Can be run separately, is resumable
 *
 * Usage:
 *   node scripts/fetch-dsld.mjs --phase 1 [--output /storage/plainvitamins/]
 *   node scripts/fetch-dsld.mjs --phase 2 [--output /storage/plainvitamins/]
 */

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

const BASE = 'https://api.ods.od.nih.gov/dsld/v9';
const args = process.argv.slice(2);
const phaseIdx = args.indexOf('--phase');
const outIdx = args.indexOf('--output');
const PHASE = phaseIdx >= 0 ? parseInt(args[phaseIdx + 1]) : 1;
const OUT_DIR = outIdx >= 0 ? args[outIdx + 1] : '/storage/plainvitamins';

const PRODUCT_TYPES = [
  { code: 'A1299', name: 'Mineral', count: 8191 },
  { code: 'A1302', name: 'Vitamin', count: 12358 },
  { code: 'A1305', name: 'Amino acid/Protein', count: 9363 },
  { code: 'A1306', name: 'Botanical', count: 55666 },
  { code: 'A1309', name: 'Non-Nutrient/Non-Botanical', count: 25229 },
  { code: 'A1310', name: 'Fat/Fatty Acid', count: 8544 },
  { code: 'A1315', name: 'Multi-Vitamin and Mineral', count: 3365 },
  { code: 'A1317', name: 'Botanical with Nutrients', count: 11783 },
  { code: 'A1325', name: 'Other Combinations', count: 76497 },
];

function curlJson(url) {
  try {
    const stdout = execFileSync('curl', ['-s', '--max-time', '60', url], {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024, // 100MB
    });
    return JSON.parse(stdout);
  } catch (e) {
    console.error(`  curl failed for ${url}: ${e.message}`);
    return null;
  }
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

// ────────────────────────────────────────
// Phase 1: Bulk listing data via search-filter
// ────────────────────────────────────────
async function phase1() {
  const outFile = `${OUT_DIR}/dsld-products.ndjson`;
  console.log('Phase 1: Fetching listing data via search-filter');
  console.log(`Output: ${outFile}`);
  console.log('');

  const seen = new Set();
  let totalProducts = 0;
  writeFileSync(outFile, ''); // start fresh

  for (const type of PRODUCT_TYPES) {
    console.log(`\n--- ${type.name} (${type.code}) — ${type.count} products ---`);

    // Ascending sort (first 10K)
    const url1 = `${BASE}/search-filter?q=*&product_type=${type.code}&size=10000&from=0&sort_by=entryDate&sort_order=asc`;
    console.log(`  Fetching ascending (first 10K)...`);
    const data1 = curlJson(url1);
    if (!data1 || !data1.hits) {
      console.error(`  FAILED — skipping type`);
      sleep(5000);
      continue;
    }

    let added = 0;
    for (const hit of data1.hits) {
      if (!seen.has(hit._id)) {
        seen.add(hit._id);
        appendFileSync(outFile, JSON.stringify({ id: hit._id, ...hit._source }) + '\n');
        added++;
      }
    }
    console.log(`  Got ${data1.hits.length} hits, ${added} new`);
    totalProducts += added;

    // For types >10K, also fetch descending (last 10K)
    if (type.count > 10000) {
      sleep(2000); // be polite
      const url2 = `${BASE}/search-filter?q=*&product_type=${type.code}&size=10000&from=0&sort_by=entryDate&sort_order=desc`;
      console.log(`  Fetching descending (last 10K)...`);
      const data2 = curlJson(url2);
      if (data2 && data2.hits) {
        let added2 = 0;
        for (const hit of data2.hits) {
          if (!seen.has(hit._id)) {
            seen.add(hit._id);
            appendFileSync(outFile, JSON.stringify({ id: hit._id, ...hit._source }) + '\n');
            added2++;
          }
        }
        console.log(`  Got ${data2.hits.length} hits, ${added2} new (${type.count - seen.size} still missing from this type)`);
        totalProducts += added2;
      }
    }

    sleep(2000); // rate limit buffer
  }

  console.log(`\n\nPhase 1 complete!`);
  console.log(`Total unique products: ${totalProducts}`);
  console.log(`Output: ${outFile}`);
  console.log(`\nNote: Types >20K are capped at 20K (asc+desc). Run Phase 2 for full label data.`);
}

// ────────────────────────────────────────
// Phase 2: Label detail enrichment (slow)
// ────────────────────────────────────────
async function phase2() {
  const productsFile = `${OUT_DIR}/dsld-products.ndjson`;
  const labelsFile = `${OUT_DIR}/dsld-labels.ndjson`;
  const CONCURRENCY = 3;
  const DELAY_MS = 500;

  if (!existsSync(productsFile)) {
    console.error(`Products file not found: ${productsFile}`);
    console.error('Run Phase 1 first.');
    process.exit(1);
  }

  // Get all product IDs
  const allIds = readFileSync(productsFile, 'utf-8').trim().split('\n')
    .map(line => { try { return JSON.parse(line).id; } catch { return null; } })
    .filter(Boolean)
    .map(id => typeof id === 'string' ? parseInt(id) : id);

  // Get already-fetched IDs for resume
  const doneIds = new Set();
  if (existsSync(labelsFile)) {
    for (const line of readFileSync(labelsFile, 'utf-8').trim().split('\n')) {
      try { const d = JSON.parse(line); if (d.id) doneIds.add(d.id); } catch {}
    }
  }

  const todoIds = allIds.filter(id => !doneIds.has(id));
  console.log(`Phase 2: Label detail enrichment`);
  console.log(`Total products: ${allIds.length}`);
  console.log(`Already fetched: ${doneIds.size}`);
  console.log(`Remaining: ${todoIds.length}`);
  console.log(`Concurrency: ${CONCURRENCY}, Delay: ${DELAY_MS}ms`);
  console.log(`ETA: ~${(todoIds.length / CONCURRENCY * (DELAY_MS + 300) / 60000).toFixed(0)} minutes`);
  console.log('');

  let fetched = 0;
  let errors = 0;

  for (let i = 0; i < todoIds.length; i += CONCURRENCY) {
    const batch = todoIds.slice(i, i + CONCURRENCY);
    const results = [];

    // Sequential within small batch to avoid rate limits
    for (const id of batch) {
      const data = curlJson(`${BASE}/label/${id}`);
      if (data && !Array.isArray(data) && data.id) {
        results.push(data);
      } else {
        errors++;
      }
    }

    if (results.length > 0) {
      appendFileSync(labelsFile, results.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    fetched += results.length;

    if ((i / CONCURRENCY) % 50 === 0) {
      const pct = ((i + batch.length) / todoIds.length * 100).toFixed(1);
      process.stdout.write(`\r[${pct}%] Fetched: ${fetched + doneIds.size}/${allIds.length} | Errors: ${errors}    `);
    }

    sleep(DELAY_MS);
  }

  console.log(`\n\nPhase 2 complete!`);
  console.log(`Labels fetched: ${fetched + doneIds.size}/${allIds.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Output: ${labelsFile}`);
}

// ────────────────────────────────────────
if (PHASE === 1) phase1();
else if (PHASE === 2) phase2();
else console.error('Usage: --phase 1 or --phase 2');
