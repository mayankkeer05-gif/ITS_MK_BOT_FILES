'use strict';
/* MK Bot - terminal menu. 1 = Console, 2 = Settings.   Made by its_mk_playa */
const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const PORT = Number(process.env.MKBOT_PORT) || 47800;
const CFG = process.env.MKBOT_CONFIG || path.join(__dirname, 'config.json');
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const col = { ok: 32, error: 31, warn: 33, chat: 36, cmd: 35, info: 37 };

// ---------- daemon rpc ----------
function rpc(req, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1');
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeout);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(t);
        s.destroy();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function ensureDaemon() {
  try { return await rpc({ op: 'tail', after: 0 }); } catch (_) {}
  const p = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  p.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { return await rpc({ op: 'tail', after: 0 }); } catch (_) {}
  }
  throw new Error('Background bot start nahi hua (node daemon.js manually chalao)');
}

// ---------- input helpers ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let waiter = null;
let inConsole = false;
rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } });
rl.on('close', () => { console.log('\nBye! Bot background me chalta rahega.'); process.exit(0); });
rl.on('SIGINT', () => {
  if (inConsole && waiter) { const w = waiter; waiter = null; w(':q'); }
  else { console.log('\nBye! Bot background me chalta rahega.'); process.exit(0); }
});
function ask(q) {
  return new Promise((res) => { waiter = res; rl.setPrompt(q); rl.prompt(); });
}

// ---------- ui ----------
function banner() {
  if (TTY) console.clear();
  console.log(c(36, '  ╔════════════════════════════════════╗'));
  console.log(c(36, '  ║') + c('1;97', '      MK BOT  •  Minecraft AFK      ') + c(36, '║'));
  console.log(c(36, '  ║') + c(33, '        made by its_mk_playa        ') + c(36, '║'));
  console.log(c(36, '  ╚════════════════════════════════════╝'));
}
const STATE = {
  online: ['● Online', 32], connecting: ['● Connecting...', 33], reconnecting: ['● Reconnecting...', 33],
  resting: ['● Resting (rejoin soon)', 33], idle: ['● Stopped', 31], 'not-configured': ['● Settings baaki hain', 31],
};
function statusLine(r) {
  const st = (r.status && r.status.state) || 'idle';
  const [label, code] = STATE[st] || [st, 37];
  const who = r.cfg.host ? `${r.cfg.name} @ ${r.cfg.host}:${r.cfg.port}` : 'server set nahi hai';
  const pl = r.status && r.status.players ? `  players: ${r.status.players}` : '';
  return `  ${c(code, label)}  ${who}${pl}${r.running ? '' : c(31, '  [stopped]')}`;
}
function fmt(l) {
  const t = new Date(l.t).toTimeString().slice(0, 8);
  return `${c(90, t)} ${c(col[l.lvl] || 37, l.msg)}`;
}
function emit(text) {
  if (process.stdout.isTTY) { readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0); }
  console.log(text);
  if (inConsole) rl.prompt(true);
}

// ---------- screens ----------
async function consoleScreen() {
  inConsole = true;
  banner();
  console.log(c(90, '  Console: kuch bhi likho = chat/command (jaise /op naam)   |   :s status   |   :q wapas menu (ya Ctrl+C)\n'));
  let after = 0;
  let warned = false;
  let first = true;
  const poll = async () => {
    try {
      const r = await rpc({ op: 'tail', after });
      warned = false;
      let list = r.logs;
      if (first) { list = list.slice(-40); first = false; }
      for (const l of list) emit(fmt(l));
      after = r.seq;
    } catch (_) {
      if (!warned) { warned = true; emit(c(31, 'Bot service se connection nahi ho raha...')); }
    }
  };
  await poll();
  const timer = setInterval(poll, 800);
  try {
    for (;;) {
      const line = (await ask(c(32, '> '))).trim();
      if (line === ':q') break;
      if (line === ':s') {
        try { const r = await rpc({ op: 'tail', after: after }); emit(statusLine(r)); const s = r.status || {};
          if (s.state === 'online') emit(c(90, `  hp ${s.health} food ${s.food} ping ${s.ping}ms  pos ${s.pos ? s.pos.x + ',' + s.pos.y + ',' + s.pos.z : '-'}  reconnects ${s.reconnects}  RAM ${s.rssMB}MB`)); } catch (_) {}
        continue;
      }
      if (line) { try { await rpc({ op: 'send', text: line }); } catch (_) { emit(c(31, 'Send fail')); } }
    }
  } finally { clearInterval(timer); inConsole = false; }
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (_) { return {}; }
}
function writeCfg(o) {
  const tmp = CFG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, CFG);
}

