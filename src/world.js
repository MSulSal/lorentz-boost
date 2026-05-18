import {
  C,
  clamp,
  gammaFromVelocity,
  integrateRelativistic,
  limitVelocity,
  mag,
  snapshot,
  v,
} from './relativity';

const ARENA_X = 1800;
const TRACK_LENGTH = ARENA_X * 2;
const HISTORY_SECONDS = 128;
const MAX_HISTORY = 1800;

const BOT_COUNT = 15;
const ENERGY_EVENT_COUNT = Math.max(18, (BOT_COUNT + 1) * 4);
const ENERGY_EVENT_MAX_POOL = Math.max(64, (BOT_COUNT + 1) * 14);
const FUTURE_EVENT_SECONDS = 16;
const EVENT_PAST_GRACE = 0.65;
const EVENT_RADIUS_MIN = 5.4;
const EVENT_RADIUS_MAX = 8.9;
const EVENT_ENERGY_MIN = 18;
const EVENT_ENERGY_MAX = 34;
const DEATH_DROP_COUNT = 8;

const PLAYER_RADIUS = 18;
const BOT_RADIUS = 16.5;
const PLAYER_MAX_BETA = 0.9;
const BOT_MAX_BETA = 0.86;

const STEER_THRUST = 410;
const BOT_THRUST = 310;
const BOT_BRAKE = 190;
const FUEL_MAX = 140;
const FUEL_REGEN = 20;
const FUEL_TURN_DRAIN = 34;
const TURN_THRUST_MIN_SCALE = 0.28;
const RETRO_COOLDOWN = 0;

const HP_MAX = 100;
const INVULNERABLE_SECONDS = 1.9;

const PLAYER_TRAIL_DROP_PERIOD = 0.19;
const BOT_TRAIL_DROP_PERIOD = 0.31;
const PLAYER_TRAIL_LIFETIME_BASE = 4.8;
const BOT_TRAIL_LIFETIME_BASE = 3.4;
const TRAIL_LIFETIME_PER_POINT = 0.03;
const TRACE_POINTS_START_PLAYER = 14;
const TRACE_POINTS_START_BOT = 10;
const TRACE_POINTS_GAIN_EVENT = 0.45;
const TRACE_POINTS_GAIN_DEAD = 0.85;
const TRACE_POINTS_MAX = 220;
const TRACE_POINTS_KEEP_ON_DEATH = 0.55;
const TRAIL_ARM_DELAY = 0.22;

const RACE_T_FINAL = 144;
const PROGRESS_SCORE_SCALE = 0.03;
const RESPAWN_BACKTRACK = 260;
const RESPAWN_COOLDOWN_SECONDS = 2.8;
const KILL_SCORE = 260;
const DEATH_SCORE_PENALTY = 190;
const CAPTURE_SCORE = 120;
const FLEET_FORMATION_SPACING = 14;
const FLEET_HITBOX_SCALE = 0.94;
const FLEET_HITBOX_MAX_BONUS = 52;
const EVENT_SPEED_BOOST_BASE = 6;
const EVENT_SPEED_BOOST_PER_ENERGY = 0.52;
const POLE_FLIP_COOLDOWN = 0.72;
const POLE_FLIP_COORDTIME_OFFSET = 0.36;
const CAPTURE_SELF_TRAIL_GRACE = 0.32;
const RETRO_SELF_TRAIL_GRACE = 1.2;
const FACING_VELOCITY_EPS = 0.01;

const COURSE_SAMPLE_DT = 1.25;
const COURSE_LANE_WANDER = 220;
const WORM_TRACK_MARGIN = 84;
const WORM_SPREAD_START = 520;
const WORM_SPREAD_MID = 64;
const WORM_SPREAD_END = 420;
const WALL_HIT_DAMAGE = 34;
const ISLAND_COUNT = 18;
const ISLAND_RADIUS_X_MIN = 58;
const ISLAND_RADIUS_X_MAX = 146;
const ISLAND_RADIUS_T_MIN = 1.9;
const ISLAND_RADIUS_T_MAX = 4.6;
const ISLAND_STRENGTH_MIN = 54;
const ISLAND_STRENGTH_MAX = 112;
const ISLAND_CORE_DPS = 22;

export const TEAMS = Object.freeze([
  { id: 'sol', name: 'SOL', primaryHue: 190, accentHue: 330 },
  { id: 'nova', name: 'NOVA', primaryHue: 40, accentHue: 195 },
  { id: 'aegis', name: 'AEGIS', primaryHue: 120, accentHue: 220 },
  { id: 'orion', name: 'ORION', primaryHue: 270, accentHue: 55 },
]);

function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const random = rand(42069);

function randomRange(min, max) {
  return min + (max - min) * random();
}

function randomInt(maxExclusive) {
  return Math.floor(random() * maxExclusive);
}

function randomSign() {
  return random() < 0.5 ? -1 : 1;
}

function wrapX(x) {
  if (x < -ARENA_X) return x + TRACK_LENGTH;
  if (x > ARENA_X) return x - TRACK_LENGTH;
  return x;
}

function wrapPoint(p) {
  p.x = wrapX(p.x);
  p.y = 0;
  return p;
}

function wrappedDelta(curr, prev) {
  let d = curr - prev;
  if (d > ARENA_X) d -= TRACK_LENGTH;
  if (d < -ARENA_X) d += TRACK_LENGTH;
  return d;
}

function unwrapFromPrev(currWrapped, prevUnwrapped) {
  const prevWrapped = wrapX(prevUnwrapped);
  const d = wrappedDelta(currWrapped, prevWrapped);
  return prevUnwrapped + d;
}

function unwrapNear(xWrapped, refX) {
  let x = xWrapped;
  while (x - refX > TRACK_LENGTH * 0.5) x -= TRACK_LENGTH;
  while (x - refX < -TRACK_LENGTH * 0.5) x += TRACK_LENGTH;
  return x;
}

function wrappedDistance(a, b) {
  return Math.abs(wrappedDelta(a, b));
}

function randomX(margin = 120) {
  return randomRange(-ARENA_X + margin, ARENA_X - margin);
}

function randomXNear(x, radius = 760) {
  return wrapX(x + randomRange(-radius, radius));
}

function randomSpawnXs(count) {
  if (count <= 1) return [randomX()];
  const stride = TRACK_LENGTH / count;
  const anchor = randomRange(-ARENA_X, ARENA_X);
  return Array.from({ length: count }, (_, i) => wrapX(anchor + i * stride + randomRange(-stride * 0.22, stride * 0.22)));
}

function teamByIndex(idx) {
  return TEAMS[((idx % TEAMS.length) + TEAMS.length) % TEAMS.length];
}

function randomTeamExcept(excludedTeamId) {
  const candidates = TEAMS.filter((t) => t.id !== excludedTeamId);
  return candidates[randomInt(candidates.length)] ?? TEAMS[0];
}

