'use strict';
/**
 * worker.js - ek process = ek Minecraft bot.
 * Manager (manager.js) isse fork karta hai. Alag process hone se:
 *  - har bot ki RAM/CPU alag naapi ja sakti hai
 *  - ek bot crash ho to baaki bots par asar nahi padta
 *  - stop karne par us bot ki poori RAM free ho jaati hai
 */

const MOCK = process.env.MOCK_BOT === '1';
const mineflayer = MOCK ? require('./test/mock-mineflayer') : require('mineflayer');
const B = require('./behavior');

const cfg = JSON.parse(process.env.BOT_CONFIG || '{}');

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const send = (m) => {
  try {
    if (process.connected) process.send(m);
  } catch (_) {}
};

// ---------------- state ----------------
let wantRun = true;
let bot = null;
let online = false;
let planned = false; // planned leave (rest cycle)
let useNewest = false;
let throttled = false;
let attempts = 0;
let reconnects = 0;
let connectedAt = 0;
let nextLeaveAt = 0;
let rejoinAt = 0;
let state = 'connecting';
let version = '';
let quotaMB = 0;
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
let cpuPct = 0;
const sent = { register: false, login: false };

// ---------------- timers ----------------
const T = {};
function setT(name, fn, ms) {
  clearTimeout(T[name]);
  T[name] = setTimeout(() => {
    T[name] = null;
    try {
      fn();
    } catch (e) {
      log(`Timer "${name}" error: ${e.message}`, 'error');
    }
  }, ms);
}
function clearT(...names) {
  for (const n of names) {
    clearTimeout(T[n]);
    T[n] = null;
  }
}
function clearBehaviorTimers() {
  clearT('jump', 'jumpOff', 'look', 'leave', 'init', 'quitFallback');
}

// ---------------- helpers ----------------
function log(msg, lvl = 'info') {
  send({ type: 'log', lvl, msg: String(msg).slice(0, 600) });
}

function setState(s) {
  state = s;
  pushStatus();
}

function pushStatus() {
  const now = Date.now();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const dt = now - lastCpuAt;
  if (dt >= 1500) {
    const used = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000; // ms
    cpuPct = Math.min(100, (used / dt) * 100);
    lastCpu = cpu;
    lastCpuAt = now;
  }
  const e = bot && online ? bot.entity : null;
  const p = e && e.position;
  send({
    type: 'status',
    data: {
      state,
      version,
      connectedAt: online ? connectedAt : 0,
      nextLeaveAt: online ? nextLeaveAt : 0,
      rejoinAt: state === 'resting' || state === 'reconnecting' ? rejoinAt : 0,
      reconnects,
      pos: p && finite(p.x) && finite(p.y) && finite(p.z) ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
      health: online && finite(bot.health) ? Math.round(bot.health) : null,
      food: online && finite(bot.food) ? Math.round(bot.food) : null,
      players: online && bot.players ? Object.keys(bot.players).length : 0,
      ping: online && bot.player && finite(bot.player.ping) ? bot.player.ping : null,
      rssMB: +(mem.rss / 1048576).toFixed(1),
      heapMB: +(mem.heapUsed / 1048576).toFixed(1),
      cpu: +cpuPct.toFixed(1),
      quotaMB,
    },
  });
}

// Kick reason ko readable text me badalta hai (JSON chat component ho sakta hai)
function kickText(reason) {
  let v = reason;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (_) {
      return v;
    }
  }
  const out = [];
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string') return out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === 'object') {
      if (n.value !== undefined) walk(n.value); // NBT style
      if (n.text !== undefined) walk(n.text);
      if (n.translate) out.push(n.translate);
      if (n.extra) walk(n.extra);
      if (n.with) walk(n.with);
      if (n.type === 'compound' || n.type === 'list') walk(n.value);
    }
  };
  walk(v);
  const t = out.join('').replace(/§./g, '').trim();
  return t || (typeof reason === 'string' ? reason : JSON.stringify(reason));
}

function newestSupportedVersion() {
  const list = Array.isArray(mineflayer.supportedVersions) ? mineflayer.supportedVersions : [];
  if (!list.length) return undefined;
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  return list.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
}

// Invalid (NaN) movement packets ko server tak jaane se rokta hai
function installPacketGuard(b) {
  const client = b._client;
  if (!client || client.__guard) return;
  client.__guard = true;
  const MOVE = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move']);
  const raw = client.write.bind(client);
  let dropped = 0;
  client.write = (name, params) => {
    if (MOVE.has(name) && params) {
      const bad = ['x', 'y', 'z', 'yaw', 'pitch'].filter((k) => k in params && !Number.isFinite(params[k]));
      if (bad.length) {
        dropped++;
        if (dropped <= 3) log(`Guard: invalid '${name}' packet dropped (${bad.join(',')})`, 'warn');
        return;
      }
      if ('pitch' in params) params.pitch = Math.max(-90, Math.min(90, params.pitch));
    }
    return raw(name, params);
  };
}

