import {
  C,
  clamp,
  dopplerFactor,
  findRetardedSnapshot,
  gammaFromVelocity,
  lengthContractionFactor,
} from './relativity';

const NOW_Y_RATIO = 0.72;
const PIX = 1;
const PIXEL_SCALE = 3;
const MIN_RENDER_WIDTH = 320;
const MIN_RENDER_HEIGHT = 180;
const MAX_FORMATION_VISUAL_SHIPS = 28;
const FORMATION_BACK_STEP = 8;
const FORMATION_SIDE_STEP = 6;

const STAR_COUNT = 180;
const DUST_COUNT = 28;
const STAR_FIELD_SPAN = 14000;
const STAR_PARALLAX_MIN = 0.32;
const STAR_PARALLAX_MAX = 1.3;

const stars = [];
const dustClouds = [];
let starsReady = false;

let pixelCanvas = null;
let pixelCtx = null;
let pixelWidth = 0;
let pixelHeight = 0;

function initStars() {
  if (starsReady) return;
  starsReady = true;
  let seed = 7777;
  const rnd = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: (rnd() * 2 - 1) * STAR_FIELD_SPAN,
      y: rnd(),
      depth: STAR_PARALLAX_MIN + rnd() * (STAR_PARALLAX_MAX - STAR_PARALLAX_MIN),
      hueBase: 178 + rnd() * 64,
      phase: rnd() * Math.PI * 2,
      twinkle: 0.35 + rnd() * 0.65,
    });
  }

  for (let i = 0; i < DUST_COUNT; i++) {
    dustClouds.push({
      x: (rnd() * 2 - 1) * STAR_FIELD_SPAN,
      y: 0.05 + rnd() * 0.85,
      depth: 0.45 + rnd() * 1.15,
      w: 9 + rnd() * 24,
      h: 1 + Math.floor(rnd() * 2),
      hueBase: 192 + rnd() * 55,
      phase: rnd() * Math.PI * 2,
      density: 0.28 + rnd() * 0.55,
    });
  }
}