function botOrdinal(entityId) {
  const match = /^bot-(\d+)$/.exec(entityId ?? '');
  return match ? Number(match[1]) + 1 : null;
}

function refreshEntityName(entity) {
  if (entity.kind !== 'bot') return;
  const suffix = botOrdinal(entity.id) ?? entity.id ?? 'x';
  const prefix = (entity.team?.name ?? 'BOT').toLowerCase();
  entity.name = `${prefix}-${suffix}`;
}

function applyTeam(entity, team) {
  entity.team = team;
  entity.hue = team.primaryHue;
  refreshEntityName(entity);
}

function isEntityActive(entity) {
  return !entity?.isRespawning;
}

function fleetSizeFor(entity) {
  const reserves = Math.max(0, Math.floor(entity?.fleetReserve ?? 0));
  return (entity?.isRespawning ? 0 : 1) + reserves;
}

function fleetRowsForShips(shipCount) {
  let rows = 0;
  let placed = 0;
  const target = Math.max(0, Math.floor(shipCount));
  while (placed < target) {
    rows += 1;
    placed += rows;
    if (rows > 64) break;
  }
  return rows;
}

function fleetHitboxBonus(entity) {
  const ships = fleetSizeFor(entity);
  if (ships <= 1) return 0;
  const rows = fleetRowsForShips(ships);
  const rowSpan = Math.max(0, rows - 1);
  const lateralExtent = rowSpan * FLEET_FORMATION_SPACING * 0.62;
  const rearExtent = rowSpan * FLEET_FORMATION_SPACING * 0.95;
  const footprint = Math.max(lateralExtent, rearExtent);
  return Math.min(FLEET_HITBOX_MAX_BONUS, footprint * FLEET_HITBOX_SCALE);
}

function collisionRadiusFor(entity) {
  return (entity?.radius ?? 0) + fleetHitboxBonus(entity);
}

function trailCollisionRadiusFor(victim, trailOwnerId) {
  // Own-worldline checks use core ship radius to avoid invisible fleet-envelope drains.
  if (trailOwnerId === victim?.id) return victim?.radius ?? 0;
  return collisionRadiusFor(victim);
}

function syncFleetReserve(entity) {
  const captures = Math.max(0, Math.floor(entity?.fleetRescues ?? 0));
  const losses = Math.max(0, Math.floor(entity?.fleetLosses ?? 0));
  entity.fleetReserve = Math.max(0, captures - losses);
}

function convertVictimToFleet(victim, killer, world) {
  if (!killer || killer.id === victim.id) return false;
  // Fleet capture is abstract: we only add a ship-count token and visual formation ship.
  killer.recentCaptureUntil = Math.max(killer.recentCaptureUntil ?? 0, world.t + CAPTURE_SELF_TRAIL_GRACE);
  killer.fleetRescues = (killer.fleetRescues ?? 0) + 1;
  syncFleetReserve(killer);
  killer.score += CAPTURE_SCORE;
  emitFlash(world, {
    type: 'capture',
    x: victim.pos.x,
    t: world.t,
    hue: killer.hue,
  });
  return true;
}

function addKillScore(killer, count = 1) {
  if (!killer) return;
  if (count <= 0) return;
  killer.kills += count;
  killer.score += KILL_SCORE * count;
}

function awardKillCredit(killer, victim, world, count = 1) {
  if (!killer || killer.id === victim.id) return;
  if (count <= 0) return;
  addKillScore(killer, count);
  if (count === 1) {
    convertVictimToFleet(victim, killer, world);
  }
}

function absorbFleetLoss(entity, world, losses = 1) {
  const totalLosses = Math.max(0, Math.floor(losses));
  if (totalLosses <= 0) return 0;
  const reserve = Math.max(0, Math.floor(entity.fleetReserve ?? 0));
  if (reserve <= 0) return totalLosses;
  const absorbed = Math.min(reserve, totalLosses);
  entity.fleetLosses = (entity.fleetLosses ?? 0) + absorbed;
  syncFleetReserve(entity);
  entity.hp = Math.max(36, entity.hp ?? 0);
  entity.invulnerableUntil = Math.max(entity.invulnerableUntil ?? 0, world.t + 0.45);
  emitFlash(world, {
    type: 'fleet-loss',
    x: entity.pos.x,
    t: world.t,
    hue: entity.hue,
  });
  return totalLosses - absorbed;
}

function applyFullDeath(victim, killer, world, cause) {
  victim.deaths += 1;
  victim.score = Math.max(0, victim.score - DEATH_SCORE_PENALTY);
  const flashType = cause === 'tail'
    ? 'tail-kill'
    : cause === 'wall'
      ? 'wall-kill'
      : cause === 'island'
        ? 'island-kill'
        : 'collision-kill';
  emitFlash(world, {
    type: flashType,
    x: victim.pos.x,
    t: world.t,
    hue: killer?.hue ?? victim.hue,
  });
  scatterDeadWorldlineDrops(victim, world);
  queueRespawn(victim, world);
}

function interpolateXUnwrapped(prevX, currX, prevT, currT, t) {
  if (currT <= prevT) return currX;
  const mix = clamp((t - prevT) / (currT - prevT), 0, 1);
  return prevX + (currX - prevX) * mix;
}

function sampleCourseLaneX(lane, t, finishT) {
  const samples = lane.samples;
  if (!samples || samples.length === 0) return 0;
  if (t <= samples[0].t) return samples[0].x;
  if (t >= finishT) return samples[samples.length - 1].x;

  const i = Math.min(samples.length - 2, Math.max(0, Math.floor(t / COURSE_SAMPLE_DT)));
  const a = samples[i];
  const b = samples[i + 1] ?? a;
  if (!b || b.t <= a.t) return a.x;
  const mix = clamp((t - a.t) / (b.t - a.t), 0, 1);
  const bx = unwrapNear(b.x, a.x);
  return wrapX(a.x + (bx - a.x) * mix);
}

function sampleScalarAt(samples, t, finishT) {
  if (!samples || samples.length === 0) return 0;
  if (t <= samples[0].t) return samples[0].value;
  if (t >= finishT) return samples[samples.length - 1].value;
  const i = Math.min(samples.length - 2, Math.max(0, Math.floor(t / COURSE_SAMPLE_DT)));
  const a = samples[i];
  const b = samples[i + 1] ?? a;
  if (!b || b.t <= a.t) return a.value;
  const mix = clamp((t - a.t) / (b.t - a.t), 0, 1);
  return a.value + (b.value - a.value) * mix;
}

function smoothstep(from, to, value) {
  if (to <= from) return value >= to ? 1 : 0;
  const x = clamp((value - from) / (to - from), 0, 1);
  return x * x * (3 - 2 * x);
}

function laneFractions(count) {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => (i / (count - 1)) * 2 - 1);
}

