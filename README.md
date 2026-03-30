# 🧠 Brainrot Fleet Scanner — Backend Infrastructure

Complete backend for the multi-VPS Roblox server hopper fleet scanner.
Two services deployed on Render.com: **Scanner** (job distribution) and **Notifier** (report ingestion + joiner polling).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         VPS BOT FLEET                           │
│  VPS1: Bot1, Bot2    VPS2: Bot3, Bot4    VPS3: Bot5, Bot6       │
└──────────┬──────────────────┬──────────────────┬────────────────┘
           │ POST /api/v1/get-job-assignment      │
           │ POST /scan-complete                  │
           │ POST /heartbeat                      │
           ▼                                      │
┌──────────────────────────┐                      │
│    SCANNER BACKEND       │                      │
│    (brainrot-scanner)    │                      │
│                          │                      │
│  • Job ID Pool Manager   │                      │
│  • Roblox API Scraper    │                      │
│  • Bot Assignment System │                      │ POST /alert
│  • Heartbeat Registry    │                      │
│  • Fleet Status API      │                      │
└──────────────────────────┘                      │
                                                  ▼
                                  ┌──────────────────────────┐
                                  │    NOTIFIER BACKEND      │
                                  │    (brainrot-notifier)    │
                                  │                          │
                                  │  • Alert Ingestion       │
                                  │  • Joiner Polling API    │
                                  │  • Web Dashboard         │
                                  │  • Rate Limiting         │
                                  │  • Deduplication         │
                                  └──────────┬───────────────┘
                                             │ GET /get-latest
                                             ▼
                                  ┌──────────────────────────┐
                                  │    JOINER CLIENTS        │
                                  │    (Roblox scripts)      │
                                  └──────────────────────────┘
```

---

## Project Structure

```
brainrot-fleet-backend/
├── scanner/
│   ├── server.js         # Scanner Express server
│   ├── scraper.js        # Roblox API scraper with proxy rotation
│   └── package.json
├── notifier/
│   ├── server.js         # Notifier Express server
│   ├── dashboard.html    # Self-contained web dashboard
│   └── package.json
├── render.yaml           # Render.com deployment blueprint
├── .gitignore
└── README.md             # This file
```

---

## Step-by-Step Deployment Guide

### Step 1: Get Your Proxies

The scraper needs proxies to avoid Roblox rate limits at scale. Recommended providers:

| Provider | Why | Price |
|----------|-----|-------|
| **Webshare.io** | Easiest setup, has free tier (10 proxies) | Free–$5.49/mo |
| **Bright Data** | Best rotation, highest success rate | ~$10/mo |
| **SmartProxy** | Good middle ground | ~$8/mo |
| **IPRoyal** | Cheap static proxies | ~$5/mo |

You need **residential or datacenter proxies** in HTTP format:
```
http://username:password@proxy-host:port
```

Get 5–10 proxies and save them as a comma-separated string:
```
http://user:pass@proxy1.example.com:8080,http://user:pass@proxy2.example.com:8080
```

### Step 2: Generate Your Secrets

Generate strong random strings for your API keys. Run this in your terminal:

```bash
# Generate API key (shared between Roblox script and backends)
node -e "console.log('API_KEY:', require('crypto').randomBytes(24).toString('hex'))"

# Generate internal API key (shared between scanner and notifier)
node -e "console.log('INTERNAL_KEY:', require('crypto').randomBytes(24).toString('hex'))"

# Generate dashboard access token
node -e "console.log('DASHBOARD_TOKEN:', require('crypto').randomBytes(16).toString('hex'))"

