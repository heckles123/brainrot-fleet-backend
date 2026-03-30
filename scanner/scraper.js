// ============================================================================
// scraper.js — High-Throughput Concurrent Roblox Server Scraper
// ============================================================================
//
// DESIGN:
//   Maximum throughput. Every proxy runs its own independent pagination
//   worker concurrently. All fire at the same time via Promise.allSettled.
//   Pool has NO upper size limit — every discovered Job ID is stored.
//   The pool uses an index-based atomic queue so no two bots ever receive
//   the same Job ID even under hundreds of concurrent requests.
//   Scrape loop runs continuously with configurable micro-delay.
//
// ARCHITECTURE:
//   - N proxies = N concurrent pagination workers per cycle
//   - Each worker independently walks all pages via nextPageCursor
//   - O(1) dequeue via head index (no array.shift/splice overhead)
//   - O(1) dedup via Set
//   - Periodic compaction reclaims consumed array memory
//   - History TTL eviction keeps memory bounded
//
// ============================================================================

const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLACE_ID = process.env.PLACE_ID || "109983668079237";
const SERVERS_API = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public`;

// Delay between full scrape cycles (ms). 0 = tight loop (max speed).
const CYCLE_DELAY_MS = parseInt(process.env.SCRAPER_CYCLE_DELAY_MS || "2000", 10);

// Delay between page fetches PER PROXY within a cycle (ms).
// Each proxy respects this independently. Low = aggressive.
const PER_PROXY_PAGE_DELAY_MS = parseInt(process.env.PER_PROXY_PAGE_DELAY_MS || "100", 10);

// Max pages each proxy chases per cycle
const MAX_PAGES_PER_PROXY = parseInt(process.env.MAX_PAGES_PER_PROXY || "50", 10);

// Concurrent direct workers when no proxies are configured
const DIRECT_WORKERS = parseInt(process.env.SCRAPER_DIRECT_WORKERS || "2", 10);

// Minimum players in server to add to pool (skip empties)
const MIN_PLAYERS = parseInt(process.env.SCRAPER_MIN_PLAYERS || "1", 10);

// Scanned server cooldown before it can be re-queued (ms)
const HISTORY_COOLDOWN_MS = parseInt(process.env.HISTORY_COOLDOWN_MS || "300000", 10);

// Max history entries (memory ceiling, set high)
const HISTORY_MAX_SIZE = parseInt(process.env.HISTORY_MAX_SIZE || "50000", 10);

// Per-request timeout (ms)
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPER_FETCH_TIMEOUT_MS || "12000", 10);

// Retries on 429 per proxy per page
const RETRY_ON_429 = parseInt(process.env.SCRAPER_RETRY_ON_429 || "2", 10);

// Proxy list
const PROXY_LIST_RAW = process.env.PROXY_LIST || "";

// ---------------------------------------------------------------------------
// Proxy Setup
// ---------------------------------------------------------------------------

const proxyUrls = PROXY_LIST_RAW.split(",").map((p) => p.trim()).filter((p) => p.length > 0);

// Pre-build reusable proxy agents
const proxyAgents = proxyUrls.map((url) => ({
  url,
  agent: new HttpsProxyAgent(url),
  label: url.replace(/^https?:\/\/[^@]+@/, ""),
}));

function log(msg) {
  console.log(`[${new Date().toISOString()}][SCRAPER] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// ATOMIC QUEUE — Lock-Free Job ID Pool
// ---------------------------------------------------------------------------
//
// Node.js is single-threaded so there are no true race conditions, but
// this design guarantees that every call to dequeueBatch() gets unique
// items even when hundreds of async Express handlers resolve in the
// same event loop turn — because the headIndex increment is synchronous.
//
// No array mutation on dequeue (no shift/splice). O(1) per item.
// Periodic compaction reclaims memory from consumed slots.
// ---------------------------------------------------------------------------

let pool = [];
let headIndex = 0;
const knownIds = new Set(); // Every ID ever seen (pool + assigned + history)

/**
 * Atomically dequeue up to `count` Job IDs from the pool.
 * Guaranteed unique — no two calls ever return the same ID.
 */
function dequeueBatch(count) {
  const available = pool.length - headIndex;
  const take = Math.min(count, available);
  if (take <= 0) return [];

  const start = headIndex;
  headIndex += take; // Atomic within the synchronous call

  const batch = pool.slice(start, start + take);

  // Compact when consumed portion exceeds threshold
  if (headIndex > 10000 && headIndex > pool.length * 0.5) {
    pool = pool.slice(headIndex);
    headIndex = 0;
    log(`Queue compacted (freed ${start} consumed slots)`);
  }

  return batch;
}

