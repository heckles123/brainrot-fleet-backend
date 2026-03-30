// ============================================================================
// server.js — Notifier Backend for Brainrot Fleet Scanner v11
// ============================================================================
// Receives found brainrot reports from scanner bots and serves them to
// joiner clients polling for servers worth joining. Also serves the
// web dashboard.
//
// Routes:
//   POST /alert          — Ingest a brainrot report from a scanner bot
//   GET  /get-latest     — Joiner polls for the best available server
//   GET  /recent         — Recent history for dashboard (last N finds)
//   GET  /dashboard      — Serves the web dashboard (token-protected)
//   GET  /health         — Render.com health check
// ============================================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3003", 10);

// API key for bot and joiner authentication
const API_KEY = process.env.API_KEY || "";

// Optional HMAC-SHA256 secret for webhook signature validation
// If set, the x-signature header is verified on /alert requests
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Dashboard access token (passed as ?token=xxx in the URL)
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";

// Scanner backend URL for dashboard to fetch fleet status
const SCANNER_BACKEND_URL = process.env.SCANNER_BACKEND_URL || "";

// Internal API key shared with scanner backend for cross-service calls
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// Maximum number of reports to keep in the circular buffer
const MAX_REPORTS = parseInt(process.env.MAX_REPORTS || "200", 10);

// Reports older than this (ms) are considered stale and not served to joiners
const STALENESS_WINDOW_MS = parseInt(process.env.STALENESS_WINDOW_MS || "90000", 10);

// Player buffer: only serve servers with (maxPlayers - players) >= this value
// Ensures there's room for the joiner to actually join
const PLAYER_ROOM_BUFFER = parseInt(process.env.PLAYER_ROOM_BUFFER || "1", 10);

// Max players per server (Steal a Brainrot uses 8)
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "8", 10);

// Once a server is served to a joiner, cooldown (ms) before it can be served again
const JOINER_COOLDOWN_MS = parseInt(process.env.JOINER_COOLDOWN_MS || "20000", 10);

// Rate limit for joiner polling: max requests per IP per window
const JOINER_RATE_WINDOW_MS = parseInt(process.env.JOINER_RATE_WINDOW_MS || "3000", 10);
const JOINER_RATE_MAX = parseInt(process.env.JOINER_RATE_MAX || "2", 10);

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
 * Circular buffer of brainrot reports.
 * Shape: Array<{
 *   id: string,           — Unique report ID (uuid-like)
 *   receivedAt: number,   — Server-side timestamp (ms)
 *   serverId: string,     — Roblox Job ID
 *   placeId: number,
 *   brainrotName: string, — Top brainrot name
 *   value: string,        — Formatted value string
 *   priority: number,     — 1 (legendary), 2 (rare), 3 (common valuable)
 *   botId: string,
 *   players: number,
 *   totalFound: number,
 *   brainrots: Array<{ name, generation, priority }>,
 *   timestamp: number     — Client-side timestamp (ms)
 * }>
 */
let reports = [];

/**
 * Joiner cooldown: Map<serverId, lastServedAt (timestamp)>
 * Prevents the same server from being spammed to multiple joiners.
 */
const joinerCooldowns = new Map();

/**
 * IP-based rate limiter for joiner polling.
 * Map<ip, { count, windowStart }>
 */
const joinerRateLimits = new Map();

/**
 * Session stats for dashboard and health endpoint.
 */
const sessionStats = {
  totalReports: 0,
  totalJoinerPolls: 0,
  totalServed: 0,      // Times a server was successfully served to a joiner
  reportsByTier: { 1: 0, 2: 0, 3: 0 },
  startTime: Date.now(),
  // Finds-per-minute tracking (last 10 minutes, per-minute buckets)
  findsPerMinute: new Array(10).fill(0),
  currentMinuteBucket: Math.floor(Date.now() / 60000),
};

// ---------------------------------------------------------------------------
// Finds-Per-Minute Tracker
// ---------------------------------------------------------------------------

/**
 * Record a new find in the per-minute tracker.
 * Rotates buckets as minutes pass.
 */