# Generate webhook HMAC secret (optional, for notifier payload signing)
node -e "console.log('WEBHOOK_SECRET:', require('crypto').randomBytes(32).toString('hex'))"
```

Save these values — you'll need them in Step 4.

### Step 3: Push to GitHub

```bash
# Create a new GitHub repository, then:
cd brainrot-fleet-backend
git init
git add .
git commit -m "Initial backend setup"
git remote add origin https://github.com/YOUR_USERNAME/brainrot-fleet-backend.git
git branch -M main
git push -u origin main
```

### Step 4: Deploy to Render.com

#### Option A: Blueprint (Recommended)
1. Go to [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints)
2. Click **"New Blueprint Instance"**
3. Connect your GitHub repo
4. Render detects `render.yaml` and creates both services
5. Fill in the environment variables when prompted (see table below)

#### Option B: Manual Setup (if blueprint doesn't work)

**Create Scanner Service:**
1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Set **Root Directory** to `scanner`
4. Set **Build Command** to `npm install`
5. Set **Start Command** to `npm start`
6. Set **Health Check Path** to `/health`
7. Add environment variables (see table below)

**Create Notifier Service:**
1. Same steps but set **Root Directory** to `notifier`
2. Add the notifier-specific environment variables

### Step 5: Configure Environment Variables

After both services deploy, go to each service's **Environment** tab and set:

#### Scanner Backend Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | ✅ Yes | — | API key that bots include in X-API-Key header |
| `INTERNAL_API_KEY` | ✅ Yes | — | Shared key for cross-service calls (dashboard → scanner) |
| `PLACE_ID` | No | `109983668079237` | Steal a Brainrot Roblox place ID |
| `PROXY_LIST` | ✅ Recommended | — | Comma-separated proxy URLs (see Step 1) |
| `SCRAPER_PAGE_DELAY_MS` | No | `600` | Delay between Roblox API pages (ms) |
| `SCRAPER_MAX_PAGES` | No | `30` | Max pages per scrape cycle |
| `SCRAPE_INTERVAL_MS` | No | `45000` | How often auto-scraper runs (ms) |
| `POOL_LOW_THRESHOLD` | No | `50` | Trigger scrape when pool drops below this |
| `POOL_MAX_SIZE` | No | `500` | Maximum pool size |
| `SCRAPER_MIN_PLAYERS` | No | `1` | Minimum players in server to add to pool |
| `BATCH_SIZE` | No | `8` | Job IDs per batch assigned to each bot |
| `ASSIGNMENT_TIMEOUT_MS` | No | `45000` | Return unfinished assignments to pool after this |
| `BOT_DEAD_THRESHOLD_MS` | No | `90000` | Consider bot dead after no heartbeat for this long |
| `HISTORY_COOLDOWN_MS` | No | `300000` | Don't re-scan a server within this window (5 min) |
| `HISTORY_MAX_SIZE` | No | `5000` | Max scan history entries |

#### Notifier Backend Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | ✅ Yes | — | Same API key as scanner (bots use same key for both) |
| `INTERNAL_API_KEY` | ✅ Yes | — | Same internal key as scanner |
| `DASHBOARD_TOKEN` | ✅ Yes | — | Token for dashboard access (?token=xxx in URL) |
| `WEBHOOK_SECRET` | No | — | HMAC-SHA256 secret for payload signing |
| `SCANNER_BACKEND_URL` | ✅ Yes | — | Full URL of scanner backend (e.g., `https://brainrot-scanner.onrender.com`) |
| `MAX_REPORTS` | No | `200` | Circular buffer size for reports |
| `STALENESS_WINDOW_MS` | No | `90000` | Reports older than this aren't served to joiners |
| `PLAYER_ROOM_BUFFER` | No | `1` | Require at least this many open slots |
| `MAX_PLAYERS` | No | `8` | Max players per Roblox server |
| `JOINER_COOLDOWN_MS` | No | `20000` | Cooldown before serving same server to another joiner |
| `JOINER_RATE_WINDOW_MS` | No | `3000` | Rate limit window for joiner polling |
| `JOINER_RATE_MAX` | No | `2` | Max polls per IP per window |

### Step 6: Get Your URLs

After deploying, Render gives you URLs like:
```
Scanner:  https://brainrot-scanner.onrender.com
Notifier: https://brainrot-notifier.onrender.com
```

**Set `SCANNER_BACKEND_URL`** in the notifier service to the scanner URL.

### Step 7: Configure the Roblox Script

Open `brainrot_scanner_v11.lua` and fill in:

```lua
local SCANNER_BACKEND  = "https://brainrot-scanner.onrender.com"
local SCANNER_API_KEY  = "your-api-key-from-step-2"

local NOTIFIER_BACKEND = "https://brainrot-notifier.onrender.com"
local NOTIFIER_API_KEY = "your-api-key-from-step-2"    -- Same key
local WEBHOOK_SECRET   = "your-webhook-secret-from-step-2"  -- Optional
```

### Step 8: Access the Dashboard

Open in your browser:
```
https://brainrot-notifier.onrender.com/dashboard?token=YOUR_DASHBOARD_TOKEN
```

