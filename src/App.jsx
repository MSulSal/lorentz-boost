import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, clamp } from './relativity';
import { createWorld, cyclePlayerTeam, getHud, rankEntities, stepWorld } from './world';
import { renderWorld } from './render';
import { createAudioSystem, destroyAudio, setAudioMix as applyAudioMix, startAudio, updateAudio } from './audio';
import './styles.css';

const keyMap = {
  KeyA: 'a',
  KeyD: 'd',
  KeyW: 'zoomIn',
  KeyS: 'zoomOut',
  ArrowLeft: 'a',
  ArrowRight: 'd',
  ArrowUp: 'zoomIn',
  ArrowDown: 'zoomOut',
  Space: 'space',
  KeyP: 'p',
  KeyT: 't',
};

const CAMERA_ZOOM_DEFAULT = 1.9;
const CAMERA_ZOOM_MAX = 10.0;
const CAMERA_ZOOM_MIN_FALLBACK = 0.28;
const CAMERA_ZOOM_KEY_SPEED = 1.9;
const RENDER_PIXEL_SCALE = 3;
const RENDER_MIN_WIDTH = 320;
const RENDER_MIN_HEIGHT = 180;
const GAME_ASPECT = 16 / 9;
const PINCH_DISTANCE_EPS = 6;
const STEER_DEADZONE = 0.018;
const TILT_AXIS_GAIN = 1 / 18;
const MOTION_RATE_GAIN = 1 / 42;
const MOUSE_AXIS_GAIN = 1.95;
const MOUSE_DELTA_PIXELS = 26;
const AXIS_CURVE = 0.68;
const MOTION_AXIS_RECENT_MS = 240;

function isCoarsePointerDevice() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function applyDeadzone(axis, deadzone = STEER_DEADZONE) {
  const a = clamp(axis, -1, 1);
  return Math.abs(a) < deadzone ? 0 : a;
}

function shapeAxis(axis, gain = 1, curve = AXIS_CURVE) {
  const sign = Math.sign(axis) || 1;
  const mag = clamp(Math.abs(axis) * gain, 0, 1);
  return sign * Math.pow(mag, curve);
}

function renderBufferSize(canvas) {
  const displayWidth = canvas?.clientWidth ?? window.innerWidth ?? RENDER_MIN_WIDTH;
  const displayHeight = canvas?.clientHeight ?? window.innerHeight ?? RENDER_MIN_HEIGHT;
  const viewAspect = displayWidth / Math.max(1, displayHeight);
  let fitWidth = displayWidth;
  let fitHeight = displayHeight;
  if (viewAspect > GAME_ASPECT) {
    fitWidth = fitHeight * GAME_ASPECT;
  } else {
    fitHeight = fitWidth / GAME_ASPECT;
  }

  let width = Math.max(RENDER_MIN_WIDTH, Math.floor(fitWidth / RENDER_PIXEL_SCALE));
  let height = Math.max(RENDER_MIN_HEIGHT, Math.round(width / GAME_ASPECT));
  const heightFromFit = Math.max(RENDER_MIN_HEIGHT, Math.floor(fitHeight / RENDER_PIXEL_SCALE));
  if (heightFromFit > height) {
    height = heightFromFit;
    width = Math.max(RENDER_MIN_WIDTH, Math.round(height * GAME_ASPECT));
  }
  return {
    width,
    height,
  };
}

function zoomBoundsFor(world, canvas) {
  void world;
  void canvas;
  return { min: CAMERA_ZOOM_MIN_FALLBACK, max: CAMERA_ZOOM_MAX };
}