async function settingsScreen() {
  banner();
  const cur = readCfg();
  const next = { host: cur.host || '', port: Number(cur.port) || 25565, name: cur.name || 'MK_Bot', authPassword: cur.authPassword || '' };
  console.log(c(90, '\n  Settings  (Enter dabao = purana value rakho)\n'));

  for (;;) {
    let v = (await ask(`  Server IP [${next.host || '-'}]: `)).trim();
    if (!v) { if (next.host) break; console.log(c(31, '  IP zaroori hai.')); continue; }
    if (/^[\w.-]+:\d{1,5}$/.test(v)) { const [h, p] = v.split(':'); v = h; if (+p >= 1 && +p <= 65535) next.port = +p; }
    if (/^[A-Za-z0-9._-]{1,253}$/.test(v)) { next.host = v; break; }
    console.log(c(31, '  IP/host galat hai.'));
  }
  for (;;) {
    const v = (await ask(`  Port [${next.port}]: `)).trim();
    if (!v) break;
    if (/^\d{1,5}$/.test(v) && +v >= 1 && +v <= 65535) { next.port = +v; break; }
    console.log(c(31, '  Port 1-65535 ke beech hona chahiye.'));
  }
  for (;;) {
    const v = (await ask(`  Bot Name [${next.name}]: `)).trim();
    if (!v) break;
    if (/^[A-Za-z0-9_]{3,16}$/.test(v)) { next.name = v; break; }
    console.log(c(31, '  Name 3-16 letters/numbers/_ ka hona chahiye.'));
  }
  const pw = (await ask(`  /login password (optional) [${next.authPassword ? 'set' : '-'}] ('-' = hatao): `)).trim();
  if (pw === '-') next.authPassword = ''; else if (pw) next.authPassword = pw;

  writeCfg(next);
  try { await rpc({ op: 'apply' }); console.log(c(32, `\n  Saved! Bot ab ${next.name} @ ${next.host}:${next.port} par join karega.`)); }
  catch (_) { console.log(c(31, '\n  Saved, par bot service se connect nahi hua.')); }
  await ask(c(90, '  Enter dabao wapas jaane ke liye...'));
}

async function menu() {
  for (;;) {
    banner();
    let r;
    try { r = await ensureDaemon(); } catch (e) { console.log(c(31, '\n  ' + e.message)); process.exit(1); }
    console.log('\n' + statusLine(r) + '\n');
    console.log('   ' + c(32, '1') + '  Console (live log + chat/commands)');
    console.log('   ' + c(32, '2') + '  Settings (IP / Port / Name)');
    console.log('   ' + c(32, '3') + '  ' + (r.running ? 'Bot STOP karo' : 'Bot START karo'));
    console.log('   ' + c(32, '0') + '  Exit menu (bot chalta rahega)\n');
    const a = (await ask('  Choose > ')).trim();
    if (a === '1') await consoleScreen();
    else if (a === '2') await settingsScreen();
    else if (a === '3') { await rpc({ op: r.running ? 'stop' : 'start' }).catch(() => {}); }
    else if (a === '0') { console.log('\n  Bye! Bot background me chalta rahega.  — its_mk_playa'); process.exit(0); }
  }
}

menu();
