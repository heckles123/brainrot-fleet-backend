// ═══════════════════════════════════════════════════════════════════
// BRAINROT FLEET BACKEND v2.0
// Combined: Notifier + WebSocket + Discord Bot + Alert Dedup + Dashboard
//
// Features:
//   • WebSocket push alerts (instant, replaces HTTP polling)
//   • Alert dedup across bots (same server+animal within 30s = 1 alert)
//   • Discord bot with 20+ slash commands
//   • Enhanced fleet dashboard with duel tracking
//   • Fleet control (pause/resume/hop-all/set-min-value)
//   • Bot health monitoring with auto-stale detection
//   • Find rate analytics and leaderboards
//
// Deploy: Single service on Render.com (or any Node host)
// ENV vars: PORT, API_KEY, DISCORD_TOKEN, DISCORD_CHANNEL_ID
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3003;
const API_KEY = process.env.API_KEY || 'changeme';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const DISCORD_ALERT_CHANNEL = process.env.DISCORD_ALERT_CHANNEL || DISCORD_CHANNEL_ID;

// ═══ AUTH MIDDLEWARE ═══
function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.headers['x-api-secret'];
    if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
    next();
}

// ═══════════════════════════════════════════════════════════════════
// STATE — Single source of truth for entire fleet
// ═══════════════════════════════════════════════════════════════════

const state = {
    // Fleet control
    paused: false,
    globalMinValue: 0,
    watchlist: [],           // animal names to prioritize
    blacklist: [],           // animal names to ignore

    // Bot registry
    bots: new Map(),         // bot_id -> { username, job_id, last_seen, scanning, uptime, finds, status }

    // Alert storage
    alerts: [],              // { id, serverId, brainrotName, value, priority, botId, players, ... }
    maxAlerts: 500,

    // Dedup tracking
    dedupMap: new Map(),     // "serverId:animalName" -> timestamp

    // Analytics
    startTime: Date.now(),
    totalFinds: 0,
    findsByTier: { 1: 0, 2: 0, 3: 0 },
    findsByBot: new Map(),   // bot_id -> count
    findsPerHour: [],        // { hour: "2024-01-01T12", count: N }
    duelsDetected: 0,
    carpetFinds: 0,
    plotFinds: 0,
    dedupBlocked: 0,

    // Joiner tracking
    joiners: new Map(),      // ws -> { connectedAt, lastPoll, alerts_sent }
};

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER — Push alerts to joiners instantly
// ═══════════════════════════════════════════════════════════════════

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[WS] Joiner connected from ${ip}`);

    const joinerInfo = { connectedAt: Date.now(), lastPing: Date.now(), alertsSent: 0 };
    state.joiners.set(ws, joinerInfo);

    // Send current state on connect
    ws.send(JSON.stringify({
        type: 'connected',
        paused: state.paused,
        globalMinValue: state.globalMinValue,
        recentAlerts: state.alerts.slice(0, 20),
        botsOnline: state.bots.size,
    }));

    ws.on('pong', () => { joinerInfo.lastPing = Date.now(); });

    ws.on('close', () => {
        state.joiners.delete(ws);
        console.log(`[WS] Joiner disconnected`);
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        } catch (e) {}
    });
});

// Heartbeat to detect dead connections
setInterval(() => {
    wss.clients.forEach(ws => {
        const info = state.joiners.get(ws);
        if (info && Date.now() - info.lastPing > 60000) {
            ws.terminate();
            state.joiners.delete(ws);
            return;
        }
        ws.ping();
    });
}, 30000);

function broadcastToJoiners(message) {
    const payload = JSON.stringify(message);
    let sent = 0;
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            const info = state.joiners.get(ws);
            if (info) info.alertsSent++;
            sent++;
        }
    });
    return sent;
}

// ═══════════════════════════════════════════════════════════════════
// ALERT DEDUPLICATION — Same server + animal within 30s = skip
// ═══════════════════════════════════════════════════════════════════

const DEDUP_WINDOW = 30000; // 30 seconds

function isDuplicate(serverId, animalName) {
    const key = `${serverId}:${animalName}`;
    const lastSeen = state.dedupMap.get(key);
    if (lastSeen && Date.now() - lastSeen < DEDUP_WINDOW) {
        state.dedupBlocked++;
        return true;
    }
    state.dedupMap.set(key, Date.now());
    return false;
}

// Clean old dedup entries every 60s
setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of state.dedupMap) {
        if (now - ts > DEDUP_WINDOW * 2) state.dedupMap.delete(key);
    }
}, 60000);

// ═══════════════════════════════════════════════════════════════════
// POST /alert — Scanner sends finds here
// ═══════════════════════════════════════════════════════════════════

app.post('/alert', auth, (req, res) => {
    try {
        const data = req.body;
        const { serverId, brainrotName, value, priority, botId, players, brainrots } = data;

        // Fleet paused check
        if (state.paused) return res.json({ success: true, status: 'paused' });

        // Blacklist check
        if (state.blacklist.includes(brainrotName)) return res.json({ success: true, status: 'blacklisted' });

        // Dedup check
        if (isDuplicate(serverId, brainrotName)) {
            return res.json({ success: true, status: 'deduplicated' });
        }

        // Build alert
        const alert = {
            id: `${serverId}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            serverId, brainrotName, value, priority: priority || 3,
            botId: botId || 'unknown', players: players || 0,
            total_found: data.total_found || 1,
            brainrots: brainrots || [],
            timestamp: data.timestamp || Date.now(),
            receivedAt: Date.now(),
            // Enhanced data from v12 scanner
            hasDuelAnimals: false,
            hasCarpetAnimals: false,
            duelAnimals: [],
            mutations: [],
        };

        // Parse enhanced brainrot data
        if (brainrots && Array.isArray(brainrots)) {
            for (const br of brainrots) {
                if (br.inDuel) {
                    alert.hasDuelAnimals = true;
                    alert.duelAnimals.push(br.name);
                    state.duelsDetected++;
                }
                if (br.isCarpet) {
                    alert.hasCarpetAnimals = true;
                    state.carpetFinds++;
                } else {
                    state.plotFinds++;
                }
                if (br.mutation) alert.mutations.push(br.mutation);
            }
        }

        // Store alert
        state.alerts.unshift(alert);
        while (state.alerts.length > state.maxAlerts) state.alerts.pop();

        // Analytics
        state.totalFinds++;
        state.findsByTier[priority] = (state.findsByTier[priority] || 0) + 1;
        state.findsByBot.set(botId, (state.findsByBot.get(botId) || 0) + 1);
        const hourKey = new Date().toISOString().slice(0, 13);
        const hourEntry = state.findsPerHour.find(h => h.hour === hourKey);
        if (hourEntry) hourEntry.count++; else state.findsPerHour.push({ hour: hourKey, count: 1 });
        while (state.findsPerHour.length > 48) state.findsPerHour.shift();

        // Update bot info
        if (state.bots.has(botId)) {
            const bot = state.bots.get(botId);
            bot.finds = (bot.finds || 0) + 1;
            bot.lastFind = Date.now();
            bot.last_seen = Date.now();
        }

        // WebSocket broadcast to all joiners
        const sent = broadcastToJoiners({
            type: 'alert',
            alert,
        });

        // Discord alert (if configured)
        if (discordReady && priority <= 2) {
            sendDiscordAlert(alert);
        }

        console.log(`[ALERT] ${brainrotName} $${value}/s P${priority} by ${botId} | WS→${sent} joiners${alert.hasDuelAnimals ? ' [DUEL]' : ''}${alert.hasCarpetAnimals ? ' [CARPET]' : ''}`);
        res.json({ success: true, id: alert.id, ws_sent: sent });
    } catch (err) {
        console.error('[ALERT ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// LEGACY POLLING ENDPOINTS (backward compatible)
// ═══════════════════════════════════════════════════════════════════

app.get('/get-latest', auth, (req, res) => {
    const alert = state.alerts[0];
    if (!alert) return res.json({ found: false });
    res.json({ found: true, ...alert });
});

app.get('/recent', auth, (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ reports: state.alerts.slice(0, limit) });
});

