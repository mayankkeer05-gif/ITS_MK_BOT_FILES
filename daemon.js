'use strict';
/* MK Bot - background daemon. Bot ko chalata rehta hai, menu band ho jaye tab bhi.
   Made by its_mk_playa */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PORT = Number(process.env.MKBOT_PORT) || 47800;
const CFG = process.env.MKBOT_CONFIG || path.join(__dirname, 'config.json');
const HEAP_MB = Number(process.env.MKBOT_HEAP_MB) || 160;

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    return {
      host: String(c.host || '').trim(),
      port: Number(c.port) || 25565,
      name: String(c.name || '').trim(),
      authPassword: String(c.authPassword || ''),
    };
  } catch (_) {
    return { host: '', port: 25565, name: '', authPassword: '' };
  }
}

// ---------- logs ----------
let seq = 0;
const logs = [];
function addLog(lvl, msg) {
  logs.push({ id: ++seq, t: Date.now(), lvl, msg: String(msg) });
  if (logs.length > 300) logs.shift();
}

// ---------- worker control ----------
let child = null;
let want = true;
let status = { state: 'idle' };
let respawnT = null;

function start() {
  if (child || !want) return;
  clearTimeout(respawnT);
  const cfg = loadCfg();
  if (!cfg.host || !NAME_RE.test(cfg.name)) {
    status = { state: 'not-configured' };
    addLog('warn', 'Pehle Settings (menu 2) me Server IP, Port aur Bot Name set karo.');
    return;
  }
  let c;
  try {
    c = fork(path.join(__dirname, 'worker.js'), [], {
      execArgv: ['--expose-gc', `--max-old-space-size=${HEAP_MB}`],
      env: { ...process.env, BOT_CONFIG: JSON.stringify(cfg) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
  } catch (e) {
    addLog('error', `Worker start nahi hua: ${e.message}`);
    respawnT = setTimeout(start, 5000);
    return;
  }
  child = c;
  status = { state: 'connecting' };
  let lastErr = '';
  c.stderr.on('data', (d) => (lastErr = (lastErr + d).slice(-400)));
  c.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'log') addLog(m.lvl || 'info', m.msg);
    else if (m.type === 'status') status = m.data;
  });
  c.on('error', (e) => addLog('error', `Worker error: ${e.message}`));
  c.once('exit', (code) => {
    if (child !== c) return;
    child = null;
    status = { state: 'idle' };
    if (!want) return;
    addLog('error', `Bot process band ho gaya (code ${code}) ${lastErr.trim().split('\n').pop() || ''} - 5s me restart`);
    respawnT = setTimeout(start, 5000);
  });
}

function stopWorker(then) {
  const c = child;
  clearTimeout(respawnT);
  if (!c) return then && then();
  c.removeAllListeners('exit');
  c.once('exit', () => {
    if (child === c) child = null;
    status = { state: 'idle' };
    then && then();
  });
  try {
    c.send({ type: 'shutdown' });
  } catch (_) {}
  setTimeout(() => {
    try {
      c.kill('SIGKILL');
    } catch (_) {}
  }, 3000);
}

// ---------- local control socket (127.0.0.1 only) ----------
function handle(req) {
  switch (req.op) {
    case 'tail': {
      const cfg = loadCfg();
      return {
        ok: true,
        seq,
        logs: logs.filter((l) => l.id > (Number(req.after) || 0)),
        status,
        running: want,
        cfg: { host: cfg.host, port: cfg.port, name: cfg.name, hasPassword: !!cfg.authPassword },
      };
    }
    case 'send':
      if (child) child.send({ type: 'send', text: String(req.text || '') });
      else addLog('warn', 'Bot abhi chalu nahi hai.');
      return { ok: true };
    case 'apply':
      want = true;
      addLog('info', 'Naye settings apply ho rahe hain...');
      stopWorker(start);
      return { ok: true };
    case 'start':
      want = true;
      start();
      return { ok: true };
    case 'stop':
      want = false;
      addLog('info', 'Bot stop kiya gaya.');
      stopWorker();
      return { ok: true };
    case 'quit':
      want = false;
      stopWorker(() => setTimeout(() => process.exit(0), 100));
      return { ok: true };
    default:
      return { ok: false, error: 'unknown op' };
  }
}

const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > 20000) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let out;
      try {
        out = handle(JSON.parse(line));
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      sock.write(JSON.stringify(out) + '\n');
    }
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0); // daemon pehle se chal raha hai
  console.error(e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  addLog('info', 'MK Bot started - made by its_mk_playa');
  start();
  if (process.stdout.isTTY) console.log(`MK Bot daemon chal raha hai (127.0.0.1:${PORT}). Menu ke liye: node cli.js`);
});

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { want = false; stopWorker(() => process.exit(0)); setTimeout(() => process.exit(0), 3500); });
