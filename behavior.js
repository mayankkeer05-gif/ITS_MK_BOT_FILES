'use strict';
// Anti-AFK / rejoin timings. Sab kuch yahin se set hota hai.
// Env variables se badal sakte ho (optional).
const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

const B = {
  // Bot kitni der server par rukega, phir thodi der ke liye leave karega (random har baar)
  STAY_MIN: num('STAY_MIN_MINUTES', 20) * 60000,
  STAY_MAX: num('STAY_MAX_MINUTES', 40) * 60000,
  // Leave karne ke baad kitni der baad wapas join karega (Aternos ko band hone ka time na mile)
  AWAY_MIN: num('AWAY_MIN_SECONDS', 8) * 1000,
  AWAY_MAX: num('AWAY_MAX_SECONDS', 25) * 1000,
  // Auto jump (random gap)
  JUMP_MIN: num('JUMP_MIN_SECONDS', 6) * 1000,
  JUMP_MAX: num('JUMP_MAX_SECONDS', 18) * 1000,
  // Halka sa idhar-udhar dekhna (move nahi karta, sirf head)
  LOOK_MIN: num('LOOK_MIN_SECONDS', 5) * 1000,
  LOOK_MAX: num('LOOK_MAX_SECONDS', 15) * 1000,
  // Auto reconnect
  RECONNECT_BASE: num('RECONNECT_BASE_SECONDS', 3) * 1000,
  RECONNECT_MAX: num('RECONNECT_MAX_SECONDS', 60) * 1000,
};
if (B.STAY_MAX < B.STAY_MIN) B.STAY_MAX = B.STAY_MIN;
if (B.AWAY_MAX < B.AWAY_MIN) B.AWAY_MAX = B.AWAY_MIN;
if (B.JUMP_MAX < B.JUMP_MIN) B.JUMP_MAX = B.JUMP_MIN;
if (B.LOOK_MAX < B.LOOK_MIN) B.LOOK_MAX = B.LOOK_MIN;

module.exports = B;