You'll see the live feed, bot fleet status, pool health, and sparkline chart.

---

## API Reference

### Scanner Backend

#### `POST /api/v1/get-job-assignment`
Request a batch of server Job IDs to scan.

**Headers:** `X-API-Key: your-key`
**Body:**
```json
{ "bot_id": "VPS01_BOT001_us_12345", "vps_id": 1 }
```
**Response:**
```json
{
  "success": true,
  "job_ids": ["xxxxxxxx-xxxx-...", "yyyyyyyy-yyyy-..."],
  "available_servers": 142,
  "history_size": 580
}
```

#### `POST /scan-complete`
Report that scanning a server is finished.

**Body:**
```json
{ "bot_id": "VPS01_BOT001_us_12345", "job_id": "xxxxxxxx-xxxx-..." }
```

#### `POST /heartbeat`
Bot keepalive ping (send every 30s).

**Body:**
```json
{ "bot_id": "VPS01_BOT001_us_12345", "job_id": "xxx", "scanning": true, "uptime": 1234 }
```

#### `GET /status`
Fleet and pool status (requires Internal API Key).

#### `GET /health`
Health check — returns 200 if alive.

### Notifier Backend

#### `POST /alert`
Submit a brainrot find report.

**Headers:** `x-api-key: your-key`, optional `x-signature: hmac-hex`
**Body:**
```json
{
  "serverId": "xxxxxxxx-xxxx-...",
  "placeId": 109983668079237,
  "brainrotName": "Skibidi Toilet",
  "value": "1.23B",
  "priority": 1,
  "botId": "VPS01_BOT001_us_12345",
  "players": 5,
  "total_found": 3,
  "brainrots": [
    { "name": "Skibidi Toilet", "generation": 1230000000, "priority": 1 }
  ],
  "timestamp": 1719900000000
}
```

#### `GET /get-latest`
Joiner polls for best available server.

**Query:** `?min_priority=3` (optional, default 3 = all tiers)
**Response:**
```json
{
  "success": true,
  "server": {
    "serverId": "xxxxxxxx-xxxx-...",
    "placeId": 109983668079237,
    "brainrotName": "Skibidi Toilet",
    "value": "1.23B",
    "players": 5,
    "priority": 1,
    "timestamp": 1719900000000
  }
}
```

#### `GET /recent?limit=20&priority=1`
Recent finds for dashboard display.

#### `GET /dashboard?token=YOUR_TOKEN`
Web dashboard UI.

#### `GET /health`
Health check.

---

## Render.com Free Tier Notes

- Free tier services **spin down after 15 minutes of inactivity**
- First request after spindown takes ~30 seconds to cold-start
- The bot fleet's heartbeats keep the scanner alive
- The joiner's polling keeps the notifier alive
- For production use, upgrade to **Starter ($7/mo per service)** for always-on

### Keeping Free Tier Alive

If you need free tier to stay alive without traffic, add a cron ping:
- Use [cron-job.org](https://cron-job.org) (free)
- Set up two cron jobs hitting `/health` every 14 minutes:
  - `https://brainrot-scanner.onrender.com/health`
  - `https://brainrot-notifier.onrender.com/health`

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Bots get 401 | Wrong API_KEY | Make sure Lua script key matches Render env var |
| Bots get 503 | Pool is empty | Check scraper logs — may need more/better proxies |
| Pool stays empty | Roblox rate limiting | Add more proxies, increase PAGE_DELAY_MS |
| Dashboard blank | Wrong token | Check ?token= matches DASHBOARD_TOKEN env var |
| Dashboard shows scanner offline | Wrong SCANNER_BACKEND_URL | Set it to scanner's full Render URL |
| Joiner gets nothing | Reports are stale | Bots aren't finding anything, or STALENESS_WINDOW too short |
| Memory grows | Long uptime | History/pool caps prevent this, but restart if needed |

---

## Local Development

```bash
# Terminal 1: Scanner
cd scanner
npm install
API_KEY=devkey INTERNAL_API_KEY=devinternal npm start

# Terminal 2: Notifier
cd notifier
npm install
API_KEY=devkey INTERNAL_API_KEY=devinternal DASHBOARD_TOKEN=devtoken SCANNER_BACKEND_URL=http://localhost:4000 npm start

# Open dashboard
open http://localhost:3003/dashboard?token=devtoken
```
