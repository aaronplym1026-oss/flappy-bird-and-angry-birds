// Rendering, input and the game loop. Rules live in core.js, level data in levels.js.
(function () {
  const C = window.Core;
  const LEVELS = window.LEVELS;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const { W, H, GROUND, SLING } = C;

  let game; // see startLevel
  let frame = 0;
  let inputLock = 0;
  const clouds = Array.from({ length: 6 }, (_, i) => ({ x: i * 170, y: 40 + (i * 53) % 150, s: 0.6 + (i % 3) * 0.3 }));

  function startLevel(index, score) {
    const level = LEVELS[index];
    game = {
      mode: 'ready', // title | ready | aim | flying | settle | won | lost | finished
      index,
      level,
      startScore: score,
      score,
      pigs: level.pigs.map((p) => ({ ...p, alive: true })),
      birdsLeft: level.birds,
      pull: { x: 0, y: 0 },
      shot: null,
      trail: [],
      particles: [],
      timer: 0,
      bonus: 0,
    };
  }

  function advance() {
    if (inputLock > 0) return;
    inputLock = 20;
    if (game.mode === 'title') startLevel(0, 0);
    else if (game.mode === 'won') startLevel(game.index + 1, game.score);
    else if (game.mode === 'lost') startLevel(game.index, game.startScore);
    else if (game.mode === 'finished') { startLevel(0, 0); game.mode = 'title'; }
  }

  // ---- input ----
  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  function doFlap() {
    if (game.mode !== 'flying') return;
    if (C.flap(game.shot)) burst(game.shot.x - 10, game.shot.y + 8, 4, '#fff', 1.2);
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = toCanvas(e);
    if (game.mode === 'ready' && Math.hypot(p.x - SLING.x, p.y - SLING.y) < 60) {
      game.mode = 'aim';
      canvas.setPointerCapture(e.pointerId);
      game.pull = C.clampPull(p.x - SLING.x, p.y - SLING.y);
    } else if (game.mode === 'flying') doFlap();
    else advance();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (game.mode !== 'aim') return;
    const p = toCanvas(e);
    game.pull = C.clampPull(p.x - SLING.x, p.y - SLING.y);
  });
  function release() {
    if (game.mode !== 'aim') return;
    if (Math.hypot(game.pull.x, game.pull.y) < 12) {
      game.mode = 'ready';
      game.pull = { x: 0, y: 0 };
      return;
    }
    game.shot = C.newShot(game.pull);
    game.birdsLeft--;
    game.trail = [];
    game.mode = 'flying';
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      if (game.mode === 'flying') doFlap();
      else advance();
    } else if (e.code === 'Enter') advance();
    else if (e.code === 'KeyR' && game.mode !== 'title') startLevel(game.index, game.startScore);
  });

  // ---- simulation ----
  function burst(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.4 + Math.random()) * speed * 2;
      game.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, life: 30 + Math.random() * 20, color, size: 2 + Math.random() * 3 });
    }
  }

  function update() {
    frame++;
    if (inputLock > 0) inputLock--;
    for (const c of clouds) { c.x += 0.15 * c.s; if (c.x > W + 80) c.x = -120; }
    for (const p of game.particles) { p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life--; }
    game.particles = game.particles.filter((p) => p.life > 0);

    if (game.mode === 'flying') {
      const popped = C.step(game.shot, game.level, game.pigs);
      for (const pig of popped) {
        game.score += 1000;
        burst(pig.x, pig.y, 18, '#8bd450', 2.5);
        burst(pig.x, pig.y, 8, '#fff', 2);
      }
      if (frame % 3 === 0) game.trail.push({ x: game.shot.x, y: game.shot.y });
      if (game.shot.done) {
        if (game.shot.y + C.BIRD_R >= GROUND) burst(game.shot.x, GROUND - 4, 8, '#c9b48a', 1.5);
        game.mode = 'settle';
        game.timer = 50;
      }
    } else if (game.mode === 'settle') {
      if (--game.timer <= 0) {
        game.shot = null;
        if (game.pigs.every((p) => !p.alive)) {
          game.bonus = game.birdsLeft * 500;
          game.score += game.bonus;
          game.mode = game.index === LEVELS.length - 1 ? 'finished' : 'won';
          inputLock = 40;
        } else if (game.birdsLeft > 0) {
          game.mode = 'ready';
          game.pull = { x: 0, y: 0 };
        } else {
          game.mode = 'lost';
          inputLock = 40;
        }
      }
    }
  }

  // ---- drawing ----
  function drawBackground() {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#5ec2ff');
    sky.addColorStop(1, '#cdeeff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const c of clouds) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 24 * c.s, 0, 7);
      ctx.arc(c.x + 26 * c.s, c.y - 8 * c.s, 30 * c.s, 0, 7);
      ctx.arc(c.x + 56 * c.s, c.y, 22 * c.s, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = '#9fd68a';
    ctx.beginPath();
    ctx.moveTo(0, GROUND);
    for (let x = 0; x <= W; x += 40) ctx.lineTo(x, GROUND - 40 - 25 * Math.sin(x / 130));
    ctx.lineTo(W, GROUND);
    ctx.fill();
    ctx.fillStyle = '#7ab648';
    ctx.fillRect(0, GROUND, W, 14);
    ctx.fillStyle = '#b5834f';
    ctx.fillRect(0, GROUND + 14, W, H - GROUND - 14);
    ctx.fillStyle = '#9a6d3f';
    for (let x = 0; x < W; x += 48) ctx.fillRect(x, GROUND + 14, 24, H);
  }

  function drawPipes() {
    for (const p of game.level.pipes) {
      for (const [i, r] of C.pipeRects(p).entries()) {
        ctx.fillStyle = '#5cb82e';
        ctx.fillRect(r.x + 4, r.y, r.w - 8, r.h);
        ctx.fillStyle = '#8be04e';
        ctx.fillRect(r.x + 10, r.y, 8, r.h);
        const capY = i === 0 ? r.y + r.h - 24 : r.y;
        ctx.fillStyle = '#5cb82e';
        ctx.fillRect(r.x, capY, r.w, 24);
        ctx.fillStyle = '#8be04e';
        ctx.fillRect(r.x + 6, capY, 8, 24);
        ctx.strokeStyle = '#2f6b14';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 4, r.y, r.w - 8, r.h);
        ctx.strokeRect(r.x, capY, r.w, 24);
      }
    }
  }

  function drawPig(pig) {
    const r = C.PIG_R;
    if (pig.y < GROUND - r - 2) {
      ctx.fillStyle = '#a0713b';
      ctx.fillRect(pig.x - 26, pig.y + r - 2, 52, 8);
      ctx.fillStyle = '#7d5429';
      ctx.fillRect(pig.x - 26, pig.y + r + 4, 52, 2);
    }
    ctx.fillStyle = '#8bd450';
    ctx.strokeStyle = '#4c8a1e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pig.x, pig.y, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(pig.x - 12, pig.y - 14, 5, 0, 7); ctx.arc(pig.x + 12, pig.y - 14, 5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#a6e46c';
    ctx.beginPath(); ctx.ellipse(pig.x, pig.y + 4, 9, 7, 0, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4c8a1e';
    ctx.beginPath(); ctx.arc(pig.x - 3, pig.y + 4, 1.8, 0, 7); ctx.arc(pig.x + 3, pig.y + 4, 1.8, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(pig.x - 7, pig.y - 5, 4, 0, 7); ctx.arc(pig.x + 7, pig.y - 5, 4, 0, 7); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(pig.x - 7, pig.y - 5, 1.8, 0, 7); ctx.arc(pig.x + 7, pig.y - 5, 1.8, 0, 7); ctx.fill();
  }

  function drawBird(x, y, angle, wing, scale = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    const r = C.BIRD_R;
    ctx.fillStyle = '#d8281f';
    ctx.strokeStyle = '#7a120d';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6, -r + 2); ctx.lineTo(-12, -r - 8); ctx.lineTo(-1, -r + 1); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f4d6b0';
    ctx.beginPath(); ctx.ellipse(2, 6, 9, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#b01d16';
    ctx.beginPath(); ctx.ellipse(-6, 3 - wing * 1.2, 7, 4, -0.5 - wing * 0.12, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(3, -4, 4.5, 0, 7); ctx.arc(10, -3, 3.8, 0, 7); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(4.5, -4, 1.8, 0, 7); ctx.arc(11, -3, 1.6, 0, 7); ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-1, -10); ctx.lineTo(12, -6); ctx.stroke();
    ctx.fillStyle = '#ffb81c';
    ctx.strokeStyle = '#a56a00';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(23, 3); ctx.lineTo(12, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawSlingshot(back) {
    const bx = SLING.x, by = SLING.y;
    ctx.strokeStyle = back ? '#5a3a1a' : '#7b4f26';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (back) { ctx.moveTo(bx - 3, by - 6); ctx.lineTo(bx - 8, by - 34); }
    else { ctx.moveTo(bx + 3, by - 6); ctx.lineTo(bx + 10, by - 34); ctx.moveTo(bx, by + 4); ctx.lineTo(bx, GROUND + 6); }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawBand(x, y) {
    ctx.strokeStyle = '#3b2412';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(SLING.x - 8, SLING.y - 34); ctx.lineTo(x, y);
    ctx.moveTo(SLING.x + 10, SLING.y - 34); ctx.lineTo(x, y);
    ctx.stroke();
  }

  function drawAimGuide() {
    const s = C.newShot(game.pull);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 1; i <= 36; i++) {
      s.vy += C.GRAVITY; s.x += s.vx; s.y += s.vy;
      if (i % 3 === 0 && i <= 30) {
        ctx.beginPath(); ctx.arc(s.x, s.y, 3.2 - i * 0.05, 0, 7); ctx.fill();
      }
    }
  }

  function text(str, x, y, size, color = '#fff', align = 'center') {
    ctx.font = `bold ${size}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.lineWidth = Math.max(3, size / 6);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawHud() {
    text(`Level ${game.index + 1}: ${game.level.name}`, 16, 32, 22, '#fff', 'left');
    text(`Score ${game.score}`, 16, 60, 18, '#ffe27a', 'left');
    for (let i = 0; i < game.birdsLeft; i++) drawBird(W - 28 - i * 34, 28, 0, 0, 0.7);
    if (game.mode === 'flying' && game.shot) {
      const left = C.MAX_FLAPS - game.shot.flaps;
      text('Flaps', W - 16 - C.MAX_FLAPS * 18 - 30, 70, 14, '#fff', 'right');
      for (let i = 0; i < C.MAX_FLAPS; i++) {
        ctx.fillStyle = i < left ? '#ffe27a' : 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.arc(W - 22 - i * 18, 65, 6, 0, 7); ctx.fill();
      }
    }
    if (game.mode === 'ready' || game.mode === 'aim') {
      text('Drag the bird back and let go, then tap / SPACE to flap through the pipes!', W / 2, H - 14, 16);
    }
    const left = game.pigs.filter((p) => p.alive).length;
    text(`Pigs left: ${left}`, W / 2, 32, 20, '#c9ff9a');
  }

  function overlay(title, lines, sub) {
    ctx.fillStyle = 'rgba(10,20,40,0.6)';
    ctx.fillRect(0, 0, W, H);
    text(title, W / 2, H / 2 - 50, 52, '#ffe27a');
    lines.forEach((l, i) => text(l, W / 2, H / 2 + 5 + i * 30, 22));
    if (sub && Math.floor(frame / 30) % 2 === 0) text(sub, W / 2, H / 2 + 5 + lines.length * 30 + 30, 18, '#c9ff9a');
  }

  function draw() {
    drawBackground();
    drawPipes();
    for (const pig of game.pigs) if (pig.alive) drawPig(pig);
    drawSlingshot(true);
    const aiming = game.mode === 'aim';
    if (game.mode === 'ready' || aiming) {
      const bx = SLING.x + game.pull.x, by = SLING.y + game.pull.y;
      drawBand(bx, by);
      if (aiming) drawAimGuide();
      drawBird(bx, by, aiming ? Math.atan2(-game.pull.y, -game.pull.x) : 0, 0);
    } else if (game.mode === 'flying' || game.mode === 'settle') {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (const t of game.trail) { ctx.beginPath(); ctx.arc(t.x, t.y, 3, 0, 7); ctx.fill(); }
      if (game.shot) {
        const s = game.shot;
        const ang = s.dead ? s.x * 0.05 : Math.max(-0.8, Math.min(0.8, Math.atan2(s.vy, Math.abs(s.vx) + 4)));
        drawBird(s.x, s.y, ang, s.flapAnim);
      }
    }
    drawSlingshot(false);
    for (const p of game.particles) {
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    if (game.mode === 'title') {
      overlay('Flappy Angry Birds', ['Fling the bird with the slingshot,', 'then flap to thread the pipes and pop every pig.'], 'Click or press SPACE to start');
    } else {
      drawHud();
      if (game.mode === 'won') overlay('Level clear!', [`Spare-bird bonus: +${game.bonus}`, `Score: ${game.score}`], 'Click or press SPACE for the next level');
      if (game.mode === 'lost') overlay('Out of birds', ['The pigs got away this time.'], 'Click or press SPACE to retry');
      if (game.mode === 'finished') overlay('All pigs popped!', [`Final score: ${game.score}`], 'Click or press SPACE to play again');
    }
  }

  // Fixed 60 Hz simulation regardless of display refresh rate.
  let last = performance.now();
  let acc = 0;
  function loop(now) {
    acc += Math.min(100, now - last);
    last = now;
    while (acc >= 1000 / 60) { update(); acc -= 1000 / 60; }
    draw();
    requestAnimationFrame(loop);
  }

  startLevel(0, 0);
  game.mode = 'title';
  requestAnimationFrame(loop);
  window.__game = { get state() { return game; } }; // handy for debugging / automated tests
})();
