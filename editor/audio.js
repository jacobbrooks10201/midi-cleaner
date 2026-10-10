// Audio engine: offline sample instruments, sustain pedal, effects rack, scheduler, WAV render.
'use strict';

const INSTRUMENTS = [
  { id: 'salamander', name: 'Grand Piano (Salamander)', kind: 'salamander', release: 0.35 },
  { id: 'acoustic_grand_piano', name: 'Grand Piano (GM)', release: 0.3 },
  { id: 'bright_acoustic_piano', name: 'Bright Piano', release: 0.3 },
  { id: 'electric_piano_1', name: 'Electric Piano (Rhodes)', release: 0.4 },
  { id: 'electric_piano_2', name: 'Electric Piano (FM)', release: 0.4 },
  { id: 'electric_guitar_clean', name: 'Clean Electric Guitar', release: 0.25 },
  { id: 'electric_guitar_jazz', name: 'Jazz Guitar', release: 0.25 },
  { id: 'acoustic_guitar_nylon', name: 'Nylon Guitar', release: 0.3 },
  { id: 'acoustic_guitar_steel', name: 'Steel-string Guitar', release: 0.3 },
  { id: 'clavinet', name: 'Clavinet', release: 0.08 },
  { id: 'harpsichord', name: 'Harpsichord', release: 0.15 },
  { id: 'celesta', name: 'Celesta', release: 0.5 },
  { id: 'music_box', name: 'Music Box', release: 0.6 },
  { id: 'vibraphone', name: 'Vibraphone', release: 0.6 },
  { id: 'marimba', name: 'Marimba', release: 0.3 },
  { id: 'orchestral_harp', name: 'Harp', release: 0.6 },
  { id: 'string_ensemble_1', name: 'String Ensemble', release: 0.5 },
  { id: 'pad_2_warm', name: 'Warm Pad', release: 0.8 },
];

const FX_DEFAULTS = {
  reverb: { on: true, mix: 0.22, size: 2.6 },
  delay: { on: false, mix: 0.18, time: 0.32, feedback: 0.3 },
  chorus: { on: false, mix: 0.4, depth: 0.5 },
  drive: { on: false, amount: 0.3 },
  eq: { on: false, low: 0, high: 0 },
  comp: { on: true },
  volume: 0.8,
};

const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function b64ToArrayBuffer(dataUri) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

class SampleBank {
  // midi -> {buffer, root}
  constructor() { this.cache = {}; }

  async load(ctx, inst, onProgress) {
    if (this.cache[inst.id]) return this.cache[inst.id];
    const map = {};
    if (inst.kind === 'salamander') {
      const names = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
      const jobs = [];
      for (let m = 21; m <= 108; m++) {
        if (!(m % 12 in names)) continue;
        const file = `${names[m % 12]}${Math.floor(m / 12) - 1}.mp3`;
        jobs.push(fetch(`samples/salamander/${file}`).then(r => r.arrayBuffer())
          .then(b => ctx.decodeAudioData(b)).then(buf => { map[m] = buf; onProgress && onProgress(); }));
      }
      await Promise.all(jobs);
    } else {
      const data = await (await fetch(`samples/gm/${inst.id}.json`)).json();
      const jobs = [];
      for (const [k, uri] of Object.entries(data)) {
        const mm = /^([A-G]b?)(-?\d)$/.exec(k);
        if (!mm) continue;
        const m = NOTE_NAMES_FLAT.indexOf(mm[1]) + 12 * (parseInt(mm[2]) + 1);
        jobs.push(ctx.decodeAudioData(b64ToArrayBuffer(uri)).then(buf => { map[m] = buf; }));
      }
      await Promise.all(jobs);
    }
    const roots = Object.keys(map).map(Number).sort((a, b) => a - b);
    const lookup = {};
    for (let m = 0; m < 128; m++) {
      let best = roots[0];
      for (const r of roots) if (Math.abs(r - m) < Math.abs(best - m)) best = r;
      lookup[m] = { buffer: map[best], root: best };
    }
    this.cache[inst.id] = lookup;
    return lookup;
  }
}

