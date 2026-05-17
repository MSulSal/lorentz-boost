import { C, clamp, dopplerFactor } from './relativity';

const THRUST_SAMPLE_URL = new URL('./assets/audio/rocket_engine_cc0.wav', import.meta.url).href;
const BGM_SAMPLE_URL = new URL('./assets/audio/space_echo_cc0.ogg', import.meta.url).href;

function wrappedDeltaX(a, b, arenaX) {
  const span = arenaX * 2;
  let d = a - b;
  if (d > arenaX) d -= span;
  if (d < -arenaX) d += span;
  return d;
}

function ensureContext(audio) {
  if (audio.ctx) return true;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return false;
  const ctx = new AudioCtx();
  const master = ctx.createGain();
  master.gain.value = 0.0001;
  master.connect(ctx.destination);
  audio.ctx = ctx;
  audio.master = master;
  return true;
}

async function ensureSample(audio) {
  if (audio.sampleBuffer) return audio.sampleBuffer;
  if (audio.samplePromise) return audio.samplePromise;
  if (!audio.ctx) return null;
  audio.samplePromise = (async () => {
    const resp = await fetch(THRUST_SAMPLE_URL);
    const data = await resp.arrayBuffer();
    const decoded = await audio.ctx.decodeAudioData(data);
    audio.sampleBuffer = decoded;
    return decoded;
  })().catch(() => null);
  return audio.samplePromise;
}

async function ensureMusic(audio) {
  if (audio.bgmBuffer) return audio.bgmBuffer;
  if (audio.bgmPromise) return audio.bgmPromise;
  if (!audio.ctx) return null;
  audio.bgmPromise = (async () => {
    const resp = await fetch(BGM_SAMPLE_URL);
    const data = await resp.arrayBuffer();
    const decoded = await audio.ctx.decodeAudioData(data);
    audio.bgmBuffer = decoded;
    return decoded;
  })().catch(() => null);
  return audio.bgmPromise;
}

function startBgm(audio) {
  if (!audio.ctx || !audio.bgmBuffer || audio.bgmSource) return;
  const source = audio.ctx.createBufferSource();
  const gain = audio.ctx.createGain();
  source.buffer = audio.bgmBuffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.max(0.01, audio.bgmBuffer.duration);
  gain.gain.value = 0.0001;
  source.connect(gain);
  gain.connect(audio.master);
  source.start();
  audio.bgmSource = source;
  audio.bgmGain = gain;
}

function stopBgm(audio) {
  if (!audio?.ctx || !audio.bgmSource || !audio.bgmGain) return;
  const now = audio.ctx.currentTime;
  audio.bgmGain.gain.cancelScheduledValues(now);
  audio.bgmGain.gain.setTargetAtTime(0.0001, now, 0.08);
  try {
    audio.bgmSource.stop(now + 0.15);
  } catch {
    // Ignore already-stopped nodes.
  }
  audio.bgmSource = null;
  audio.bgmGain = null;
}

function createVoice(audio, entityId) {
  if (!audio.ctx || !audio.sampleBuffer) return null;
  const ctx = audio.ctx;
  const source = ctx.createBufferSource();
  source.buffer = audio.sampleBuffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.max(0.01, audio.sampleBuffer.duration);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 580;
  filter.Q.value = 0.7;

  const gain = ctx.createGain();
  gain.gain.value = 0.0001;

  const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
  source.connect(filter);
  filter.connect(gain);
  if (panner) {
    gain.connect(panner);
    panner.connect(audio.master);
  } else {
    gain.connect(audio.master);
  }
  source.playbackRate.value = 0.9;
  source.start();

  return {
    id: entityId,
    source,
    filter,
    gain,
    panner,
  };
}

function stopVoice(voice, ctx) {
  const now = ctx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0.0001, now, 0.06);
  try {
    voice.source.stop(now + 0.1);
  } catch {
    // Ignore already-stopped nodes.
  }
}

export function createAudioSystem() {
  return {
    ctx: null,
    master: null,
    sampleBuffer: null,
    samplePromise: null,
    bgmBuffer: null,
    bgmPromise: null,
    bgmSource: null,
    bgmGain: null,
    voices: new Map(),
  };
}