function wormSpreadAt(t, finishT) {
  const p = clamp(finishT > 0 ? t / finishT : 0, 0, 1);
  const tails = 1 - smoothstep(0.06, 0.36, p);
  const heads = smoothstep(0.66, 0.95, p);
  return WORM_SPREAD_MID
    + tails * (WORM_SPREAD_START - WORM_SPREAD_MID)
    + heads * (WORM_SPREAD_END - WORM_SPREAD_MID);
}

function makeIslandsFromWorm(centerPath, halfWidthSamples, lanes, finishT) {
  const islands = [];
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const laneIdx = randomInt(lanes.length);
    const lane = lanes[laneIdx];
    const t = randomRange(5.2, finishT - 5.2);
    const centerX = sampleCourseLaneX(centerPath, t, finishT);
    const halfW = sampleScalarAt(halfWidthSamples, t, finishT);
    const laneX = sampleCourseLaneX(lane, t, finishT);
    const laneDelta = wrappedDelta(laneX, centerX);
    const side = i % 2 === 0 ? -1 : 1;
    const offset = laneDelta * 0.55 + side * randomRange(halfW * 0.12, halfW * 0.38);
    const mass = random() < 0.86 ? 1 : -0.7;
    islands.push({
      id: `island-${i}`,
      x: wrapX(centerX + offset),
      t,
      radiusX: randomRange(ISLAND_RADIUS_X_MIN, ISLAND_RADIUS_X_MAX),
      radiusT: randomRange(ISLAND_RADIUS_T_MIN, ISLAND_RADIUS_T_MAX),
      strength: randomRange(ISLAND_STRENGTH_MIN, ISLAND_STRENGTH_MAX),
      mass,
      hue: mass > 0 ? randomRange(196, 218) : randomRange(326, 356),
    });
  }
  return islands;
}

function makeCourse(laneCount, finishT) {
  const sampleCount = Math.max(10, Math.ceil(finishT / COURSE_SAMPLE_DT) + 1);
  const centerSamples = [];
  const halfWidthSamples = [];
  const fractions = laneFractions(laneCount);
  const laneSamples = fractions.map(() => []);

  let center = randomRange(-ARENA_X * 0.16, ARENA_X * 0.16);
  let drift = randomRange(-14, 14);
  for (let k = 0; k < sampleCount; k++) {
    const t = Math.min(finishT, k * COURSE_SAMPLE_DT);
    if (k > 0) {
      const phase = t * 0.082;
      drift += randomRange(-8, 8) * COURSE_SAMPLE_DT * 0.24;
      drift *= 0.9;
      center = clamp(
        center + drift * COURSE_SAMPLE_DT + Math.sin(phase) * 5 + Math.sin(phase * 0.5 + 1.4) * 4,
        -COURSE_LANE_WANDER,
        COURSE_LANE_WANDER,
      );
    }
    const centerX = wrapX(center);
    const spread = wormSpreadAt(t, finishT);
    const halfW = clamp(WORM_TRACK_MARGIN + spread * 0.68, 128, 450);
    centerSamples.push({ t, x: centerX });
    halfWidthSamples.push({ t, value: halfW });

    for (let i = 0; i < laneCount; i++) {
      const frac = fractions[i];
      const wiggle = Math.sin(t * 0.19 + i * 1.73) * 16 + Math.sin(t * 0.053 + i * 0.88) * 11;
      const laneX = wrapX(centerX + frac * spread + wiggle * (0.25 + Math.abs(frac) * 0.34));
      laneSamples[i].push({ t, x: laneX });
    }
  }
  const lanes = laneSamples.map((samples, i) => ({
    id: `lane-${i}`,
    hue: 165 + i * 44,
    samples,
  }));
  const wallLeft = {
    id: 'wall-left',
    hue: 26,
    samples: centerSamples.map((c, i) => ({ t: c.t, x: wrapX(c.x - halfWidthSamples[i].value) })),
  };
  const wallRight = {
    id: 'wall-right',
    hue: 36,
    samples: centerSamples.map((c, i) => ({ t: c.t, x: wrapX(c.x + halfWidthSamples[i].value) })),
  };
  const islands = makeIslandsFromWorm({ id: 'center', samples: centerSamples }, halfWidthSamples, lanes, finishT);
  const avgHalfW = halfWidthSamples.reduce((sum, s) => sum + s.value, 0) / Math.max(1, halfWidthSamples.length);
  return {
    laneHalfWidth: avgHalfW * 0.35,
    sampleDt: COURSE_SAMPLE_DT,
    center: { id: 'center', samples: centerSamples },
    halfWidthSamples,
    lanes,
    walls: [wallLeft, wallRight],
    islands,
  };
}

