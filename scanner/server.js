// ============================================================================
// server.js — Scanner Backend for Brainrot Fleet Scanner v11
// ============================================================================
// Manages the pool of Roblox server Job IDs and distributes them to the
// bot fleet without overlap. Tracks bot heartbeats, assignment state,
// scan completions, and exposes a fleet status endpoint.
//
// Routes:
//   POST /api/v1/get-job-assignment — Assign batch of Job IDs to a bot
//   POST /scan-complete             — Bot reports it finished scanning a server
//   POST /heartbeat                 — Bot keepalive ping
//   GET  /status                    — Fleet & pool status (API-key protected)
//   GET  /health                    — Render.com health check
// ============================================================================

const express = require("express");
const cors = require("cors");
const scraper = require("./scraper");

// ---------------------------------------------------------------------------
// Configuration (all from environment with defaults)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "4000", 10);

// API key that all bot requests must include in the X-API-Key header
const API_KEY = process.env.API_KEY || "";

// Internal API key for cross-service calls (dashboard → scanner status)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// How many Job IDs to assign per batch
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "8", 10);

// If a bot doesn't call /scan-complete within this window (ms), the
// assignment expires and the Job ID returns to the pool
const ASSIGNMENT_TIMEOUT_MS = parseInt(process.env.ASSIGNMENT_TIMEOUT_MS || "45000", 10);

// How often to run the assignment cleanup sweep (ms)
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || "15000", 10);

// Bot is considered "dead" if no heartbeat within this window (ms)
const BOT_DEAD_THRESHOLD_MS = parseInt(process.env.BOT_DEAD_THRESHOLD_MS || "90000", 10);

// Rate limit: max requests per bot per window
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "5000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "10", 10);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}][${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// In-Memory Data Structures
// ---------------------------------------------------------------------------

/**
 * Active assignments: Map<jobId, { botId, assignedAt (timestamp) }>
 * Tracks which Job IDs are currently being scanned by which bot.
 * Entries are removed on scan-complete or when they expire.
 */
const assignments = new Map();

/**
 * Bot registry: Map<botId, { lastSeen, jobId, scanning, uptime, vpsId }>
 * Updated on every heartbeat. Used for fleet status display.
 */
const botRegistry = new Map();

/**
 * Per-bot rate limiter: Map<botId, { count, windowStart }>
 */
const rateLimits = new Map();

/**
 * Session-level counters for the status endpoint.
 */
const sessionStats = {
  totalAssigned: 0,
  totalCompleted: 0,
  totalHeartbeats: 0,
  startTime: Date.now(),
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const botId = req.body?.bot_id || req.headers["x-bot-id"] || "-";
    log("HTTP", `${req.method} ${req.path} ${res.statusCode} ${ms}ms [${botId}]`);
  });
  next();
});

/**
 * API key validation middleware.
 * Checks X-API-Key header against the configured secret.
 */
