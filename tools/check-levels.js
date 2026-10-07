#!/usr/bin/env node
// Brute-forces launch angle, power and a simple flap policy to confirm every level can be cleared
// with the birds it gives you. Usage: node tools/check-levels.js
const Core = require('../src/core.js');
const LEVELS = require('../src/levels.js');

function simulate(level, angleDeg, power, flapFromX, flapBelowVy) {
  const a = (angleDeg * Math.PI) / 180;
  const shot = Core.newShot({ x: -Math.cos(a) * power, y: Math.sin(a) * power });
  const pigs = level.pigs.map((p) => ({ ...p, alive: true }));
  let mask = 0;
  for (let i = 0; i < 1500 && !shot.done; i++) {
    if (shot.x >= flapFromX && shot.vy > flapBelowVy) Core.flap(shot);
    Core.step(shot, level, pigs);
  }
  pigs.forEach((p, i) => { if (!p.alive) mask |= 1 << i; });
  return mask;
}

function reachableMasks(level) {
  const masks = new Set();
  for (let angle = -10; angle <= 80; angle += 1)
    for (let power = 20; power <= Core.MAX_PULL; power += 5)
      for (let fx = 150; fx <= 840; fx += 30)
        for (const vy of [-99, 0, 1, 2, 3, 4]) {
          const m = simulate(level, angle, power, vy === -99 ? 1e9 : fx, vy);
          if (m) masks.add(m);
        }
  return masks;
}

// Seeded random search over launch vectors and arbitrary flap frames (finds shots the grid misses).
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMasks(level, masks, tries) {
  const rnd = mulberry32(1234);
  for (let n = 0; n < tries; n++) {
    const a = ((-10 + rnd() * 90) * Math.PI) / 180;
    const power = 25 + rnd() * (Core.MAX_PULL - 25);
    const shot = Core.newShot({ x: -Math.cos(a) * power, y: Math.sin(a) * power });
    const pigs = level.pigs.map((p) => ({ ...p, alive: true }));
    const flapFrames = new Set();
    for (let k = rnd() * (Core.MAX_FLAPS + 1) | 0; k > 0; k--) flapFrames.add((rnd() * 90) | 0);
    for (let f = 0; f < 1500 && !shot.done; f++) {
      if (flapFrames.has(f)) Core.flap(shot);
      Core.step(shot, level, pigs);
    }
    let mask = 0;
    pigs.forEach((p, i) => { if (!p.alive) mask |= 1 << i; });
    if (mask) masks.add(mask);
  }
  return masks;
}

// Fewest shots whose hit-sets together cover every pig (BFS over covered-pig bitmasks).
function minShots(masks, pigCount) {
  const full = (1 << pigCount) - 1;
  let frontier = new Set([0]);
  for (let shots = 1; shots <= 8; shots++) {
    const next = new Set();
    for (const covered of frontier) for (const m of masks) next.add(covered | m);
    if (next.has(full)) return shots;
    frontier = next;
  }
  return Infinity;
}

let failed = false;
LEVELS.forEach((level, i) => {
  const masks = randomMasks(level, reachableMasks(level), 300000);
  const reachable = [...masks].reduce((a, b) => a | b, 0);
  const unreachable = level.pigs.map((_, k) => k).filter((k) => !(reachable & (1 << k)));
  const need = minShots(masks, level.pigs.length);
  const ok = unreachable.length === 0 && need <= level.birds;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} L${i + 1} ${level.name}: ${level.birds} birds, needs ${need}` +
      (unreachable.length ? `, unreachable pigs: ${unreachable.join(',')}` : '')
  );
});
process.exit(failed ? 1 : 0);