function nearestEntity(entities, x, excludeId) {
  let best = null;
  let bestDist = Infinity;
  for (const e of entities) {
    if (e.id === excludeId) continue;
    const d = wrappedDistance(e.pos.x, x);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

function trackProgressMetric(entity, world) {
  void world;
  return entity.progress ?? 0;
}

function fuelRatio(entity) {
  return clamp((entity.boostEnergy ?? 0) / FUEL_MAX, 0, 1);
}

function tracePointsStart(kind) {
  return kind === 'player' ? TRACE_POINTS_START_PLAYER : TRACE_POINTS_START_BOT;
}

function clampTracePoints(points) {
  return clamp(points, 0, TRACE_POINTS_MAX);
}

function trailLifetimeFor(entity) {
  const base = entity.kind === 'player' ? PLAYER_TRAIL_LIFETIME_BASE : BOT_TRAIL_LIFETIME_BASE;
  const points = clampTracePoints(entity.tracePoints ?? tracePointsStart(entity.kind));
  return base + points * TRAIL_LIFETIME_PER_POINT;
}

function makeEntity(id, name, kind, x, team, initialVx = 0, timeDirection = 1, initialCoordTime = 0) {
  const hue = team?.primaryHue ?? randomRange(0, 360);
  const radius = kind === 'player' ? PLAYER_RADIUS : BOT_RADIUS;
  const initialFacing = Math.sign(initialVx) || 1;
  return {
    id,
    name,
    kind,
    team,
    pos: v(x, 0),
    vel: v(initialVx, 0),
    properTime: 0,
    hue,
    radius,
    hp: HP_MAX,
    boostEnergy: FUEL_MAX * 0.62,
    score: 0,
    progress: 0,
    startUnwrappedX: x,
    unwrappedX: x,
    finished: false,
    finishTime: null,
    placement: null,
    facing: initialFacing,
    wrongWay: false,
    timeDirection: timeDirection < 0 ? -1 : 1,
    coordTime: initialCoordTime,
    tracePoints: tracePointsStart(kind),
    isRespawning: false,
    respawnAt: 0,
    respawnUnwrappedX: x,
    respawnProgress: 0,
    invulnerableUntil: 0,
    retroReadyAt: 0,
    nextPoleFlipAt: 0,
    recentCaptureUntil: 0,
    selfTrailGraceUntil: 0,
    kills: 0,
    deaths: 0,
    fleetRescues: 0,
    fleetLosses: 0,
    fleetReserve: 0,
    history: [],
    lastTrailAt: 0,
    brain: {
      gateBias: randomRange(0.88, 1.16),
      courseLaneIdx: 0,
      laneSwapAt: randomRange(8.5, 13.5),
    },
  };
}

function futureEventTime(t, min = 0.9, max = FUTURE_EVENT_SECONDS) {
  return t + randomRange(min, max);
}

function makeEnergyEvent(id, t, anchorX, course, finishT) {
  const eventT = futureEventTime(t);
  let x = randomXNear(anchorX ?? randomX(), randomRange(220, 940));
  if (course?.lanes?.length) {
    const lane = course.lanes[randomInt(course.lanes.length)];
    const laneX = sampleCourseLaneX(lane, eventT, finishT);
    x = wrapX(laneX + randomRange(-course.laneHalfWidth * 0.72, course.laneHalfWidth * 0.72));
  }
  return {
    id,
    x,
    eventT,
    radius: randomRange(EVENT_RADIUS_MIN, EVENT_RADIUS_MAX),
    energy: randomRange(EVENT_ENERGY_MIN, EVENT_ENERGY_MAX),
    hue: randomRange(155, 220),
    born: t,
  };
}

function respawnEnergyEvent(event, t, anchorX, course, finishT) {
  Object.assign(event, makeEnergyEvent(event.id, t, anchorX, course, finishT));
}

function energyEventExpired(event, t) {
  return event.eventT < t - EVENT_PAST_GRACE || event.eventT > t + FUTURE_EVENT_SECONDS * 1.18;
}

function pushHistory(entity, t) {
  entity.history.push(snapshot(entity, t));
  while (entity.history.length > MAX_HISTORY || entity.history[0]?.t < t - HISTORY_SECONDS) {
    entity.history.shift();
  }
}

function emitFlash(world, flash) {
  world.flashes.push({
    id: `flash-${world.nextFlashId++}`,
    ...flash,
  });
}

function scatterDeadWorldlineDrops(victim, world) {
  const history = victim.history ?? [];
  if (!world.energyEvents || history.length < 2) return;
  const hue = victim.team?.primaryHue ?? victim.hue;
  const coordNow = victim.coordTime ?? world.t;

  for (let i = 0; i < DEATH_DROP_COUNT; i++) {
    const sampleIdx = Math.max(
      0,
      history.length - 2 - Math.floor((i / Math.max(1, DEATH_DROP_COUNT - 1)) * Math.min(history.length - 2, 36)),
    );
    const h = history[sampleIdx] ?? history[history.length - 1];
    if (!h) continue;

    world.energyEvents.push({
      id: `drop-${world.nextDropId++}`,
      x: wrapX(h.pos.x + randomRange(-26, 26)),
      eventT: coordNow + randomRange(0.25, 2.2),
      radius: randomRange(EVENT_RADIUS_MIN * 0.9, EVENT_RADIUS_MAX * 1.24),
      energy: randomRange(EVENT_ENERGY_MIN * 0.45, EVENT_ENERGY_MAX * 0.86),
      hue: hue + randomRange(-18, 18),
      born: coordNow,
      deadWorldline: true,
    });
  }

  if (world.energyEvents.length > ENERGY_EVENT_MAX_POOL) {
    world.energyEvents.sort((a, b) => (a.born ?? 0) - (b.born ?? 0));
    world.energyEvents.splice(0, world.energyEvents.length - ENERGY_EVENT_MAX_POOL);
  }
}

function queueRespawn(entity, world) {
  const heading = Math.sign(entity.vel.x) || entity.facing || 1;
  entity.respawnProgress = Math.max(0, (entity.progress ?? 0) - RESPAWN_BACKTRACK * 0.45);
  entity.respawnUnwrappedX = (entity.unwrappedX ?? entity.pos.x) - heading * RESPAWN_BACKTRACK;
  const startPoints = tracePointsStart(entity.kind);
  entity.tracePoints = clampTracePoints(
    Math.max(startPoints * 0.6, (entity.tracePoints ?? startPoints) * TRACE_POINTS_KEEP_ON_DEATH),
  );
  entity.isRespawning = true;
  entity.respawnAt = world.t + RESPAWN_COOLDOWN_SECONDS;
  entity.hp = 0;
  entity.vel = v(0, 0);
  entity.lastTrailAt = world.t;
}

function reviveEntity(entity, world) {
  entity.unwrappedX = entity.respawnUnwrappedX ?? entity.unwrappedX ?? entity.pos.x;
  entity.progress = entity.respawnProgress ?? entity.progress ?? 0;
  entity.pos = v(wrapX(entity.unwrappedX), 0);
  entity.vel = v(24, 0);
  entity.hp = HP_MAX;
  entity.boostEnergy = FUEL_MAX * 0.45;
  entity.invulnerableUntil = world.t + INVULNERABLE_SECONDS;
  entity.facing = 1;
  entity.isRespawning = false;
  entity.respawnAt = 0;
  entity.history = [snapshot(entity, world.t)];
  emitFlash(world, {
    type: 'respawn',
    x: entity.pos.x,
    t: world.t,
    hue: entity.hue,
  });
}

function refreshRespawns(world) {
  for (const entity of world.entities) {
    if (!entity.isRespawning) continue;
    if ((entity.respawnAt ?? Infinity) > world.t) continue;
    reviveEntity(entity, world);
  }
}

function killEntity(victim, killer, world, cause) {
  awardKillCredit(killer, victim, world, 1);
  const remainingLosses = absorbFleetLoss(victim, world, 1);
  if (remainingLosses <= 0) return;
  applyFullDeath(victim, killer, world, cause);
}

function finishEntity(entity, world) {
  if (entity.finished) return;
  entity.finished = true;
  entity.finishTime = world.t;
  void world;
}

function concludeRace(world) {
  if (world.raceFinished) return;
  for (const entity of world.entities) {
    finishEntity(entity, world);
  }
  const ordered = [...world.entities].sort((a, b) => {
    if (b.properTime !== a.properTime) return b.properTime - a.properTime;
    if ((b.progress ?? 0) !== (a.progress ?? 0)) return (b.progress ?? 0) - (a.progress ?? 0);
    if (b.score !== a.score) return b.score - a.score;
    return a.deaths - b.deaths;
  });
  world.finishOrder = ordered.map((e) => e.id);
  for (let i = 0; i < ordered.length; i++) {
    ordered[i].placement = i + 1;
  }
  world.winnerId = ordered[0]?.id ?? null;
  world.winnerName = ordered[0]?.name ?? null;
  world.raceFinished = true;
  world.paused = true;
  if (ordered[0]) {
    emitFlash(world, {
      type: 'finish',
      x: ordered[0].pos.x,
      t: world.t,
      hue: ordered[0].hue,
    });
  }
}

function updateRaceProgress(entity, prevUnwrappedX, currUnwrappedX, world) {
  const dx = currUnwrappedX - prevUnwrappedX;
  const traveled = Math.abs(dx);
  entity.wrongWay = false;
  entity.progress = Math.max(0, (entity.progress ?? 0) + traveled);
  entity.score += traveled * PROGRESS_SCORE_SCALE;
  void world;
}

function syncFacingFromVelocity(entity) {
  if (!entity) return;
  const vx = entity.vel?.x ?? 0;
  if (Math.abs(vx) <= FACING_VELOCITY_EPS) return;
  entity.facing = Math.sign(vx);
}

function tryRetroBoost(entity, world) {
  entity.timeDirection = (entity.timeDirection ?? 1) >= 0 ? -1 : 1;
  entity.retroReadyAt = world.t + RETRO_COOLDOWN;
  entity.selfTrailGraceUntil = Math.max(entity.selfTrailGraceUntil ?? 0, world.t + RETRO_SELF_TRAIL_GRACE);
  entity.invulnerableUntil = Math.max(entity.invulnerableUntil, world.t + 1.1);
  // Prevent an instant cusp segment at reversal from counting as a paradox hit.
  entity.lastTrailAt = world.t;
  emitFlash(world, {
    type: 'retro',
    x: entity.pos.x,
    t: world.t,
    hue: entity.hue + (entity.timeDirection > 0 ? 118 : 332),
  });
  return true;
}

function updatePlayerBoostAndSteer(player, controls, dt, world) {
  const steerAxis = Number.isFinite(controls.steerAxis)
    ? clamp(controls.steerAxis, -1, 1)
    : (controls.d ? 1 : 0) - (controls.a ? 1 : 0);
  const steerInput = Math.abs(steerAxis) < 0.015 ? 0 : clamp(steerAxis * 1.75, -1, 1);
  const burn = Math.abs(steerInput) * FUEL_TURN_DRAIN * dt;
  const regen = FUEL_REGEN * dt;
  player.boostEnergy = clamp((player.boostEnergy ?? 0) + regen - burn, 0, FUEL_MAX);
  const thrustScale = TURN_THRUST_MIN_SCALE + (1 - TURN_THRUST_MIN_SCALE) * fuelRatio(player);
  const accX = steerInput * STEER_THRUST * thrustScale;

  if (controls.spacePressed && world.t >= (player.retroReadyAt ?? 0)) {
    tryRetroBoost(player, world);
  }
  return v(accX, 0);
}

function updateBot(bot, world, dt, prevXMap) {
  const laneCount = world.course?.lanes?.length ?? 1;
  if (bot.brain.courseLaneIdx == null || bot.brain.courseLaneIdx >= laneCount) {
    bot.brain.courseLaneIdx = randomInt(laneCount);
  }
  if (world.t >= bot.brain.laneSwapAt && random() < 0.42) {
    bot.brain.courseLaneIdx = randomInt(laneCount);
    bot.brain.laneSwapAt = world.t + randomRange(6.8, 12.4);
  }

  const lane = world.course?.lanes?.[bot.brain.courseLaneIdx];
  const lookT = Math.min(world.finishT, world.t + 1.2 + bot.brain.gateBias * 0.5);
  const targetX = lane ? sampleCourseLaneX(lane, lookT, world.finishT) : bot.pos.x;
  const centerX = world.course?.center ? sampleCourseLaneX(world.course.center, lookT, world.finishT) : bot.pos.x;
  const halfW = world.course?.halfWidthSamples
    ? sampleScalarAt(world.course.halfWidthSamples, lookT, world.finishT)
    : (world.course?.laneHalfWidth ?? 220);
  const deltaX = wrappedDelta(targetX, bot.pos.x);
  const deltaCenter = wrappedDelta(centerX, bot.pos.x);
  const laneSteer = clamp(deltaX * 2.2, -220, 220);
  const underPressure = Math.abs(deltaCenter) > halfW * 0.88 || bot.hp < 34;
  const retroChance = underPressure ? 0.28 : 0.06;
  if (world.t >= (bot.retroReadyAt ?? 0) && random() < retroChance * dt) {
    tryRetroBoost(bot, world);
  }

  let desiredBeta = 0.58 + 0.16 * bot.brain.gateBias;
  if (Math.abs(deltaCenter) > halfW * 0.82) desiredBeta *= 0.86;
  if (bot.hp < 45) desiredBeta *= 0.9;
  const desiredSpeed = C * clamp(desiredBeta, 0.3, 0.9) * (Math.sign(deltaX) || Math.sign(bot.vel.x) || 1);
  const steerIntent = clamp(laneSteer / BOT_THRUST, -1, 1);
  const burn = Math.abs(steerIntent) * FUEL_TURN_DRAIN * dt * 0.88;
  const regen = FUEL_REGEN * dt * 0.95;
  bot.boostEnergy = clamp((bot.boostEnergy ?? 0) + regen - burn, 0, FUEL_MAX);
  const thrustScale = TURN_THRUST_MIN_SCALE + (1 - TURN_THRUST_MIN_SCALE) * fuelRatio(bot);
  let accX = laneSteer * thrustScale;
  if (bot.vel.x < desiredSpeed - 10) accX += BOT_THRUST;
  if (bot.vel.x > desiredSpeed + 10) accX -= BOT_BRAKE;

  integrateRelativistic(bot, v(accX, 0), dt, BOT_MAX_BETA);
  syncFacingFromVelocity(bot);

  // prevXMap read is intentional for future bot prediction tuning.
  void prevXMap;
}

function resolveWallCollisions(world, prevXMap, prevT, currT) {
  if (!world.course?.center || !world.course?.halfWidthSamples) return;
  const leftHue = world.course.walls?.[0]?.hue ?? 24;
  const rightHue = world.course.walls?.[1]?.hue ?? 38;
  void prevT;
  for (const entity of world.entities) {
    if (!isEntityActive(entity)) continue;
    const prevWrappedX = prevXMap.get(entity.id) ?? entity.pos.x;
    const centerX = sampleCourseLaneX(world.course.center, currT, world.finishT);
    const halfW = sampleScalarAt(world.course.halfWidthSamples, currT, world.finishT);
    const prevDelta = wrappedDelta(prevWrappedX, centerX);
    const currDelta = wrappedDelta(entity.pos.x, centerX);
    const hitRadius = collisionRadiusFor(entity);
    const limit = Math.max(56, halfW - hitRadius * 0.2);
    const penetration = Math.abs(currDelta) - limit;
    if (penetration <= 0) continue;

    const side = Math.sign(currDelta) || Math.sign(prevDelta) || 1;
    const impactNorm = clamp(
      (penetration + Math.abs(currDelta - prevDelta) * 0.45) / Math.max(18, halfW * 0.45),
      0,
      1,
    );
    entity.pos.x = wrapX(centerX + side * (limit - 2));
    const rebound = Math.max(14, Math.abs(entity.vel.x) * (0.26 + impactNorm * 0.5));
    entity.vel.x = -side * rebound - entity.vel.x * 0.12;
    entity.vel = limitVelocity(
      v(entity.vel.x, 0),
      entity.kind === 'player' ? PLAYER_MAX_BETA : BOT_MAX_BETA,
    );
    entity.facing = Math.sign(entity.vel.x) || -side;

    if (currT >= entity.invulnerableUntil) {
      const damage = WALL_HIT_DAMAGE * (0.4 + impactNorm);
      entity.hp = Math.max(0, entity.hp - damage);
      entity.score = Math.max(0, entity.score - 4.2 * (0.5 + impactNorm));
    }

    emitFlash(world, {
      type: 'wall-hit',
      x: entity.pos.x,
      t: currT,
      hue: side < 0 ? leftHue : rightHue,
    });
    if (entity.hp <= 0.5) {
      killEntity(entity, null, world, 'wall');
    }
  }
}

function energyEventHit(entity, prevWrappedX, prevCoordT, currCoordT, event) {
  const minT = Math.min(prevCoordT, currCoordT);
  const maxT = Math.max(prevCoordT, currCoordT);
  if (event.eventT < minT || event.eventT > maxT) return false;
  if (Math.abs(currCoordT - prevCoordT) < 1e-6) return false;
  const currUnwrappedX = unwrapFromPrev(entity.pos.x, prevWrappedX);
  const prevUnwrappedX = prevWrappedX;
  const xAtEventUnwrapped = interpolateXUnwrapped(prevUnwrappedX, currUnwrappedX, prevCoordT, currCoordT, event.eventT);
  const eventXUnwrapped = unwrapNear(event.x, xAtEventUnwrapped);
  const assist = entity.kind === 'player' ? 4.8 : 2.6;
  const hitRadius = collisionRadiusFor(entity);
  return Math.abs(xAtEventUnwrapped - eventXUnwrapped) <= hitRadius + event.radius + assist;
}

function applyEnergySpeedBoost(entity, event) {
  const maxBeta = entity.kind === 'player' ? PLAYER_MAX_BETA : BOT_MAX_BETA;
  const heading = Math.sign(entity.vel.x) || entity.facing || 1;
  const speed = Math.abs(entity.vel.x);
  const gain = EVENT_SPEED_BOOST_BASE + event.energy * EVENT_SPEED_BOOST_PER_ENERGY;
  const boostedSpeed = speed + gain;
  entity.vel = limitVelocity(v(heading * boostedSpeed, 0), maxBeta);
}

function collectEnergyEvents(entity, prevWrappedX, world, prevCoordT, currCoordT) {
  if (!isEntityActive(entity)) return;
  for (const event of world.energyEvents) {
    if (energyEventHit(entity, prevWrappedX, prevCoordT, currCoordT, event)) {
      entity.boostEnergy = Math.min(FUEL_MAX, entity.boostEnergy + event.energy);
      applyEnergySpeedBoost(entity, event);
      const gainScale = event.deadWorldline ? TRACE_POINTS_GAIN_DEAD : TRACE_POINTS_GAIN_EVENT;
      entity.tracePoints = clampTracePoints(
        (entity.tracePoints ?? tracePointsStart(entity.kind)) + event.energy * gainScale,
      );
      entity.score += event.energy * 0.35;
      emitFlash(world, {
        type: 'energy',
        x: event.x,
        t: event.eventT,
        hue: event.hue,
        amount: event.energy,
      });
      respawnEnergyEvent(event, entity.coordTime ?? world.t, entity.pos.x, world.course, world.finishT);
      continue;
    }
    if (energyEventExpired(event, world.player.coordTime ?? world.t)) {
      respawnEnergyEvent(event, world.player.coordTime ?? world.t, world.player.pos.x, world.course, world.finishT);
    }
  }
}

function dot2(ax, ay, bx, by) {
  return ax * bx + ay * by;
}

function minDistanceSegmentToSegment2D(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y) {
  const ux = a1x - a0x;
  const uy = a1y - a0y;
  const vx = b1x - b0x;
  const vy = b1y - b0y;
  const wx = a0x - b0x;
  const wy = a0y - b0y;

  const a = dot2(ux, uy, ux, uy);
  const b = dot2(ux, uy, vx, vy);
  const c = dot2(vx, vy, vx, vy);
  const d = dot2(ux, uy, wx, wy);
  const e = dot2(vx, vy, wx, wy);
  const D = a * c - b * b;
  const EPS2 = 1e-9;

  let sN;
  let sD = D;
  let tN;
  let tD = D;

  if (D < EPS2) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) {
      sN = 0;
    } else if (-d > a) {
      sN = sD;
    } else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) {
      sN = 0;
    } else if (-d + b > a) {
      sN = sD;
    } else {
      sN = -d + b;
      sD = a;
    }
  }

  const sc = Math.abs(sN) < EPS2 ? 0 : sN / sD;
  const tc = Math.abs(tN) < EPS2 ? 0 : tN / tD;
  const dx = wx + sc * ux - tc * vx;
  const dy = wy + sc * uy - tc * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