function recordFind() {
  const currentBucket = Math.floor(Date.now() / 60000);
  const elapsed = currentBucket - sessionStats.currentMinuteBucket;

  if (elapsed > 0) {
    // Shift buckets left by the number of elapsed minutes
    const shift = Math.min(elapsed, sessionStats.findsPerMinute.length);
    for (let i = 0; i < shift; i++) {
      sessionStats.findsPerMinute.shift();
      sessionStats.findsPerMinute.push(0);
    }
    sessionStats.currentMinuteBucket = currentBucket;
  }

  // Increment current minute
  sessionStats.findsPerMinute[sessionStats.findsPerMinute.length - 1]++;
}

/**
 * Get the finds-per-minute array, properly shifted to current time.
 */
function getFindsPerMinute() {
  const currentBucket = Math.floor(Date.now() / 60000);
  const elapsed = currentBucket - sessionStats.currentMinuteBucket;
  const arr = [...sessionStats.findsPerMinute];

  if (elapsed > 0) {
    const shift = Math.min(elapsed, arr.length);
    for (let i = 0; i < shift; i++) {
      arr.shift();
      arr.push(0);
    }
  }

  return arr;
}

// ---------------------------------------------------------------------------
// Cleanup Intervals
// ---------------------------------------------------------------------------

// Clean up stale joiner cooldowns every 30s
setInterval(() => {
  const now = Date.now();
  for (const [serverId, lastServed] of joinerCooldowns) {
    if (now - lastServed > JOINER_COOLDOWN_MS * 3) {
      joinerCooldowns.delete(serverId);
    }
  }
}, 30000);

