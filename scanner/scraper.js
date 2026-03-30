// ============================================================================
// scraper.js — High-Throughput Roblox Server Scraper
// ============================================================================
//
// OPTIMIZED FOR ROTATING RESIDENTIAL PROXIES (e.g., Smartproxy)
//
// With a rotating proxy gateway, every request automatically gets a
// different IP from a pool of millions. This means:
//   - We can run MANY concurrent workers (20+) without rate limits
//   - We create a NEW proxy agent per request (forces IP rotation)
//   - We don't need a list of static proxies — one URL does it all
//   - Roblox sees each request from a unique residential IP
//
// The pool has NO upper size limit. Every discovered Job ID is stored.
// The queue uses an atomic index-based design for O(1) dequeue.
//
// ============================================================================

const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLACE_ID = process.env.PLACE_ID || "109983668079237";
const SERVERS_API = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public`;

// ─── PROXY CONFIG ───
// ROTATING PROXY: A single gateway URL where every request gets a new IP.
// This is the recommended setup for Smartproxy, Bright Data, IPRoyal, etc.
// Example: http://user:pass@gate.smartproxy.com:10001
const ROTATING_PROXY_URL = process.env.ROTATING_PROXY_URL || "";

// STATIC PROXY LIST: Comma-separated list of fixed proxy URLs (fallback).
// Only used if ROTATING_PROXY_URL is not set.
const PROXY_LIST_RAW = process.env.PROXY_LIST || "";

// ─── WORKER CONFIG ───
// How many concurrent pagination workers to run per scrape cycle.
// With rotating proxies, each worker gets unique IPs, so more = faster.
// With static proxies or direct mode, keep this lower.
const WORKER_COUNT = parseInt(process.env.SCRAPER_WORKER_COUNT || "0", 10);
// 0 = auto-detect: 15 for rotating, count for static list, 2 for direct

// ─── TIMING CONFIG ───
// Delay between full scrape cycles (ms)
const CYCLE_DELAY_MS = parseInt(process.env.SCRAPER_CYCLE_DELAY_MS || "2000", 10);

// Delay between page fetches per worker (ms)
const PAGE_DELAY_MS = parseInt(process.env.PER_PROXY_PAGE_DELAY_MS || "50", 10);

// Max pages each worker chases per cycle
const MAX_PAGES_PER_WORKER = parseInt(process.env.MAX_PAGES_PER_PROXY || "50", 10);

// ─── FILTER CONFIG ───
// Minimum players in server to add to pool (skip empty servers)
const MIN_PLAYERS = parseInt(process.env.SCRAPER_MIN_PLAYERS || "1", 10);

// ─── HISTORY CONFIG ───
// How long before a scanned server can be re-discovered (ms)
const HISTORY_COOLDOWN_MS = parseInt(process.env.HISTORY_COOLDOWN_MS || "300000", 10);

// Max history entries (memory ceiling)
const HISTORY_MAX_SIZE = parseInt(process.env.HISTORY_MAX_SIZE || "50000", 10);

// ─── REQUEST CONFIG ───
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPER_FETCH_TIMEOUT_MS || "15000", 10);
const RETRY_ON_429 = parseInt(process.env.SCRAPER_RETRY_ON_429 || "2", 10);

// ---------------------------------------------------------------------------
// Proxy Mode Detection
// ---------------------------------------------------------------------------

// Parse static proxies (only used if no rotating proxy is set)
const staticProxies = PROXY_LIST_RAW.split(",").map((p) => p.trim()).filter((p) => p.length > 0);

// Determine proxy mode
let proxyMode;
if (ROTATING_PROXY_URL) {
  proxyMode = "rotating";
} else if (staticProxies.length > 0) {
  proxyMode = "static";
} else {
  proxyMode = "direct";
}

// Determine effective worker count
let effectiveWorkers;
if (WORKER_COUNT > 0) {
  effectiveWorkers = WORKER_COUNT;
} else {
  // Auto-detect based on proxy mode
  switch (proxyMode) {
    case "rotating":  effectiveWorkers = 15; break;  // Rotating can handle many
    case "static":    effectiveWorkers = staticProxies.length; break;
    case "direct":    effectiveWorkers = 2; break;
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}][SCRAPER] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Proxy Agent Factory
// ---------------------------------------------------------------------------

// Pre-build static proxy agents (reusable)
const staticAgents = staticProxies.map((url, i) => ({
  agent: new HttpsProxyAgent(url),
  label: `static-${i}`,
}));

/**
 * Get a proxy agent for a request.
 *
 * ROTATING MODE: Creates a NEW HttpsProxyAgent instance every call.
 * This is intentional — rotating gateways assign a new IP per connection,
 * so reusing an agent may reuse the same TCP connection and same IP.
 * Creating a fresh agent forces a new connection = new IP.
 *
 * STATIC MODE: Returns the agent for the given worker index (round-robin).
 * DIRECT MODE: Returns null (no proxy).
 */
function getAgent(workerIndex) {
  switch (proxyMode) {
    case "rotating":
      // New agent = new connection = new IP from the rotating gateway
      return new HttpsProxyAgent(ROTATING_PROXY_URL);

    case "static":
      return staticAgents[workerIndex % staticAgents.length].agent;

    case "direct":
    default:
      return null;
  }
}

function getWorkerLabel(workerIndex) {
  switch (proxyMode) {
    case "rotating": return `rot-${workerIndex}`;
    case "static":   return `static-${workerIndex % staticAgents.length}`;
    case "direct":   return `direct-${workerIndex}`;
  }
}

// ---------------------------------------------------------------------------
// ATOMIC QUEUE — Lock-Free Job ID Pool
// ---------------------------------------------------------------------------
//
// Array + head index. O(1) dequeue, no array mutation.
// Node.js single-threaded = synchronous index increment is atomic.
// Periodic compaction reclaims consumed memory.
// ---------------------------------------------------------------------------

let pool = [];
let headIndex = 0;
const knownIds = new Set(); // All IDs ever seen (dedup)

/**
 * Atomically dequeue up to `count` Job IDs.
 * Guaranteed unique across all concurrent async handlers.
 */
function dequeueBatch(count) {
  const available = pool.length - headIndex;
  const take = Math.min(count, available);
  if (take <= 0) return [];

  const start = headIndex;
  headIndex += take;

  const batch = pool.slice(start, start + take);

  // Compact when >10k consumed slots and >50% consumed
  if (headIndex > 10000 && headIndex > pool.length * 0.5) {
    pool = pool.slice(headIndex);
    headIndex = 0;
    log(`Queue compacted, freed ${start} consumed slots`);
  }

  return batch;
}

function availableCount() {
  return pool.length - headIndex;
}

function enqueue(jobId) {
  if (knownIds.has(jobId)) return false;
  knownIds.add(jobId);
  pool.push(jobId);
  return true;
}

function requeue(jobId) {
  pool.push(jobId);
}

// ---------------------------------------------------------------------------
// SCAN HISTORY
// ---------------------------------------------------------------------------

const scanHistory = new Map();

function addToHistory(jobId, botId, found = false) {
  if (scanHistory.size >= HISTORY_MAX_SIZE) {
    // Bulk evict oldest 10%
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

// Periodic history cleanup (every 60s)
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

// Periodic knownIds cleanup (every 2 min)
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
// PAGE FETCHER
// ---------------------------------------------------------------------------

async function fetchPage(cursor, workerIndex) {
  const url = `${SERVERS_API}?sortOrder=Asc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;

  for (let attempt = 0; attempt <= RETRY_ON_429; attempt++) {
    try {
      // Get a fresh agent per request (critical for rotating proxies)
      const agent = getAgent(workerIndex);

      const opts = {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: FETCH_TIMEOUT_MS,
      };
      if (agent) opts.agent = agent;

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
// WORKER — One pagination stream
// ---------------------------------------------------------------------------

async function runWorker(workerIndex) {
  const label = getWorkerLabel(workerIndex);
  let cursor = "";
  let added = 0;
  let pages = 0;
  let rateLimited = false;

  for (let page = 0; page < MAX_PAGES_PER_WORKER; page++) {
    const result = await fetchPage(cursor, workerIndex);
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

    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  return { label, added, pages, rateLimited };
}

// ---------------------------------------------------------------------------
// SCRAPE CYCLE
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
    // Fire all workers concurrently
    const workers = [];
    for (let i = 0; i < effectiveWorkers; i++) {
      workers.push(runWorker(i));
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

    const ok = workerResults.filter((w) => !w.error && !w.rateLimited).length;
    const rl = workerResults.filter((w) => w.rateLimited).length;

    log(
      `Cycle #${stats.totalCycles}: +${totalAdded} IDs | ${totalPages} pages | ` +
      `${ok}/${workers.length} workers OK | ${elapsed}ms | ` +
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
// CONTINUOUS LOOP
// ---------------------------------------------------------------------------

let loopRunning = false;

async function startContinuousLoop() {
  if (loopRunning) return;
  loopRunning = true;
  stats.continuousMode = true;

  log(
    `Continuous scraper started | mode: ${proxyMode} | ` +
    `workers: ${effectiveWorkers} | cycle delay: ${CYCLE_DELAY_MS}ms | ` +
    `page delay: ${PAGE_DELAY_MS}ms | max pages/worker: ${MAX_PAGES_PER_WORKER}`
  );

  while (loopRunning) {
    await scrape();
    await sleep(Math.max(CYCLE_DELAY_MS, 1));
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
  totalEnqueued: () => pool.length,
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
    proxyMode,
    proxyCount: proxyMode === "rotating" ? "rotating gateway" : (proxyMode === "static" ? staticProxies.length : 0),
    effectiveWorkers,
    CYCLE_DELAY_MS,
    PAGE_DELAY_MS,
    MAX_PAGES_PER_WORKER,
    MIN_PLAYERS,
    HISTORY_COOLDOWN_MS,
    HISTORY_MAX_SIZE,
    FETCH_TIMEOUT_MS,
  },
};
