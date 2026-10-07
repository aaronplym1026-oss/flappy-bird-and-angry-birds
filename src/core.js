// Game rules and physics. No DOM access, so it runs in the browser and in Node.
(function (root) {
  const C = {
    W: 960,
    H: 540,
    GROUND: 480,
    GRAVITY: 0.25,
    SLING: { x: 150, y: 380 },
    MAX_PULL: 90,
    POWER: 0.14,
    FLAP_V: -6.2,
    MAX_FLAPS: 5,
    BIRD_R: 14,
    PIG_R: 18,
    PIPE_W: 70,
  };

  // A pipe is a full-height column with a gap: { x, gap (centre y), h (gap height) }.
  function pipeRects(p) {
    const bottomY = p.gap + p.h / 2;
    return [
      { x: p.x, y: 0, w: C.PIPE_W, h: p.gap - p.h / 2 },
      { x: p.x, y: bottomY, w: C.PIPE_W, h: C.GROUND - bottomY },
    ];
  }

  function circleHitsRect(cx, cy, r, rc) {
    const nx = Math.max(rc.x, Math.min(cx, rc.x + rc.w));
    const ny = Math.max(rc.y, Math.min(cy, rc.y + rc.h));
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
  }

  // `pull` is the vector from the sling to the dragged bird; the bird flies the opposite way.
  function clampPull(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len <= C.MAX_PULL) return { x: dx, y: dy };
    return { x: (dx / len) * C.MAX_PULL, y: (dy / len) * C.MAX_PULL };
  }

  function newShot(pull) {
    return {
      x: C.SLING.x + pull.x,
      y: C.SLING.y + pull.y,
      vx: -pull.x * C.POWER,
      vy: -pull.y * C.POWER,
      flaps: 0,
      flapAnim: 0,
      dead: false, // bumped into a pipe: just falls now
      done: false, // shot is over
    };
  }

  function flap(shot) {
    if (shot.done || shot.dead || shot.flaps >= C.MAX_FLAPS) return false;
    shot.vy = C.FLAP_V;
    shot.flaps++;
    shot.flapAnim = 10;
    return true;
  }

  // Advance one frame. Returns the pigs popped during this frame.
  function step(shot, level, pigs) {
    const popped = [];
    if (shot.done) return popped;
    shot.vy += C.GRAVITY;
    shot.x += shot.vx;
    shot.y += shot.vy;
    if (shot.flapAnim > 0) shot.flapAnim--;

    if (!shot.dead) {
      for (const p of level.pipes) {
        if (shot.x < p.x - 40 || shot.x > p.x + C.PIPE_W + 40) continue;
        if (pipeRects(p).some((r) => circleHitsRect(shot.x, shot.y, C.BIRD_R, r))) {
          shot.dead = true;
          shot.vx = -Math.abs(shot.vx) * 0.15;
          shot.vy = Math.max(shot.vy, 0);
          break;
        }
      }
    }
    if (!shot.dead) {
      for (const pig of pigs) {
        if (!pig.alive) continue;
        if (Math.hypot(shot.x - pig.x, shot.y - pig.y) < C.BIRD_R + C.PIG_R) {
          pig.alive = false;
          shot.vx *= 0.85;
          popped.push(pig);
        }
      }
    }
    if (shot.y + C.BIRD_R >= C.GROUND) {
      shot.y = C.GROUND - C.BIRD_R;
      shot.done = true;
    }
    if (shot.x > C.W + 60 || shot.x < -60 || shot.y < -500) shot.done = true;
    return popped;
  }

  const api = { ...C, pipeRects, circleHitsRect, clampPull, newShot, flap, step };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