function seededRandom(seed) { // mulberry32: deterministic, so separately rendered pieces match
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rnd = seededRandom(1234 + c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (rnd() * 2 - 1) * 0.4; // slightly darkened noise
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 64 ? i / 64 : 1);
    }
  }
  return buf;
}

function driveCurve(amount) {
  const k = amount * 60 + 1, n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

// Build the effects rack on any (real or offline) context. Returns {input, apply(fx), band(vel)}.
// t0 = song time at context time 0, so a piece rendered separately has its chorus LFO in phase.
function buildFx(ctx, fx, t0 = 0) {
  const input = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '2x';
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3500;
  const pre = ctx.createGain();
  const dry = ctx.createGain();
  // reverb
  const conv = ctx.createConvolver();
  const revWet = ctx.createGain();
  // delay
  const dl = ctx.createDelay(2.0), dlFb = ctx.createGain(), dlWet = ctx.createGain();
  dl.connect(dlFb); dlFb.connect(dl);
  // chorus: two modulated short delays panned L/R
  const chWet = ctx.createGain();
  const chorusParts = [];
  for (const [rate, pan] of [[0.7, -0.6], [0.93, 0.6]]) {
    const d = ctx.createDelay(0.1); d.delayTime.value = 0.018;
    const plen = Math.round(ctx.sampleRate / rate), period = plen / ctx.sampleRate;
    const sine = ctx.createBuffer(1, plen, ctx.sampleRate), sd = sine.getChannelData(0);
    for (let i = 0; i < plen; i++) sd[i] = Math.sin(2 * Math.PI * i / plen);
    const lfo = ctx.createBufferSource(); lfo.buffer = sine; lfo.loop = true;
    const depth = ctx.createGain(); depth.gain.value = 0.004;
    lfo.connect(depth); depth.connect(d.delayTime); lfo.start(0, t0 % period);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    pre.connect(d); d.connect(p); p.connect(chWet);
    chorusParts.push(depth);
  }
  const comp = ctx.createDynamicsCompressor();
  const master = ctx.createGain();

  input.connect(shaper); shaper.connect(low); low.connect(high); high.connect(pre);
  pre.connect(dry); pre.connect(conv); conv.connect(revWet); pre.connect(dl); dl.connect(dlWet);
  for (const n of [dry, revWet, dlWet, chWet]) n.connect(comp);
  comp.connect(master);
  master.connect(ctx.destination);

  let lastSize = null;
  function apply(f) {
    shaper.curve = f.drive.on ? driveCurve(f.drive.amount) : null;
    pre.gain.value = f.drive.on ? 0.8 - 0.35 * f.drive.amount : 1;
    low.gain.value = f.eq.on ? f.eq.low : 0;
    high.gain.value = f.eq.on ? f.eq.high : 0;
    if (f.reverb.on && lastSize !== f.reverb.size) { conv.buffer = makeImpulse(ctx, f.reverb.size); lastSize = f.reverb.size; }
    revWet.gain.value = f.reverb.on ? f.reverb.mix * 1.6 : 0;
    dl.delayTime.value = f.delay.time;
    dlFb.gain.value = f.delay.feedback;
    dlWet.gain.value = f.delay.on ? f.delay.mix : 0;
    chWet.gain.value = f.chorus.on ? f.chorus.mix : 0;
    for (const d of chorusParts) d.gain.value = 0.001 + 0.006 * f.chorus.depth;
    dry.gain.value = 1 - (f.reverb.on ? f.reverb.mix * 0.35 : 0);
    if (f.comp.on) { comp.threshold.value = -20; comp.ratio.value = 3.5; comp.knee.value = 12; comp.attack.value = 0.01; comp.release.value = 0.25; }
    else { comp.threshold.value = 0; comp.ratio.value = 1; }
    master.gain.value = f.volume;
  }
  apply(fx);
  // Shared velocity-band lowpass filters (the Salamander set has one velocity layer, so quiet notes
  // are darkened). Six shared filters instead of one per voice keeps long renders fast.
  const bands = [];
  function band(vel) {
    const k = Math.min(5, Math.floor(vel / 22));
    if (!bands[k]) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 0.3;
      f.frequency.value = 900 + 17000 * Math.pow((k * 22 + 11) / 127, 2.2);
      f.connect(input);
      bands[k] = f;
    }
    return bands[k];
  }
  return { input, apply, band };
}