function dispose(b) {
  if (!b) return;
  try {
    b.removeAllListeners();
    b.on('error', () => {});
    b.end();
  } catch (_) {}
}

// ---------------- connect / reconnect ----------------
function connect() {
  if (!wantRun) return;
  clearT('connect', 'reconnect');
  online = false;
  planned = false;
  rejoinAt = 0;
  setState('connecting');
  log(`Connecting to ${cfg.host}:${cfg.port} as ${cfg.name} ...`);

  let me;
  try {
    me = mineflayer.createBot({
      username: cfg.name,
      auth: 'offline',
      host: cfg.host,
      port: cfg.port,
      version: useNewest ? newestSupportedVersion() : undefined,
      hideErrors: true,
      checkTimeoutInterval: 120000,
      viewDistance: 'tiny', // chunks kam -> RAM kam
    });
  } catch (e) {
    log(`Failed to create bot: ${e.message}`, 'error');
    scheduleReconnect('create-error');
    return;
  }
  bot = me;
  sent.register = sent.login = false;
  installPacketGuard(me);

  // Aternos server start hone me 1-2 min le sakta hai
  setT(
    'connect',
    () => {
      if (bot === me && !online) {
        log('Connection timeout (spawn nahi hua)', 'warn');
        dropBot(me);
        scheduleReconnect('timeout');
      }
    },
    150000,
  );

  me.once('spawn', () => onSpawn(me));

  me.on('messagestr', (message, position) => {
    if (bot !== me || position === 'game_info') return;
    const text = String(message).replace(/§./g, '').trim();
    if (!text) return;
    log(text, 'chat');
    handleAuthPrompt(me, text);
  });

  me.on('kicked', (reason) => {
    if (bot !== me) return;
    const text = kickText(reason);
    log(`Kicked: ${text}`, 'error');
    const low = text.toLowerCase();
    if (low.includes('throttl') || low.includes('wait before reconnect') || low.includes('too fast')) {
      throttled = true;
      log('Throttle detect hua - lamba wait karunga', 'warn');
    }
  });

  me.on('end', (reason) => handleEnd(me, reason));

  me.on('error', (err) => {
    if (bot !== me) return;
    const msg = (err && err.message) || String(err);
    log(`Error: ${msg}`, 'error');
    if (!useNewest && /unsupported|not supported|no data for|unknown version/i.test(msg)) {
      useNewest = true;
      log('Server version mineflayer me supported nahi - agli baar newest supported version use hoga', 'warn');
    }
    // 'end' event iske baad aata hai aur reconnect wahi handle karta hai
  });

  me.on('death', () => {
    if (bot === me) log('Bot mar gaya - respawn ho raha hai', 'warn');
  });
}

function dropBot(me) {
  if (bot === me) bot = null;
  online = false;
  clearBehaviorTimers();
  dispose(me);
}

function handleEnd(me, reason) {
  if (bot !== me) return;
  const wasOnline = online;
  const wasPlanned = planned;
  online = false;
  bot = null;
  clearT('connect');
  clearBehaviorTimers();
  nextLeaveAt = 0;
  if (connectedAt && Date.now() - connectedAt > 60000) attempts = 0;
  connectedAt = 0;
  setImmediate(() => dispose(me));

  if (!wantRun) return;

  if (wasPlanned) {
    planned = false;
    attempts = 0;
    const away = rand(B.AWAY_MIN, B.AWAY_MAX);
    rejoinAt = Date.now() + away;
    setState('resting');
    log(`Rest: ${Math.round(away / 1000)}s baad wapas join karunga`, 'info');
    setT('reconnect', connect, away);
    return;
  }

  log(`Disconnected: ${reason || 'unknown'}${wasOnline ? '' : ' (join nahi ho paya)'}`, 'warn');
  scheduleReconnect('end');
}

function scheduleReconnect(why) {
  if (!wantRun || T.reconnect) return;
  attempts++;
  reconnects++;
  let delay;
  if (throttled) {
    throttled = false;
    delay = rand(60000, 120000);
  } else {
    delay = Math.min(B.RECONNECT_BASE * 2 ** Math.min(attempts - 1, 6), B.RECONNECT_MAX) + rand(0, 2000);
  }
  rejoinAt = Date.now() + delay;
  setState('reconnecting');
  log(`Auto-reconnect ${Math.round(delay / 1000)}s me (attempt #${attempts}, ${why})`, 'info');
  setT('reconnect', connect, delay);
}

