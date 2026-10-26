# MK Bot — Terminal Minecraft AFK Bot
**Made by its_mk_playa**

Koi web page nahi — sab kuch terminal me. Anti-AFK (auto jump + head look, no walking), auto-reconnect, rest-cycle (Aternos ke liye), auto `/register` + `/login`.

## Menu
```
1  Console   -> live log, kuch bhi likho = chat/command (/op naam)
2  Settings  -> Server IP, Port, Bot Name, (optional) login password
3  Bot START / STOP
0  Exit menu -> bot background me chalta rehta hai
```
Console me: `:s` status, `:q` ya Ctrl+C = wapas menu.

## CodeSandbox
1. GitHub repo import karo (ya zip upload). `.codesandbox/tasks.json` apne aap `npm install` chalata hai aur bot + menu start karta hai.
2. Terminal me menu na dikhe to: `npm start`
3. Menu me **2** dabao, IP/port/name daalo. Bot turant join karega.

> Free CodeSandbox me credits limited hote hain (24/7 nahi chalta). Sandbox hibernate ho to dobara kholne par bot khud start ho jata hai.

## Termux / VPS / PC
```
pkg install -y nodejs git      # Termux (VPS par: Node 18+ install karo)
npm install --omit=dev
npm start
```
Background me bot chalane ke liye `node daemon.js &` bhi chala sakte ho.

## Optional env (timings)
`STAY_MIN_MINUTES` `STAY_MAX_MINUTES` `AWAY_MIN_SECONDS` `AWAY_MAX_SECONDS` `JUMP_MIN_SECONDS` `JUMP_MAX_SECONDS` `RECONNECT_MAX_SECONDS` `MKBOT_HEAP_MB` (default 160)

## Files
`cli.js` menu • `daemon.js` background service • `worker.js` bot logic • `behavior.js` timings • `config.json` settings

© its_mk_playa