// Schedule one note on a context. Returns the source node (so it can be stopped).
function playNote(ctx, rack, lookup, inst, n, when, offWhen) {
  const s = lookup[n.pitch];
  if (!s || !s.buffer) return null;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  const rate = Math.pow(2, (n.pitch - s.root) / 12);
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  const v = n.vel / 127;
  const peak = 0.06 + 0.9 * Math.pow(v, 1.7);
  src.connect(g);
  g.connect(inst.kind === 'salamander' ? rack.band(n.vel) : rack.input);
  const rel = inst.release || 0.3;
  const stopAt = Math.max(offWhen, when + 0.02);
  const late = Math.max(0, -when); // started before this (offline) context began
  if (late > 0) {
    if (stopAt <= 0) return null;
    g.gain.setValueAtTime(peak, 0);
  } else {
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.004);
  }
  g.gain.setValueAtTime(peak, stopAt);
  g.gain.setTargetAtTime(0, stopAt, rel / 4);
  if (late * rate >= s.buffer.duration) return null;
  src.start(Math.max(0, when), late * rate);
  src.stop(stopAt + rel * 2 + 0.05);
  return { src, g, pitch: n.pitch, end: stopAt + rel * 2 };
}

function pedalReleaseTimes(notes, ccs) {
  // sustain: a note released while the pedal is down keeps sounding until the pedal lifts
  const ped = ccs.filter(c => c.num === 64).sort((a, b) => a.t - b.t);
  const intervals = [];
  let cur = null;
  for (const c of ped) {
    const d = c.val >= 64;
    if (d && cur === null) cur = c.t;
    if (!d && cur !== null) { intervals.push([cur, c.t]); cur = null; }
  }
  if (cur !== null) intervals.push([cur, Infinity]);
  for (const n of notes) {
    n.release = n.off;
    for (const [a, b] of intervals) {
      if (a > n.off) break;
      if (n.off < b) { n.release = Math.min(b, n.off + 12); break; }
    }
  }
}

