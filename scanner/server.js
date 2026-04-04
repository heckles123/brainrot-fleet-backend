// ============================================================================
// server.js — Scanner Backend (High-Throughput Edition) + Bot Dedup v2
// ============================================================================
//
// Distributes Job IDs to the bot fleet using an atomic queue that serves
// hundreds of concurrent requests per second with zero contention.
//
// Routes:
//   POST /api/v1/get-job-assignment — Assign batch of Job IDs to a bot
//   POST /scan-complete             — Bot finished scanning a server
//   POST /heartbeat                 — Bot keepalive ping
//   POST /scanner-register          — Bot registers username for dedup
//   GET  /scanner-list              — Get all registered bot usernames
//   GET  /status                    — Fleet & pool status (internal auth)
//   GET  /health                    — Render.com health check
//
// ============================================================================

const express = require("express");
const cors = require("cors");
const scraper = require("./scraper");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "4000", 10);
const API_KEY = process.env.API_KEY || "";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "8", 10);
const ASSIGNMENT_TIMEOUT_MS = parseInt(process.env.ASSIGNMENT_TIMEOUT_MS || "45000", 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || "10000", 10);
const BOT_DEAD_THRESHOLD_MS = parseInt(process.env.BOT_DEAD_THRESHOLD_MS || "90000", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "3000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "15", 10);
const BOT_DEDUP_TTL_MS = parseInt(process.env.BOT_DEDUP_TTL_MS || "120000", 10);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}][${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

const assignments = new Map();
const botRegistry = new Map();
const dedupRegistry = new Map();
const rateLimits = new Map();

const session = {
  totalAssigned: 0,
  totalCompleted: 0,
  totalHeartbeats: 0,
  totalExpiredReclaimed: 0,
  totalRegistrations: 0,
  startTime: Date.now(),
};

// ---------------------------------------------------------------------------
// Express Setup
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const bot = req.body?.bot_id || req.body?.username || "-";
    log("HTTP", `${req.method} ${req.path} ${res.statusCode} ${ms}ms [${bot}]`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Auth Middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.headers["x-api-secret"];
  if (key !== API_KEY) return res.status(401).json({ error: "Invalid API key" });
  next();
}

function requireInternalAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!API_KEY && !INTERNAL_API_KEY) return next();
  if (key === API_KEY || key === INTERNAL_API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function checkRateLimit(botId) {
  const now = Date.now();
  let e = rateLimits.get(botId);
  if (!e || now - e.windowStart > RATE_LIMIT_WINDOW_MS) {
    e = { count: 0, windowStart: now };
    rateLimits.set(botId, e);
  }
  e.count++;
  return e.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of rateLimits) {
    if (now - e.windowStart > RATE_LIMIT_WINDOW_MS * 3) rateLimits.delete(id);
  }
}, 30000);

// ---------------------------------------------------------------------------
// Assignment Expiry Cleanup
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  let expired = 0;
  for (const [jobId, a] of assignments) {
    if (now - a.assignedAt > ASSIGNMENT_TIMEOUT_MS) {
      assignments.delete(jobId);
      scraper.requeue(jobId);
      expired++;
    }
  }
  if (expired > 0) {
    session.totalExpiredReclaimed += expired;
    log("CLEANUP", `Reclaimed ${expired} expired assignments (total: ${session.totalExpiredReclaimed})`);
  }
}, CLEANUP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Dedup Registry Cleanup
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [username, info] of dedupRegistry) {
    if (now - info.last_seen > BOT_DEDUP_TTL_MS) {
      dedupRegistry.delete(username);
      removed++;
    }
  }
  if (removed > 0) {
    log("DEDUP", `Cleaned ${removed} stale registrations (remaining: ${dedupRegistry.size})`);
  }
}, 30000);

// ---------------------------------------------------------------------------
// ROUTE: POST /api/v1/get-job-assignment
// ---------------------------------------------------------------------------

app.post("/api/v1/get-job-assignment", requireAuth, (req, res) => {
  const { bot_id, vps_id } = req.body;
  if (!bot_id) return res.status(400).json({ error: "bot_id required" });

  if (checkRateLimit(bot_id)) {
    return res.status(429).json({ error: "Rate limited", retry_in_ms: RATE_LIMIT_WINDOW_MS });
  }

  const available = scraper.availableCount();

  if (available === 0) {
    return res.status(503).json({
      success: false,
      error: "No servers in pool",
      available_servers: 0,
      history_size: scraper.getHistorySize(),
    });
  }

  const batch = scraper.dequeueBatch(Math.min(BATCH_SIZE, available));

  const now = Date.now();
  for (const jobId of batch) {
    assignments.set(jobId, { botId: bot_id, assignedAt: now });
  }

  session.totalAssigned += batch.length;

  log("ASSIGN", `${bot_id}: ${batch.length} jobs (avail: ${scraper.availableCount()}, in-flight: ${assignments.size})`);

  return res.json({
    success: true,
    job_ids: batch,
    available_servers: scraper.availableCount(),
    history_size: scraper.getHistorySize(),
  });
});

// ---------------------------------------------------------------------------
// ROUTE: POST /scan-complete
// ---------------------------------------------------------------------------

