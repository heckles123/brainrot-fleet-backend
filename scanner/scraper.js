// ============================================================================
// scraper.js — Roblox Server List Scraper with Rotating Proxy Support
// ============================================================================
// Periodically scrapes the Roblox Public Servers API to discover active
// server Job IDs for the Steal a Brainrot place. Uses rotating proxies
// to avoid Roblox rate limits across high-frequency scrape cycles.
//
// Exports:
//   scrape()       — Run one full scrape cycle, returns { added, total, pages }
//   getPool()      — Returns the current array of unassigned Job IDs
//   getPoolSize()  — Returns current pool length
//   removeFromPool(jobId) — Remove a specific Job ID from the pool
//   isInHistory(jobId)    — Check if a Job ID was recently scanned
//   addToHistory(jobId, botId, found) — Record a completed scan
//   getHistorySize()      — Returns scan history size
//   getStats()            — Returns scraper statistics object
// ============================================================================

const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ---------------------------------------------------------------------------
// Configuration (all from environment with sensible defaults)
// ---------------------------------------------------------------------------

// The Roblox Place ID for Steal a Brainrot
const PLACE_ID = process.env.PLACE_ID || "109983668079237";

// Roblox API base URL for public server listings
const SERVERS_API = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public`;

// Delay between paginated API requests (ms) — prevents hammering Roblox
const PAGE_DELAY_MS = parseInt(process.env.SCRAPER_PAGE_DELAY_MS || "600", 10);

// Maximum pages to fetch per scrape cycle (safety cap)
const MAX_PAGES = parseInt(process.env.SCRAPER_MAX_PAGES || "30", 10);

// How often the auto-scraper runs (ms)
const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS || "45000", 10);

// Only trigger a scrape if pool drops below this size
const POOL_LOW_THRESHOLD = parseInt(process.env.POOL_LOW_THRESHOLD || "50", 10);

// Maximum pool size — stop adding once we hit this
const POOL_MAX_SIZE = parseInt(process.env.POOL_MAX_SIZE || "500", 10);

// How long (ms) before a scanned server can be re-queued
const HISTORY_COOLDOWN_MS = parseInt(process.env.HISTORY_COOLDOWN_MS || "300000", 10); // 5 min

// Maximum history entries (prevents unbounded memory growth)
const HISTORY_MAX_SIZE = parseInt(process.env.HISTORY_MAX_SIZE || "5000", 10);

// Minimum players in a server to bother scanning (skip empty servers)
const MIN_PLAYERS = parseInt(process.env.SCRAPER_MIN_PLAYERS || "1", 10);

// Comma-separated list of proxy URLs (e.g., http://user:pass@proxy1:port,http://user:pass@proxy2:port)
// If empty, scraper will make direct requests (may hit rate limits faster)
const PROXY_LIST_RAW = process.env.PROXY_LIST || "";

// ---------------------------------------------------------------------------
// Proxy Rotation System
// ---------------------------------------------------------------------------

// Parse proxy list into array of proxy URL strings
const proxyList = PROXY_LIST_RAW
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

let proxyIndex = 0;

/**
 * Get the next proxy agent in round-robin rotation.
 * Returns null if no proxies are configured (direct mode).
 */
function getNextProxy() {
  if (proxyList.length === 0) return null;
  const proxyUrl = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Log helper with timestamp prefix.
 */
function log(msg) {
  console.log(`[${new Date().toISOString()}][SCRAPER] ${msg}`);
}

// ---------------------------------------------------------------------------
// In-Memory Data Structures
// ---------------------------------------------------------------------------

// Pool: array of Job ID strings ready to be assigned to bots
// Shape: string[]
let pool = [];

// Set for O(1) dedup lookups against the pool
const poolSet = new Set();

// Scan history: Map<jobId, { botId, timestamp, found }>
// Records every scanned server so we don't re-queue within the cooldown
const scanHistory = new Map();

// Scraper stats for the status endpoint
const stats = {
  totalScraped: 0, // Total Job IDs ever discovered
  totalCycles: 0, // Number of completed scrape cycles
  lastCycleTime: null, // ISO timestamp of last cycle completion
  lastCycleAdded: 0, // How many new IDs the last cycle added
  lastCyclePages: 0, // How many pages the last cycle fetched
  isRunning: false, // Whether a scrape is currently in progress
};

// ---------------------------------------------------------------------------
// History Management
// ---------------------------------------------------------------------------

/**
 * Add a completed scan to history. Enforces max size by evicting oldest.
 */
function addToHistory(jobId, botId, found = false) {
  // Evict oldest entries if at capacity
  if (scanHistory.size >= HISTORY_MAX_SIZE) {
    const oldest = scanHistory.keys().next().value;
    scanHistory.delete(oldest);
  }
  scanHistory.set(jobId, {
    botId,
    timestamp: Date.now(),
    found,
  });
}

/**
 * Check if a Job ID is in recent history (within cooldown window).
 */
function isInHistory(jobId) {
  const entry = scanHistory.get(jobId);
  if (!entry) return false;
  // If older than cooldown, it's expired — remove and allow re-queue
  if (Date.now() - entry.timestamp > HISTORY_COOLDOWN_MS) {
    scanHistory.delete(jobId);
    return false;
  }
  return true;
}

/**
 * Periodic cleanup of expired history entries to free memory.
 */
function pruneHistory() {
  const now = Date.now();
  for (const [jobId, entry] of scanHistory) {
    if (now - entry.timestamp > HISTORY_COOLDOWN_MS) {
      scanHistory.delete(jobId);
    }
  }
}

// Run history pruning every 60 seconds
setInterval(pruneHistory, 60000);

// ---------------------------------------------------------------------------
// Pool Management
// ---------------------------------------------------------------------------

/**
 * Remove a specific Job ID from the pool (called when assigned to a bot).
 */
function removeFromPool(jobId) {
  const idx = pool.indexOf(jobId);
  if (idx !== -1) {
    pool.splice(idx, 1);
    poolSet.delete(jobId);
  }
}

/**
 * Try to add a Job ID to the pool. Returns false if duplicate or in history.
 */
function addToPool(jobId) {
  if (pool.length >= POOL_MAX_SIZE) return false;
  if (poolSet.has(jobId)) return false;
  if (isInHistory(jobId)) return false;
  pool.push(jobId);
  poolSet.add(jobId);
  return true;
}

// ---------------------------------------------------------------------------
// Roblox API Scraper
// ---------------------------------------------------------------------------

/**
 * Fetch a single page of servers from the Roblox API.
 * Uses proxy rotation if proxies are configured.
 * Returns { data: [...servers], nextPageCursor: string|null }
 */
async function fetchPage(cursor = "") {
  const url = `${SERVERS_API}?sortOrder=Asc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
  const agent = getNextProxy();

  const fetchOpts = {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 15000,
  };

  // Attach proxy agent if available
  if (agent) {
    fetchOpts.agent = agent;
  }

  const res = await fetch(url, fetchOpts);

  // Handle rate limiting — wait and retry once
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
    log(`Rate limited by Roblox, waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    // Retry with a different proxy
    const retryAgent = getNextProxy();
    if (retryAgent) fetchOpts.agent = retryAgent;
    const retryRes = await fetch(url, fetchOpts);
    if (!retryRes.ok) {
      throw new Error(`Roblox API retry failed: ${retryRes.status}`);
    }
    return retryRes.json();
  }

  if (!res.ok) {
    throw new Error(`Roblox API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Sleep utility.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a full scrape cycle across all paginated results.
 * Returns { added: number, total: number, pages: number }
 */
async function scrape() {
  if (stats.isRunning) {
    log("Scrape already in progress, skipping");
    return { added: 0, total: pool.length, pages: 0 };
  }

  // Skip scrape if pool is healthy
  if (pool.length >= POOL_LOW_THRESHOLD && stats.totalCycles > 0) {
    log(`Pool healthy (${pool.length} >= ${POOL_LOW_THRESHOLD}), skipping scrape`);
    return { added: 0, total: pool.length, pages: 0 };
  }

  stats.isRunning = true;
  const startTime = Date.now();
  let added = 0;
  let pages = 0;
  let cursor = "";

  log(`Starting scrape cycle #${stats.totalCycles + 1} (pool: ${pool.length}, proxies: ${proxyList.length || "direct"})`);

  try {
    do {
      pages++;
      const data = await fetchPage(cursor);

      if (data.data && Array.isArray(data.data)) {
        for (const server of data.data) {
          // server shape: { id: "jobId", maxPlayers, playing, ... }
          if (server.id && server.playing >= MIN_PLAYERS) {
            if (addToPool(server.id)) {
              added++;
            }
          }
        }
      }

      cursor = data.nextPageCursor || "";

      // Safety caps
      if (pages >= MAX_PAGES) {
        log(`Hit max page cap (${MAX_PAGES}), stopping`);
        break;
      }
      if (pool.length >= POOL_MAX_SIZE) {
        log(`Pool full (${POOL_MAX_SIZE}), stopping`);
        break;
      }

      // Delay between pages to respect rate limits
      if (cursor) {
        await sleep(PAGE_DELAY_MS);
      }
    } while (cursor);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    stats.totalScraped += added;
    stats.totalCycles++;
    stats.lastCycleTime = new Date().toISOString();
    stats.lastCycleAdded = added;
    stats.lastCyclePages = pages;

    log(`Scrape complete: +${added} new servers from ${pages} pages in ${elapsed}s (pool: ${pool.length})`);
  } catch (err) {
    log(`Scrape error: ${err.message}`);
  } finally {
    stats.isRunning = false;
  }

  return { added, total: pool.length, pages };
}

// ---------------------------------------------------------------------------
// Auto-Scraper Loop
// ---------------------------------------------------------------------------

let autoScrapeTimer = null;

/**
 * Start the automatic scrape loop.
 */
function startAutoScrape() {
  // Run immediately on first start
  scrape().catch((err) => log(`Initial scrape failed: ${err.message}`));

  autoScrapeTimer = setInterval(() => {
    scrape().catch((err) => log(`Auto-scrape failed: ${err.message}`));
  }, SCRAPE_INTERVAL_MS);

  log(`Auto-scraper started (interval: ${SCRAPE_INTERVAL_MS / 1000}s, threshold: ${POOL_LOW_THRESHOLD})`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  scrape,
  getPool: () => pool,
  getPoolSize: () => pool.length,
  removeFromPool,
  addToPool,
  isInHistory,
  addToHistory,
  getHistorySize: () => scanHistory.size,
  getStats: () => ({ ...stats, poolSize: pool.length, historySize: scanHistory.size }),
  startAutoScrape,
  // Expose config for status endpoint
  config: {
    PLACE_ID,
    PAGE_DELAY_MS,
    MAX_PAGES,
    SCRAPE_INTERVAL_MS,
    POOL_LOW_THRESHOLD,
    POOL_MAX_SIZE,
    HISTORY_COOLDOWN_MS,
    MIN_PLAYERS,
    proxyCount: proxyList.length,
  },
};