class Player {
  constructor() {
    this.ctx = null; this.bank = new SampleBank(); this.inst = INSTRUMENTS[0];
    this.fx = JSON.parse(JSON.stringify(FX_DEFAULTS));
    this.playing = false; this.voices = []; this.timer = null;
    this.metronome = false; this.beats = [];
    this.onTick = null;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.rack = buildFx(this.ctx, this.fx);
    }
    return this.ctx;
  }
  async setInstrument(id, onProgress) {
    this.inst = INSTRUMENTS.find(i => i.id === id) || INSTRUMENTS[0];
    this.lookup = await this.bank.load(this.ensure(), this.inst, onProgress);
  }
  setFx(fx) { this.fx = fx; if (this.rack) this.rack.apply(fx); }
  // notes: [{pitch, vel, on, off}] in seconds, ccs: pedal events
  play(notes, ccs, from, to, beats) {
    this.stop();
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    this.notes = notes.slice().sort((a, b) => a.on - b.on);
    pedalReleaseTimes(this.notes, ccs);
    this.beats = beats || [];
    this.from = from; this.to = to ?? Infinity;
    this.t0 = ctx.currentTime + 0.08;
    this.idx = this.notes.findIndex(n => n.on >= from); if (this.idx < 0) this.idx = this.notes.length;
    this.bidx = this.beats.findIndex(b => b.t >= from); if (this.bidx < 0) this.bidx = this.beats.length;
    this.playing = true;
    const tick = () => {
      if (!this.playing) return;
      const now = ctx.currentTime;
      const songNow = this.from + (now - this.t0);
      const horizon = songNow + 0.3;
      while (this.idx < this.notes.length && this.notes[this.idx].on < horizon) {
        const n = this.notes[this.idx++];
        if (n.on >= this.to) { this.idx = this.notes.length; break; }
        const when = this.t0 + (n.on - this.from);
        const off = this.t0 + (Math.min(n.release, this.to + 1.5) - this.from);
        // damper: re-striking a key cuts the previous voice of that key
        for (const v of this.voices) if (v.pitch === n.pitch && v.end > when) {
          v.g.gain.cancelScheduledValues(when); v.g.gain.setTargetAtTime(0, when, 0.015); v.end = when;
        }
        const v = playNote(ctx, this.rack, this.lookup, this.inst, n, Math.max(when, now), off);
        if (v) this.voices.push(v);
      }
      if (this.metronome) {
        while (this.bidx < this.beats.length && this.beats[this.bidx].t < horizon) {
          const b = this.beats[this.bidx++];
          if (b.t >= this.to) break;
          this.click(this.t0 + (b.t - this.from), b.down);
        }
      } else {
        while (this.bidx < this.beats.length && this.beats[this.bidx].t < horizon) this.bidx++;
      }
      this.voices = this.voices.filter(v => v.end > now);
      if (this.onTick) this.onTick(songNow);
      if (songNow > this.to + 0.3 || (this.idx >= this.notes.length && this.voices.length === 0 && songNow > this.from + 1)) {
        this.stop(); if (this.onEnd) this.onEnd(); return;
      }
    };
    this.timer = setInterval(tick, 25);
    tick();
  }
  click(when, down) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = down ? 1800 : 1200;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(down ? 0.35 : 0.2, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(ctx.destination);
    o.start(when); o.stop(when + 0.06);
  }
  position() { return this.playing ? this.from + (this.ctx.currentTime - this.t0) : null; }
  stop() {
    this.playing = false;
    clearInterval(this.timer); this.timer = null;
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const v of this.voices) { try { v.g.gain.cancelScheduledValues(now); v.g.gain.setTargetAtTime(0, now, 0.03); v.src.stop(now + 0.2); } catch (e) { /* already stopped */ } }
    }
    this.voices = [];
  }
  // Render the whole performance (with effects) to a WAV Blob.
  // Long takes are split into pieces rendered in parallel (one offline context per CPU core). Each
  // piece starts PRE seconds early so held notes, reverb and compressor are already in the right state
  // at the join, effects are deterministic, and joins get a short crossfade. Within a piece, notes are
  // scheduled block by block during the render (suspend/resume) so the audio graph stays small.
  async renderWav(notes, ccs, end, onProgress, signal) {
    const sr = 44100, PRE = 8, XF = 0.02;
    const dur = end + 3;
    const ns = notes.slice().sort((a, b) => a.on - b.on);
    pedalReleaseTimes(ns, ccs);
    const K = dur > 90 ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
    const cuts = Array.from({ length: K + 1 }, (_, k) => Math.round(dur * k / K * sr) / sr);
    const prog = new Array(K).fill(0);
    const report = () => onProgress && onProgress(prog.reduce((a, b) => a + b, 0) / K, 'rendering');
    const pieces = await Promise.all(cuts.slice(0, K).map((t0, k) => {
      const s0 = Math.max(0, t0 - PRE), s1 = Math.min(dur, cuts[k + 1] + (k < K - 1 ? XF : 0));
      return this._renderPiece(ns, s0, s1, sr, signal, f => { prog[k] = f; report(); });
    }));
    if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    onProgress && onProgress(1, 'encoding');
    await new Promise(r => setTimeout(r, 0));
    return encodePieces(pieces, cuts, sr, XF);
  }

  async _renderPiece(ns, s0, s1, sr, signal, onFrac) {
    const STEP = 4.0;
    const off = new OfflineAudioContext(2, Math.ceil((s1 - s0) * sr), sr);
    const rack = buildFx(off, this.fx, s0);
    const len = s1 - s0;
    const last = {};
    // notes still sounding at s0 (incl. pedal + release tail) or starting inside the piece
    let i = 0;
    const live = ns.filter(n => n.on < s1 && n.release + 2 > s0);
    const schedule = upto => {
      while (i < live.length && live[i].on - s0 < upto) {
        const n = live[i++];
        const when = n.on - s0;
        const prev = last[n.pitch];
        if (prev && prev.end > when && when > 0) { prev.g.gain.cancelScheduledValues(when); prev.g.gain.setTargetAtTime(0, when, 0.015); }
        const v = playNote(off, rack, this.lookup, this.inst, n, when, n.release - s0);
        if (v) last[n.pitch] = v;
      }
    };
    let aborted = false;
    schedule(STEP + 0.5);
    for (let t = STEP; t < len; t += STEP) {
      off.suspend(t).then(() => {
        if (signal && signal.aborted) aborted = true;
        if (!aborted) schedule(t + STEP + 0.5);
        onFrac(t / len);
        off.resume();
      });
    }
    const buf = await off.startRendering();
    onFrac(1);
    return { buf, s0 };
  }
}