// Clean up stale rate limit entries every 15s
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinerRateLimits) {
    if (now - entry.windowStart > JOINER_RATE_WINDOW_MS * 3) {
      joinerRateLimits.delete(ip);
    }
  }
}, 15000);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Request logger (skip /health to reduce noise)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    log("HTTP", `${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

/**
 * API key validation middleware.
 */
function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers["x-api-key"];
  if (provided !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

/**
 * Verify HMAC-SHA256 signature on request body.
 * Only enforced if WEBHOOK_SECRET is configured.
 */
function verifySignature(req, res, next) {
  if (!WEBHOOK_SECRET) return next();

  const signature = req.headers["x-signature"];
  if (!signature) {
    // If no signature header but secret is configured, allow but log warning
    // (some executors don't support HMAC)
    if (signature !== "no-hmac-support") {
      log("AUTH", "Missing x-signature header (HMAC not enforced)");
    }
    return next();
  }

  if (signature === "no-hmac-support") {
    return next(); // Bot executor doesn't have HMAC — allow through
  }

  try {
    const rawBody = JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expected) {
      log("AUTH", "Invalid HMAC signature");
      return res.status(403).json({ error: "Invalid signature" });
    }
  } catch (err) {
    log("AUTH", `Signature verification error: ${err.message}`);
  }

  next();
}

/**
 * Joiner rate limiter middleware.
 */
function joinerRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();

  let entry = joinerRateLimits.get(ip);
  if (!entry || now - entry.windowStart > JOINER_RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    joinerRateLimits.set(ip, entry);
  }

  entry.count++;

  if (entry.count > JOINER_RATE_MAX) {
    const retryIn = JOINER_RATE_WINDOW_MS - (now - entry.windowStart);
    return res.status(429).json({
      error: "Rate limited",
      retry_in_ms: Math.max(retryIn, 500),
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Helper: Generate a unique report ID
// ---------------------------------------------------------------------------

let reportCounter = 0;
function generateReportId() {
  reportCounter++;
  return `RPT-${Date.now().toString(36)}-${reportCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// ROUTE: POST /alert
// ---------------------------------------------------------------------------
// Receives a brainrot report from a scanner bot.
// Body: { serverId, placeId, brainrotName, value, priority, botId,
//         players, total_found, brainrots: [{name, generation, priority}],
//         timestamp }
// Returns: { success: boolean, reportId: string }
// ---------------------------------------------------------------------------

app.post("/alert", requireAuth, verifySignature, (req, res) => {
  try {
    const {
      serverId,
      placeId,
      brainrotName,
      value,
      priority,
      botId,
      players,
      total_found,
      brainrots,
      timestamp,
    } = req.body;

    if (!serverId || !brainrotName) {
      return res.status(400).json({ error: "serverId and brainrotName are required" });
    }

    const reportId = generateReportId();

    const report = {
      id: reportId,
      receivedAt: Date.now(),
      serverId,
      placeId: placeId || 0,
      brainrotName: brainrotName || "Unknown",
      value: value || "0",
      priority: priority || 3,
      botId: botId || "unknown",
      players: players || 0,
      totalFound: total_found || 0,
      brainrots: Array.isArray(brainrots) ? brainrots : [],
      timestamp: timestamp || Date.now(),
    };

    // Add to circular buffer (cap at MAX_REPORTS)
    reports.push(report);
    if (reports.length > MAX_REPORTS) {
      reports = reports.slice(-MAX_REPORTS);
    }

    // Update stats
    sessionStats.totalReports++;
    const tier = Math.min(Math.max(report.priority, 1), 3);
    sessionStats.reportsByTier[tier] = (sessionStats.reportsByTier[tier] || 0) + 1;
    recordFind();

    log("ALERT", `${botId}: ${brainrotName} ($${value}/s) P${priority} in ${serverId.substring(0, 8)}... [${players} players]`);

    return res.json({ success: true, reportId });
  } catch (err) {
    log("ERROR", `Alert processing failed: ${err.message}`);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// ROUTE: GET /get-latest
// ---------------------------------------------------------------------------
// Joiner clients poll this to find the best available server to join.
// Query params:
//   min_priority — Only return servers with priority <= this (1=legendary only)
//   bot_id       — Optional joiner identifier for logging
// Returns: { success, server: { serverId, placeId, brainrotName, value,
//            players, priority, timestamp } } or { success: false }
// ---------------------------------------------------------------------------

app.get("/get-latest", requireAuth, joinerRateLimit, (req, res) => {
  sessionStats.totalJoinerPolls++;

  const minPriority = parseInt(req.query.min_priority || "3", 10);
  const now = Date.now();

  // Filter reports:
  // 1. Not stale (within staleness window)
  // 2. Priority is <= minPriority (lower number = rarer = higher priority)
  // 3. Has room for joiner (players < maxPlayers - buffer)
  // 4. Not in joiner cooldown (recently served to another joiner)
  const candidates = reports.filter((r) => {
    if (now - r.receivedAt > STALENESS_WINDOW_MS) return false;
    if (r.priority > minPriority) return false;
    if (r.players >= MAX_PLAYERS - PLAYER_ROOM_BUFFER) return false;
    const lastServed = joinerCooldowns.get(r.serverId);
    if (lastServed && now - lastServed < JOINER_COOLDOWN_MS) return false;
    return true;
  });

  if (candidates.length === 0) {
    return res.json({ success: false, message: "No servers available" });
  }

  // Sort: priority ascending (1 first), then by highest generation value
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Compare by top brainrot generation value
    const aGen = a.brainrots?.[0]?.generation || 0;
    const bGen = b.brainrots?.[0]?.generation || 0;
    return bGen - aGen;
  });

  const best = candidates[0];

  // Mark as served (enter joiner cooldown)
  joinerCooldowns.set(best.serverId, now);
  sessionStats.totalServed++;

  log("JOINER", `Served ${best.brainrotName} P${best.priority} in ${best.serverId.substring(0, 8)}... (${candidates.length} candidates)`);

  return res.json({
    success: true,
    server: {
      serverId: best.serverId,
      placeId: best.placeId,
      brainrotName: best.brainrotName,
      value: best.value,
      players: best.players,
      priority: best.priority,
      brainrots: best.brainrots,
      timestamp: best.receivedAt,
      reportId: best.id,
    },
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /recent
// ---------------------------------------------------------------------------
// Returns recent reports for the dashboard.
// Query params:
//   limit    — Number of reports to return (default 20, max 50)
//   priority — Filter by specific priority tier (optional)
// Returns: { reports: [...], total: number }
// ---------------------------------------------------------------------------

app.get("/recent", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
  const priorityFilter = req.query.priority ? parseInt(req.query.priority, 10) : null;

  let filtered = [...reports].reverse(); // Most recent first

  if (priorityFilter) {
    filtered = filtered.filter((r) => r.priority === priorityFilter);
  }

  filtered = filtered.slice(0, limit);

  return res.json({
    reports: filtered,
    total: reports.length,
    stats: {
      ...sessionStats,
      findsPerMinute: getFindsPerMinute(),
      uptimeMs: Date.now() - sessionStats.startTime,
    },
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /dashboard
// ---------------------------------------------------------------------------
// Serves the web dashboard. Protected by a query-string token.
// ---------------------------------------------------------------------------

app.get("/dashboard", (req, res) => {
  if (DASHBOARD_TOKEN && req.query.token !== DASHBOARD_TOKEN) {
    return res.status(401).send("Unauthorized — append ?token=YOUR_TOKEN to the URL");
  }
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ---------------------------------------------------------------------------
// ROUTE: GET /health
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    reports: reports.length,
    totalReports: sessionStats.totalReports,
    totalServed: sessionStats.totalServed,
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /internal/stats
// ---------------------------------------------------------------------------
// Internal endpoint used by the dashboard to get combined stats.
// Returns notifier stats + scanner stats (if scanner URL is configured).
// ---------------------------------------------------------------------------

app.get("/internal/stats", async (req, res) => {
  // Validate token from query or API key from header
  const tokenOk = DASHBOARD_TOKEN && req.query.token === DASHBOARD_TOKEN;
  const keyOk = API_KEY && req.headers["x-api-key"] === API_KEY;
  if (!tokenOk && !keyOk && (DASHBOARD_TOKEN || API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const notifierStats = {
    reports: [...reports].reverse().slice(0, 30),
    totalReports: sessionStats.totalReports,
    reportsByTier: sessionStats.reportsByTier,
    totalJoinerPolls: sessionStats.totalJoinerPolls,
    totalServed: sessionStats.totalServed,
    findsPerMinute: getFindsPerMinute(),
    uptimeMs: Date.now() - sessionStats.startTime,
  };

  // Try to fetch scanner status for the dashboard
  let scannerStatus = null;
  if (SCANNER_BACKEND_URL && INTERNAL_API_KEY) {
    try {
      const resp = await fetch(`${SCANNER_BACKEND_URL}/status`, {
        headers: { "X-API-Key": INTERNAL_API_KEY },
        timeout: 5000,
      });
      if (resp.ok) {
        scannerStatus = await resp.json();
      }
    } catch (err) {
      log("INTERNAL", `Failed to fetch scanner status: ${err.message}`);
    }
  }

  return res.json({ notifier: notifierStats, scanner: scannerStatus });
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
// Startup
// ---------------------------------------------------------------------------

function maskSecret(s) {
  if (!s || s.length < 8) return s ? "****" : "(not set)";
  return s.substring(0, 4) + "****" + s.substring(s.length - 4);
}

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════");
  console.log("  🧠 BRAINROT FLEET SCANNER — Notifier Backend");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Port:              ${PORT}`);
  console.log(`  API Key:           ${maskSecret(API_KEY)}`);
  console.log(`  Webhook Secret:    ${maskSecret(WEBHOOK_SECRET)}`);
  console.log(`  Dashboard Token:   ${maskSecret(DASHBOARD_TOKEN)}`);
  console.log(`  Scanner URL:       ${SCANNER_BACKEND_URL || "(not set)"}`);
  console.log(`  Internal Key:      ${maskSecret(INTERNAL_API_KEY)}`);
  console.log(`  Max Reports:       ${MAX_REPORTS}`);
  console.log(`  Staleness Window:  ${STALENESS_WINDOW_MS / 1000}s`);
  console.log(`  Player Buffer:     ${PLAYER_ROOM_BUFFER} (max ${MAX_PLAYERS})`);
  console.log(`  Joiner Cooldown:   ${JOINER_COOLDOWN_MS / 1000}s`);
  console.log("═══════════════════════════════════════════════\n");

  log("BOOT", "Notifier backend is live");
});