// ---------------- after spawn ----------------
function onSpawn(me) {
  if (bot !== me) return;
  clearT('connect');
  online = true;
  connectedAt = Date.now();
  version = me.version || '';
  setState('online');
  log(`Server par join ho gaya! (version ${version})`, 'ok');

  const stay = rand(B.STAY_MIN, B.STAY_MAX);
  nextLeaveAt = Date.now() + stay;
  setT('leave', () => doRest(me), stay);
  log(`Rest cycle: ${(stay / 60000).toFixed(1)} min baad thodi der ke liye leave karunga`);

  // World load hone ka thoda wait, phir anti-AFK start
  setT(
    'init',
    () => {
      if (bot !== me || !online) return;
      scheduleJump(me);
      scheduleLook(me);
    },
    4000,
  );
}

function doRest(me) {
  if (bot !== me || !online) return;
  planned = true;
  nextLeaveAt = 0;
  clearT('jump', 'jumpOff', 'look');
  try {
    me.setControlState('jump', false);
  } catch (_) {}
  log('Rest time: server se leave kar raha hoon');
  try {
    me.quit('Leaving');
  } catch (_) {
    planned = false;
  }
  // agar 'end' event nahi aaya to khud handle karo
  setT('quitFallback', () => {
    if (bot === me) handleEnd(me, 'quit');
  }, 5000);
}

function scheduleJump(me) {
  setT(
    'jump',
    () => {
      if (bot !== me || !online) return;
      try {
        me.setControlState('jump', true);
        setT('jumpOff', () => {
          try {
            me.setControlState('jump', false);
          } catch (_) {}
        }, rand(220, 380));
      } catch (_) {}
      scheduleJump(me);
    },
    rand(B.JUMP_MIN, B.JUMP_MAX),
  );
}

function scheduleLook(me) {
  setT(
    'look',
    () => {
      if (bot !== me || !online) return;
      try {
        const e = me.entity;
        if (e && finite(e.yaw)) {
          const yaw = e.yaw + (Math.random() - 0.5) * 1.6;
          const pitch = (Math.random() - 0.5) * 0.6;
          if (finite(yaw) && finite(pitch)) {
            const p = me.look(yaw, pitch, false);
            if (p && p.catch) p.catch(() => {});
          }
        }
      } catch (_) {}
      scheduleLook(me);
    },
    rand(B.LOOK_MIN, B.LOOK_MAX),
  );
}

// Cracked servers (AuthMe etc.) ke liye auto /register /login
function handleAuthPrompt(me, text) {
  if (!cfg.authPassword || /^<[^>]+>/.test(text)) return;
  const low = text.toLowerCase();
  const pw = cfg.authPassword;
  if (!sent.register && (low.includes('/register') || low.includes('please register'))) {
    sent.register = true;
    setTimeout(() => {
      if (bot === me && online) {
        me.chat(`/register ${pw} ${pw}`);
        log('Auth: /register bheja');
      }
    }, rand(800, 1800));
  } else if (!sent.login && (low.includes('/login') || low.includes('please login') || low.includes('please log in'))) {
    sent.login = true;
    setTimeout(() => {
      if (bot === me && online) {
        me.chat(`/login ${pw}`);
        log('Auth: /login bheja');
      }
    }, rand(800, 1800));
  }
}

// ---------------- commands from dashboard ----------------
function handleSend(text) {
  const me = bot;
  const msg = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!msg) return;
  if (!me || !online) {
    log('Bot abhi server par online nahi hai - message nahi gaya', 'warn');
    return;
  }
  log(`> ${msg}`, 'cmd');
  try {
    if (msg.startsWith('/')) {
      me.chat(msg.slice(0, 256));
    } else {
      for (let i = 0; i < msg.length; i += 250) me.chat(msg.slice(i, i + 250));
    }
  } catch (e) {
    log(`Send error: ${e.message}`, 'error');
  }
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'send') handleSend(m.text);
  else if (m.type === 'quota') {
    quotaMB = Number(m.mb) || 0;
    const rss = process.memoryUsage().rss / 1048576;
    if (quotaMB && rss > quotaMB * 0.85 && typeof global.gc === 'function') {
      try {
        global.gc();
      } catch (_) {}
    }
  } else if (m.type === 'shutdown') {
    wantRun = false;
    clearT('connect', 'reconnect');
    clearBehaviorTimers();
    try {
      if (bot) bot.quit('Stopped');
    } catch (_) {}
    setTimeout(() => process.exit(0), 400);
  }
});

process.on('disconnect', () => process.exit(0)); // manager chala gaya

process.on('uncaughtException', (err) => {
  log(`Uncaught: ${err && err.message}`, 'error');
  if (wantRun && !T.reconnect) {
    if (bot) dropBot(bot);
    scheduleReconnect('crash');
  }
});
process.on('unhandledRejection', (r) => log(`Rejection: ${r && r.message ? r.message : r}`, 'warn'));

setInterval(pushStatus, 2000);
log('Worker started');
connect();