function spawnTrail(entity, world, prevWrappedX, prevCoordT, currCoordT, simNow) {
  const period = entity.kind === 'player' ? PLAYER_TRAIL_DROP_PERIOD : BOT_TRAIL_DROP_PERIOD;
  if (simNow - entity.lastTrailAt < period) return;
  entity.lastTrailAt = simNow;

  const lifetime = trailLifetimeFor(entity);
  const radiusScale = entity.kind === 'player' ? 0.56 : 0.46;
  const x0 = prevWrappedX;
  const x1 = entity.pos.x;
  if (wrappedDistance(x0, x1) < 0.001) return;

  world.trails.push({
    id: `trail-${world.nextTrailId++}`,
    ownerId: entity.id,
    x0,
    x1,
    t0: prevCoordT,
    t1: currCoordT,
    bornT: simNow,
    armT: simNow + TRAIL_ARM_DELAY,
    expireT: simNow + lifetime,
    radius: entity.radius * radiusScale,
    hue: entity.team?.primaryHue ?? entity.hue,
  });
}

function maybeFlipAtTemporalPole(entity, world, prevCoordTime, currCoordTime) {
  const finishT = world.finishT ?? 0;
  if (!(finishT > 0)) return false;
  if (world.t < (entity.nextPoleFlipAt ?? 0)) return false;
  const prevBand = Math.floor(prevCoordTime / finishT);
  const currBand = Math.floor(currCoordTime / finishT);
  if (prevBand === currBand) return false;

  const forward = currCoordTime >= prevCoordTime;
  entity.timeDirection = forward ? -1 : 1;
  const seam = forward ? (prevBand + 1) * finishT : prevBand * finishT;
  entity.coordTime = seam + entity.timeDirection * POLE_FLIP_COORDTIME_OFFSET;
  // Pole crossing transitions to the antipodal hemisphere on the compact sphere.
  entity.pos = v(wrapX(entity.pos.x + TRACK_LENGTH * 0.5), 0);
  entity.nextPoleFlipAt = world.t + POLE_FLIP_COOLDOWN;
  entity.invulnerableUntil = Math.max(entity.invulnerableUntil ?? 0, world.t + 0.3);
  entity.lastTrailAt = world.t;
  emitFlash(world, {
    type: 'pole-flip',
    x: entity.pos.x,
    t: world.t,
    hue: (entity.hue ?? 200) + (entity.timeDirection > 0 ? 116 : 330),
  });
  return true;
}