// ═══════════════════════════════════════════════════════════════════
// BOT MANAGEMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

app.post('/heartbeat', auth, (req, res) => {
    const { bot_id, job_id, scanning, uptime, username } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'bot_id required' });

    const existing = state.bots.get(bot_id) || {};
    state.bots.set(bot_id, {
        ...existing,
        bot_id, job_id, scanning, uptime,
        username: username || existing.username || bot_id,
        last_seen: Date.now(),
        status: state.paused ? 'paused' : (scanning ? 'scanning' : 'idle'),
        finds: existing.finds || 0,
    });

    res.json({
        success: true,
        commands: {
            paused: state.paused,
            globalMinValue: state.globalMinValue,
            watchlist: state.watchlist,
            blacklist: state.blacklist,
        },
    });
});

app.post('/scanner-register', auth, (req, res) => {
    const { username, bot_id } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const existing = state.bots.get(bot_id) || {};
    state.bots.set(bot_id || username, { ...existing, username, bot_id, last_seen: Date.now(), finds: existing.finds || 0 });
    res.json({ success: true, total_bots: state.bots.size });
});

app.get('/scanner-list', auth, (req, res) => {
    const usernames = [];
    for (const [, info] of state.bots) {
        if (info.username && Date.now() - info.last_seen < 120000) usernames.push(info.username);
    }
    res.json({ success: true, usernames, count: usernames.length });
});

// Clean stale bots every 60s
setInterval(() => {
    const now = Date.now();
    for (const [id, info] of state.bots) {
        if (now - info.last_seen > 300000) { // 5 min stale
            info.status = 'stale';
        }
        if (now - info.last_seen > 600000) { // 10 min dead
            state.bots.delete(id);
        }
    }
}, 60000);

// ═══════════════════════════════════════════════════════════════════
// FLEET CONTROL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

app.post('/fleet/pause', auth, (req, res) => {
    state.paused = true;
    broadcastToJoiners({ type: 'fleet_update', paused: true });
    res.json({ success: true, paused: true });
});

app.post('/fleet/resume', auth, (req, res) => {
    state.paused = false;
    broadcastToJoiners({ type: 'fleet_update', paused: false });
    res.json({ success: true, paused: false });
});

app.post('/fleet/set-min-value', auth, (req, res) => {
    const { value } = req.body;
    state.globalMinValue = value || 0;
    broadcastToJoiners({ type: 'fleet_update', globalMinValue: state.globalMinValue });
    res.json({ success: true, globalMinValue: state.globalMinValue });
});

