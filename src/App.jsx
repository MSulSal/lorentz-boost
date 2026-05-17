import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C, clamp } from './relativity';
import { createWorld, cyclePlayerTeam, getHud, rankEntities, stepWorld } from './world';
import { renderWorld } from './render';
import { createAudioSystem, destroyAudio, startAudio, updateAudio } from './audio';
import './styles.css';

const keyMap = {
  KeyA: 'a',
  KeyD: 'd',
  ArrowLeft: 'a',
  ArrowRight: 'd',
  Space: 'space',
  KeyP: 'p',
  KeyT: 't',
};

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

  const fish = 1 + 0.18 * Math.max(0, z2) * Math.max(0, z2);
  return {
    px: geom.cx + geom.r * x1 * fish,
    py: geom.cy - geom.r * y1 * fish,
    depth: z2,
  };
}

function MinimapOverlay({ world }) {
  const width = 218;
  const height = 164;
  const cx = width * 0.5;
  const cy = 88;
  const r = 56;
  const geom = { cx, cy, r, yaw: -0.78, pitch: 0.46 };
  const ranks = rankEntities(world);
  const placementById = new Map(ranks.map((r, idx) => [r.id, idx + 1]));
  const worldPhase = temporalPhase(world.player?.coordTime ?? world.t, world.finishT);
  const playerTimeDir = world.player?.timeDirection ?? 1;
  const playerTimeLabel = playerTimeDir >= 0 ? '+t' : '-t';

  const wallBack = [];
  const wallFront = [];
  const islandBack = [];
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
        const front = (pa.depth + pb.depth) * 0.5 >= 0;
        const seg = {
          key: `${wall.id}-${i}`,
          x1: pa.px,
          y1: pa.py,
          x2: pb.px,
          y2: pb.py,
          hue: wall.hue,
        };
        (front ? wallFront : wallBack).push(seg);
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
      (p.depth >= 0 ? islandFront : islandBack).push(bubble);
    }
  }

  const worldlineBack = [];
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
      const front = (pa.depth + pb.depth) * 0.5 >= 0;
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
      (front ? worldlineFront : worldlineBack).push(seg);
    }
  }

  const points = world.entities
    .map((entity) => {
      const p = spherePointFromXT(entity.pos.x, entity.coordTime ?? world.t, world, geom);
      const px = p.px;
      const py = p.py;
      const front = p.depth >= 0;
      const hue = (entity.team?.primaryHue ?? entity.hue) + dopplerHueShift1D(entity.pos.x, entity.vel.x, world);
      return { entity, px, py, front, hue };
    })
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

        {wallBack.map((seg) => (
          <line
            key={seg.key}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={hueColor(seg.hue, 0.54)}
            strokeWidth={2.1}
            strokeLinecap="round"
          />
        ))}
        {islandBack.map((b) => (
          <circle key={b.key} cx={b.x} cy={b.y} r={b.r} fill={hueColor(b.hue, 0.48)} stroke={hueColor(b.hue + 8, 0.6)} strokeWidth="0.8" />
        ))}
        {worldlineBack.map((seg) => (
          <line
            key={seg.key}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={hueColor(seg.hue, 0.92)}
            strokeWidth={seg.w}
            strokeLinecap="round"
          />
        ))}

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

        {points.map(({ entity, px, py, front, hue }) => {
          const isPlayer = entity.id === world.player.id;
          const place = placementById.get(entity.id) ?? '-';
          return (
            <g key={entity.id}>
              <circle
                cx={px}
                cy={py}
                r={isPlayer ? 5 : 4}
                fill={hueColor(hue, 0.98)}
                stroke={isPlayer ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.86)'}
                strokeWidth={isPlayer ? 1.5 : 1}
              />
              <text
                x={px + 7}
                y={py - 5}
                fill={front ? 'rgba(230,245,255,0.92)' : 'rgba(182,206,226,0.9)'}
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
          <b>{r.kills ?? 0}K / {r.deaths ?? 0}D</b>
        </div>
      ))}
    </aside>
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
          Four rockets fight on a compactified 1+1D Minkowski-sphere arena with random spawn points and mixed temporal orientations: no start line, no finish line, only survival via past-worldline kills.
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
        <div className="meter-row"><span>team flag</span><b>{hud.teamName}</b></div>
        <div className="meter-row"><span>simulation</span><b>{world.paused ? 'PAUSED' : 'running'}</b></div>
        <div className="meter-row"><span>c</span><b>{C} sim-px/s</b></div>
      </section>

      <section className="panel controls">
        <h2>Controls</h2>
        <div><kbd>A</kbd><kbd>D</kbd><kbd>Left</kbd><kbd>Right</kbd> Lorentz steering and fuel burn</div>
        <div><kbd>Space</kbd> time reversal (x-axis reflection: face into past direction)</div>
        <div><kbd>Combat</kbd> all worldlines kill, including your own (paradox loops)</div>
        <div><kbd>Drops</kbd> events + dead-worldline fragments extend your lethal worldline</div>
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
  const worldRef = useRef(null);
  const audioRef = useRef(null);
  const cameraRef = useRef({ x: 0, zoom: 0.5 });
  const pauseLatch = useRef(false);
  const teamLatch = useRef(false);
  const spaceLatch = useRef(false);
  const [worldVersion, setWorldVersion] = useState(0);
  const [hudOpen, setHudOpen] = useState(false);
  const [opts, setOpts] = useState({
    finiteLight: true,
    lengthContraction: true,
    timeDilation: true,
    doppler: true,
    lightCones: true,
  });
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  if (!worldRef.current) worldRef.current = createWorld();
  if (!audioRef.current) audioRef.current = createAudioSystem();

  useEffect(() => {
    const armAudio = () => {
      startAudio(audioRef.current);
    };
    window.addEventListener('keydown', armAudio, { passive: true });
    window.addEventListener('pointerdown', armAudio, { passive: true });
    return () => {
      window.removeEventListener('keydown', armAudio);
      window.removeEventListener('pointerdown', armAudio);
      destroyAudio(audioRef.current);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let frameCount = 0;

    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const rawControls = keys.current;
      const controls = {
        ...rawControls,
        spacePressed: !!rawControls.space && !spaceLatch.current,
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

      stepWorld(worldRef.current, controls, dt);

      const playerX = worldRef.current.player.pos.x;
      const arenaX = worldRef.current.arenaX;
      const camDx = wrappedDeltaX(playerX, camera.x, arenaX);
      camera.x = wrapXToArena(camera.x + camDx * clamp(dt * 6.5, 0, 1), arenaX);

      const canvas = canvasRef.current;
      if (canvas) renderWorld(canvas, worldRef.current, camera, optsRef.current);
      updateAudio(audioRef.current, worldRef.current);

      frameCount += 1;
      if (frameCount % 8 === 0) setWorldVersion((v) => v + 1);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [keys]);

  const hudWorld = useMemo(() => worldRef.current, [worldVersion]);

  return (
    <main className="app">
      <canvas ref={canvasRef} className="game-canvas" />
      <LiveLeaderboard world={hudWorld} />
      <MinimapOverlay world={hudWorld} />
      <button
        className={`hud-toggle ${hudOpen ? 'open' : ''}`}
        onClick={() => setHudOpen((v) => !v)}
      >
        {hudOpen ? 'Hide HUD' : 'Show HUD'}
      </button>
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
        4-player compact Minkowski-sphere deathmatch: every worldline is lethal, spacetime events and dead traces extend your own trace, and Space flips your time direction.
      </div>
    </main>
  );
}