function resolveTailKills(world, prevXMap, prevCoordTimeMap, currSimT) {
  const ownerById = new Map(world.entities.map((e) => [e.id, e]));
  const pendingKills = [];
  for (const victim of world.entities) {
    if (!isEntityActive(victim)) continue;
    if (currSimT < victim.invulnerableUntil) continue;
    const prevWrappedX = prevXMap.get(victim.id) ?? victim.pos.x;
    const prevCoordT = prevCoordTimeMap.get(victim.id) ?? (victim.coordTime ?? currSimT);
    const currCoordT = victim.coordTime ?? currSimT;
    const prevUnwrappedX = prevWrappedX;
    const currUnwrappedX = unwrapFromPrev(victim.pos.x, prevUnwrappedX);
    let bestHit = null;

    for (const trail of world.trails) {
      if (currSimT < trail.armT || currSimT > trail.expireT) continue;
      if (trail.ownerId === victim.id) {
        const selfTrailGraceUntil = Math.max(victim.recentCaptureUntil ?? 0, victim.selfTrailGraceUntil ?? 0);
        if (currSimT < selfTrailGraceUntil) continue;
      }

      const victimMid = (prevUnwrappedX + currUnwrappedX) * 0.5;
      const trailDelta = wrappedDelta(trail.x1, trail.x0);
      const trailBaseX0 = unwrapNear(trail.x0, victimMid);
      let minDistance = Infinity;
      const trailT0 = trail.t0 ?? trail.t1 ?? currCoordT;
      const trailT1 = trail.t1 ?? trail.t0 ?? currCoordT;
      for (const wrapShift of [-1, 0, 1]) {
        const tx0 = trailBaseX0 + wrapShift * TRACK_LENGTH;
        const tx1 = tx0 + trailDelta;
        const d = minDistanceSegmentToSegment2D(
          prevUnwrappedX,
          prevCoordT * C,
          currUnwrappedX,
          currCoordT * C,
          tx0,
          trailT0 * C,
          tx1,
          trailT1 * C,
        );
        minDistance = Math.min(minDistance, d);
      }

      const hitRadius = trailCollisionRadiusFor(victim, trail.ownerId);
      if (minDistance <= hitRadius + trail.radius + 2.5) {
        const killerId = trail.ownerId ?? null;
        const isSelf = killerId === victim.id;
        if (!bestHit) {
          bestHit = { killerId, isSelf, dist: minDistance };
          continue;
        }
        const bestIsSelf = bestHit.isSelf;
        if (bestIsSelf && !isSelf) {
          bestHit = { killerId, isSelf, dist: minDistance };
          continue;
        }
        if (bestIsSelf === isSelf && minDistance < bestHit.dist) {
          bestHit = { killerId, isSelf, dist: minDistance };
        }
      }
    }
    if (bestHit) {
      pendingKills.push({
        victimId: victim.id,
        killerId: bestHit.killerId,
      });
    }
  }

  const lossesByVictim = new Map();
  const firstKillerByVictim = new Map();
  const killCreditsByKiller = new Map();
  const capturedVictimIds = new Set();

  // 1) Fleet capture pass (once per victim) + killer credits.
  for (const pending of pendingKills) {
    const victim = ownerById.get(pending.victimId);
    if (!victim || !isEntityActive(victim)) continue;
    const killer = ownerById.get(pending.killerId);
    lossesByVictim.set(victim.id, (lossesByVictim.get(victim.id) ?? 0) + 1);
    if (killer && killer.id !== victim.id) {
      if (!firstKillerByVictim.has(victim.id)) {
        firstKillerByVictim.set(victim.id, killer.id);
      }
      killCreditsByKiller.set(killer.id, (killCreditsByKiller.get(killer.id) ?? 0) + 1);
      if (!capturedVictimIds.has(victim.id)) {
        convertVictimToFleet(victim, killer, world);
        capturedVictimIds.add(victim.id);
      }
    }
  }

  // 2) Apply aggregated kill credits.
  for (const [killerId, count] of killCreditsByKiller.entries()) {
    const killer = ownerById.get(killerId);
    if (!killer) continue;
    addKillScore(killer, count);
  }

  // 3) Resolve fleet losses. Only unresolved losses count as a true death.
  for (const [victimId, losses] of lossesByVictim.entries()) {
    const victim = ownerById.get(victimId);
    if (!victim || !isEntityActive(victim) || losses <= 0) continue;
    const remainingLosses = absorbFleetLoss(victim, world, losses);
    if (remainingLosses <= 0) continue;

    const killerId = firstKillerByVictim.get(victim.id);
    const killer = killerId ? (ownerById.get(killerId) ?? null) : null;
    applyFullDeath(victim, killer, world, 'tail');
  }
}