function hsl(h, s = 84, l = 62, a = 1) {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

function snap(n) {
  return Math.round(n / PIX) * PIX;
}

function wrapDelta(a, b, halfSpan) {
  const span = halfSpan * 2;
  let d = a - b;
  if (d > halfSpan) d -= span;
  if (d < -halfSpan) d += span;
  return d;
}

function projectXT(x, t, camera) {
  const dt = t - camera.now;
  const dx = camera.arenaX != null ? wrapDelta(x, camera.originX, camera.arenaX) : (x - camera.originX);
  return {
    x: camera.width * 0.5 + dx * camera.zoom,
    y: camera.nowY - dt * C * camera.zoom,
  };
}

function visibleOnCanvas(p, camera, margin = 120) {
  return p.x > -margin && p.y > -margin && p.x < camera.width + margin && p.y < camera.height + margin;
}

function teamColors(entity, fallbackHue) {
  const primary = entity?.team?.primaryHue ?? fallbackHue ?? 190;
  const accent = entity?.team?.accentHue ?? (primary + 120);
  return { primary, accent };
}

function dopplerHueShiftForState(state, world, opts) {
  if (!opts.doppler) return 0;
  const factor = dopplerFactor(state.pos, state.vel, world.player.pos, world.player.vel);
  return clamp((factor - 1) * 120, -92, 92);
}

function drawBackground(ctx, world, camera, opts) {
  initStars();
  const beta = clamp(world.player.vel.x / C, -0.98, 0.98);
  const gamma = gammaFromVelocity(world.player.vel);
  const contraction = opts.lengthContraction ? 1 / gamma : 1;

  // Pixel nebula strip background.
  for (let y = 0; y < camera.height; y += 1) {
    const mix = y / camera.height;
    const hue = 219 + Math.sin(mix * 6.4 + world.t * 0.08) * 7;
    const lum = 7 + mix * 10;
    ctx.fillStyle = hsl(hue, 52, lum, 1);
    ctx.fillRect(0, y, camera.width, 1);
  }

  // Dust clouds visibly contract and Doppler-shift with motion.
  for (const cloud of dustClouds) {
    const relX = wrapDelta(cloud.x, world.player.pos.x, world.arenaX) * contraction;
    const cx = camera.width * 0.5 + (relX * camera.zoom) / cloud.depth;
    if (cx < -40 || cx > camera.width + 40) continue;
    const cy = snap(cloud.y * camera.height + Math.sin(world.t * 0.11 + cloud.phase) * 2);
    const radialSign = Math.sign(relX) || 1;
    const radialBeta = clamp(-beta * radialSign, -0.95, 0.95);
    const doppler = opts.doppler ? Math.sqrt((1 - radialBeta) / (1 + radialBeta)) : 1;
    const hue = cloud.hueBase + clamp((doppler - 1) * 85, -70, 70);
    const alpha = 0.08 + cloud.density * 0.16 + Math.abs(beta) * 0.04;
    const w = Math.max(4, Math.round(cloud.w * contraction));
    const h = Math.max(1, cloud.h);
    const startX = snap(cx - w * 0.5);
    const bandStep = 2;

    ctx.fillStyle = hsl(hue, 60, 24 + doppler * 6, alpha);
    for (let dx = 0; dx < w; dx += bandStep) {
      if (((dx + Math.floor(world.t * 4)) & 3) === 0) continue;
      ctx.fillRect(startX + dx, cy, bandStep, h);
    }
  }

  for (const star of stars) {
    const relX = wrapDelta(star.x, world.player.pos.x, world.arenaX) * contraction;
    const sx = camera.width * 0.5 + (relX * camera.zoom) / star.depth;
    if (sx < -20 || sx > camera.width + 20) continue;
    const sy = snap(star.y * camera.height + Math.sin(world.t * 0.17 + star.phase) * 2);

    // Approaching stars shift blue; receding stars shift red.
    const radialSign = Math.sign(relX) || 1;
    const radialBeta = clamp(-beta * radialSign, -0.95, 0.95);
    const doppler = opts.doppler ? Math.sqrt((1 - radialBeta) / (1 + radialBeta)) : 1;
    const hue = star.hueBase + clamp((doppler - 1) * 130, -95, 95);
    const lum = 52 + star.twinkle * 30 + Math.sin(world.t * 2.5 + star.phase) * 6;
    const h = Math.max(1, Math.round(1 + star.twinkle));
    const baseW = Math.max(1, Math.round(1 + star.twinkle * 1.8));
    const streak = Math.max(1, Math.round(baseW + Math.abs(beta) * 7 * star.twinkle * contraction));
    const dir = beta >= 0 ? -1 : 1;
    const x = snap(sx);
    const streakX = dir > 0 ? x : x - streak + 1;

    ctx.fillStyle = hsl(hue, 80, lum, 0.95);
    ctx.fillRect(streakX, sy, streak, h);
    ctx.fillStyle = hsl(hue, 88, Math.min(96, lum + 10), 0.95);
    ctx.fillRect(x, sy, 1, 1);
  }

  // CRT-like scanline pattern to enhance pixel feel.
  ctx.fillStyle = 'rgba(5, 10, 18, 0.12)';
  for (let y = 0; y < camera.height; y += 2) {
    ctx.fillRect(0, y, camera.width, 1);
  }
}

function drawGrid(ctx, world, camera) {
  const timeScale = C * camera.zoom;
  const secFuture = camera.nowY / timeScale + 1;
  const secPast = (camera.height - camera.nowY) / timeScale + 1;
  const tStart = Math.floor(camera.now - secPast);
  const tEnd = Math.ceil(camera.now + secFuture);
  const xStep = 180;
  const xSpan = camera.width / Math.max(camera.zoom, 1e-4);
  const xFirst = Math.floor((camera.originX - xSpan * 0.5) / xStep) * xStep;
  const xLast = Math.ceil((camera.originX + xSpan * 0.5) / xStep) * xStep;

  ctx.save();
  ctx.font = '7px ui-monospace, SFMono-Regular, Menlo, monospace';

  for (let t = tStart; t <= tEnd; t += 1) {
    const y = projectXT(camera.originX, t, camera).y;
    ctx.strokeStyle = 'rgba(130,190,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const left = projectXT(xFirst, t, camera);
    const right = projectXT(xLast, t, camera);
    ctx.moveTo(snap(left.x), snap(y));
    ctx.lineTo(snap(right.x), snap(y));
    ctx.stroke();
    if (t % 2 === 0) {
      ctx.fillStyle = 'rgba(190,225,255,0.38)';
      ctx.fillText(`t=${t}`, camera.width - 26, y - 2);
    }
  }

  for (let x = xFirst; x <= xLast; x += xStep) {
    ctx.strokeStyle = x === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(130,190,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const top = projectXT(x, tStart - 0.5, camera);
    const bottom = projectXT(x, tEnd + 0.5, camera);
    ctx.moveTo(snap(top.x), snap(top.y));
    ctx.lineTo(snap(bottom.x), snap(bottom.y));
    ctx.stroke();
  }

  ctx.restore();
}

function drawLightCones(ctx, world, camera) {
  const coordNow = world.player.coordTime ?? world.t;
  const origin = projectXT(world.player.pos.x, coordNow, camera);
  const timeScale = C * camera.zoom;
  const maxFuture = Math.min(camera.nowY / timeScale, 9.5);
  const maxPast = Math.min((camera.height - camera.nowY) / timeScale, 9.5);
  const conePoint = (dt, sign) => projectXT(world.player.pos.x + sign * C * dt, coordNow + dt, camera);

  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = 'rgba(72,232,255,0.34)';
  ctx.lineWidth = 1;
  for (const sign of [-1, 1]) {
    const p = conePoint(maxFuture, sign);
    ctx.beginPath();
    ctx.moveTo(snap(origin.x), snap(origin.y));
    ctx.lineTo(snap(p.x), snap(p.y));
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,104,210,0.3)';
  for (const sign of [-1, 1]) {
    const p = conePoint(-maxPast, sign);
    ctx.beginPath();
    ctx.moveTo(snap(origin.x), snap(origin.y));
    ctx.lineTo(snap(p.x), snap(p.y));
    ctx.stroke();
  }
  ctx.restore();
}

function drawCourse(ctx, world, camera) {
  const trackSpan = world.arenaX * 2;
  if (world.course?.islands?.length) {
    ctx.save();
    for (const island of world.course.islands) {
      const rx = Math.max(2, Math.round(island.radiusX * camera.zoom));
      const ry = Math.max(2, Math.round(island.radiusT * C * camera.zoom));
      const nearNow = clamp(1 - Math.abs(world.t - island.t) / (island.radiusT * 1.35), 0, 1);
      const hue = island.hue + (island.mass > 0 ? 0 : 10);
      for (const shift of [-1, 0, 1]) {
        const x = island.x + shift * trackSpan;
        const p = projectXT(x, island.t, camera);
        if (!visibleOnCanvas(p, camera, 220 + rx)) continue;
        ctx.fillStyle = hsl(hue, 72, island.mass > 0 ? 26 : 34, 0.16 + nearNow * 0.16);
        ctx.beginPath();
        ctx.ellipse(snap(p.x), snap(p.y), rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = hsl(hue + 8, 88, island.mass > 0 ? 58 : 66, 0.54);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(snap(p.x), snap(p.y), Math.max(1, Math.floor(rx * 0.58)), Math.max(1, Math.floor(ry * 0.58)), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (world.course?.walls?.length) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const wall of world.course.walls) {
      const samples = wall.samples ?? [];
      if (samples.length < 2) continue;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (!a || !b) continue;
        if (Math.abs(a.x - b.x) > world.arenaX) continue;
        const pa = projectXT(a.x, a.t, camera);
        const pb = projectXT(b.x, b.t, camera);
        if (!visibleOnCanvas(pa, camera, 180) && !visibleOnCanvas(pb, camera, 180)) continue;

        ctx.strokeStyle = hsl(wall.hue, 86, 30, 0.42);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(snap(pa.x), snap(pa.y));
        ctx.lineTo(snap(pb.x), snap(pb.y));
        ctx.stroke();

        ctx.strokeStyle = hsl(wall.hue + 10, 94, 66, 0.82);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(snap(pa.x), snap(pa.y));
        ctx.lineTo(snap(pb.x), snap(pb.y));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  void world;
}

function drawEnergyEvents(ctx, world, camera) {
  ctx.save();
  for (const ev of world.energyEvents) {
    const p = projectXT(ev.x, ev.eventT, camera);
    if (!visibleOnCanvas(p, camera, 110)) continue;
    const dt = ev.eventT - camera.now;
    const future = dt >= 0;
    const age = camera.now - ev.eventT;
    const alpha = future ? clamp(0.85 - dt * 0.06, 0.2, 0.82) : clamp(0.2 - age * 0.2, 0, 0.2);
    if (alpha <= 0.01) continue;
    const r = Math.max(2, Math.round(ev.radius * (0.35 + camera.zoom * 0.4)));
    const x = snap(p.x);
    const y = snap(p.y);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = hsl(ev.hue, 94, future ? 70 : 58, 0.95);
    ctx.fillRect(x - r, y, r * 2 + 1, 1);
    ctx.fillRect(x, y - r, 1, r * 2 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(x - 1, y - 1, 3, 3);
  }
  ctx.restore();
}

function drawTrails(ctx, world, camera) {
  ctx.save();
  for (const tr of world.trails) {
    const start = projectXT(tr.x0, tr.t0, camera);
    const end = projectXT(tr.x1, tr.t1, camera);
    if (!visibleOnCanvas(start, camera, 120) && !visibleOnCanvas(end, camera, 120)) continue;
    const ttl = Math.max(0.001, tr.expireT - tr.bornT);
    const age = world.t - tr.bornT;
    const fade = clamp(1 - age / ttl, 0, 1);
    if (fade <= 0.01) continue;
    const r = Math.max(1, Math.round(tr.radius * camera.zoom * 0.14));

    ctx.strokeStyle = hsl(tr.hue, 90, 58, 0.18 + 0.3 * fade);
    ctx.lineWidth = Math.max(1, r * 2);
    ctx.beginPath();
    ctx.moveTo(snap(start.x), snap(start.y));
    ctx.lineTo(snap(end.x), snap(end.y));
    ctx.stroke();

    ctx.strokeStyle = hsl(tr.hue, 92, 72, 0.2 + 0.42 * fade);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snap(start.x), snap(start.y));
    ctx.lineTo(snap(end.x), snap(end.y));
    ctx.stroke();

    ctx.fillStyle = hsl(tr.hue, 96, 80, 0.24 + 0.54 * fade);
    ctx.fillRect(snap(end.x) - 1, snap(end.y) - 1, 2, 2);
  }
  ctx.restore();
}

function drawFlashes(ctx, world, camera) {
  ctx.save();
  for (const f of world.flashes) {
    const age = world.t - f.t;
    const p = projectXT(f.x, f.t, camera);
    if (!visibleOnCanvas(p, camera, 120)) continue;
    let hue = f.hue ?? 200;
    if (f.type === 'tail-kill') hue += 25;
    if (f.type === 'rescue' || f.type === 'capture') hue = 168;
    if (f.type === 'wall-hit' || f.type === 'wall-kill') hue = 28;
    if (f.type === 'island-kill') hue = 332;
    if (f.type === 'pole-flip') hue = 274;
    const fade = clamp(0.65 - age * 0.25, 0, 0.56);
    if (fade <= 0.01) continue;
    const r = Math.max(1, Math.round(1 + age * camera.zoom * C * 0.08));
    const x = snap(p.x);
    const y = snap(p.y);
    ctx.fillStyle = hsl(hue, 92, 70, fade);
    for (let i = -r; i <= r; i++) {
      const dy = r - Math.abs(i);
      ctx.fillRect(x + i, y - dy, 1, dy * 2 + 1);
    }
  }
  ctx.restore();
}

function drawWorldline(ctx, entity, world, camera, opts, isSelf) {
  if (!entity.history || entity.history.length < 3) return;
  const maxAge = isSelf ? 10 : 6;
  const samples = [];
  for (let i = entity.history.length - 1; i >= 0; i -= 2) {
    const h = entity.history[i];
    const age = world.t - h.t;
    if (age > maxAge) break;
    const p = projectXT(h.pos.x, h.coordTime ?? h.t, camera);
    if (!visibleOnCanvas(p, camera, 180)) continue;
    samples.push({ h, p });
  }
  if (samples.length < 2) return;

  ctx.save();
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const age = world.t - a.h.t;
    const alpha = clamp((isSelf ? 0.72 : 0.8) * (1 - age / maxAge), 0.12, 0.86);
    const stripe = opts.timeDilation ? 0.54 + 0.46 * Math.sin(a.h.properTime * Math.PI * 3.2) : 1;
    const w = Math.max(1, Math.round((a.h.radius ?? 16) * camera.zoom * 0.18));
    const hueShift = isSelf ? 0 : dopplerHueShiftForState(a.h, world, opts);
    ctx.strokeStyle = hsl(entity.hue + hueShift, 84, 50 + stripe * 18, alpha);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(snap(a.p.x), snap(a.p.y));
    ctx.lineTo(snap(b.p.x), snap(b.p.y));
    ctx.stroke();
  }
  ctx.restore();
}

function quantizeAngle(angle, steps = 20) {
  const step = (Math.PI * 2) / steps;
  return Math.round(angle / step) * step;
}

function fleetShipCount(entity) {
  const reserves = Math.max(0, Math.floor(entity?.fleetReserve ?? 0));
  return (entity?.isRespawning ? 0 : 1) + reserves;
}

function fleetFormationSlots(shipCount) {
  const count = Math.max(1, Math.min(MAX_FORMATION_VISUAL_SHIPS, Math.floor(shipCount || 1)));
  const slots = [{ back: 0, side: 0, scale: 1, lead: true }];
  let placed = 1;
  for (let row = 1; placed < count; row++) {
    const rowCount = row + 1;
    const back = -row * FORMATION_BACK_STEP;
    const span = row * FORMATION_SIDE_STEP;
    for (let i = 0; i < rowCount && placed < count; i++) {
      const side = rowCount <= 1 ? 0 : -span * 0.5 + (span * i) / (rowCount - 1);
      slots.push({
        back,
        side,
        scale: clamp(1 - row * 0.045, 0.78, 0.94),
        lead: false,
      });
      placed += 1;
    }
  }
  return slots;
}

function drawRocketPixel(ctx, entity, state, world, camera, opts) {
  const p = projectXT(state.pos.x, state.coordTime ?? state.t, camera);
  if (!visibleOnCanvas(p, camera, 180)) return;
  const isSelf = entity.id === world.player.id;
  const alpha = 0.98;
  const contraction = opts.lengthContraction ? lengthContractionFactor(state.vel, world.player.vel) : 1;
  const speed = Math.abs(state.vel.x);
  const facing = speed > 0.4 ? Math.sign(state.vel.x) : entity.facing || 1;
  const dirX = facing >= 0 ? 1 : -1;
  const timeSign = (entity.timeDirection ?? 1) >= 0 ? 1 : -1;
  const angleRaw = Math.atan2(-C * camera.zoom * timeSign, dirX * Math.max(3, speed * camera.zoom));
  const angle = quantizeAngle(angleRaw);
  const hueShift = isSelf ? 0 : dopplerHueShiftForState(state, world, opts);
  const { primary, accent } = teamColors(entity, entity.hue);
  const shiftedPrimary = primary + hueShift;
  const shiftedAccent = accent + hueShift;

  const len = Math.max(7, Math.round(state.radius * camera.zoom * 0.64 * contraction));
  const wid = Math.max(4, Math.round(len * 0.5));
  const halfL = Math.floor(len * 0.5);
  const halfW = Math.floor(wid * 0.5);
  const flameFrame = Math.floor(world.t * 12 + (entity.id.length % 7)) % 4;
  const flame = Math.max(1, Math.round((1 + flameFrame) * (0.35 + 0.65 * (speed / C))));
  const formationSlots = fleetFormationSlots(fleetShipCount(entity));

  ctx.save();
  ctx.translate(snap(p.x), snap(p.y));
  ctx.rotate(angle);
  for (let i = formationSlots.length - 1; i >= 0; i--) {
    const slot = formationSlots[i];
    const slotFlame = slot.lead ? flame : Math.max(1, Math.floor(flame * 0.7));
    const slotAlpha = slot.lead ? alpha : alpha * 0.84;
    ctx.save();
    ctx.translate(slot.back, slot.side);
    if (slot.scale !== 1) ctx.scale(slot.scale, slot.scale);
    ctx.globalAlpha = slotAlpha;

    ctx.fillStyle = hsl(26, 96, 58, 0.95);
    ctx.fillRect(-halfL - slotFlame, -1, slotFlame, 3);
    ctx.fillStyle = hsl(50, 95, 74, 0.9);
    ctx.fillRect(-halfL - Math.max(1, slotFlame - 1), 0, Math.max(1, slotFlame - 1), 1);

    ctx.fillStyle = hsl(shiftedPrimary, 74, slot.lead ? 58 : 53, 0.96);
    ctx.fillRect(-halfL, -halfW + 1, Math.max(4, len - 2), Math.max(3, wid - 2));
    ctx.fillStyle = hsl(shiftedPrimary - 14, 62, slot.lead ? 44 : 39, 0.95);
    ctx.fillRect(-halfL, -halfW + 1, Math.max(3, Math.floor(len * 0.26)), Math.max(3, wid - 2));

    ctx.fillStyle = hsl(shiftedAccent, 82, slot.lead ? 70 : 62, 0.96);
    ctx.fillRect(Math.floor(-len * 0.1), -1, Math.max(2, Math.floor(len * 0.36)), 2);

    const noseX = Math.floor(len * 0.3);
    ctx.fillStyle = hsl(shiftedPrimary + 12, 84, slot.lead ? 66 : 60, 0.96);
    ctx.fillRect(noseX, -2, 2, 5);
    ctx.fillRect(noseX + 2, -1, 1, 3);

    ctx.fillStyle = hsl(shiftedPrimary - 24, 58, slot.lead ? 43 : 38, 0.95);
    ctx.fillRect(Math.floor(-len * 0.26), -halfW - 1, 2, 2);
    ctx.fillRect(Math.floor(-len * 0.26), halfW - 1, 2, 2);

    if (slot.lead) {
      ctx.fillStyle = 'rgba(245,250,255,0.9)';
      ctx.fillRect(Math.floor(-len * 0.02), halfW + 1, 1, 3);
      ctx.fillStyle = hsl(shiftedPrimary, 90, 62, 0.96);
      ctx.fillRect(Math.floor(-len * 0.02) + 1, halfW + 1, 2, 2);
    }
    ctx.restore();
  }

  ctx.restore();

  if (!isSelf) {
    const dx = Math.abs(p.x - camera.width * 0.5);
    const dy = Math.abs(p.y - camera.nowY);
    if (dx > 88 || dy > 70) return;
    ctx.save();
    ctx.font = '6px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(230,245,255,0.76)';
    ctx.fillText(`${entity.name}`, p.x + 4, p.y - 6);
    ctx.restore();
  }
}

function drawTangent(ctx, world, camera) {
  const p = world.player;
  if (p?.isRespawning) return;
  const coordNow = p.coordTime ?? world.t;
  const origin = projectXT(p.pos.x, coordNow, camera);
  const dtMag = 0.9;
  const timeSign = (p.timeDirection ?? 1) >= 0 ? 1 : -1;
  const tip = projectXT(p.pos.x + p.vel.x * dtMag, coordNow + dtMag * timeSign, camera);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(snap(origin.x), snap(origin.y));
  ctx.lineTo(snap(tip.x), snap(tip.y));
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.84)';
  ctx.fillRect(snap(tip.x), snap(tip.y), 1, 1);
  ctx.restore();
}

function makeCamera(displayWidth, displayHeight, world, cameraState) {
  return {
    originX: cameraState.x ?? 0,
    arenaX: world.arenaX,
    zoom: cameraState.zoom ?? 0.45,
    now: world.player?.coordTime ?? world.t,
    nowY: displayHeight * NOW_Y_RATIO,
    width: displayWidth,
    height: displayHeight,
  };
}

function resizeDisplayCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;
  if (canvas.width !== Math.floor(displayWidth * dpr) || canvas.height !== Math.floor(displayHeight * dpr)) {
    canvas.width = Math.floor(displayWidth * dpr);
    canvas.height = Math.floor(displayHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, displayWidth, displayHeight);
  return { ctx, displayWidth, displayHeight };
}

function ensurePixelBuffer(displayWidth, displayHeight) {
  const targetWidth = Math.max(MIN_RENDER_WIDTH, Math.floor(displayWidth / PIXEL_SCALE));
  const targetHeight = Math.max(MIN_RENDER_HEIGHT, Math.floor(displayHeight / PIXEL_SCALE));

  if (!pixelCanvas) {
    pixelCanvas = document.createElement('canvas');
    pixelCtx = pixelCanvas.getContext('2d');
  }
  if (pixelWidth !== targetWidth || pixelHeight !== targetHeight) {
    pixelWidth = targetWidth;
    pixelHeight = targetHeight;
    pixelCanvas.width = targetWidth;
    pixelCanvas.height = targetHeight;
  }

  pixelCtx.setTransform(1, 0, 0, 1, 0, 0);
  pixelCtx.imageSmoothingEnabled = false;
  pixelCtx.clearRect(0, 0, pixelWidth, pixelHeight);
  return { ctx: pixelCtx, width: pixelWidth, height: pixelHeight };
}

function buildRenderQueue(world) {
  const observerCoordTime = world.player?.coordTime ?? world.t;
  return world.entities.map((entity) => {
    const isSelf = entity.id === world.player.id;
    const inactive = !!entity.isRespawning;
    const current = entity.history[entity.history.length - 1] ?? {
      t: world.t,
      coordTime: entity.coordTime ?? world.t,
      pos: { ...entity.pos },
      vel: { ...entity.vel },
      properTime: entity.properTime,
      radius: entity.radius,
      hue: entity.hue,
    };
    const retarded = inactive
      ? null
      : isSelf
      ? current
      : findRetardedSnapshot(entity.history, world.player.pos, observerCoordTime, C);
    return { entity, isSelf, current, retarded };
  });
}

export function renderWorld(canvas, world, cameraState, opts) {
  const display = resizeDisplayCanvas(canvas);
  const pixel = ensurePixelBuffer(display.displayWidth, display.displayHeight);
  const camera = makeCamera(pixel.width, pixel.height, world, cameraState);
  const ctx = pixel.ctx;

  drawBackground(ctx, world, camera, opts);
  drawGrid(ctx, world, camera);
  if (opts.lightCones) drawLightCones(ctx, world, camera);
  drawCourse(ctx, world, camera);
  drawTrails(ctx, world, camera);
  drawEnergyEvents(ctx, world, camera);
  drawFlashes(ctx, world, camera);

  const queue = buildRenderQueue(world);
  for (const item of queue) {
    drawWorldline(ctx, item.entity, world, camera, opts, item.isSelf);
  }
  for (const item of queue) {
    if (item.retarded) {
      drawRocketPixel(ctx, item.entity, item.retarded, world, camera, opts);
    }
  }

  drawTangent(ctx, world, camera);

  display.ctx.imageSmoothingEnabled = false;
  display.ctx.drawImage(pixelCanvas, 0, 0, pixel.width, pixel.height, 0, 0, display.displayWidth, display.displayHeight);
}