/**
 * Count of Job IDs available for assignment right now.
 */
function availableCount() {
  return pool.length - headIndex;
}

/**
 * Enqueue a new Job ID. Returns false if already known (dedup).
 */
function enqueue(jobId) {
  if (knownIds.has(jobId)) return false;
  knownIds.add(jobId);
  pool.push(jobId);
  return true;
}

/**
 * Re-add a Job ID to the back of the queue (expired assignment).
 */
function requeue(jobId) {
  pool.push(jobId);
}

// ---------------------------------------------------------------------------
// SCAN HISTORY
// ---------------------------------------------------------------------------

const scanHistory = new Map();

function addToHistory(jobId, botId, found = false) {
  // Bulk evict oldest 10% when at capacity
  if (scanHistory.size >= HISTORY_MAX_SIZE) {
    const evictCount = Math.floor(HISTORY_MAX_SIZE * 0.1);
    let evicted = 0;
    for (const key of scanHistory.keys()) {
      scanHistory.delete(key);
      knownIds.delete(key);
      if (++evicted >= evictCount) break;
    }
  }
  scanHistory.set(jobId, { botId, timestamp: Date.now(), found });
}

function isInHistory(jobId) {
  const entry = scanHistory.get(jobId);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > HISTORY_COOLDOWN_MS) {
    scanHistory.delete(jobId);
    knownIds.delete(jobId);
    return false;
  }
  return true;
}

// Periodic history cleanup
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [jobId, entry] of scanHistory) {
    if (now - entry.timestamp > HISTORY_COOLDOWN_MS) {
      scanHistory.delete(jobId);
      knownIds.delete(jobId);
      cleaned++;
    }
  }
  if (cleaned > 0) log(`History cleanup: evicted ${cleaned} expired entries`);
}, 60000);

// Periodic knownIds cleanup — purge IDs that are consumed and not in history
setInterval(() => {
  if (knownIds.size > 100000) {
    const before = knownIds.size;
    const activePool = new Set(pool.slice(headIndex));
    for (const id of knownIds) {
      if (!activePool.has(id) && !scanHistory.has(id)) {
        knownIds.delete(id);
      }
    }
    log(`KnownIds cleanup: ${before} -> ${knownIds.size}`);
  }
}, 120000);

// ---------------------------------------------------------------------------
// PAGE FETCHER — Single page with retry on 429
// ---------------------------------------------------------------------------