function useKeyboard() {
  const keys = useRef({});
  useEffect(() => {
    const down = (e) => {
      const k = keyMap[e.code];
      if (k) {
        keys.current[k] = true;
        e.preventDefault();
      }
    };
    const up = (e) => {
      const k = keyMap[e.code];
      if (k) {
        keys.current[k] = false;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up, { passive: false });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  return keys;
}

function fmt(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

function hueColor(h, a = 1) {
  const hue = ((h % 360) + 360) % 360;
  return `hsla(${hue}, 90%, 66%, ${a})`;
}

function normalizedWrapX(x, arenaX) {
  const span = arenaX * 2;
  return (((x + arenaX) % span) + span) % span / span;
}

function wrappedDeltaX(a, b, arenaX) {
  const span = arenaX * 2;
  let d = a - b;
  if (d > arenaX) d -= span;
  if (d < -arenaX) d += span;
  return d;
}

function wrapXToArena(x, arenaX) {
  const span = arenaX * 2;
  return ((((x + arenaX) % span) + span) % span) - arenaX;
}

function dopplerHueShift1D(x, vx, world) {
  const relX = wrappedDeltaX(x, world.player.pos.x, world.arenaX);
  const radialSign = Math.sign(relX) || 1;
  const radialBeta = clamp(((vx - world.player.vel.x) / C) * radialSign, -0.92, 0.92);
  const doppler = Math.sqrt((1 - radialBeta) / (1 + radialBeta));
  return clamp((doppler - 1) * 110, -84, 84);
}

function temporalPhase(t, period) {
  if (!(period > 0)) return t;
  return (((t % period) + period) % period);
}

function spherePointFromXT(x, t, world, geom) {
  const u = normalizedWrapX(x, world.arenaX);
  const phaseRaw = temporalPhase(t, world.finishT);
  const v = clamp(world.finishT > 0 ? phaseRaw / world.finishT : 0.5, 0, 1);
  const lon = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;

  const sx = Math.cos(lat) * Math.cos(lon);
  const sy = Math.sin(lat);
  const sz = Math.cos(lat) * Math.sin(lon);

  const cosYaw = Math.cos(geom.yaw);
  const sinYaw = Math.sin(geom.yaw);
  const x1 = sx * cosYaw - sz * sinYaw;
  const z1 = sx * sinYaw + sz * cosYaw;

  const cosPitch = Math.cos(geom.pitch);
  const sinPitch = Math.sin(geom.pitch);
  const y1 = sy * cosPitch - z1 * sinPitch;
  const z2 = sy * sinPitch + z1 * cosPitch;

  const perspective = geom.camDist / Math.max(0.2, geom.camDist - z2);
  return {
    px: geom.cx + geom.r * x1 * perspective,
    py: geom.cy - geom.r * y1 * perspective,
    depth: z2,
    front: z2 >= (geom.frontDepthThreshold ?? 0),
  };
}

function MinimapOverlay({ world }) {
  const width = 218;
  const height = 164;
  const cx = width * 0.5;
  const cy = 88;
  const r = 56;
  const playerU = normalizedWrapX(world.player?.pos?.x ?? 0, world.arenaX);
  const playerV = clamp(world.finishT > 0 ? temporalPhase(world.player?.coordTime ?? world.t, world.finishT) / world.finishT : 0.5, 0, 1);
  const playerLon = (playerU - 0.5) * Math.PI * 2;
  const playerLat = (playerV - 0.5) * Math.PI;
  const geom = {
    cx,
    cy,
    r,
    yaw: Math.PI * 0.5 - playerLon,
    pitch: playerLat,
    camDist: 4.8,
    frontDepthThreshold: -0.02,
  };
  const ranks = rankEntities(world);
  const placementById = new Map(ranks.map((r, idx) => [r.id, idx + 1]));
  const worldPhase = temporalPhase(world.player?.coordTime ?? world.t, world.finishT);
  const playerTimeDir = world.player?.timeDirection ?? 1;
  const playerTimeLabel = playerTimeDir >= 0 ? '+t' : '-t';

  const wallFront = [];
  const islandFront = [];
  if (world.course?.walls?.length) {
    for (const wall of world.course.walls) {
      const samples = wall.samples ?? [];
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (!a || !b) continue;
        if (Math.abs(b.x - a.x) > world.arenaX) continue;
        const pa = spherePointFromXT(a.x, a.t, world, geom);
        const pb = spherePointFromXT(b.x, b.t, world, geom);
        const front = pa.front && pb.front;
        const seg = {
          key: `${wall.id}-${i}`,
          x1: pa.px,
          y1: pa.py,
          x2: pb.px,
          y2: pb.py,
          hue: wall.hue,
        };
        if (front) wallFront.push(seg);
      }
    }
  }
  if (world.course?.islands?.length) {
    for (const island of world.course.islands) {
      const p = spherePointFromXT(island.x, island.t, world, geom);
      const r = clamp(island.radiusX / 92, 2.2, 6.4);
      const bubble = {
        key: island.id,
        x: p.px,
        y: p.py,
        r,
        hue: island.hue,
      };
      if (p.front) islandFront.push(bubble);
    }
  }

  const worldlineFront = [];
  for (const entity of world.entities) {
    const hist = entity.history ?? [];
    for (let i = 2; i < hist.length; i += 3) {
      const a = hist[i - 1];
      const b = hist[i];
      if (!a || !b) continue;
      if (a.t < 0 || b.t < 0) continue;
      if (Math.abs(b.pos.x - a.pos.x) > world.arenaX) continue;
      const pa = spherePointFromXT(a.pos.x, a.coordTime ?? a.t, world, geom);
      const pb = spherePointFromXT(b.pos.x, b.coordTime ?? b.t, world, geom);
      const front = pa.front && pb.front;
      const seg = {
        key: `${entity.id}-${i}`,
        x1: pa.px,
        y1: pa.py,
        x2: pb.px,
        y2: pb.py,
        hue: (entity.team?.primaryHue ?? entity.hue) + dopplerHueShift1D(
          (a.pos.x + b.pos.x) * 0.5,
          ((a.vel?.x ?? entity.vel.x) + (b.vel?.x ?? entity.vel.x)) * 0.5,
          world,
        ),
        w: entity.id === world.player.id ? 1.7 : 1.1,
      };
      if (front) worldlineFront.push(seg);
    }
  }

  const points = world.entities
    .map((entity) => {
      const p = spherePointFromXT(entity.pos.x, entity.coordTime ?? world.t, world, geom);
      const px = p.px;
      const py = p.py;
      const front = p.front;
      const hue = (entity.team?.primaryHue ?? entity.hue) + dopplerHueShift1D(entity.pos.x, entity.vel.x, world);
      return { entity, px, py, front, hue, inactive: !!entity.isRespawning };
    })
    .filter((p) => p.front)
    .sort((a, b) => {
      if (a.front === b.front) return a.py - b.py;
      return a.front ? 1 : -1;
    });

  return (
    <div className="minimap-overlay" aria-hidden="true">
      <div className="minimap-title">Minkowski Sphere Map</div>
      <svg className="minimap-svg" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <radialGradient id="sphereFill" cx="40%" cy="34%" r="72%">
            <stop offset="0%" stopColor="rgba(102, 206, 255, 0.2)" />
            <stop offset="100%" stopColor="rgba(50, 112, 162, 0.08)" />
          </radialGradient>
        </defs>

        <circle cx={cx} cy={cy} r={r} fill="url(#sphereFill)" stroke="rgba(138, 228, 255, 0.58)" strokeWidth="1.5" />
        <ellipse cx={cx} cy={cy} rx={r * 0.98} ry={r * 0.42} fill="none" stroke="rgba(132, 224, 255, 0.28)" strokeWidth="1.2" />
        <ellipse cx={cx} cy={cy} rx={r * 0.42} ry={r * 0.98} fill="none" stroke="rgba(255, 214, 152, 0.24)" strokeWidth="1.2" />

        {wallFront.map((seg) => (
          <line
            key={seg.key}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={hueColor(seg.hue, 0.82)}
            strokeWidth={2.1}
            strokeLinecap="round"
          />
        ))}
        {islandFront.map((b) => (
          <circle key={b.key} cx={b.x} cy={b.y} r={b.r} fill={hueColor(b.hue, 0.72)} stroke={hueColor(b.hue + 8, 0.92)} strokeWidth="0.8" />
        ))}
        {worldlineFront.map((seg) => (
          <line
            key={seg.key}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={hueColor(seg.hue, 0.96)}
            strokeWidth={seg.w}
            strokeLinecap="round"
          />
        ))}
        <text x={cx} y={cy - r - 9} textAnchor="middle" fill="rgba(255, 220, 155, 0.92)" fontSize="9" fontFamily="ui-monospace, monospace">
          t seam
        </text>
        <text x={cx} y={cy + r + 13} textAnchor="middle" fill="rgba(170, 234, 255, 0.9)" fontSize="9" fontFamily="ui-monospace, monospace">
          x seam
        </text>
        <text x={12} y={18} fill="rgba(170, 234, 255, 0.86)" fontSize="9" fontFamily="ui-monospace, monospace">
          phase={fmt(worldPhase, 1)}
        </text>
        <text x={width - 12} y={18} textAnchor="end" fill="rgba(255, 220, 155, 0.9)" fontSize="9" fontFamily="ui-monospace, monospace">
          you:{playerTimeLabel}
        </text>

        {points.map(({ entity, px, py, front, hue, inactive }) => {
          const isPlayer = entity.id === world.player.id;
          const place = placementById.get(entity.id) ?? '-';
          return (
            <g key={entity.id}>
              <circle
                cx={px}
                cy={py}
                r={isPlayer ? 5 : 4}
                fill={hueColor(hue, inactive ? 0.34 : 0.98)}
                stroke={isPlayer ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.86)'}
                strokeWidth={isPlayer ? 1.5 : 1}
              />
              <text
                x={px + 7}
                y={py - 5}
                fill={inactive ? 'rgba(182,206,226,0.48)' : (front ? 'rgba(230,245,255,0.92)' : 'rgba(182,206,226,0.9)')}
                fontSize="8"
                fontFamily="ui-monospace, monospace"
              >
                {place}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LiveLeaderboard({ world }) {
  const ranks = rankEntities(world).slice(0, 8);
  return (
    <aside className="live-leaderboard panel" aria-label="Leaderboard">
      <h2>Leaderboard</h2>
      {ranks.map((r, i) => (
        <div className="live-rank" key={r.id}>
          <span>{i + 1}. {r.name}</span>
          <b>{r.kills ?? 0}K / {r.deaths ?? 0}D / {r.fleetSize ?? 1}F / {r.fleetRescues ?? 0}C / {r.fleetLosses ?? 0}L</b>
        </div>
      ))}
    </aside>
  );
}

function BrandBanner() {
  return (
    <header className="brand-banner" aria-label="Game title">
      <div className="pixel-logo">LORENTZ BOOST</div>
      <div className="brand-sub">relativistic fleet arena</div>
    </header>
  );
}

function AudioDock({ audioMix, setAudioMix }) {
  const pct = (v) => Math.round((v ?? 1) * 100);
  return (
    <aside className="audio-dock panel" aria-label="Audio controls">
      <h2>Audio</h2>
      <div className="audio-row">
        <span>master</span>
        <b>{pct(audioMix.master)}%</b>
      </div>
      <input
        type="range"
        min="0"
        max="140"
        step="1"
        value={pct(audioMix.master)}
        onChange={(e) => setAudioMix((m) => ({ ...m, master: Number(e.target.value) / 100 }))}
      />
      <div className="audio-row">
        <span>music</span>
        <b>{pct(audioMix.music)}%</b>
      </div>
      <input
        type="range"
        min="0"
        max="140"
        step="1"
        value={pct(audioMix.music)}
        onChange={(e) => setAudioMix((m) => ({ ...m, music: Number(e.target.value) / 100 }))}
      />
      <div className="audio-row">
        <span>thrusters + Doppler</span>
        <b>{pct(audioMix.thrusters)}%</b>
      </div>
      <input
        type="range"
        min="0"
        max="140"
        step="1"
        value={pct(audioMix.thrusters)}
        onChange={(e) => setAudioMix((m) => ({ ...m, thrusters: Number(e.target.value) / 100 }))}
      />
    </aside>
  );
}

function MobilePauseButton({ paused, onTogglePause }) {
  return (
    <button type="button" className="mobile-pause-btn" onClick={onTogglePause} aria-label={paused ? 'Resume simulation' : 'Pause simulation'}>
      {paused ? 'RESUME' : 'PAUSE'}
    </button>
  );
}

function Hud({ world, opts, setOpts, onTogglePause, onCycleTeam }) {
  const hud = getHud(world);
  return (
    <div className="hud">
      <section className="panel hero-panel">
        <div className="kicker">lorentz-boost / 1+1D spacetime sphere deathmatch</div>
        <h1>Past-worldline combat arena</h1>
        <p>
          Sixteen rockets fight on a compactified 1+1D Minkowski-sphere arena with random spawn points and mixed temporal orientations: no start line, no finish line, only survival via past-worldline kills.
        </p>
      </section>

      <section className="panel meters">
        <div className="meter-row"><span>beta = |v| / c</span><b>{fmt(hud.beta, 3)}</b></div>
        <div className="bar"><i style={{ width: `${clamp(hud.beta * 100, 0, 100)}%` }} /></div>
        <div className="meter-row"><span>fuel reservoir</span><b>{fmt(hud.boostEnergy, 0)}%</b></div>
        <div className="bar boost"><i style={{ width: `${clamp((hud.boostEnergy / 140) * 100, 0, 100)}%` }} /></div>
        <div className="meter-row"><span>trace points</span><b>{fmt(hud.tracePoints, 0)}</b></div>
        <div className="meter-row"><span>trail lifetime</span><b>{fmt(hud.trailLifetime, 1)}s</b></div>
        <div className="meter-row"><span>hull integrity</span><b>{fmt(hud.hp, 0)}%</b></div>
        <div className="bar"><i style={{ width: `${clamp(hud.hp, 0, 100)}%` }} /></div>
        <div className="meter-row"><span>Lorentz gamma</span><b>{fmt(hud.gamma, 3)}</b></div>
        <div className="meter-row"><span>coordinate time t</span><b>{fmt(hud.coordTime, 1)}s</b></div>
        <div className="meter-row"><span>simulation clock</span><b>{fmt(world.t, 1)}s</b></div>
        <div className="meter-row"><span>sphere period T</span><b>{fmt(hud.raceFinishT, 1)}s</b></div>
        <div className="meter-row"><span>sphere phase</span><b>{fmt(hud.raceRemaining, 1)}s</b></div>
        <div className="meter-row"><span>time direction</span><b>{hud.timeDirection >= 0 ? '+t' : '-t'}</b></div>
        <div className="meter-row"><span>proper time tau</span><b>{fmt(hud.properTime, 1)}s</b></div>
        <div className="meter-row"><span>d(ct)/dtau</span><b>{fmt(hud.fourTime, 0)}</b></div>
        <div className="meter-row"><span>gamma*v</span><b>{fmt(hud.fourSpace, 0)}</b></div>
        <div className="meter-row"><span>combat points</span><b>{fmt(hud.score, 0)}</b></div>
        <div className="meter-row"><span>placement</span><b>{hud.placement ?? '--'}</b></div>
        <div className="meter-row"><span>mode</span><b>DEATHMATCH</b></div>
        <div className="meter-row"><span>kills / deaths</span><b>{hud.playerKills} / {hud.playerDeaths}</b></div>
        <div className="meter-row"><span>fleet captures / losses</span><b>{hud.playerFleetCaptures ?? 0} / {hud.playerFleetLosses ?? 0}</b></div>
        <div className="meter-row"><span>reserve (captures-losses)</span><b>{(hud.playerFleetCaptures ?? 0) - (hud.playerFleetLosses ?? 0)}</b></div>
        <div className="meter-row"><span>fleet reserve</span><b>{hud.playerFleetReserve ?? 0}</b></div>
        <div className="meter-row"><span>fleet size</span><b>{hud.playerFleetSize ?? 1}</b></div>
        <div className="meter-row"><span>team flag</span><b>{hud.teamName}</b></div>
        <div className="meter-row"><span>respawn</span><b>{hud.isRespawning ? `${fmt(hud.respawnRemaining, 1)}s` : 'active'}</b></div>
        <div className="meter-row"><span>simulation</span><b>{world.paused ? 'PAUSED' : 'running'}</b></div>
        <div className="meter-row"><span>c</span><b>{C} sim-px/s</b></div>
      </section>

      <section className="panel controls">
        <h2>Controls</h2>
        <div><kbd>Mouse move</kbd> move right/left to steer right/left on desktop</div>
        <div><kbd>Phone tilt</kbd> rotate right/left to steer right/left on mobile</div>
        <div><kbd>A</kbd><kbd>D</kbd><kbd>Left</kbd><kbd>Right</kbd> keyboard steering fallback</div>
        <div><kbd>LMB</kbd> desktop left-click reverse pulse, <kbd>tap screen</kbd> mobile reverse pulse</div>
        <div><kbd>W</kbd><kbd>S</kbd><kbd>Up</kbd><kbd>Down</kbd> or <kbd>mouse wheel</kbd> zoom spacetime view (pinch to zoom on mobile)</div>
        <div><kbd>Space</kbd> time reversal (x-axis reflection: face into past direction)</div>
        <div><kbd>Pole wrap</kbd> crossing temporal seam auto-reflects time direction and remaps to antipodal hemisphere</div>
        <div><kbd>Combat</kbd> all worldlines kill, including your own (paradox loops)</div>
        <div><kbd>Fleet</kbd> tail-kill opponents to capture a ship into your head formation reserve</div>
        <div><kbd>Formation</kbd> reserve ships render in triangular lead formation and expand hitbox</div>
        <div><kbd>Drops</kbd> events + dead-worldline fragments extend your lethal worldline and add speed</div>
        <div><kbd>Respawn</kbd> cooldown only triggers on full fleet wipe</div>
        <div><kbd>Audio</kbd> click or press any key once to arm Doppler rocket sound</div>
        <div><kbd>P</kbd> pause / resume</div>
        <div><kbd>T</kbd> cycle team colors + flag</div>
      </section>

      <section className="panel toggles">
        <h2>Physics Layers</h2>
        <button className="view-button secondary" onClick={onTogglePause}>
          {world.paused ? 'Resume simulation' : 'Pause simulation'}
        </button>
        <button className="view-button tertiary" onClick={onCycleTeam}>
          Switch team flag (T)
        </button>
        {[
          ['finiteLight', 'retarded visibility / past light cone'],
          ['lengthContraction', 'length contraction'],
          ['timeDilation', 'proper-time tick cues'],
          ['doppler', 'Doppler hue shift'],
          ['lightCones', 'light-cone boundaries'],
        ].map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={opts[key]} onChange={(e) => setOpts((o) => ({ ...o, [key]: e.target.checked }))} />
            <span>{label}</span>
          </label>
        ))}
      </section>

    </div>
  );
}

export default function App() {
  const canvasRef = useRef(null);
  const keys = useKeyboard();
  const touchRef = useRef({ reversePulse: false });
  const mouseRef = useRef({ axis: 0, active: false, reversePulse: false, lastX: null, lastMoveAt: 0 });
  const motionRef = useRef({ axis: 0, active: false, lastUpdateAt: 0, sawSensorData: false, requestPermission: null });
  const pinchRef = useRef({
    pointers: new Map(),
    startDistance: 0,
    startZoom: CAMERA_ZOOM_DEFAULT,
  });
  const worldRef = useRef(null);
  const audioRef = useRef(null);
  const cameraRef = useRef({ x: 0, zoom: CAMERA_ZOOM_DEFAULT });
  const pauseLatch = useRef(false);
  const teamLatch = useRef(false);
  const spaceLatch = useRef(false);
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => isCoarsePointerDevice());
  const [motionStatus, setMotionStatus] = useState('unknown');
  const [worldVersion, setWorldVersion] = useState(0);
  const [hudOpen, setHudOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [opts, setOpts] = useState({
    finiteLight: true,
    lengthContraction: true,
    timeDilation: true,
    doppler: true,
    lightCones: true,
  });
  const [audioMix, setAudioMix] = useState({
    master: 1.05,
    music: 1.1,
    thrusters: 1.06,
  });
  const optsRef = useRef(opts);
  const audioMixRef = useRef(audioMix);

  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  useEffect(() => {
    audioMixRef.current = audioMix;
    applyAudioMix(audioRef.current, audioMix);
  }, [audioMix]);

  if (!worldRef.current) worldRef.current = createWorld();
  if (!audioRef.current) audioRef.current = createAudioSystem();

  const requestMotionAccess = useCallback(async () => {
    const req = motionRef.current.requestPermission;
    if (!req) return false;
    setMotionStatus((s) => (s === 'granted' ? s : 'requesting'));
    try {
      const granted = await req();
      setMotionStatus(granted ? 'granted' : 'denied');
      return granted;
    } catch {
      setMotionStatus('error');
      return false;
    }
  }, []);

  useEffect(() => {
    const armAudio = () => {
      startAudio(audioRef.current);
      applyAudioMix(audioRef.current, audioMixRef.current);
      void requestMotionAccess();
    };
    window.addEventListener('keydown', armAudio, { passive: true });
    window.addEventListener('pointerdown', armAudio, { passive: true });
    return () => {
      window.removeEventListener('keydown', armAudio);
      window.removeEventListener('pointerdown', armAudio);
      destroyAudio(audioRef.current);
    };
  }, [requestMotionAccess]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const update = () => setIsCoarsePointer(!!mq.matches);
    update();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener?.(update);
    return () => mq.removeListener?.(update);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const pinch = pinchRef.current;

    const pin = (e) => ({ x: e.clientX, y: e.clientY });

    const onPointerDown = (e) => {
      if (e.pointerType !== 'touch') return;
      pinch.pointers.set(e.pointerId, pin(e));
      if (pinch.pointers.size === 1) {
        touchRef.current.reversePulse = true;
      }
      if (pinch.pointers.size === 2) {
        const [a, b] = [...pinch.pointers.values()];
        pinch.startDistance = Math.hypot(b.x - a.x, b.y - a.y);
        pinch.startZoom = cameraRef.current.zoom;
      }
    };

    const onPointerMove = (e) => {
      if (e.pointerType !== 'touch') return;
      if (!pinch.pointers.has(e.pointerId)) return;
      pinch.pointers.set(e.pointerId, pin(e));
      if (pinch.pointers.size < 2 || pinch.startDistance < PINCH_DISTANCE_EPS) return;
      const [a, b] = [...pinch.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(dist > PINCH_DISTANCE_EPS)) return;
      const zoomScale = dist / pinch.startDistance;
      const bounds = zoomBoundsFor(worldRef.current, canvas);
      cameraRef.current.zoom = clamp(pinch.startZoom * zoomScale, bounds.min, bounds.max);
      e.preventDefault();
    };

    const onPointerUp = (e) => {
      if (e.pointerType !== 'touch') return;
      pinch.pointers.delete(e.pointerId);
      if (pinch.pointers.size < 2) {
        pinch.startDistance = 0;
        pinch.startZoom = cameraRef.current.zoom;
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp, { passive: false });
    canvas.addEventListener('pointercancel', onPointerUp, { passive: false });
    canvas.addEventListener('pointerleave', onPointerUp, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerUp);
      pinch.pointers.clear();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const onWheel = (e) => {
      const deltaY = Number.isFinite(e.deltaY) ? e.deltaY : 0;
      if (deltaY === 0) return;
      const zoomBounds = zoomBoundsFor(worldRef.current, canvas);
      const direction = deltaY < 0 ? 1 : -1;
      const strength = clamp(Math.abs(deltaY) / 120, 0.2, 3.2);
      const zoomScale = Math.exp(direction * CAMERA_ZOOM_KEY_SPEED * 0.12 * strength);
      cameraRef.current.zoom = clamp(cameraRef.current.zoom * zoomScale, zoomBounds.min, zoomBounds.max);
      e.preventDefault();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const motion = motionRef.current;
    const ctor = window.DeviceOrientationEvent;
    const motionCtor = window.DeviceMotionEvent;
    if (!window.isSecureContext) {
      motion.requestPermission = null;
      motion.active = false;
      motion.axis = 0;
      motion.lastUpdateAt = 0;
      motion.sawSensorData = false;
      setMotionStatus('insecure');
      return undefined;
    }
    if (!ctor) {
      motion.requestPermission = null;
      motion.active = false;
      motion.axis = 0;
      motion.lastUpdateAt = 0;
      motion.sawSensorData = false;
      setMotionStatus('unsupported');
      return undefined;
    }
    setMotionStatus((s) => (s === 'granted' ? s : 'unknown'));

    const readScreenAngle = () => {
      const angle = window.screen?.orientation?.angle;
      if (Number.isFinite(angle)) return Number(angle);
      const legacy = window.orientation;
      return Number.isFinite(legacy) ? Number(legacy) : 0;
    };

    const angleBucket = () => {
      const a = ((readScreenAngle() % 360) + 360) % 360;
      if (a >= 45 && a < 135) return 90;
      if (a >= 135 && a < 225) return 180;
      if (a >= 225 && a < 315) return 270;
      return 0;
    };

    const axisFromOrientation = (beta, gamma) => {
      const b = Number.isFinite(beta) ? beta : 0;
      const g = Number.isFinite(gamma) ? gamma : 0;
      const bucket = angleBucket();
      if (bucket === 90) return -b * TILT_AXIS_GAIN;
      if (bucket === 270) return b * TILT_AXIS_GAIN;
      if (bucket === 180) return -g * TILT_AXIS_GAIN;
      return g * TILT_AXIS_GAIN;
    };

    const axisFromRotationRate = (betaRate, gammaRate) => {
      const b = Number.isFinite(betaRate) ? betaRate : 0;
      const g = Number.isFinite(gammaRate) ? gammaRate : 0;
      const bucket = angleBucket();
      if (bucket === 90) return -b * MOTION_RATE_GAIN;
      if (bucket === 270) return b * MOTION_RATE_GAIN;
      if (bucket === 180) return -g * MOTION_RATE_GAIN;
      return g * MOTION_RATE_GAIN;
    };

    const updateAxis = (axisRaw) => {
      const axis = applyDeadzone(shapeAxis(clamp(axisRaw, -1, 1)));
      if (axis === 0) {
        motion.axis = 0;
      } else {
        motion.axis = motion.axis * 0.32 + axis * 0.68;
      }
      motion.active = true;
      motion.sawSensorData = true;
      motion.lastUpdateAt = performance.now();
      setMotionStatus((s) => (s === 'granted' ? s : 'granted'));
    };

    const onOrientation = (e) => {
      if (!Number.isFinite(e?.beta) && !Number.isFinite(e?.gamma)) return;
      updateAxis(-axisFromOrientation(e.beta, e.gamma));
    };

    const onMotion = (e) => {
      const rr = e?.rotationRate;
      if (!rr) return;
      const axisRaw = -axisFromRotationRate(rr.beta, rr.gamma);
      updateAxis(axisRaw);
    };

    let attached = false;
    const attach = () => {
      if (attached) return;
      window.addEventListener('deviceorientation', onOrientation, true);
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('devicemotion', onMotion, true);
      attached = true;
    };

    const requestOne = async (permissionCtor) => {
      if (!permissionCtor || typeof permissionCtor.requestPermission !== 'function') return 'unsupported';
      try {
        return await permissionCtor.requestPermission();
      } catch {
        return 'denied';
      }
    };

    motion.requestPermission = async () => {
      try {
        const [orientationPermission, motionPermission] = await Promise.all([
          requestOne(ctor),
          requestOne(motionCtor),
        ]);
        const orientationOkay = orientationPermission === 'granted' || orientationPermission === 'unsupported';
        const motionOkay = motionPermission === 'granted' || motionPermission === 'unsupported';
        if (!orientationOkay && !motionOkay) return false;
        attach();
        return true;
      } catch {
        return false;
      }
    };

    if (typeof ctor.requestPermission !== 'function') {
      attach();
    }

    return () => {
      if (attached) window.removeEventListener('deviceorientation', onOrientation, true);
      if (attached) window.removeEventListener('deviceorientationabsolute', onOrientation, true);
      if (attached) window.removeEventListener('devicemotion', onMotion, true);
      motion.requestPermission = null;
      motion.active = false;
      motion.axis = 0;
      motion.lastUpdateAt = 0;
      motion.sawSensorData = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === 'undefined') return undefined;
    const mouse = mouseRef.current;

    const axisFromClientX = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      const half = Math.max(1, rect.width * 0.5);
      const axis = -((clientX - (rect.left + half)) / half);
      return applyDeadzone(shapeAxis(axis, MOUSE_AXIS_GAIN));
    };

    const axisFromDeltaX = (deltaX) => {
      const raw = -deltaX / MOUSE_DELTA_PIXELS;
      return applyDeadzone(shapeAxis(raw, MOUSE_AXIS_GAIN));
    };

    const onPointerMove = (e) => {
      if (e.pointerType !== 'mouse') return;
      mouse.active = true;
      const dx = Number.isFinite(mouse.lastX) ? e.clientX - mouse.lastX : 0;
      mouse.lastX = e.clientX;
      const axis = axisFromDeltaX(dx);
      mouse.axis = mouse.axis * 0.32 + axis * 0.68;
      mouse.lastMoveAt = performance.now();
    };
    const onPointerLeave = (e) => {
      if (e.pointerType !== 'mouse') return;
      mouse.active = false;
      mouse.axis = 0;
      mouse.lastX = null;
    };
    const onPointerDown = (e) => {
      if (e.pointerType !== 'mouse') return;
      mouse.active = true;
      mouse.lastX = e.clientX;
      mouse.lastMoveAt = performance.now();
      mouse.axis = axisFromClientX(e.clientX);
      if (e.button === 0) {
        mouse.reversePulse = true;
        e.preventDefault();
      }
    };
    const onWindowLeave = () => {
      mouse.active = false;
      mouse.axis = 0;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
    canvas.addEventListener('pointercancel', onPointerLeave, { passive: true });
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    window.addEventListener('mouseleave', onWindowLeave, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointercancel', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('mouseleave', onWindowLeave);
      mouse.active = false;
      mouse.axis = 0;
      mouse.lastX = null;
      mouse.reversePulse = false;
      mouse.lastMoveAt = 0;
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let frameCount = 0;

    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const keySteerAxis = (keys.current.a ? 1 : 0) - (keys.current.d ? 1 : 0);
      const motionRecent = (now - (motionRef.current.lastUpdateAt ?? 0)) < MOTION_AXIS_RECENT_MS;
      const motionSteerAxis = motionRef.current.active && motionRecent ? (motionRef.current.axis ?? 0) : 0;
      const mouseRecent = (now - (mouseRef.current.lastMoveAt ?? 0)) < 120;
      const mouseSteerAxis = !isCoarsePointer && mouseRef.current.active && mouseRecent ? (mouseRef.current.axis ?? 0) : 0;
      const preferredAxis = Math.abs(motionSteerAxis) > 0.0001
        ? motionSteerAxis
        : (Math.abs(mouseSteerAxis) > 0.0001 ? mouseSteerAxis : keySteerAxis);
      const steerAxis = applyDeadzone(preferredAxis);
      const mouseReversePulse = !isCoarsePointer && mouseRef.current.reversePulse;
      mouseRef.current.reversePulse = false;
      const touchReversePulse = touchRef.current.reversePulse;
      touchRef.current.reversePulse = false;

      const rawControls = {
        a: steerAxis < -STEER_DEADZONE,
        d: steerAxis > STEER_DEADZONE,
        steerAxis,
        space: !!keys.current.space,
        zoomIn: !!keys.current.zoomIn,
        zoomOut: !!keys.current.zoomOut,
        p: !!keys.current.p,
        t: !!keys.current.t,
      };
      const controls = {
        ...rawControls,
        spacePressed: (!!rawControls.space && !spaceLatch.current) || mouseReversePulse || touchReversePulse,
      };
      spaceLatch.current = !!rawControls.space;
      const camera = cameraRef.current;

      if (controls.p && !pauseLatch.current) {
        worldRef.current.paused = !worldRef.current.paused;
        setWorldVersion((v) => v + 1);
      }
      pauseLatch.current = !!controls.p;

      if (controls.t && !teamLatch.current) {
        cyclePlayerTeam(worldRef.current);
        setWorldVersion((v) => v + 1);
      }
      teamLatch.current = !!controls.t;

      const zoomDir = (rawControls.zoomIn ? 1 : 0) - (rawControls.zoomOut ? 1 : 0);
      const zoomBounds = zoomBoundsFor(worldRef.current, canvasRef.current);
      if (zoomDir !== 0) {
        const zoomScale = Math.exp(zoomDir * CAMERA_ZOOM_KEY_SPEED * dt);
        camera.zoom = clamp(camera.zoom * zoomScale, zoomBounds.min, zoomBounds.max);
      } else {
        camera.zoom = clamp(camera.zoom, zoomBounds.min, zoomBounds.max);
      }
      camera.minZoom = zoomBounds.min;
      camera.maxZoom = zoomBounds.max;

      stepWorld(worldRef.current, controls, dt);

      const playerX = worldRef.current.player.pos.x;
      const arenaX = worldRef.current.arenaX;
      const camDx = wrappedDeltaX(playerX, camera.x, arenaX);
      camera.x = wrapXToArena(camera.x + camDx * clamp(dt * 6.5, 0, 1), arenaX);

      const canvas = canvasRef.current;
      if (canvas) renderWorld(canvas, worldRef.current, camera, optsRef.current);
      applyAudioMix(audioRef.current, audioMixRef.current);
      updateAudio(audioRef.current, worldRef.current);

      frameCount += 1;
      if (frameCount % 8 === 0) setWorldVersion((v) => v + 1);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [keys, isCoarsePointer]);

  const hudWorld = useMemo(() => worldRef.current, [worldVersion]);

  return (
    <main className="app">
      <canvas ref={canvasRef} className="game-canvas" />
      <BrandBanner />
      <LiveLeaderboard world={hudWorld} />
      <MinimapOverlay world={hudWorld} />
      {audioOpen && <AudioDock audioMix={audioMix} setAudioMix={setAudioMix} />}
      {isCoarsePointer && (
        <MobilePauseButton
          paused={hudWorld.paused}
          onTogglePause={() => {
            worldRef.current.paused = !worldRef.current.paused;
            setWorldVersion((v) => v + 1);
          }}
        />
      )}
      <div className="top-left-controls">
        <button
          className={`hud-toggle ${hudOpen ? 'open' : ''}`}
          onClick={() => setHudOpen((v) => !v)}
        >
          {hudOpen ? 'Hide HUD' : 'Show HUD'}
        </button>
        <button
          className={`audio-toggle ${audioOpen ? 'open' : ''}`}
          onClick={() => setAudioOpen((v) => !v)}
        >
          {audioOpen ? 'Hide Audio' : 'Audio'}
        </button>
        {isCoarsePointer && motionStatus !== 'granted' && (
          <button
            className={`motion-toggle ${motionStatus === 'requesting' ? 'open' : ''}`}
            onClick={() => { void requestMotionAccess(); }}
          >
            {motionStatus === 'insecure'
              ? 'Tilt Needs HTTPS'
              : motionStatus === 'unsupported'
                ? 'Tilt Unavailable'
                : motionStatus === 'requesting'
                  ? 'Enabling Tilt...'
                  : 'Enable Tilt'}
          </button>
        )}
      </div>
      {hudOpen && (
        <Hud
          world={hudWorld}
          opts={opts}
          setOpts={setOpts}
          onTogglePause={() => {
            worldRef.current.paused = !worldRef.current.paused;
            setWorldVersion((v) => v + 1);
          }}
          onCycleTeam={() => {
            cyclePlayerTeam(worldRef.current);
            setWorldVersion((v) => v + 1);
          }}
        />
      )}
      <div className={`caption ${hudWorld.paused ? 'paused' : ''}`}>
        {hudWorld.paused ? 'PAUSED - press P to resume. ' : ''}
        16-player compact Minkowski-sphere deathmatch: every worldline is lethal, tail kills add ships to your triangular head fleet, spacetime events and dead traces extend your own trace, and Space flips your time direction.
      </div>
    </main>
  );
}