export function startAudio(audio) {
  if (!audio || !ensureContext(audio)) return;
  const ctx = audio.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  ensureSample(audio);
  ensureMusic(audio).then(() => {
    if (audio?.ctx?.state === 'running') startBgm(audio);
  }).catch(() => null);
  audio.master.gain.setTargetAtTime(0.34, ctx.currentTime, 0.18);
}

export function updateAudio(audio, world) {
  if (!audio || !world || !audio.ctx || audio.ctx.state !== 'running') return;
  if (audio.bgmBuffer) {
    startBgm(audio);
  } else {
    ensureMusic(audio).then(() => {
      if (audio?.ctx?.state === 'running') startBgm(audio);
    }).catch(() => null);
  }

  if (audio.bgmGain) {
    const now = audio.ctx.currentTime;
    let bgmLevel = 0.042;
    if (world.paused) bgmLevel = 0.012;
    if (world.raceFinished) bgmLevel = 0.024;
    audio.bgmGain.gain.setTargetAtTime(bgmLevel, now, 0.28);
  }

  if (!audio.sampleBuffer) {
    ensureSample(audio);
    return;
  }

  const entities = world.entities ?? [];
  const listener = world.player;
  const seenIds = new Set(entities.map((e) => e.id));

  for (const [id, voice] of audio.voices.entries()) {
    if (!seenIds.has(id)) {
      stopVoice(voice, audio.ctx);
      audio.voices.delete(id);
    }
  }

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    let voice = audio.voices.get(entity.id);
    if (!voice) {
      voice = createVoice(audio, entity.id);
      if (!voice) continue;
      audio.voices.set(entity.id, voice);
    }

    const now = audio.ctx.currentTime;
    const relX = wrappedDeltaX(entity.pos.x, listener.pos.x, world.arenaX);
    const distanceNorm = clamp(Math.abs(relX) / (world.arenaX * 0.9), 0, 1);
    const speedNorm = clamp(Math.abs(entity.vel.x) / C, 0, 1);
    const pan = clamp(relX / world.arenaX, -1, 1);

    // Keep Doppler natural but pleasant by easing the factor and clamping extremes.
    const rawDoppler = entity.id === listener.id ? 1 : dopplerFactor(entity.pos, entity.vel, listener.pos, listener.vel);
    const softDoppler = clamp(Math.pow(rawDoppler, 0.45), 0.82, 1.22);
    const baseRate = entity.id === listener.id ? 0.9 + speedNorm * 0.35 : 0.86 + speedNorm * 0.28;
    const targetRate = clamp(baseRate * softDoppler, 0.72, 1.36);
    const filterHz = 360 + speedNorm * 1600 + (softDoppler - 1) * 180;

    let loudness = (entity.id === listener.id ? 0.075 : 0.058) * (1 - distanceNorm * 0.8);
    if (world.paused) loudness *= 0.22;
    if (world.raceFinished) loudness *= 0.28;
    loudness = clamp(loudness, 0.0001, 0.095);

    voice.source.playbackRate.setTargetAtTime(targetRate, now, 0.1);
    voice.filter.frequency.setTargetAtTime(clamp(filterHz, 220, 2600), now, 0.14);
    voice.gain.gain.setTargetAtTime(loudness, now, 0.12);
    if (voice.panner) {
      voice.panner.pan.setTargetAtTime(pan, now, 0.1);
    }
  }
}

export function destroyAudio(audio) {
  if (!audio || !audio.ctx) return;
  const ctx = audio.ctx;
  const now = ctx.currentTime;
  stopBgm(audio);
  for (const voice of audio.voices.values()) {
    stopVoice(voice, ctx);
  }
  audio.voices.clear();
  audio.master.gain.setTargetAtTime(0.0001, now, 0.08);
  setTimeout(() => {
    ctx.close();
  }, 220);
  audio.ctx = null;
  audio.master = null;
  audio.sampleBuffer = null;
  audio.samplePromise = null;
  audio.bgmBuffer = null;
  audio.bgmPromise = null;
  audio.bgmSource = null;
  audio.bgmGain = null;
}