export function createWorld() {
  const playerTeam = teamByIndex(0);
  const playerCount = BOT_COUNT + 1;
  const course = null;
  const startSlots = randomSpawnXs(playerCount);
  const randomInitialVx = () => randomSign() * randomRange(C * 0.06, C * 0.2);
  const randomTimeDirection = () => randomSign();
  const randomPhaseOffset = () => randomRange(0, RACE_T_FINAL);
  const player = makeEntity(
    'you',
    'YOU',
    'player',
    startSlots[0] ?? randomX(),
    playerTeam,
    randomInitialVx(),
    randomTimeDirection(),
    randomPhaseOffset(),
  );

  const bots = Array.from({ length: BOT_COUNT }, (_, i) => {
    const team = randomTeamExcept(playerTeam.id);
    const x = startSlots[i + 1] ?? randomX();
    return makeEntity(
      `bot-${i}`,
      `${team.name.toLowerCase()}-${i + 1}`,
      'bot',
      x,
      team,
      randomInitialVx(),
      randomTimeDirection(),
      randomPhaseOffset(),
    );
  });

  const energyEvents = Array.from({ length: ENERGY_EVENT_COUNT }, (_, i) =>
    makeEnergyEvent(`energy-${i}`, player.coordTime ?? 0, randomX(), course, RACE_T_FINAL),
  );

  const entities = [player, ...bots];
  for (const e of entities) {
    e.history.push(snapshot(e, 0));
  }
  entities.forEach((e) => {
    e.brain.courseLaneIdx = 0;
    e.courseLaneId = null;
    e.courseOffset = 0;
  });

  return {
    t: 0,
    arenaX: ARENA_X,
    finishT: RACE_T_FINAL,
    raceDuration: RACE_T_FINAL,
    finishOrder: [],
    raceFinished: false,
    winnerId: null,
    winnerName: null,
    entities,
    player,
    bots,
    energyEvents,
    course,
    trails: [],
    flashes: [],
    paused: false,
    simSpeed: 1,
    modeName: '1+1D compact Minkowski sphere (paradox worldline combat)',
    nextTrailId: 0,
    nextFlashId: 0,
    nextDropId: 0,
  };
}

