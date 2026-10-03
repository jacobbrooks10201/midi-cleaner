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

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; // slightly darkened noise
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

// Build the effects rack on any (real or offline) context. Returns {input, apply(fx)}.
function buildFx(ctx, fx) {
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
    const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
    const depth = ctx.createGain(); depth.gain.value = 0.004;
    lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
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
  return { input, apply };
}

// Schedule one note on a context. Returns the source node (so it can be stopped).
function playNote(ctx, dest, lookup, inst, n, when, offWhen) {
  const s = lookup[n.pitch];
  if (!s || !s.buffer) return null;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = Math.pow(2, (n.pitch - s.root) / 12);
  const g = ctx.createGain();
  const v = n.vel / 127;
  const peak = 0.06 + 0.9 * Math.pow(v, 1.7);
  let node = src;
  if (inst.kind === 'salamander') {
    // single velocity layer: soften quiet notes with a velocity-tracking lowpass
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900 + 17000 * Math.pow(v, 2.2);
    f.Q.value = 0.3;
    src.connect(f); node = f;
  }
  node.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.004);
  const rel = inst.release || 0.3;
  const stopAt = Math.max(offWhen, when + 0.02);
  g.gain.setValueAtTime(peak, stopAt);
  g.gain.setTargetAtTime(0, stopAt, rel / 4);
  src.start(when);
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
        const v = playNote(ctx, this.rack.input, this.lookup, this.inst, n, Math.max(when, now), off);
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
  async renderWav(notes, ccs, end, onProgress) {
    const sr = 44100;
    const dur = end + 3;
    const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    const rack = buildFx(off, this.fx);
    const ns = notes.slice().sort((a, b) => a.on - b.on);
    pedalReleaseTimes(ns, ccs);
    const last = {};
    for (const n of ns) {
      const prev = last[n.pitch];
      if (prev && prev.end > n.on) { prev.g.gain.cancelScheduledValues(n.on); prev.g.gain.setTargetAtTime(0, n.on, 0.015); }
      const v = playNote(off, rack.input, this.lookup, this.inst, n, n.on + 0.05, n.release + 0.05);
      if (v) last[n.pitch] = v;
    }
    onProgress && onProgress('rendering…');
    const buf = await off.startRendering();
    return encodeWav(buf);
  }
}

function encodeWav(buf) {
  const nch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * nch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * nch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * nch * 2, true); out.setUint16(32, nch * 2, true);
  out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * nch * 2, true);
  const chans = []; for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
  let peak = 0;
  for (const d of chans) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const norm = peak > 0.98 ? 0.98 / peak : 1;
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i] * norm));
    out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

window.Audio2 = { INSTRUMENTS, FX_DEFAULTS, Player };
