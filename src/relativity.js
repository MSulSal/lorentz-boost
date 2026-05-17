export const C = 180; // px / second. Intentionally slow for readable light cones.
export const C2 = C * C;
export const EPS = 1e-9;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function v(x = 0, y = 0) {
  return { x, y };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mul(a, s) {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function mag2(a) {
  return dot(a, a);
}

export function mag(a) {
  return Math.sqrt(mag2(a));
}

export function normalize(a) {
  const m = mag(a);
  if (m < EPS) return { x: 0, y: 0 };
  return { x: a.x / m, y: a.y / m };
}

export function rotate(a, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpVec(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function speedBeta(velocity) {
  return clamp(mag(velocity) / C, 0, 0.999999);
}

export function gammaFromVelocity(velocity) {
  const beta = speedBeta(velocity);
  return 1 / Math.sqrt(Math.max(1 - beta * beta, 1e-8));
}

export function properTimeStep(dt, velocity) {
  return dt / gammaFromVelocity(velocity);
}

export function limitVelocity(velocity, maxBeta = 0.985) {
  const s = mag(velocity);
  const max = C * maxBeta;
  if (s <= max) return velocity;
  return mul(velocity, max / Math.max(s, EPS));
}

// Convert a desired proper acceleration vector into a coordinate acceleration.
// Components parallel to velocity are suppressed by gamma^3, perpendicular by gamma^2.
// This preserves the key relativistic feel while keeping the integrator simple and stable.
export function coordinateAccelerationFromProper(properAcceleration, velocity) {
  const speed = mag(velocity);
  if (speed < EPS) return properAcceleration;
  const g = gammaFromVelocity(velocity);
  const vh = mul(velocity, 1 / speed);
  const aParallel = mul(vh, dot(properAcceleration, vh));
  const aPerp = sub(properAcceleration, aParallel);
  return add(mul(aParallel, 1 / (g * g * g)), mul(aPerp, 1 / (g * g)));
}

export function integrateRelativistic(entity, properAcceleration, dt, maxBeta = 0.985) {
  const a = coordinateAccelerationFromProper(properAcceleration, entity.vel);
  entity.vel = limitVelocity(add(entity.vel, mul(a, dt)), maxBeta);
  entity.pos = add(entity.pos, mul(entity.vel, dt));
  entity.properTime += properTimeStep(dt, entity.vel);
}

// Transform a target coordinate velocity u into the instantaneous rest frame of an observer
// moving at velocity obsVel. Exact 2D Lorentz velocity transformation for a boost along obsVel.
export function velocityInObserverFrame(u, obsVel) {
  const vObsSpeed = mag(obsVel);
  if (vObsSpeed < EPS) return u;

  const n = mul(obsVel, 1 / vObsSpeed);
  const uParallelScalar = dot(u, n);
  const uParallel = mul(n, uParallelScalar);
  const uPerp = sub(u, uParallel);
  const betaObs = clamp(vObsSpeed / C, 0, 0.999999);
  const gammaObs = 1 / Math.sqrt(1 - betaObs * betaObs);
  const denom = Math.max(1 - (uParallelScalar * vObsSpeed) / C2, 1e-6);
  const transformedParallel = mul(n, (uParallelScalar - vObsSpeed) / denom);
  const transformedPerp = mul(uPerp, 1 / (gammaObs * denom));
  return limitVelocity(add(transformedParallel, transformedPerp), 0.999);
}

export function relativeGamma(u, obsVel) {
  return gammaFromVelocity(velocityInObserverFrame(u, obsVel));
}

export function lengthContractionFactor(u, obsVel) {
  return 1 / relativeGamma(u, obsVel);
}

export function dopplerFactor(sourcePos, sourceVel, observerPos, observerVel) {
  const line = normalize(sub(sourcePos, observerPos));
  const relVel = velocityInObserverFrame(sourceVel, observerVel);
  const radialBeta = clamp(dot(relVel, line) / C, -0.98, 0.98); // positive = receding
  return Math.sqrt((1 - radialBeta) / (1 + radialBeta));
}

export function aberrationAngle(angle, observerVel) {
  const beta = speedBeta(observerVel);
  if (beta < EPS) return angle;
  const obsAngle = Math.atan2(observerVel.y, observerVel.x);
  const theta = angle - obsAngle;
  const cosPrime = clamp((Math.cos(theta) - beta) / (1 - beta * Math.cos(theta)), -1, 1);
  const sinSign = Math.sign(Math.sin(theta)) || 1;
  const thetaPrime = sinSign * Math.acos(cosPrime);
  return thetaPrime + obsAngle;
}

export function findRetardedSnapshot(history, observerPos, observerTime, c = C) {
  if (!history || history.length === 0) return null;
  if (history.length === 1) return history[0];

  // f(t_emit) = observerTime - t_emit - distance/c. We solve using coordinate-time
  // when present, and fall back robustly when history is non-monotonic in t_emit.
  const emitTime = (h) => h.coordTime ?? h.t;
  let best = history[history.length - 1];
  let bestErr = Infinity;

  const score = (h) => observerTime - emitTime(h) - mag(sub(h.pos, observerPos)) / c;
  for (const h of history) {
    const f = score(h);
    if (emitTime(h) <= observerTime && Math.abs(f) < bestErr) {
      best = h;
      bestErr = Math.abs(f);
    }
  }

  for (let i = history.length - 2; i >= 0; i--) {
    const a = history[i];
    const b = history[i + 1];
    const fa = score(a);
    const fb = score(b);
    if ((fa <= 0 && fb >= 0) || (fa >= 0 && fb <= 0)) {
      const denom = fa - fb;
      const mix = Math.abs(denom) < 1e-9 ? 0 : fa / denom;
      return interpolateSnapshot(a, b, mix);
    }
  }

  return best ?? history[0];
}

export function interpolateSnapshot(a, b, mix) {
  const t = clamp(mix, 0, 1);
  return {
    t: lerp(a.t, b.t, t),
    coordTime: lerp(a.coordTime ?? a.t, b.coordTime ?? b.t, t),
    pos: lerpVec(a.pos, b.pos, t),
    vel: lerpVec(a.vel, b.vel, t),
    properTime: lerp(a.properTime, b.properTime, t),
    hue: lerp(a.hue ?? 180, b.hue ?? 180, t),
    radius: lerp(a.radius ?? 16, b.radius ?? 16, t),
    score: lerp(a.score ?? 0, b.score ?? 0, t),
    name: a.name ?? b.name,
    kind: a.kind ?? b.kind,
  };
}

export function snapshot(entity, t) {
  return {
    t,
    coordTime: entity.coordTime ?? t,
    pos: { ...entity.pos },
    vel: { ...entity.vel },
    properTime: entity.properTime,
    hue: entity.hue,
    radius: entity.radius,
    score: entity.score,
    name: entity.name,
    kind: entity.kind,
  };
}