export function stepWorld(world, controls, rawDt) {
  if (world.paused) return;
  const baseDt = Math.min(rawDt, 1 / 24) * world.simSpeed;
  const dt = baseDt;
  if (dt <= 0) return;
  const prevT = world.t;
  world.t += dt;
  const currT = world.t;
  refreshRespawns(world);

  const prevXMap = new Map();
  const prevUnwrappedXMap = new Map();
  const prevCoordTimeMap = new Map();
  for (const e of world.entities) {
    prevXMap.set(e.id, e.pos.x);
    prevUnwrappedXMap.set(e.id, e.unwrappedX ?? e.pos.x);
    prevCoordTimeMap.set(e.id, e.coordTime ?? world.t);
  }

  if (isEntityActive(world.player)) {
    const pAcc = updatePlayerBoostAndSteer(world.player, controls, dt, world);
    integrateRelativistic(world.player, pAcc, dt, PLAYER_MAX_BETA);
    syncFacingFromVelocity(world.player);
    wrapPoint(world.player.pos);
  }

  for (const bot of world.bots) {
    if (!isEntityActive(bot)) continue;
    updateBot(bot, world, dt, prevXMap);
    wrapPoint(bot.pos);
  }

  resolveWallCollisions(world, prevXMap, prevT, currT);

  for (const e of world.entities) {
    if (!isEntityActive(e)) continue;
    wrapPoint(e.pos);
    const prevCoordTime = prevCoordTimeMap.get(e.id) ?? (e.coordTime ?? world.t);
    const prevUnwrappedX = prevUnwrappedXMap.get(e.id) ?? e.pos.x;
    e.coordTime = prevCoordTime + (e.timeDirection ?? 1) * dt;
    const poleFlipped = maybeFlipAtTemporalPole(e, world, prevCoordTime, e.coordTime);
    if (poleFlipped) {
      // Skip seam-bridge traces/progress from antipodal remap.
      e.unwrappedX = prevUnwrappedX;
    } else {
      e.unwrappedX = unwrapFromPrev(e.pos.x, prevUnwrappedX);
      spawnTrail(
        e,
        world,
        prevXMap.get(e.id) ?? e.pos.x,
        prevCoordTime,
        e.coordTime,
        world.t,
      );
    }
    updateRaceProgress(e, prevUnwrappedX, e.unwrappedX, world);
  }

  resolveTailKills(world, prevXMap, prevCoordTimeMap, currT);

  for (const e of world.entities) {
    if (!isEntityActive(e)) continue;
    if (currT >= e.invulnerableUntil) {
      collectEnergyEvents(
        e,
        prevXMap.get(e.id) ?? e.pos.x,
        world,
        prevCoordTimeMap.get(e.id) ?? (e.coordTime ?? world.t),
        e.coordTime ?? world.t,
      );
    }
    syncFacingFromVelocity(e);
    pushHistory(e, world.t);
  }

  world.trails = world.trails.filter((trail) => trail.expireT >= world.t - 0.02);
  world.flashes = world.flashes.filter((f) => world.t - f.t < 3.6);

}

export function cyclePlayerTeam(world) {
  const currentId = world.player.team?.id;
  const idx = Math.max(0, TEAMS.findIndex((t) => t.id === currentId));
  applyTeam(world.player, teamByIndex(idx + 1));
}

export function getHud(world) {
  const p = world.player;
  const ranks = rankEntities(world);
  const placement = Math.max(1, ranks.findIndex((e) => e.id === p.id) + 1);
  const speed = mag(p.vel);
  const beta = speed / C;
  const gamma = gammaFromVelocity(p.vel);
  const progress = trackProgressMetric(p, world);
  const wraps = (p.progress ?? 0) / TRACK_LENGTH;
  const elapsed = world.t;
  const coordNow = p.coordTime ?? world.t;
  const phase = world.finishT > 0 ? (((coordNow % world.finishT) + world.finishT) % world.finishT) : coordNow;
  return {
    beta,
    gamma,
    speed,
    fourTime: gamma * C,
    fourSpace: gamma * speed,
    properTime: p.properTime,
    score: p.score,
    boostEnergy: p.boostEnergy,
    tracePoints: p.tracePoints ?? tracePointsStart(p.kind),
    trailLifetime: trailLifetimeFor(p),
    hp: p.hp,
    progressDistance: p.progress ?? 0,
    wraps,
    raceElapsed: elapsed,
    coordTime: coordNow,
    raceRemaining: phase,
    raceFinishT: world.finishT,
    placement: placement || p.placement,
    raceFinished: world.raceFinished,
    winnerName: world.winnerName,
    playerKills: p.kills,
    playerDeaths: p.deaths,
    playerFleetCaptures: p.fleetRescues ?? 0,
    playerFleetLosses: p.fleetLosses ?? 0,
    playerFleetReserve: Math.max(0, Math.floor(p.fleetReserve ?? 0)),
    playerFleetSize: fleetSizeFor(p),
    isRespawning: !!p.isRespawning,
    respawnRemaining: p.isRespawning ? Math.max(0, (p.respawnAt ?? world.t) - world.t) : 0,
    timeDirection: p.timeDirection ?? 1,
    teamName: p.team?.name ?? 'SOLO',
    modeName: world.modeName,
    wrongWay: p.wrongWay,
    progress,
  };
}

export function rankEntities(world) {
  const sorted = [...world.entities]
    .sort((a, b) => {
    if ((b.kills ?? 0) !== (a.kills ?? 0)) return (b.kills ?? 0) - (a.kills ?? 0);
    if ((b.fleetRescues ?? 0) !== (a.fleetRescues ?? 0)) return (b.fleetRescues ?? 0) - (a.fleetRescues ?? 0);
    if ((a.deaths ?? 0) !== (b.deaths ?? 0)) return (a.deaths ?? 0) - (b.deaths ?? 0);
    if (b.score !== a.score) return b.score - a.score;
    if (b.properTime !== a.properTime) return b.properTime - a.properTime;
    return (b.progress ?? 0) - (a.progress ?? 0);
  });
  return sorted
    .slice(0, 8)
    .map((e) => ({
      ...e,
      wraps: (e.progress ?? 0) / TRACK_LENGTH,
      fleetSize: fleetSizeFor(e),
    }));
}