app.post("/scan-complete", requireAuth, (req, res) => {
  const { bot_id, job_id, found } = req.body;
  if (!bot_id || !job_id) return res.status(400).json({ error: "bot_id and job_id required" });

  assignments.delete(job_id);
  scraper.addToHistory(job_id, bot_id, !!found);
  session.totalCompleted++;

  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// ROUTE: POST /heartbeat
// ---------------------------------------------------------------------------

app.post("/heartbeat", requireAuth, (req, res) => {
  const { bot_id, job_id, scanning, uptime, username } = req.body;
  if (!bot_id) return res.status(400).json({ error: "bot_id required" });

  botRegistry.set(bot_id, {
    lastSeen: Date.now(),
    jobId: job_id || "",
    scanning: !!scanning,
    uptime: uptime || 0,
    username: username || "",
  });

  // Also refresh dedup registry if username provided
  if (username) {
    dedupRegistry.set(username, {
      bot_id,
      last_seen: Date.now(),
      job_id: job_id || null,
    });
  }

  session.totalHeartbeats++;
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// ROUTE: POST /scanner-register — Bot registers username for dedup
// ---------------------------------------------------------------------------

app.post("/scanner-register", requireAuth, (req, res) => {
  try {
    const { username, bot_id } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });

    dedupRegistry.set(username, {
      bot_id: bot_id || username,
      last_seen: Date.now(),
      job_id: req.body.job_id || null,
    });

    session.totalRegistrations++;
    log("DEDUP", `Bot registered: ${username} (${bot_id || "no-id"}) | Total: ${dedupRegistry.size}`);

    res.json({
      success: true,
      registered: username,
      total_bots: dedupRegistry.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: GET /scanner-list — Returns all registered bot usernames
// ---------------------------------------------------------------------------

app.get("/scanner-list", requireAuth, (req, res) => {
  try {
    const usernames = [];
    const details = [];

    for (const [username, info] of dedupRegistry) {
      if (Date.now() - info.last_seen <= BOT_DEDUP_TTL_MS) {
        usernames.push(username);
        details.push({
          username,
          bot_id: info.bot_id,
          last_seen_ago: Math.floor((Date.now() - info.last_seen) / 1000) + "s",
        });
      }
    }

    res.json({
      success: true,
      usernames,
      count: usernames.length,
      details,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: GET /status
// ---------------------------------------------------------------------------

app.get("/status", requireInternalAuth, (req, res) => {
  const now = Date.now();

  const bots = [];
  for (const [botId, info] of botRegistry) {
    const agoMs = now - info.lastSeen;
    bots.push({
      botId,
      username: info.username || "",
      lastSeen: new Date(info.lastSeen).toISOString(),
      agoMs,
      alive: agoMs < BOT_DEAD_THRESHOLD_MS,
      scanning: info.scanning,
      jobId: info.jobId,
    });
  }

  const dedupBots = [];
  for (const [username, info] of dedupRegistry) {
    dedupBots.push({
      username,
      bot_id: info.bot_id,
      last_seen: new Date(info.last_seen).toISOString(),
      alive: (now - info.last_seen) < BOT_DEDUP_TTL_MS,
    });
  }

  const scraperStats = scraper.getStats();
  const scraperConfig = scraper.config;

  return res.json({
    pool: {
      size: scraper.availableCount(),
      totalDiscovered: scraperStats.poolTotalDiscovered,
      historySize: scraperStats.historySize,
    },
    assignments: {
      inProgress: assignments.size,
      timeoutMs: ASSIGNMENT_TIMEOUT_MS,
    },
    fleet: {
      totalRegistered: botRegistry.size,
      activeInLast60s: bots.filter((b) => b.agoMs < 60000).length,
      bots,
    },
    dedup: {
      registeredUsernames: dedupRegistry.size,
      bots: dedupBots,
      totalRegistrations: session.totalRegistrations,
    },
    session: {
      ...session,
      uptimeMs: now - session.startTime,
    },
    scraper: scraperStats,
    config: scraperConfig,
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /health
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    pool: scraper.availableCount(),
    assignments: assignments.size,
    discovered: scraper.getStats().poolTotalDiscovered,
    dedupBots: dedupRegistry.size,
  });
});

// ---------------------------------------------------------------------------
// Global Error Handlers
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  log("FATAL", `Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on("unhandledRejection", (reason) => {
  log("FATAL", `Unhandled rejection: ${reason}`);
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function maskSecret(s) {
  if (!s || s.length < 8) return s ? "****" : "(not set)";
  return s.substring(0, 4) + "****" + s.substring(s.length - 4);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const cfg = scraper.config;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BRAINROT FLEET SCANNER — Scanner Backend (Turbo + Dedup)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Port:              ${PORT}`);
  console.log(`  API Key:           ${maskSecret(API_KEY)}`);
  console.log(`  Internal Key:      ${maskSecret(INTERNAL_API_KEY)}`);
  console.log(`  Batch Size:        ${BATCH_SIZE}`);
  console.log(`  Assignment TTL:    ${ASSIGNMENT_TIMEOUT_MS / 1000}s`);
  console.log(`  Bot Dead After:    ${BOT_DEAD_THRESHOLD_MS / 1000}s`);
  console.log(`  Dedup TTL:         ${BOT_DEDUP_TTL_MS / 1000}s`);
  console.log("  ─── Scraper ───");
  console.log(`  Place ID:          ${cfg.PLACE_ID}`);
  console.log(`  Proxy Mode:        ${cfg.proxyMode}`);
  console.log(`  Proxies:           ${cfg.proxyCount}`);
  console.log(`  Workers:           ${cfg.effectiveWorkers}`);
  console.log(`  Cycle Delay:       ${cfg.CYCLE_DELAY_MS}ms`);
  console.log(`  Page Delay:        ${cfg.PAGE_DELAY_MS}ms`);
  console.log(`  Max Pages/Worker:  ${cfg.MAX_PAGES_PER_WORKER}`);
  console.log(`  Pool Cap:          NONE (unlimited)`);
  console.log(`  History Cooldown:  ${cfg.HISTORY_COOLDOWN_MS / 1000}s`);
  console.log(`  History Max:       ${cfg.HISTORY_MAX_SIZE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  scraper.startContinuousLoop();
  log("BOOT", "Scanner backend is live (turbo + dedup mode)");
});