function requireAuth(req, res, next) {
  if (!API_KEY) {
    // If no API key is configured, skip auth (development mode)
    return next();
  }
  const provided = req.headers["x-api-key"];
  if (provided !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

/**
 * Internal auth for cross-service endpoints (status, etc.)
 * Accepts either the main API_KEY or the INTERNAL_API_KEY.
 */
function requireInternalAuth(req, res, next) {
  const provided = req.headers["x-api-key"];
  if (!API_KEY && !INTERNAL_API_KEY) return next();
  if (provided === API_KEY || provided === INTERNAL_API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Per-bot rate limiter.
 */
function checkRateLimit(botId) {
  const now = Date.now();
  let entry = rateLimits.get(botId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimits.set(botId, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Assignment Cleanup
// ---------------------------------------------------------------------------

/**
 * Periodically check for expired assignments (bot crashed or timed out).
 * Returns expired Job IDs to the pool so another bot can scan them.
 */
function cleanupExpiredAssignments() {
  const now = Date.now();
  let expired = 0;

  for (const [jobId, assignment] of assignments) {
    if (now - assignment.assignedAt > ASSIGNMENT_TIMEOUT_MS) {
      assignments.delete(jobId);
      // Return to pool if not already there and not in history
      scraper.addToPool(jobId);
      expired++;
    }
  }

  if (expired > 0) {
    log("CLEANUP", `Returned ${expired} expired assignments to pool`);
  }
}

// Run cleanup on interval
setInterval(cleanupExpiredAssignments, CLEANUP_INTERVAL_MS);

// Periodically clean up stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [botId, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimits.delete(botId);
    }
  }
}, 30000);

// ---------------------------------------------------------------------------
// ROUTE: POST /api/v1/get-job-assignment
// ---------------------------------------------------------------------------
// Called by bots to request a batch of Job IDs to scan.
// Body: { bot_id: string, vps_id: number }
// Returns: { success: boolean, job_ids: string[], available_servers: number, history_size: number }
// ---------------------------------------------------------------------------

app.post("/api/v1/get-job-assignment", requireAuth, (req, res) => {
  const { bot_id, vps_id } = req.body;

  if (!bot_id) {
    return res.status(400).json({ error: "bot_id is required" });
  }

  // Rate limit check
  if (checkRateLimit(bot_id)) {
    return res.status(429).json({
      error: "Rate limited",
      retry_in_ms: RATE_LIMIT_WINDOW_MS,
    });
  }

  const pool = scraper.getPool();

  // If pool is empty, return 503 so the bot knows to wait
  if (pool.length === 0) {
    return res.status(503).json({
      success: false,
      error: "No servers available in pool",
      available_servers: 0,
      history_size: scraper.getHistorySize(),
    });
  }

  // Assign a batch from the front of the pool
  const batchSize = Math.min(BATCH_SIZE, pool.length);
  const batch = [];

  for (let i = 0; i < batchSize; i++) {
    if (pool.length === 0) break;

    // Take from the front of the pool
    const jobId = pool[0];
    scraper.removeFromPool(jobId);

    // Record the assignment
    assignments.set(jobId, {
      botId: bot_id,
      assignedAt: Date.now(),
    });

    batch.push(jobId);
  }

  sessionStats.totalAssigned += batch.length;

  log("ASSIGN", `${bot_id}: assigned ${batch.length} jobs (pool: ${pool.length}, in-progress: ${assignments.size})`);

  return res.json({
    success: true,
    job_ids: batch,
    available_servers: pool.length,
    history_size: scraper.getHistorySize(),
  });
});

// ---------------------------------------------------------------------------
// ROUTE: POST /scan-complete
// ---------------------------------------------------------------------------
// Called by a bot after it finishes scanning a server.
// Body: { bot_id: string, job_id: string, found?: boolean }
// Returns: { success: boolean }
// ---------------------------------------------------------------------------

app.post("/scan-complete", requireAuth, (req, res) => {
  const { bot_id, job_id, found } = req.body;

  if (!bot_id || !job_id) {
    return res.status(400).json({ error: "bot_id and job_id are required" });
  }

  // Remove from active assignments
  assignments.delete(job_id);

  // Record in scan history
  scraper.addToHistory(job_id, bot_id, !!found);

  sessionStats.totalCompleted++;

  log("COMPLETE", `${bot_id}: finished ${job_id.substring(0, 8)}... (found: ${!!found})`);

  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// ROUTE: POST /heartbeat
// ---------------------------------------------------------------------------
// Called every 30s by each bot to report it's alive.
// Body: { bot_id: string, job_id: string, scanning: boolean, uptime: number }
// Returns: { success: boolean }
// ---------------------------------------------------------------------------

app.post("/heartbeat", requireAuth, (req, res) => {
  const { bot_id, job_id, scanning, uptime } = req.body;

  if (!bot_id) {
    return res.status(400).json({ error: "bot_id is required" });
  }

  botRegistry.set(bot_id, {
    lastSeen: Date.now(),
    jobId: job_id || "",
    scanning: !!scanning,
    uptime: uptime || 0,
  });

  sessionStats.totalHeartbeats++;

  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /status
// ---------------------------------------------------------------------------
// Returns fleet and pool status. Protected by internal API key.
// Used by the web dashboard and operators.
// ---------------------------------------------------------------------------

app.get("/status", requireInternalAuth, (req, res) => {
  const now = Date.now();

  // Build active bots list
  const activeBots = [];
  for (const [botId, info] of botRegistry) {
    const alive = now - info.lastSeen < BOT_DEAD_THRESHOLD_MS;
    activeBots.push({
      botId,
      lastSeen: new Date(info.lastSeen).toISOString(),
      agoMs: now - info.lastSeen,
      alive,
      scanning: info.scanning,
      jobId: info.jobId,
    });
  }

  // Count bots active in last 60s
  const activeCount = activeBots.filter((b) => b.agoMs < 60000).length;

  const scraperStats = scraper.getStats();
  const scraperConfig = scraper.config;

  return res.json({
    pool: {
      size: scraper.getPoolSize(),
      maxSize: scraperConfig.POOL_MAX_SIZE,
      lowThreshold: scraperConfig.POOL_LOW_THRESHOLD,
    },
    assignments: {
      inProgress: assignments.size,
      timeoutMs: ASSIGNMENT_TIMEOUT_MS,
    },
    fleet: {
      totalRegistered: botRegistry.size,
      activeInLast60s: activeCount,
      bots: activeBots,
    },
    session: {
      ...sessionStats,
      uptimeMs: now - sessionStats.startTime,
      uptime: formatUptime(now - sessionStats.startTime),
    },
    scraper: scraperStats,
    history: {
      size: scraper.getHistorySize(),
      cooldownMs: scraperConfig.HISTORY_COOLDOWN_MS,
    },
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /health
// ---------------------------------------------------------------------------
// Render.com health check endpoint. Returns 200 if server is alive.
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    pool: scraper.getPoolSize(),
    assignments: assignments.size,
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function maskSecret(s) {
  if (!s || s.length < 8) return s ? "****" : "(not set)";
  return s.substring(0, 4) + "****" + s.substring(s.length - 4);
}

// ---------------------------------------------------------------------------
// Global Error Handlers (keep process alive on Render.com)
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  log("FATAL", `Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on("unhandledRejection", (reason) => {
  log("FATAL", `Unhandled rejection: ${reason}`);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════");
  console.log("  🧠 BRAINROT FLEET SCANNER — Scanner Backend");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Port:              ${PORT}`);
  console.log(`  API Key:           ${maskSecret(API_KEY)}`);
  console.log(`  Internal Key:      ${maskSecret(INTERNAL_API_KEY)}`);
  console.log(`  Batch Size:        ${BATCH_SIZE}`);
  console.log(`  Assignment TTL:    ${ASSIGNMENT_TIMEOUT_MS / 1000}s`);
  console.log(`  Bot Dead After:    ${BOT_DEAD_THRESHOLD_MS / 1000}s`);
  console.log(`  Place ID:          ${scraper.config.PLACE_ID}`);
  console.log(`  Pool Target:       ${scraper.config.POOL_LOW_THRESHOLD}–${scraper.config.POOL_MAX_SIZE}`);
  console.log(`  Scrape Interval:   ${scraper.config.SCRAPE_INTERVAL_MS / 1000}s`);
  console.log(`  Proxies:           ${scraper.config.proxyCount || "none (direct)"}`);
  console.log(`  History Cooldown:  ${scraper.config.HISTORY_COOLDOWN_MS / 1000}s`);
  console.log("═══════════════════════════════════════════════\n");

  // Start the auto-scraper
  scraper.startAutoScrape();

  log("BOOT", "Scanner backend is live");
});