app.post('/fleet/watchlist', auth, (req, res) => {
    const { action, name } = req.body;
    if (action === 'add' && name) { if (!state.watchlist.includes(name)) state.watchlist.push(name); }
    else if (action === 'remove' && name) { state.watchlist = state.watchlist.filter(n => n !== name); }
    else if (action === 'clear') { state.watchlist = []; }
    res.json({ success: true, watchlist: state.watchlist });
});

app.post('/fleet/blacklist', auth, (req, res) => {
    const { action, name } = req.body;
    if (action === 'add' && name) { if (!state.blacklist.includes(name)) state.blacklist.push(name); }
    else if (action === 'remove' && name) { state.blacklist = state.blacklist.filter(n => n !== name); }
    else if (action === 'clear') { state.blacklist = []; }
    res.json({ success: true, blacklist: state.blacklist });
});

app.post('/fleet/clear-alerts', auth, (req, res) => {
    state.alerts = [];
    broadcastToJoiners({ type: 'alerts_cleared' });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// ENHANCED DASHBOARD
// ═══════════════════════════════════════════════════════════════════

app.get('/dashboard/data', (req, res) => {
    const now = Date.now();
    const uptimeMs = now - state.startTime;
    const uptimeH = (uptimeMs / 3600000).toFixed(1);

    // Bot details
    const botDetails = [];
    for (const [id, info] of state.bots) {
        botDetails.push({
            bot_id: id,
            username: info.username || id,
            job_id: info.job_id,
            status: info.status || 'unknown',
            scanning: info.scanning || false,
            last_seen_ago: Math.floor((now - (info.last_seen || 0)) / 1000) + 's',
            finds: info.finds || 0,
            lastFind: info.lastFind ? Math.floor((now - info.lastFind) / 1000) + 's ago' : 'never',
            uptime: info.uptime || 0,
        });
    }

    // Recent finds with full details
    const recentFinds = state.alerts.slice(0, 30).map(a => ({
        id: a.id,
        brainrotName: a.brainrotName,
        value: a.value,
        priority: a.priority,
        serverId: a.serverId,
        botId: a.botId,
        players: a.players,
        age: Math.floor((now - a.receivedAt) / 1000) + 's',
        hasDuelAnimals: a.hasDuelAnimals,
        duelAnimals: a.duelAnimals || [],
        hasCarpetAnimals: a.hasCarpetAnimals,
        mutations: a.mutations || [],
        total_found: a.total_found,
        brainrots: (a.brainrots || []).map(b => ({
            name: b.name,
            generation: b.generation,
            priority: b.priority,
            mutation: b.mutation || 'Normal',
            inDuel: b.inDuel || false,
            isCarpet: b.isCarpet || false,
        })),
    }));

    // Find rate per hour
    const findRate = state.findsPerHour.slice(-12);

    // Bot leaderboard
    const leaderboard = Array.from(state.findsByBot.entries())
        .map(([bot, count]) => ({ bot, finds: count }))
        .sort((a, b) => b.finds - a.finds)
        .slice(0, 10);

    // Duel summary
    const recentDuels = state.alerts.filter(a => a.hasDuelAnimals).slice(0, 10).map(a => ({
        brainrotName: a.brainrotName,
        duelAnimals: a.duelAnimals,
        serverId: a.serverId?.slice(0, 8),
        age: Math.floor((now - a.receivedAt) / 1000) + 's',
    }));

    // Active servers (unique serverIds from recent alerts)
    const activeServers = new Set(state.alerts.slice(0, 50).map(a => a.serverId)).size;

    res.json({
        fleet: {
            paused: state.paused,
            globalMinValue: state.globalMinValue,
            watchlist: state.watchlist,
            blacklist: state.blacklist,
            uptime: uptimeH + 'h',
            uptimeMs,
        },
        bots: {
            total: state.bots.size,
            online: botDetails.filter(b => b.status !== 'stale' && b.status !== 'dead').length,
            scanning: botDetails.filter(b => b.scanning).length,
            details: botDetails,
        },
        alerts: {
            total: state.totalFinds,
            stored: state.alerts.length,
            recent: recentFinds,
            dedupBlocked: state.dedupBlocked,
        },
        analytics: {
            findsByTier: state.findsByTier,
            findRate,
            leaderboard,
            duelsDetected: state.duelsDetected,
            carpetFinds: state.carpetFinds,
            plotFinds: state.plotFinds,
            activeServers,
        },
        duels: {
            total: state.duelsDetected,
            recent: recentDuels,
        },
        joiners: {
            connected: state.joiners.size,
        },
    });
});

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════

app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fleet Dashboard v2</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0812;color:#e8e0d0;font-family:'Segoe UI',sans-serif;padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:14px}
.card{background:#14101e;border:1px solid #2a2040;border-radius:12px;padding:16px}
.card h3{color:#eb8c0f;font-size:14px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.stat{font-size:28px;font-weight:700;color:#fff}
.sub{color:#9a8a70;font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
th{color:#eb8c0f;text-align:left;padding:6px 8px;border-bottom:1px solid #2a2040}
td{padding:6px 8px;border-bottom:1px solid #1a1428}
.online{color:#32d25a}.offline{color:#c82d37}.scanning{color:#eb8c0f}.stale{color:#666}
.duel{color:#ff4060;font-weight:700}.carpet{color:#40a0ff}.plot{color:#50d080}
.badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700}
.badge.t1{background:#5c1520;color:#ff4060}.badge.t2{background:#4a3800;color:#ffc340}.badge.t3{background:#1a2a1a;color:#50d080}
.badge.duel{background:#3a1020;color:#ff6080}.badge.carpet{background:#102a3a;color:#60b0ff}
.paused-banner{background:#5c1520;color:#ff4060;padding:12px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:12px;display:none}
h1{color:#eb8c0f;font-size:22px}
.header{display:flex;justify-content:space-between;align-items:center}
.ws-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px}
.ws-on{background:#32d25a}.ws-off{background:#c82d37}
.feed-entry{background:#1a1428;border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid #eb8c0f}
.feed-entry.t1{border-left-color:#ff4060}.feed-entry.t2{border-left-color:#ffc340}
.chart-bar{height:20px;background:#eb8c0f;border-radius:3px;margin:2px 0;transition:width 0.3s}
</style></head><body>
<div class="header"><h1>Brainrot Fleet Dashboard v2</h1>
<div id="wsStatus"><span class="ws-dot ws-off"></span>Connecting...</div></div>
<div class="paused-banner" id="pausedBanner">FLEET PAUSED</div>
<div class="grid">
<div class="card"><h3>Fleet Overview</h3><div class="stat" id="totalFinds">0</div><div class="sub">Total finds</div>
<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
<div><div class="stat" style="font-size:18px;color:#ff4060" id="t1Finds">0</div><div class="sub">Tier 1</div></div>
<div><div class="stat" style="font-size:18px;color:#ffc340" id="t2Finds">0</div><div class="sub">Tier 2</div></div>
<div><div class="stat" style="font-size:18px;color:#50d080" id="t3Finds">0</div><div class="sub">Tier 3</div></div>
</div>
<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
<div><div class="stat" style="font-size:16px;color:#ff6080" id="duelCount">0</div><div class="sub">In Duels</div></div>
<div><div class="stat" style="font-size:16px;color:#60b0ff" id="carpetCount">0</div><div class="sub">Carpet</div></div>
<div><div class="stat" style="font-size:16px;color:#50d080" id="plotCount">0</div><div class="sub">Plot</div></div>
</div></div>

<div class="card"><h3>Active Bots</h3>
<div style="display:flex;gap:16px;margin-bottom:8px">
<div><span class="stat" style="font-size:20px" id="botsOnline">0</span><span class="sub"> online</span></div>
<div><span class="stat" style="font-size:20px" id="botsScanning">0</span><span class="sub"> scanning</span></div>
<div><span class="stat" style="font-size:20px" id="joinersCount">0</span><span class="sub"> joiners</span></div>
</div>
<table><thead><tr><th>Bot</th><th>Status</th><th>Server</th><th>Finds</th><th>Last Seen</th></tr></thead>
<tbody id="botTable"></tbody></table></div>

<div class="card"><h3>Live Feed</h3><div id="liveFeed" style="max-height:400px;overflow-y:auto"></div></div>

<div class="card"><h3>Duels Detected</h3><div id="duelFeed" style="max-height:300px;overflow-y:auto">
<div class="sub">No duels detected yet</div></div></div>

<div class="card"><h3>Find Rate (per hour)</h3><div id="findRateChart"></div></div>

<div class="card"><h3>Bot Leaderboard</h3><table><thead><tr><th>Bot</th><th>Finds</th></tr></thead>
<tbody id="leaderboard"></tbody></table></div>

<div class="card"><h3>Dedup Stats</h3>
<div><span class="stat" style="font-size:18px" id="dedupBlocked">0</span><span class="sub"> alerts deduplicated</span></div>
<div style="margin-top:6px"><span class="stat" style="font-size:18px" id="activeServers">0</span><span class="sub"> unique servers (last 50 alerts)</span></div>
</div>
</div>

<script>
let ws;
function connectWS(){
    const proto=location.protocol==='https:'?'wss':'ws';
    ws=new WebSocket(proto+'://'+location.host+'/ws');
    ws.onopen=()=>{document.getElementById('wsStatus').innerHTML='<span class="ws-dot ws-on"></span>Live';};
    ws.onclose=()=>{document.getElementById('wsStatus').innerHTML='<span class="ws-dot ws-off"></span>Reconnecting...';setTimeout(connectWS,3000);};
    ws.onmessage=(e)=>{
        const msg=JSON.parse(e.data);
        if(msg.type==='alert'){addLiveFeedEntry(msg.alert);fetchDashboard();}
        if(msg.type==='fleet_update'){if(msg.paused!==undefined)document.getElementById('pausedBanner').style.display=msg.paused?'block':'none';}
    };
}
connectWS();

function addLiveFeedEntry(a){
    const feed=document.getElementById('liveFeed');
    const cls=a.priority===1?'t1':a.priority===2?'t2':'';
    const badges=[];
    if(a.hasDuelAnimals)badges.push('<span class="badge duel">DUEL</span>');
    if(a.hasCarpetAnimals)badges.push('<span class="badge carpet">CARPET</span>');
    if(a.mutations&&a.mutations.length)a.mutations.forEach(m=>badges.push('<span class="badge" style="background:#2a1a3a;color:#c090ff">'+m+'</span>'));
    const el=document.createElement('div');
    el.className='feed-entry '+cls;
    el.innerHTML='<div style="display:flex;justify-content:space-between"><b>'+a.brainrotName+'</b><span style="color:#32d25a">$'+a.value+'/s</span></div>'
        +'<div class="sub">'+a.botId+' | '+a.players+'/8 | '+a.serverId?.slice(0,8)+' '+badges.join(' ')+'</div>';
    feed.insertBefore(el,feed.firstChild);
    while(feed.children.length>30)feed.removeChild(feed.lastChild);
}

async function fetchDashboard(){
    try{
        const r=await fetch('/dashboard/data');const d=await r.json();
        document.getElementById('totalFinds').textContent=d.alerts.total;
        document.getElementById('t1Finds').textContent=d.analytics.findsByTier[1]||0;
        document.getElementById('t2Finds').textContent=d.analytics.findsByTier[2]||0;
        document.getElementById('t3Finds').textContent=d.analytics.findsByTier[3]||0;
        document.getElementById('duelCount').textContent=d.analytics.duelsDetected;
        document.getElementById('carpetCount').textContent=d.analytics.carpetFinds;
        document.getElementById('plotCount').textContent=d.analytics.plotFinds;
        document.getElementById('botsOnline').textContent=d.bots.online;
        document.getElementById('botsScanning').textContent=d.bots.scanning;
        document.getElementById('joinersCount').textContent=d.joiners.connected;
        document.getElementById('dedupBlocked').textContent=d.alerts.dedupBlocked;
        document.getElementById('activeServers').textContent=d.analytics.activeServers;
        document.getElementById('pausedBanner').style.display=d.fleet.paused?'block':'none';
        // Bot table
        const bt=document.getElementById('botTable');bt.innerHTML='';
        d.bots.details.forEach(b=>{
            const sc=b.status==='scanning'?'scanning':b.status==='stale'?'stale':b.status==='idle'?'online':'offline';
            bt.innerHTML+='<tr><td>'+b.username+'</td><td class="'+sc+'">'+b.status+'</td><td>'+(b.job_id?.slice(0,8)||'-')+'</td><td>'+b.finds+'</td><td>'+b.last_seen_ago+'</td></tr>';
        });
        // Duels
        const df=document.getElementById('duelFeed');
        if(d.duels.recent.length){df.innerHTML='';d.duels.recent.forEach(du=>{
            df.innerHTML+='<div class="feed-entry" style="border-left-color:#ff4060"><b>'+du.brainrotName+'</b> <span class="badge duel">DUEL</span><div class="sub">Animals: '+(du.duelAnimals||[]).join(', ')+' | Server: '+du.serverId+' | '+du.age+' ago</div></div>';
        });}
        // Find rate chart
        const fc=document.getElementById('findRateChart');fc.innerHTML='';
        const maxRate=Math.max(...d.analytics.findRate.map(h=>h.count),1);
        d.analytics.findRate.forEach(h=>{
            const pct=Math.round(h.count/maxRate*100);
            fc.innerHTML+='<div style="display:flex;align-items:center;gap:8px"><span class="sub" style="width:40px">'+h.hour.slice(11)+'h</span><div class="chart-bar" style="width:'+pct+'%"></div><span class="sub">'+h.count+'</span></div>';
        });
        // Leaderboard
        const lb=document.getElementById('leaderboard');lb.innerHTML='';
        d.analytics.leaderboard.forEach(l=>{lb.innerHTML+='<tr><td>'+l.bot+'</td><td>'+l.finds+'</td></tr>';});
        // Live feed (initial populate)
        if(!document.getElementById('liveFeed').children.length){
            d.alerts.recent.forEach(a=>addLiveFeedEntry(a));
        }
    }catch(e){console.error(e);}
}
fetchDashboard();
setInterval(fetchDashboard,10000);
</script></body></html>`);
});

// ═══════════════════════════════════════════════════════════════════
// DISCORD BOT — Comprehensive fleet management
// ═══════════════════════════════════════════════════════════════════

let discordReady = false;
let discordClient = null;

function formatNum(n) {
    if (!n || isNaN(n)) return '0';
    n = parseFloat(n.toString().replace(/[^0-9.]/g, ''));
    if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
    return Math.floor(n).toString();
}

async function sendDiscordAlert(alert) {
    if (!discordClient || !DISCORD_ALERT_CHANNEL) return;
    try {
        const channel = await discordClient.channels.fetch(DISCORD_ALERT_CHANNEL);
        if (!channel) return;

        const tierColors = { 1: 0xff4060, 2: 0xffc340, 3: 0x50d080 };
        const tierNames = { 1: 'LEGENDARY', 2: 'RARE', 3: 'VALUABLE' };

        const embed = new EmbedBuilder()
            .setTitle(`${tierNames[alert.priority] || 'FIND'}: ${alert.brainrotName}`)
            .setColor(tierColors[alert.priority] || 0xeb8c0f)
            .addFields(
                { name: 'Value', value: `$${alert.value}/s`, inline: true },
                { name: 'Players', value: `${alert.players}/8`, inline: true },
                { name: 'Server', value: alert.serverId?.slice(0, 12) || '?', inline: true },
                { name: 'Bot', value: alert.botId || '?', inline: true },
            )
            .setTimestamp();

        if (alert.hasDuelAnimals) embed.addFields({ name: 'Duels', value: alert.duelAnimals.join(', '), inline: false });
        if (alert.mutations?.length) embed.addFields({ name: 'Mutations', value: alert.mutations.join(', '), inline: true });
        if (alert.hasCarpetAnimals) embed.setFooter({ text: 'Found on carpet' });

        if (alert.brainrots?.length > 1) {
            const list = alert.brainrots.slice(0, 8).map(b =>
                `• ${b.name} ($${formatNum(b.generation)}/s)${b.inDuel ? ' 🗡️' : ''}${b.mutation ? ` [${b.mutation}]` : ''}`
            ).join('\n');
            embed.addFields({ name: `All Brainrots (${alert.total_found})`, value: list, inline: false });
        }

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[DISCORD] Alert send failed:', err.message);
    }
}

if (DISCORD_TOKEN) {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    const commands = [
        new SlashCommandBuilder().setName('status').setDescription('Fleet overview — bots, finds, uptime'),
        new SlashCommandBuilder().setName('bots').setDescription('List all active bots with details'),
        new SlashCommandBuilder().setName('finds').setDescription('Recent finds with full details')
            .addIntegerOption(o => o.setName('limit').setDescription('How many (default 10)').setRequired(false)),
        new SlashCommandBuilder().setName('top').setDescription('Top finds by value today'),
        new SlashCommandBuilder().setName('duels').setDescription('Animals currently detected in duels'),
        new SlashCommandBuilder().setName('pause').setDescription('Pause entire fleet (scanners stop reporting)'),
        new SlashCommandBuilder().setName('resume').setDescription('Resume fleet'),
        new SlashCommandBuilder().setName('hop-all').setDescription('Signal all bots to hop servers'),
        new SlashCommandBuilder().setName('set-min-value').setDescription('Set global minimum value threshold')
            .addStringOption(o => o.setName('value').setDescription('e.g. 50M, 100M, 1B').setRequired(true)),
        new SlashCommandBuilder().setName('stats').setDescription('Detailed analytics — find rates, dedup, leaderboard'),
        new SlashCommandBuilder().setName('watchlist').setDescription('Manage priority watchlist')
            .addSubcommand(s => s.setName('add').setDescription('Add animal').addStringOption(o => o.setName('name').setDescription('Animal name').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove animal').addStringOption(o => o.setName('name').setDescription('Animal name').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('Show current watchlist'))
            .addSubcommand(s => s.setName('clear').setDescription('Clear entire watchlist')),
        new SlashCommandBuilder().setName('blacklist').setDescription('Manage ignore list')
            .addSubcommand(s => s.setName('add').setDescription('Block animal').addStringOption(o => o.setName('name').setDescription('Animal name').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Unblock animal').addStringOption(o => o.setName('name').setDescription('Animal name').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('Show blacklist'))
            .addSubcommand(s => s.setName('clear').setDescription('Clear blacklist')),
        new SlashCommandBuilder().setName('servers').setDescription('Show currently active servers being scanned'),
        new SlashCommandBuilder().setName('clear-alerts').setDescription('Clear all stored alerts'),
        new SlashCommandBuilder().setName('config').setDescription('Show current fleet configuration'),
        new SlashCommandBuilder().setName('uptime').setDescription('Fleet uptime and health'),
        new SlashCommandBuilder().setName('leaderboard').setDescription('Bot find leaderboard'),
        new SlashCommandBuilder().setName('joiners').setDescription('Show connected joiner clients'),
        new SlashCommandBuilder().setName('search').setDescription('Search finds by animal name')
            .addStringOption(o => o.setName('name').setDescription('Animal name to search').setRequired(true)),
        new SlashCommandBuilder().setName('carpet').setDescription('Recent carpet finds'),
        new SlashCommandBuilder().setName('dedup-stats').setDescription('Alert deduplication statistics'),
    ];

    discordClient.on('ready', async () => {
        console.log(`[DISCORD] Bot ready: ${discordClient.user.tag}`);
        discordReady = true;
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
        try {
            await rest.put(Routes.applicationCommands(discordClient.user.id), { body: commands.map(c => c.toJSON()) });
            console.log('[DISCORD] Slash commands registered');
        } catch (err) { console.error('[DISCORD] Command registration failed:', err.message); }
    });

    discordClient.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        try {
            if (commandName === 'status') {
                const online = Array.from(state.bots.values()).filter(b => b.status !== 'stale').length;
                const scanning = Array.from(state.bots.values()).filter(b => b.scanning).length;
                const uptimeH = ((Date.now() - state.startTime) / 3600000).toFixed(1);
                const embed = new EmbedBuilder().setTitle('Fleet Status').setColor(0xeb8c0f)
                    .addFields(
                        { name: 'Status', value: state.paused ? '⏸️ PAUSED' : '▶️ Running', inline: true },
                        { name: 'Bots', value: `${online} online / ${scanning} scanning`, inline: true },
                        { name: 'Joiners', value: `${state.joiners.size} connected`, inline: true },
                        { name: 'Total Finds', value: `${state.totalFinds}`, inline: true },
                        { name: 'T1/T2/T3', value: `${state.findsByTier[1]||0} / ${state.findsByTier[2]||0} / ${state.findsByTier[3]||0}`, inline: true },
                        { name: 'Duels', value: `${state.duelsDetected} detected`, inline: true },
                        { name: 'Carpet/Plot', value: `${state.carpetFinds} / ${state.plotFinds}`, inline: true },
                        { name: 'Dedup Blocked', value: `${state.dedupBlocked}`, inline: true },
                        { name: 'Uptime', value: `${uptimeH}h`, inline: true },
                    ).setTimestamp();
                await interaction.reply({ embeds: [embed] });
            }
            else if (commandName === 'bots') {
                const bots = Array.from(state.bots.entries());
                if (!bots.length) return interaction.reply('No bots registered.');
                const desc = bots.map(([id, b]) => {
                    const icon = b.status === 'scanning' ? '🟢' : b.status === 'stale' ? '🔴' : '🟡';
                    return `${icon} **${b.username || id}** | ${b.status} | Server: \`${b.job_id?.slice(0,8)||'-'}\` | Finds: ${b.finds||0} | Last: ${Math.floor((Date.now()-(b.last_seen||0))/1000)}s ago`;
                }).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Active Bots').setDescription(desc).setColor(0xeb8c0f)] });
            }
            else if (commandName === 'finds') {
                const limit = interaction.options.getInteger('limit') || 10;
                const finds = state.alerts.slice(0, limit);
                if (!finds.length) return interaction.reply('No finds yet.');
                const desc = finds.map(a => {
                    const tags = [];
                    if (a.hasDuelAnimals) tags.push('🗡️');
                    if (a.hasCarpetAnimals) tags.push('🧶');
                    return `**${a.brainrotName}** $${a.value}/s | ${a.players}/8 | \`${a.serverId?.slice(0,8)}\` | P${a.priority} ${tags.join('')}`;
                }).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Recent Finds (${finds.length})`).setDescription(desc).setColor(0xeb8c0f)] });
            }
            else if (commandName === 'top') {
                const sorted = [...state.alerts].sort((a, b) => {
                    const va = parseFloat(a.value?.toString().replace(/[^0-9.]/g, '') || '0');
                    const vb = parseFloat(b.value?.toString().replace(/[^0-9.]/g, '') || '0');
                    return vb - va;
                }).slice(0, 10);
                const desc = sorted.map((a, i) => `**${i+1}.** ${a.brainrotName} — $${a.value}/s | P${a.priority}`).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Top Finds').setDescription(desc || 'None').setColor(0xffc340)] });
            }
            else if (commandName === 'duels') {
                const duels = state.alerts.filter(a => a.hasDuelAnimals).slice(0, 15);
                if (!duels.length) return interaction.reply('No duel animals detected.');
                const desc = duels.map(a => `🗡️ **${a.brainrotName}** — Dueling: ${a.duelAnimals?.join(', ')||'?'} | \`${a.serverId?.slice(0,8)}\``).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Duel Detections').setDescription(desc).setColor(0xff4060)] });
            }
            else if (commandName === 'pause') {
                state.paused = true;
                broadcastToJoiners({ type: 'fleet_update', paused: true });
                await interaction.reply('⏸️ Fleet **paused**. Scanners will stop reporting.');
            }
            else if (commandName === 'resume') {
                state.paused = false;
                broadcastToJoiners({ type: 'fleet_update', paused: false });
                await interaction.reply('▶️ Fleet **resumed**.');
            }
            else if (commandName === 'hop-all') {
                broadcastToJoiners({ type: 'command', action: 'hop-all' });
                await interaction.reply('🚀 Hop signal sent to all bots.');
            }
            else if (commandName === 'set-min-value') {
                const raw = interaction.options.getString('value');
                let val = parseFloat(raw.replace(/[^0-9.]/g, ''));
                if (raw.toLowerCase().includes('b')) val *= 1e9;
                else if (raw.toLowerCase().includes('m')) val *= 1e6;
                else if (raw.toLowerCase().includes('k')) val *= 1e3;
                state.globalMinValue = val;
                broadcastToJoiners({ type: 'fleet_update', globalMinValue: val });
                await interaction.reply(`✅ Global min value set to **$${formatNum(val)}/s**`);
            }
            else if (commandName === 'stats') {
                const uptimeH = ((Date.now()-state.startTime)/3600000).toFixed(1);
                const rate = state.totalFinds / Math.max(parseFloat(uptimeH), 0.1);
                const leaderboard = Array.from(state.findsByBot.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([b,c])=>`${b}: ${c}`).join('\n');
                const embed = new EmbedBuilder().setTitle('Fleet Analytics').setColor(0xeb8c0f)
                    .addFields(
                        { name: 'Find Rate', value: `${rate.toFixed(1)}/hour`, inline: true },
                        { name: 'Dedup Blocked', value: `${state.dedupBlocked}`, inline: true },
                        { name: 'Carpet/Plot', value: `${state.carpetFinds}/${state.plotFinds}`, inline: true },
                    )
                    .addFields({ name: 'Top Bots', value: leaderboard || 'None', inline: false });
                await interaction.reply({ embeds: [embed] });
            }
            else if (commandName === 'watchlist') {
                const sub = interaction.options.getSubcommand();
                if (sub === 'add') { const n=interaction.options.getString('name'); if(!state.watchlist.includes(n))state.watchlist.push(n); await interaction.reply(`✅ **${n}** added to watchlist`); }
                else if (sub === 'remove') { const n=interaction.options.getString('name'); state.watchlist=state.watchlist.filter(x=>x!==n); await interaction.reply(`✅ **${n}** removed`); }
                else if (sub === 'list') { await interaction.reply(state.watchlist.length?`**Watchlist:** ${state.watchlist.join(', ')}`:'Watchlist is empty.'); }
                else if (sub === 'clear') { state.watchlist=[]; await interaction.reply('✅ Watchlist cleared'); }
            }
            else if (commandName === 'blacklist') {
                const sub = interaction.options.getSubcommand();
                if (sub === 'add') { const n=interaction.options.getString('name'); if(!state.blacklist.includes(n))state.blacklist.push(n); await interaction.reply(`🚫 **${n}** blacklisted`); }
                else if (sub === 'remove') { const n=interaction.options.getString('name'); state.blacklist=state.blacklist.filter(x=>x!==n); await interaction.reply(`✅ **${n}** removed`); }
                else if (sub === 'list') { await interaction.reply(state.blacklist.length?`**Blacklist:** ${state.blacklist.join(', ')}`:'Blacklist is empty.'); }
                else if (sub === 'clear') { state.blacklist=[]; await interaction.reply('✅ Blacklist cleared'); }
            }
            else if (commandName === 'servers') {
                const servers = new Map();
                state.alerts.slice(0, 50).forEach(a => { if (!servers.has(a.serverId)) servers.set(a.serverId, a); });
                const desc = Array.from(servers.values()).slice(0, 10).map(a => `\`${a.serverId?.slice(0,12)}\` | ${a.players}/8 | Last: ${a.brainrotName}`).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Active Servers (${servers.size})`).setDescription(desc||'None').setColor(0xeb8c0f)] });
            }
            else if (commandName === 'clear-alerts') { state.alerts=[]; broadcastToJoiners({type:'alerts_cleared'}); await interaction.reply('🗑️ Alerts cleared.'); }
            else if (commandName === 'config') {
                const embed = new EmbedBuilder().setTitle('Fleet Config').setColor(0xeb8c0f)
                    .addFields(
                        { name: 'Paused', value: state.paused?'Yes':'No', inline: true },
                        { name: 'Min Value', value: `$${formatNum(state.globalMinValue)}/s`, inline: true },
                        { name: 'Watchlist', value: state.watchlist.length?state.watchlist.join(', '):'None', inline: false },
                        { name: 'Blacklist', value: state.blacklist.length?state.blacklist.join(', '):'None', inline: false },
                    );
                await interaction.reply({ embeds: [embed] });
            }
            else if (commandName === 'uptime') {
                const ms = Date.now()-state.startTime;
                const h=Math.floor(ms/3600000); const m=Math.floor((ms%3600000)/60000);
                await interaction.reply(`⏱️ Fleet uptime: **${h}h ${m}m** | Bots: ${state.bots.size} | Finds: ${state.totalFinds}`);
            }
            else if (commandName === 'leaderboard') {
                const lb = Array.from(state.findsByBot.entries()).sort((a,b)=>b[1]-a[1]).slice(0,15);
                const desc = lb.map(([b,c],i)=>`**${i+1}.** ${b} — ${c} finds`).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Bot Leaderboard').setDescription(desc||'No data').setColor(0xffc340)] });
            }
            else if (commandName === 'joiners') { await interaction.reply(`📱 **${state.joiners.size}** joiner clients connected via WebSocket`); }
            else if (commandName === 'search') {
                const name = interaction.options.getString('name').toLowerCase();
                const matches = state.alerts.filter(a => a.brainrotName?.toLowerCase().includes(name)).slice(0, 10);
                if (!matches.length) return interaction.reply(`No finds matching "${name}"`);
                const desc = matches.map(a => `**${a.brainrotName}** $${a.value}/s | P${a.priority} | \`${a.serverId?.slice(0,8)}\``).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Search: "${name}"`).setDescription(desc).setColor(0xeb8c0f)] });
            }
            else if (commandName === 'carpet') {
                const carpets = state.alerts.filter(a => a.hasCarpetAnimals).slice(0, 10);
                if (!carpets.length) return interaction.reply('No carpet finds.');
                const desc = carpets.map(a => `🧶 **${a.brainrotName}** $${a.value}/s | \`${a.serverId?.slice(0,8)}\``).join('\n');
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Carpet Finds').setDescription(desc).setColor(0x40a0ff)] });
            }
            else if (commandName === 'dedup-stats') {
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Dedup Stats').setColor(0xeb8c0f)
                    .addFields(
                        { name: 'Alerts Blocked', value: `${state.dedupBlocked}`, inline: true },
                        { name: 'Dedup Window', value: `${DEDUP_WINDOW/1000}s`, inline: true },
                        { name: 'Active Keys', value: `${state.dedupMap.size}`, inline: true },
                    )] });
            }
        } catch (err) {
            console.error('[DISCORD CMD ERROR]', err);
            await interaction.reply({ content: 'Error: ' + err.message, ephemeral: true }).catch(() => {});
        }
    });

    discordClient.login(DISCORD_TOKEN).catch(err => console.error('[DISCORD] Login failed:', err.message));
} else {
    console.log('[DISCORD] No DISCORD_TOKEN set — bot disabled');
}

// ═══════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - state.startTime) / 1000),
        bots: state.bots.size,
        joiners: state.joiners.size,
        alerts: state.alerts.length,
        totalFinds: state.totalFinds,
        paused: state.paused,
        discord: discordReady,
    });
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log(`  BRAINROT FLEET BACKEND v2.0`);
    console.log(`  HTTP + WebSocket on port ${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`  Discord: ${DISCORD_TOKEN ? 'enabled' : 'disabled'}`);
    console.log('═══════════════════════════════════════════');
});