// Join rendered pieces into one 16-bit WAV, crossfading XF seconds at each join and normalizing only
// if it would clip. Piece k covers global frames [starts[k], starts[k+1]); the first xf frames after a
// join blend in the previous piece's overlap.
function encodePieces(pieces, cuts, sr, XF) {
  const total = Math.round(cuts[cuts.length - 1] * sr);
  const xf = Math.round(XF * sr);
  const starts = cuts.map(t => Math.round(t * sr));
  starts[starts.length - 1] = total;
  const offs = pieces.map(p => Math.round(p.s0 * sr));
  const L = pieces.map(p => p.buf.getChannelData(0)), R = pieces.map(p => p.buf.getChannelData(1));
  const span = k => [starts[k], starts[k + 1]];
  // pass 1: peak
  let peak = 0;
  for (let k = 0; k < pieces.length; k++) {
    const [a, b] = span(k), o = offs[k];
    for (const d of [L[k], R[k]]) for (let f = a; f < b; f++) { const v = Math.abs(d[f - o] || 0); if (v > peak) peak = v; }
  }
  const norm = peak > 0.98 ? 0.98 / peak : 1;
  const bytes = new ArrayBuffer(44 + total * 4);
  const hdr = new DataView(bytes, 0, 44);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) hdr.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); hdr.setUint32(4, 36 + total * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 2, true);
  hdr.setUint32(24, sr, true); hdr.setUint32(28, sr * 4, true); hdr.setUint16(32, 4, true);
  hdr.setUint16(34, 16, true); w(36, 'data'); hdr.setUint32(40, total * 4, true);
  const pcm = new Int16Array(bytes, 44, total * 2); // WAV is little-endian, as are x86/ARM
  const q = v => { v *= norm; v = v > 1 ? 1 : v < -1 ? -1 : v; return v < 0 ? v * 0x8000 : v * 0x7fff; };
  for (let k = 0; k < pieces.length; k++) {
    const [a, b] = span(k), o = offs[k], l = L[k], r = R[k];
    const po = k ? offs[k - 1] : 0, pl = k ? L[k - 1] : null, pr = k ? R[k - 1] : null;
    for (let f = a; f < b; f++) {
      let x = l[f - o] || 0, y = r[f - o] || 0;
      if (k && f < a + xf) { const wt = (f - a) / xf; x = x * wt + (pl[f - po] || 0) * (1 - wt); y = y * wt + (pr[f - po] || 0) * (1 - wt); }
      pcm[2 * f] = q(x); pcm[2 * f + 1] = q(y);
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

window.Audio2 = { INSTRUMENTS, FX_DEFAULTS, Player };