async function fetchPage(cursor, agent) {
  const url = `${SERVERS_API}?sortOrder=Asc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;

  const opts = {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: FETCH_TIMEOUT_MS,
  };
  if (agent) opts.agent = agent;

  for (let attempt = 0; attempt <= RETRY_ON_429; attempt++) {
    try {
      const res = await fetch(url, opts);

      if (res.status === 429) {
        const wait = parseInt(res.headers.get("retry-after") || "3", 10);
        if (attempt < RETRY_ON_429) {
          await sleep(wait * 1000);
          continue;
        }
        return { data: [], nextPageCursor: null, rateLimited: true };
      }

      if (!res.ok) {
        return { data: [], nextPageCursor: null, error: res.status };
      }

      return await res.json();
    } catch (err) {
      if (attempt < RETRY_ON_429) {
        await sleep(1000);
        continue;
      }
      return { data: [], nextPageCursor: null, error: err.message };
    }
  }
  return { data: [], nextPageCursor: null };
}

// ---------------------------------------------------------------------------
// WORKER — One proxy's independent pagination loop
// ---------------------------------------------------------------------------

async function runWorker(agent, label) {
  let cursor = "";
  let added = 0;
  let pages = 0;
  let rateLimited = false;

  for (let page = 0; page < MAX_PAGES_PER_PROXY; page++) {
    const result = await fetchPage(cursor, agent);
    pages++;

    if (result.rateLimited) { rateLimited = true; break; }
    if (result.error) break;

    if (result.data && result.data.length > 0) {
      for (const server of result.data) {
        if (server.id && server.playing >= MIN_PLAYERS) {
          if (enqueue(server.id)) added++;
        }
      }
    }

    cursor = result.nextPageCursor;
    if (!cursor) break;

    if (PER_PROXY_PAGE_DELAY_MS > 0) await sleep(PER_PROXY_PAGE_DELAY_MS);
  }

  return { label, added, pages, rateLimited };
}

// ---------------------------------------------------------------------------
// SCRAPE CYCLE — Fire all workers concurrently
// ---------------------------------------------------------------------------

const stats = {
  totalAdded: 0,
  totalPages: 0,
  totalCycles: 0,
  lastCycleDurationMs: 0,
  lastCycleAdded: 0,
  lastCyclePages: 0,
  lastCycleTime: null,
  lastCycleWorkers: [],
  isRunning: false,
  continuousMode: false,
  rateLimitHits: 0,
};

async function scrape() {
  if (stats.isRunning) return { added: 0 };
  stats.isRunning = true;
  const start = Date.now();
  let totalAdded = 0;
  let totalPages = 0;

  try {
    const workers = [];

    if (proxyAgents.length > 0) {
      // One worker per proxy, all concurrent
      for (const proxy of proxyAgents) {
        workers.push(runWorker(proxy.agent, proxy.label));
      }
    } else {
      // No proxies: fire DIRECT_WORKERS concurrent direct workers
      for (let i = 0; i < DIRECT_WORKERS; i++) {
        workers.push(runWorker(null, `direct-${i}`));
      }
    }

    const results = await Promise.allSettled(workers);
    const workerResults = [];

    for (const r of results) {
      if (r.status === "fulfilled") {
        const w = r.value;
        totalAdded += w.added;
        totalPages += w.pages;
        if (w.rateLimited) stats.rateLimitHits++;
        workerResults.push(w);
      } else {
        workerResults.push({ label: "crashed", error: r.reason?.message });
      }
    }

    const elapsed = Date.now() - start;
    stats.totalAdded += totalAdded;
    stats.totalPages += totalPages;
    stats.totalCycles++;
    stats.lastCycleDurationMs = elapsed;
    stats.lastCycleAdded = totalAdded;
    stats.lastCyclePages = totalPages;
    stats.lastCycleTime = new Date().toISOString();
    stats.lastCycleWorkers = workerResults;

    const ok = workerResults.filter((w) => !w.error).length;
    const rl = workerResults.filter((w) => w.rateLimited).length;

    log(
      `Cycle #${stats.totalCycles}: +${totalAdded} IDs | ${totalPages} pages | ` +
      `${ok}/${workers.length} workers | ${elapsed}ms | ` +
      `pool: ${availableCount()} avail / ${knownIds.size} discovered` +
      `${rl > 0 ? ` | ${rl} rate-limited` : ""}`
    );
  } catch (err) {
    log(`Cycle error: ${err.message}`);
  } finally {
    stats.isRunning = false;
  }

  return { added: totalAdded, pages: totalPages };
}

// ---------------------------------------------------------------------------
// CONTINUOUS LOOP — Tight scrape-rescrape cycle
// ---------------------------------------------------------------------------

let loopRunning = false;

async function startContinuousLoop() {
  if (loopRunning) return;
  loopRunning = true;
  stats.continuousMode = true;

  log(
    `Continuous scraper started (${proxyAgents.length || DIRECT_WORKERS} workers, ` +
    `${CYCLE_DELAY_MS}ms cycle delay, ${PER_PROXY_PAGE_DELAY_MS}ms page delay, ` +
    `${MAX_PAGES_PER_PROXY} max pages/worker)`
  );

  while (loopRunning) {
    await scrape();
    await sleep(Math.max(CYCLE_DELAY_MS, 1)); // Yield to event loop
  }
}

function stopLoop() {
  loopRunning = false;
  stats.continuousMode = false;
  log("Continuous scraper stopped");
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  dequeueBatch,
  availableCount,
  totalEnqueued,
  requeue,
  enqueue,

  addToHistory,
  isInHistory,
  getHistorySize: () => scanHistory.size,

  scrape,
  startContinuousLoop,
  stopLoop,

  getStats: () => ({
    ...stats,
    poolAvailable: availableCount(),
    poolTotalDiscovered: knownIds.size,
    historySize: scanHistory.size,
    queueHeadIndex: headIndex,
    queueArrayLength: pool.length,
  }),

  config: {
    PLACE_ID,
    CYCLE_DELAY_MS,
    PER_PROXY_PAGE_DELAY_MS,
    MAX_PAGES_PER_PROXY,
    DIRECT_WORKERS,
    MIN_PLAYERS,
    HISTORY_COOLDOWN_MS,
    HISTORY_MAX_SIZE,
    FETCH_TIMEOUT_MS,
    proxyCount: proxyAgents.length,
  },
};
