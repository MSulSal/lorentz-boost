import { C, clamp, dopplerFactor } from './relativity';

const THRUST_SAMPLE_URL = new URL('./assets/audio/rocket_engine_cc0.wav', import.meta.url).href;
const BGM_SAMPLE_URL = new URL('./assets/audio/space_echo_cc0.ogg', import.meta.url).href;
const DEFAULT_MIX = Object.freeze({
  master: 1,
  music: 1,
  thrusters: 1,
});
const MASTER_BASE_GAIN = 0.46;
const BGM_BASE_GAIN = 0.086;

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

function sanitizeMix(mix) {
  return {
    master: clamp(mix?.master ?? DEFAULT_MIX.master, 0, 1.4),
    music: clamp(mix?.music ?? DEFAULT_MIX.music, 0, 1.4),
    thrusters: clamp(mix?.thrusters ?? DEFAULT_MIX.thrusters, 0, 1.4),
  };
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
  const filter = audio.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1680;
  filter.Q.value = 0.6;
  const gain = audio.ctx.createGain();
  source.buffer = audio.bgmBuffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.max(0.01, audio.bgmBuffer.duration);
  gain.gain.value = 0.0001;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  source.start();
  audio.bgmSource = source;
  audio.bgmFilter = filter;
  audio.bgmGain = gain;
}

function stopBgm(audio) {
  if (!audio?.ctx || !audio.bgmSource || !audio.bgmGain || !audio.bgmFilter) return;
  const now = audio.ctx.currentTime;
  audio.bgmGain.gain.cancelScheduledValues(now);
  audio.bgmGain.gain.setTargetAtTime(0.0001, now, 0.08);
  try {
    audio.bgmSource.stop(now + 0.15);
  } catch {
    // Ignore already-stopped nodes.
  }
  audio.bgmSource = null;
  audio.bgmFilter = null;
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
    bgmFilter: null,
    bgmGain: null,
    mix: { ...DEFAULT_MIX },
    voices: new Map(),
  };
}

export function setAudioMix(audio, mix) {
  if (!audio) return;
  audio.mix = sanitizeMix(mix);
  if (audio.ctx && audio.master) {
    audio.master.gain.setTargetAtTime(
      MASTER_BASE_GAIN * audio.mix.master,
      audio.ctx.currentTime,
      0.14,
    );
  }
}

export function startAudio(audio) {
  if (!audio || !ensureContext(audio)) return;
  const ctx = audio.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  ensureSample(audio);
  ensureMusic(audio).then(() => {
    if (audio?.ctx?.state === 'running') startBgm(audio);
  }).catch(() => null);
  const mix = audio.mix ?? DEFAULT_MIX;
  audio.master.gain.setTargetAtTime(MASTER_BASE_GAIN * mix.master, ctx.currentTime, 0.18);
}

export function updateAudio(audio, world) {
  if (!audio || !world || !audio.ctx || audio.ctx.state !== 'running') return;
  const mix = audio.mix ?? DEFAULT_MIX;
  const now = audio.ctx.currentTime;
  const entities = (world.entities ?? []).filter((e) => !e.isRespawning && !e.isRetired);
  const listener = world.player;
  if (audio.master) {
    audio.master.gain.setTargetAtTime(MASTER_BASE_GAIN * mix.master, now, 0.14);
  }
  if (audio.bgmBuffer) {
    startBgm(audio);
  } else {
    ensureMusic(audio).then(() => {
      if (audio?.ctx?.state === 'running') startBgm(audio);
    }).catch(() => null);
  }

  if (audio.bgmGain) {
    const fleetSize = entities.reduce(
      (count, entity) => count + ((entity.team?.id && entity.team.id === listener.team?.id) ? 1 : 0),
      0,
    );
    const heroic = clamp((fleetSize - 1) / 11, 0, 1);
    let bgmLevel = BGM_BASE_GAIN;
    if (world.paused) bgmLevel = BGM_BASE_GAIN * 0.36;
    if (world.raceFinished) bgmLevel = BGM_BASE_GAIN * 0.58;
    bgmLevel *= 1 + heroic * 0.24;
    audio.bgmGain.gain.setTargetAtTime(bgmLevel * mix.music, now, 0.28);
    if (audio.bgmFilter) {
      const bgmCut = 1480 + heroic * 1620;
      audio.bgmFilter.frequency.setTargetAtTime(clamp(bgmCut, 900, 3800), now, 0.34);
      audio.bgmFilter.Q.setTargetAtTime(0.52 + heroic * 0.5, now, 0.34);
    }
    if (audio.bgmSource) {
      const heroicRate = 1 + heroic * 0.06;
      audio.bgmSource.playbackRate.setTargetAtTime(heroicRate, now, 0.32);
    }
  }

  if (!audio.sampleBuffer) {
    ensureSample(audio);
    return;
  }
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

    const relX = wrappedDeltaX(entity.pos.x, listener.pos.x, world.arenaX);
    const distanceNorm = clamp(Math.abs(relX) / (world.arenaX * 0.9), 0, 1);
    const speedNorm = clamp(Math.abs(entity.vel.x) / C, 0, 1);
    const pan = clamp(relX / world.arenaX, -1, 1);

    // Keep Doppler natural but audible by easing and clamping extremes.
    const rawDoppler = entity.id === listener.id ? 1 : dopplerFactor(entity.pos, entity.vel, listener.pos, listener.vel);
    const softDoppler = clamp(Math.pow(rawDoppler, 0.55), 0.78, 1.28);
    const baseRate = entity.id === listener.id ? 0.9 + speedNorm * 0.35 : 0.86 + speedNorm * 0.28;
    const targetRate = clamp(baseRate * softDoppler, 0.72, 1.36);
    const filterHz = 360 + speedNorm * 1600 + (softDoppler - 1) * 180;

    const voiceBase = entity.id === listener.id ? 0.094 : 0.078;
    let loudness = voiceBase * (1 - distanceNorm * 0.66);
    loudness = Math.max(loudness, entity.id === listener.id ? 0.006 : 0.0035);
    if (world.paused) loudness *= 0.22;
    if (world.raceFinished) loudness *= 0.28;
    loudness = clamp(loudness * mix.thrusters, 0.0001, 0.14);

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
  audio.bgmFilter = null;
  audio.bgmGain = null;
}
