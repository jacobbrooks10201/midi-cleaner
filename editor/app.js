// MIDI Cleaner review editor.
// Model: original notes + AI edit proposals (per-note deltas) + your decisions.
// final = original + sum(deltas of accepted edits) + your manual tweaks. Nothing is destructive.
'use strict';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pname = p => NAMES[p % 12] + (Math.floor(p / 12) - 1);
const fmt = t => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s - 60 * m).toFixed(3).padStart(6, '0')}`; };
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const TYPE_ORDER = ['tempo', 'delete', 'roll', 'stutter', 'ornament'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const TYPE_LABEL = { tempo: 'Tempo regularization', delete: 'Note removals', roll: 'Rolled chords', stutter: 'Stutters (fixed by tempo)', ornament: 'Protected ornaments' };

const S = {
  P: null, name: null,
  state: { accepted: {}, manual: {}, fx: null, instrument: 'salamander' },
  undo: [], redo: [], dirty: false,
  final: [], byId: new Map(), finalCcs: [],
  view: { t0: -0.5, pps: 60, pitchTop: 96, rowH: 7 },
  sel: new Set(), hotEdit: null, playhead: 0,
  source: 'clean', filter: 'all', ghosts: true, snap: false,
  region: null,            // last box-selected area {t0,t1,lo,hi}
  ai: { replies: {}, running: false, loadedMtime: 0, available: true },
};
const player = new Audio2.Player();

// ------------------------------------------------------------------ model

function isAccepted(e) { return S.state.accepted[e.id] ?? e.default; }

function compute() {
  const P = S.P;
  const fin = new Map();
  for (const n of P.notes) fin.set(n.id, { id: n.id, pitch: n.pitch, vel: n.vel, on: n.on, off: n.off, ch: n.ch || 0,
    origOn: n.on, origOff: n.off, origPitch: n.pitch, deleted: false, moved: 0, edits: [], prot: false, manual: false, delEdit: null });
  const cct = new Map(P.ccs.map(c => [c.id, c.t]));
  const acceptedTempo = new Set();
  for (const e of P.edits) {
    if (e.type === 'ornament') for (const i of e.ids || []) fin.get(i).prot = true;
    for (const i of Object.keys(e.notes)) fin.get(+i).edits.push(e.id);
    for (const i of e.deletes) { fin.get(i).edits.push(e.id); fin.get(i).delEdit = e.id; }
    if (e.info || !isAccepted(e)) continue;
    if (e.type === 'tempo') acceptedTempo.add(e.section);
    for (const [i, [a, b]] of Object.entries(e.notes)) { const n = fin.get(+i); n.on += a; n.off += b; }
    for (const [i, d] of Object.entries(e.ccs)) cct.set(+i, cct.get(+i) + d);
    for (const i of e.deletes) fin.get(i).deleted = true;
  }
  for (const [i, m] of Object.entries(S.state.manual)) {
    const n = fin.get(+i); if (!n) continue;
    n.on += m.dOn || 0; n.off += m.dOff || 0; n.pitch += m.dPitch || 0;
    if (m.vel != null) n.vel = m.vel;
    if (m.deleted) n.deleted = true;
    if (m.restored) n.deleted = false;
    n.manual = true;
  }
  for (const n of fin.values()) {
    n.on = Math.min(Math.max(0, n.on), P.end);
    n.off = Math.min(Math.max(n.on + 0.01, n.off), P.end);
    n.moved = n.on - n.origOn;
  }
  S.final = [...fin.values()].sort((a, b) => a.origOn - b.origOn);
  S.byId = fin;
  S.finalCcs = P.ccs.map(c => ({ ...c, t: Math.max(0, cct.get(c.id)) }));
  S.acceptedTempo = acceptedTempo;
  // tempo map beats for grid + metronome
  S.beats = [];
  for (const s of P.sections) {
    const b = acceptedTempo.has(s.index) ? s.grid : s.beats;
    for (let k = 0; k < b.length - 1; k++) S.beats.push({ t: b[k], down: k % s.num === 0, sec: s.index, k });
  }
  S.beats.push({ t: P.sections[P.sections.length - 1].end, down: true, sec: -1, k: 0 });
  // bar numbers
  let bar = 0; for (const b of S.beats) if (b.down) b.bar = ++bar;
  validate();
}

function validate() {
  // Golden rule checks + the same doubt-guards the pipeline runs.
  const P = S.P;
  const live = S.final.filter(n => !n.deleted);
  const secOf = t => { for (const s of P.sections) if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s.index; return t < 0.001 ? 0 : P.sections.length - 1; };
  let crossed = 0, merges = 0, swaps = 0;
  for (const n of live) if (secOf(n.origOn) !== secOf(n.on)) crossed++;
  const ordered = live.slice().sort((a, b) => a.origOn - b.origOn);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (b.origOn - a.origOn >= 0.035 && Math.abs(b.on - a.on) < 0.012) merges++;
    if (b.origOn - a.origOn >= 0.012 && b.on < a.on - 0.005) swaps++;
  }
  const removed = S.final.length - live.length;
  const moved = live.filter(n => Math.abs(n.moved) > 0.005);
  const maxMove = moved.reduce((m, n) => Math.max(m, Math.abs(n.moved)), 0);
  const ok = (c, t) => `<span class="${c ? 'ok' : 'bad'}">${c ? '✓' : '⚠'} ${t}</span>`;
  $('sync').innerHTML = [
    ok(true, `Length ${fmt(P.end)} fixed · ${P.sections.length} section boundaries pinned`),
    ok(crossed === 0, `${crossed} notes crossed a section boundary`),
    ok(merges === 0 && swaps === 0, `${merges} onset merges · ${swaps} order swaps`),
    `<span class="muted">${removed} removed · ${moved.length} moved (max ${(maxMove * 1000).toFixed(0)} ms) · ${P.trim > 0 ? `trimmed ${P.trim.toFixed(3)}s lead-in` : 'lead-in kept (file time = video time)'}</span>`,
  ].join('<br>');
}

// ------------------------------------------------------------------ state / undo

function snapshot() { return JSON.stringify({ accepted: S.state.accepted, manual: S.state.manual }); }
function commit(fn) {
  S.undo.push(snapshot()); if (S.undo.length > 300) S.undo.shift();
  S.redo = [];
  fn();
  changed();
}
function changed() { S.dirty = true; $('saveState').textContent = 'unsaved'; compute(); renderEdits(); renderSections(); renderNoteInfo(); draw(); restartIfPlaying(); }
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); Object.assign(S.state, JSON.parse(S.undo.pop())); changed(); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); Object.assign(S.state, JSON.parse(S.redo.pop())); changed(); }
function manual(id) { return (S.state.manual[id] ||= {}); }
function cleanManual(id) {
  const m = S.state.manual[id]; if (!m) return;
  for (const k of Object.keys(m)) if (!m[k]) delete m[k];
  if (!Object.keys(m).length) delete S.state.manual[id];
}

async function save() {
  S.state.fx = player.fx; S.state.instrument = player.inst.id;
  const r = await fetch(`/api/review/${encodeURIComponent(S.name)}`, { method: 'POST', body: JSON.stringify(S.state) });
  if (r.ok) { S.dirty = false; $('saveState').textContent = 'saved ' + new Date().toLocaleTimeString(); }
  else $('saveState').textContent = 'save failed';
}

// ------------------------------------------------------------------ canvas

const cv = $('roll'), g = cv.getContext('2d');
const RULER = 34, SECBAND = 18, PEDAL = 26;
function rollTop() { return RULER + SECBAND; }
function rollBottom() { return cv.clientHeight - PEDAL; }
const x2t = x => S.view.t0 + x / S.view.pps;
const t2x = t => (t - S.view.t0) * S.view.pps;
const p2y = p => rollTop() + (S.view.pitchTop - p) * S.view.rowH;
const y2p = y => Math.round(S.view.pitchTop - (y - rollTop()) / S.view.rowH);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

let drawQueued = false;
function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); } }

function velColor(v, alpha = 1) {
  const t = v / 127;
  const h = 210 - 170 * t, l = 45 + 15 * t;
  return `hsla(${h},70%,${l}%,${alpha})`;
}

function paint() {
  if (!S.P) return;
  const W = cv.clientWidth, H = cv.clientHeight, P = S.P, V = S.view;
  const tA = x2t(0), tB = x2t(W);
  g.fillStyle = css('--bg'); g.fillRect(0, 0, W, H);
  // pitch rows
  for (let p = V.pitchTop; p > V.pitchTop - (H / V.rowH) && p >= 0; p--) {
    const y = p2y(p);
    if (y > rollBottom()) break;
    if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = '#191c22'; g.fillRect(0, y, W, V.rowH); }
    if (p % 12 === 0) { g.fillStyle = '#2a2f3a'; g.fillRect(0, y + V.rowH - 1, W, 1); }
  }
  // section tint + band
  const modeCol = { steady: css('--steady'), ramp: css('--ramp'), rubato: css('--rubato') };
  for (const s of P.sections) {
    const x0 = t2x(s.start), x1 = t2x(s.end);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = modeCol[s.mode] + (s.mode === 'rubato' ? '14' : '0a');
    g.fillRect(x0, rollTop(), x1 - x0, rollBottom() - rollTop());
    g.fillStyle = modeCol[s.mode] + (S.acceptedTempo.has(s.index) || s.mode === 'rubato' ? 'cc' : '55');
    g.fillRect(x0, RULER, x1 - x0 - 1, SECBAND - 2);
    g.save(); g.beginPath(); g.rect(x0, RULER, Math.max(0, x1 - x0 - 2), SECBAND); g.clip();
    g.fillStyle = '#fff'; g.font = '11px system-ui';
    g.fillText(`${s.label} · ${s.mode} ${s.mode === 'rubato' ? '' : s.bpm.toFixed(1) + ' bpm '}${s.num}/${s.den}`, Math.max(x0, 0) + 4, RULER + 12);
    g.restore();
    // boundary pin
    g.fillStyle = '#ffffffaa'; g.fillRect(x0, RULER, 2, rollBottom() - RULER);
  }
  // beat grid
  const showBeats = V.pps > 25;
  g.font = '10px system-ui';
  for (const b of S.beats) {
    if (b.t < tA - 1 || b.t > tB + 1) continue;
    const x = Math.round(t2x(b.t)) + 0.5;
    if (b.down) { g.strokeStyle = '#3a4152'; } else if (showBeats) { g.strokeStyle = '#242934'; } else continue;
    g.beginPath(); g.moveTo(x, rollTop()); g.lineTo(x, rollBottom()); g.stroke();
    if (b.down && b.bar && (V.pps > 40 || b.bar % 4 === 1)) { g.fillStyle = css('--muted'); g.fillText(b.bar, x + 2, RULER - 3); }
  }
  // ruler time ticks
  g.fillStyle = css('--panel'); g.fillRect(0, 0, W, RULER - 14);
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find(s => s * V.pps > 70) || 60;
  g.fillStyle = css('--muted'); g.strokeStyle = '#3a4152';
  for (let t = Math.ceil(tA / step) * step; t < tB; t += step) {
    const x = Math.round(t2x(t)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, RULER - 14); g.stroke();
    g.fillText(fmt(t).replace(/\.?0+$/, ''), x + 3, 12);
  }
  // hot edit range
  const hot = S.hotEdit && P.edits.find(e => e.id === S.hotEdit);
  if (hot) { g.fillStyle = '#5aa9ff22'; g.fillRect(t2x(hot.t0) - 3, rollTop(), (hot.t1 - hot.t0) * V.pps + 6, rollBottom() - rollTop()); }
  // stutter markers
  for (const e of P.edits) if (e.type === 'stutter') {
    const x = t2x(e.t0); if (x < -10 || x > W + 10) continue;
    g.fillStyle = '#ff9f43'; g.beginPath(); g.moveTo(x, RULER - 12); g.lineTo(x + 5, RULER - 4); g.lineTo(x - 5, RULER - 4); g.fill();
  }
  // notes
  g.save(); g.beginPath(); g.rect(0, rollTop(), W, rollBottom() - rollTop()); g.clip();
  const rh = V.rowH;
  for (const n of S.final) {
    const a = Math.min(n.on, n.origOn), b = Math.max(n.off, n.origOff);
    if (b < tA || a > tB) continue;
    const y = p2y(n.pitch) + 0.5, h = rh - 1;
    if (S.ghosts && (Math.abs(n.moved) > 0.004 || n.pitch !== n.origPitch) && !n.deleted) {
      g.setLineDash([3, 2]); g.strokeStyle = css('--ghost') + '99';
      g.strokeRect(t2x(n.origOn) + 0.5, p2y(n.origPitch) + 0.5, Math.max(2, (n.origOff - n.origOn) * V.pps), h);
      g.setLineDash([]);
    }
    const x = t2x(n.on), w = Math.max(2, (n.off - n.on) * V.pps);
    if (n.deleted) {
      g.setLineDash([3, 2]); g.strokeStyle = css('--del'); g.strokeRect(x + 0.5, y, w, h); g.setLineDash([]);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.min(w, 10), y + h); g.stroke();
      continue;
    }
    g.fillStyle = velColor(n.vel, 0.9); g.fillRect(x, y, w, h);
    if (n.prot) { g.fillStyle = css('--prot'); g.fillRect(x, y, Math.min(w, 3), h); }
    if (n.manual) { g.strokeStyle = css('--manual'); g.lineWidth = 1.5; g.strokeRect(x + 0.5, y, w, h); g.lineWidth = 1; }
    else if (Math.abs(n.moved) > 0.004) { g.fillStyle = css('--accent'); g.fillRect(x, y + h - 2, w, 2); }
    if (S.sel.has(n.id)) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x - 0.5, y - 1, w + 1, h + 2); g.lineWidth = 1; }
  }
  g.restore();
  // pedal lane
  const pyTop = rollBottom();
  g.fillStyle = '#121419'; g.fillRect(0, pyTop, W, PEDAL);
  const ccs = (S.source === 'orig' ? S.P.ccs : S.finalCcs).filter(c => c.num === 64);
  g.fillStyle = '#4f8f6b88'; g.beginPath(); g.moveTo(0, H);
  let lastV = 0;
  for (const c of ccs) {
    const x = t2x(c.t); if (x < -50) { lastV = c.val; continue; } if (x > W + 50) break;
    g.lineTo(x, H - (lastV / 127) * (PEDAL - 4)); g.lineTo(x, H - (c.val / 127) * (PEDAL - 4)); lastV = c.val;
  }
  g.lineTo(W, H - (lastV / 127) * (PEDAL - 4)); g.lineTo(W, H); g.fill();
  g.fillStyle = css('--muted'); g.fillText('pedal', 4, pyTop + 11);
  // keyboard labels
  g.font = '10px system-ui';
  for (let p = V.pitchTop; p > 0; p--) { const y = p2y(p); if (y > rollBottom()) break; if (p % 12 === 0) { g.fillStyle = css('--muted'); g.fillText(pname(p), 3, y + rh - 1); } }
  // box select
  if (drag && drag.kind === 'box') { g.strokeStyle = css('--accent'); g.setLineDash([4, 3]); g.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); g.setLineDash([]); }
  // notes to Claude
  for (const q of S.state.requests || []) {
    const x0 = t2x(q.t0), x1 = t2x(q.t1); if (x1 < -20 || x0 > W + 20) continue;
    const answered = !!S.ai.replies[q.id];
    const col = answered ? '#7ee0b5' : '#d58cff';
    g.setLineDash([5, 3]); g.strokeStyle = col; g.lineWidth = S.hotEdit === q.id ? 2 : 1;
    g.strokeRect(x0, p2y(q.hi) - 2, Math.max(4, x1 - x0), p2y(q.lo) - p2y(q.hi) + S.view.rowH + 4);
    g.setLineDash([]); g.lineWidth = 1;
    g.fillStyle = col; g.fillRect(x0, RULER - 13, 14, 9); g.fillStyle = '#15171c'; g.font = 'bold 8px system-ui'; g.fillText(answered ? '✓' : '?', x0 + 4, RULER - 6); g.font = '10px system-ui';
  }
  // pending region selection
  const r = S.region;
  if (r && !drag) { g.fillStyle = '#d58cff18'; g.fillRect(t2x(r.t0), p2y(r.hi), (r.t1 - r.t0) * V.pps, p2y(r.lo) - p2y(r.hi) + V.rowH); }
  // playhead
  const px = t2x(S.playhead);
  g.strokeStyle = '#ff5c5c'; g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, H); g.stroke();
}

// ------------------------------------------------------------------ interaction

let drag = null;
function noteAt(x, y) {
  const t = x2t(x), p = y2p(y);
  let best = null;
  for (const n of S.final) {
    if (n.pitch !== p) continue;
    const pad = 3 / S.view.pps;
    if (t >= n.on - pad && t <= Math.max(n.off, n.on + 4 / S.view.pps) + pad) best = n;
  }
  return best;
}
function snapTime(t) {
  if (!S.snap) return t;
  // snap to nearest eighth of the active grid
  let best = t, bd = Infinity;
  for (let i = 0; i < S.beats.length - 1; i++) {
    const a = S.beats[i].t, b = S.beats[i + 1].t;
    if (b < t - 2 || a > t + 2) continue;
    for (const f of [0, 0.5]) { const c = a + (b - a) * f; if (Math.abs(c - t) < bd) { bd = Math.abs(c - t); best = c; } }
  }
  return best;
}

cv.addEventListener('mousedown', ev => {
  const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (y < RULER + SECBAND) {
    if (y >= RULER) { const s = S.P.sections.find(s => x2t(x) >= s.start && x2t(x) < s.end); if (s) { showTab('sections'); highlightSection(s.index); } }
    S.playhead = Math.max(0, x2t(x)); restartIfPlaying(); updateClock(); draw(); return;
  }
  const n = noteAt(x, y);
  if (n) {
    if (ev.shiftKey) { S.sel.has(n.id) ? S.sel.delete(n.id) : S.sel.add(n.id); }
    else if (!S.sel.has(n.id)) { S.sel = new Set([n.id]); }
    const resize = !n.deleted && x > t2x(n.off) - 5;
    drag = { kind: resize ? 'resize' : 'move', x0: x, y0: y, t0: x2t(x), p0: y2p(y), moved: false, before: snapshot(), anchor: n };
    renderNoteInfo(); showTab('note'); draw();
    preview(n);
  } else {
    if (!ev.shiftKey) S.sel.clear();
    drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
    draw();
  }
});
window.addEventListener('mousemove', ev => {
  const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (!drag) { hover(x, y, ev); return; }
  if (drag.kind === 'box') { drag.x1 = x; drag.y1 = y; draw(); return; }
  const dt = x2t(x) - drag.t0, dp = y2p(y) - drag.p0;
  if (!drag.moved && Math.abs(x - drag.x0) < 3 && Math.abs(y - drag.y0) < 3) return;
  if (!drag.moved) { drag.moved = true; drag.base = {}; for (const id of S.sel) drag.base[id] = { ...(S.state.manual[id] || {}) }; }
  let shift = dt;
  if (drag.kind === 'move' && S.snap && !ev.altKey) {
    const a = drag.anchor; const target = snapTime(a.on - ((S.state.manual[a.id]?.dOn || 0) - (drag.base[a.id].dOn || 0)) + dt);
    shift = target - (a.on - ((S.state.manual[a.id]?.dOn || 0) - (drag.base[a.id].dOn || 0)));
  }
  for (const id of S.sel) {
    const b = drag.base[id], m = manual(id);
    if (drag.kind === 'move') { m.dOn = (b.dOn || 0) + shift; m.dOff = (b.dOff || 0) + shift; m.dPitch = (b.dPitch || 0) + dp; }
    else m.dOff = (b.dOff || 0) + dt;
  }
  compute(); draw();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.kind === 'box') {
    const ta = x2t(Math.min(drag.x0, drag.x1)), tb = x2t(Math.max(drag.x0, drag.x1));
    const pa = y2p(Math.max(drag.y0, drag.y1)), pb = y2p(Math.min(drag.y0, drag.y1));
    for (const n of S.final) if (n.on <= tb && n.off >= ta && n.pitch >= pa && n.pitch <= pb) S.sel.add(n.id);
    S.region = Math.abs(drag.x1 - drag.x0) > 4 ? { t0: Math.max(0, ta), t1: tb, lo: pa, hi: pb } : null;
    renderNoteInfo(); if (S.sel.size || S.region) showTab('note');
  } else if (drag.moved) {
    for (const id of S.sel) cleanManual(id);
    S.undo.push(drag.before); S.redo = []; changed();
  }
  drag = null; draw();
});
function hover(x, y, ev) {
  const tip = $('hoverTip');
  const n = y > rollTop() && y < rollBottom() ? noteAt(x, y) : null;
  if (!n) { tip.classList.add('hidden'); cv.style.cursor = 'crosshair'; return; }
  cv.style.cursor = x > t2x(n.off) - 5 ? 'ew-resize' : 'pointer';
  const lines = [`${pname(n.pitch)}  v${n.vel}  ${((n.off - n.on) * 1000).toFixed(0)} ms`, `at ${n.on.toFixed(3)}s` + (Math.abs(n.moved) > 0.0005 ? `  (${n.moved > 0 ? '+' : ''}${(n.moved * 1000).toFixed(0)} ms)` : '')];
  if (n.deleted) lines.push('REMOVED');
  if (n.prot) lines.push('protected ornament');
  tip.textContent = lines.join('\n');
  tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 10) + 'px'; tip.classList.remove('hidden');
  void ev;
}
cv.addEventListener('mouseleave', () => $('hoverTip').classList.add('hidden'));
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = cv.getBoundingClientRect(), x = ev.clientX - r.left;
  if (ev.ctrlKey || ev.metaKey) { zoomAt(x, Math.exp(-ev.deltaY * 0.0025)); return; }
  if (ev.shiftKey) { S.view.pitchTop = Math.max(30, Math.min(127, S.view.pitchTop + Math.sign(ev.deltaY) * -2)); draw(); return; }
  const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  S.view.t0 = Math.max(-2, S.view.t0 + d / S.view.pps); draw();
}, { passive: false });
function zoomAt(x, f) { const t = x2t(x); S.view.pps = Math.max(2, Math.min(1500, S.view.pps * f)); S.view.t0 = t - x / S.view.pps; draw(); }
function zoomTo(t0, t1) {
  const W = cv.clientWidth; S.view.pps = Math.max(4, Math.min(1500, (W * 0.8) / Math.max(0.3, t1 - t0)));
  S.view.t0 = t0 - (W * 0.1) / S.view.pps;
  const ps = S.final.filter(n => n.on < t1 && n.off > t0).map(n => n.pitch);
  if (ps.length) fitPitch(Math.min(...ps), Math.max(...ps));
  draw();
}
function fitPitch(lo, hi) {
  const H = rollBottom() - rollTop();
  S.view.rowH = Math.max(3, Math.min(16, H / (hi - lo + 5)));
  S.view.pitchTop = Math.min(127, hi + Math.floor((H / S.view.rowH - (hi - lo)) / 2));
}

window.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox' && ev.target.type !== 'range' || ev.target.tagName === 'SELECT') return;
  const k = ev.key;
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 's') { ev.preventDefault(); save(); return; }
  if (k === ' ') { ev.preventDefault(); togglePlay(); return; }
  if (k === 'b' || k === 'B') { setSource(S.source === 'clean' ? 'orig' : 'clean'); return; }
  if (k === 'm' || k === 'M') { $('metro').checked = !$('metro').checked; player.metronome = $('metro').checked; return; }
  if (k === 'Home') { ev.preventDefault(); nav.start(); return; }
  if (k === 'End') { ev.preventDefault(); nav.end(); return; }
  if (k === '[' || k === 'PageUp') { ev.preventDefault(); nav.prevSection(); return; }
  if (k === ']' || k === 'PageDown') { ev.preventDefault(); nav.nextSection(); return; }
  if (k === '+' || k === '=') { nav.zoom(1.5); return; }
  if (k === '-' || k === '_') { nav.zoom(1 / 1.5); return; }
  if (k === '0') { nav.fit(); return; }
  if (k === 'Escape') { S.sel.clear(); S.region = null; renderNoteInfo(); draw(); return; }
  if ((k === 'n' || k === 'N') && (S.sel.size || S.region)) { ev.preventDefault(); showTab('note'); renderNoteInfo(); const ta = $('askText'); if (ta) ta.focus(); return; }
  if (!S.sel.size) return;
  if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); commit(() => { for (const id of S.sel) { const m = manual(id); m.deleted = true; m.restored = false; cleanManual(id); } }); return; }
  if (k === 'r' || k === 'R') { commit(() => { for (const id of S.sel) { const n = S.byId.get(id); delete S.state.manual[id]; if (n.delEdit && isAccepted(S.P.edits.find(e => e.id === n.delEdit))) manual(id).restored = true; } }); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    ev.preventDefault(); const d = (k === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 0.001 : 0.01);
    commit(() => { for (const id of S.sel) { const m = manual(id); m.dOn = (m.dOn || 0) + d; m.dOff = (m.dOff || 0) + d; cleanManual(id); } }); return;
  }
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    ev.preventDefault(); const d = k === 'ArrowUp' ? 1 : -1;
    commit(() => { for (const id of S.sel) { const m = manual(id); m.dPitch = (m.dPitch || 0) + d; cleanManual(id); } }); return;
  }
});

// ------------------------------------------------------------------ side panel

function showTab(t) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const id of ['edits', 'sections', 'note']) $('tab-' + id).classList.toggle('hidden', id !== t);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

function renderFilters() {
  const counts = {}; for (const e of S.P.edits) counts[e.type] = (counts[e.type] || 0) + 1;
  const f = $('filters'); f.innerHTML = '';
  for (const t of ['all', ...TYPE_ORDER.filter(t => counts[t])]) {
    const b = document.createElement('button');
    b.textContent = t === 'all' ? 'All' : `${t} ${counts[t]}`;
    b.classList.toggle('on', S.filter === t);
    b.onclick = () => { S.filter = t; renderFilters(); renderEdits(); };
    f.appendChild(b);
  }
}

function renderRequests(box) {
  const reqs = S.state.requests || [];
  if (!reqs.length) return;
  const h = document.createElement('div'); h.className = 'group-h';
  h.innerHTML = `Your notes to Claude <span class="count">${openRequests().length} open / ${reqs.length}</span>`;
  box.appendChild(h);
  for (const q of reqs.slice().reverse()) {
    const rep = S.ai.replies[q.id];
    const st = rep ? 'answered' : (S.ai.running ? 'working' : 'open');
    const d = document.createElement('div');
    d.className = 'edit req' + (S.hotEdit === q.id ? ' hot open' : '');
    d.innerHTML = `<div class="row"><span class="pill q-${st}">${st}</span><span class="lbl">“${esc(q.text)}”</span>
      <button class="mini" data-p="clean" title="Audition cleaned">▶</button><button class="mini" data-p="orig" title="Audition original">A</button>
      <button class="mini del" title="${rep ? 'Dismiss' : 'Delete note'}">✕</button></div>
      <div class="muted small mono">${q.t0.toFixed(2)}–${q.t1.toFixed(2)}s · ${pname(q.lo)}–${pname(q.hi)}</div>
      ${rep ? `<div class="reply"><b>Claude:</b> ${esc(rep.reply)}${rep.changes && rep.changes.length ? '<ul>' + rep.changes.map(c => `<li>${esc(c)}</li>`).join('') + '</ul>' : ''}</div>` : ''}`;
    d.querySelector('.del').onclick = ev => { ev.stopPropagation(); deleteRequest(q.id); };
    for (const b of d.querySelectorAll('button.mini[data-p]')) b.onclick = ev => { ev.stopPropagation(); audition({ t0: q.t0, t1: q.t1, type: 'request' }, b.dataset.p); };
    d.onclick = () => { S.hotEdit = S.hotEdit === q.id ? null : q.id; if (S.hotEdit) { zoomTo(q.t0 - 1.5, q.t1 + 1.5); S.playhead = Math.max(0, q.t0 - 1.5); updateClock(); } renderEdits(); draw(); };
    box.appendChild(d);
  }
}

function renderEdits() {
  const box = $('edits'); box.innerHTML = '';
  if (S.filter === 'all') renderRequests(box);
  for (const type of TYPE_ORDER) {
    if (S.filter !== 'all' && S.filter !== type) continue;
    const list = S.P.edits.filter(e => e.type === type);
    if (!list.length) continue;
    const h = document.createElement('div'); h.className = 'group-h';
    const on = list.filter(e => !e.info && isAccepted(e)).length;
    h.innerHTML = `${TYPE_LABEL[type]} <span class="count">${list[0].info ? list.length : on + '/' + list.length}</span>`;
    if (!list[0].info) {
      for (const [lbl, val] of [['all on', true], ['all off', false], ['AI', null]]) {
        const b = document.createElement('button'); b.textContent = lbl;
        b.onclick = () => commit(() => { for (const e of list) { if (val === null) delete S.state.accepted[e.id]; else S.state.accepted[e.id] = val; } });
        h.appendChild(b);
      }
    }
    box.appendChild(h);
    for (const e of list) box.appendChild(editRow(e));
  }
}

function editRow(e) {
  const d = document.createElement('div');
  const acc = isAccepted(e);
  d.className = 'edit' + (!e.info && !acc ? ' rejected' : '') + (S.hotEdit === e.id ? ' hot open' : '');
  const sec = S.P.sections[e.section];
  const pill = e.type === 'tempo' ? `<span class="pill ${sec.mode}">${sec.mode}</span>` : '';
  const conf = e.confidence != null ? `<span class="conf">${Math.round(e.confidence * 100)}%</span>` : '';
  const aiNote = !e.info && (S.state.accepted[e.id] !== undefined && S.state.accepted[e.id] !== e.default) ? '<span class="conf" title="You overrode the AI default">✎</span>' : '';
  d.innerHTML = `<div class="row">${e.info ? '' : `<input type="checkbox" class="toggle" ${acc ? 'checked' : ''} title="Accept / reject">`}
    <span class="lbl">${pill} ${e.label}</span>${aiNote}${conf}
    <button class="mini" data-p="clean" title="Audition cleaned">▶</button><button class="mini" data-p="orig" title="Audition original">A</button></div>
    <div class="why">${e.rationale || ''}<br><span class="mono">${e.t0.toFixed(2)}s – ${e.t1.toFixed(2)}s</span></div>`;
  const tg = d.querySelector('.toggle');
  if (tg) { tg.onclick = ev => ev.stopPropagation(); tg.onchange = () => commit(() => { S.state.accepted[e.id] = tg.checked; if (tg.checked === e.default) delete S.state.accepted[e.id]; }); }
  for (const b of d.querySelectorAll('button.mini')) b.onclick = ev => { ev.stopPropagation(); audition(e, b.dataset.p); };
  d.onclick = () => {
    S.hotEdit = S.hotEdit === e.id ? null : e.id;
    if (S.hotEdit) {
      const span = e.type === 'tempo' ? [e.t0, e.t1] : [e.t0 - 1.5, e.t1 + 1.5];
      zoomTo(...span);
      S.sel = new Set([...Object.keys(e.notes).map(Number), ...e.deletes, ...(e.type === 'ornament' ? e.ids : [])]);
      if (e.type === 'tempo') S.sel.clear();
      S.playhead = Math.max(0, e.t0 - (e.type === 'tempo' ? 0 : 1.5)); updateClock();
    }
    renderEdits(); renderNoteInfo(); draw();
  };
  return d;
}

function renderSections() {
  const box = $('sections'); box.innerHTML = '';
  for (const s of S.P.sections) {
    const d = document.createElement('div'); d.className = 'secrow'; d.id = 'sec-' + s.index;
    const tempoOn = S.acceptedTempo.has(s.index);
    const dg = s.diag;
    d.innerHTML = `<div><span class="pill ${s.mode}">${s.mode}</span> <b>${s.label}</b></div>
      <div class="meta mono">${fmt(s.start)} → ${fmt(s.end)} · ${(s.end - s.start).toFixed(3)}s · ${s.n_beats} beats (${s.bars} bars ${s.num}/${s.den}) · ${s.bpm.toFixed(1)} bpm</div>
      <div class="meta">${s.mode === 'rubato' ? 'Left as played; tempo map follows the performance.' : (tempoOn ? 'Regularized' : 'Regularization rejected, tempo map follows the performance') + (s.anchor_every_bars ? ` · re-pinned every ${s.anchor_every_bars} bars` : '') + (dg.feel_kept ? ` · keeps feel ${dg.feel.template.map(v => v.toFixed(2)).join('/')}` : '') + ` · max shift ${((s.max_shift || 0) * 1000).toFixed(0)} ms`}</div>
      <div class="meta">${s.note || ''}</div>
      <div class="meta">stutters ${dg.stutters.length} · rubato score ${dg.rubato_score} · beat support ${dg.onset_support}</div>`;
    d.onclick = () => { zoomTo(s.start, s.end); S.playhead = s.start; updateClock(); draw(); };
    box.appendChild(d);
  }
}
function highlightSection(i) { const el = $('sec-' + i); if (el) { el.scrollIntoView({ block: 'nearest' }); el.style.borderColor = css('--accent'); setTimeout(() => el.style.borderColor = '', 900); } }

function selectionRegion() {
  if (S.sel.size) {
    const ns = [...S.sel].map(id => S.byId.get(id)).filter(Boolean);
    const r = { t0: Math.min(...ns.map(n => Math.min(n.on, n.origOn))), t1: Math.max(...ns.map(n => Math.max(n.off, n.origOff))),
      lo: Math.min(...ns.map(n => n.pitch)), hi: Math.max(...ns.map(n => n.pitch)) };
    if (S.region) { r.t0 = Math.min(r.t0, S.region.t0); r.t1 = Math.max(r.t1, S.region.t1); r.lo = Math.min(r.lo, S.region.lo); r.hi = Math.max(r.hi, S.region.hi); }
    return r;
  }
  return S.region;
}

function askForm() {
  const r = selectionRegion();
  if (!r) return null;
  const d = document.createElement('div'); d.className = 'ask';
  d.innerHTML = `<div class="ask-h">Ask Claude to reassess this</div>
    <div class="muted small">${r.t0.toFixed(2)}–${r.t1.toFixed(2)}s · ${pname(r.lo)}–${pname(r.hi)}${S.sel.size ? ` · ${S.sel.size} notes` : ''}</div>
    <textarea id="askText" rows="3" placeholder="e.g. this is a grace note, keep it · the tempo drags here, it should be steady · this should be rubato"></textarea>
    <div class="row"><button id="askSend" class="primary">Add note</button><span class="muted small">Ctrl+Enter · then “Ask Claude” in the top bar</span></div>`;
  const ta = d.querySelector('textarea'), go = () => addRequest(r, ta.value);
  d.querySelector('#askSend').onclick = go;
  ta.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) go(); };
  return d;
}

async function addRequest(r, text) {
  text = text.trim(); if (!text) return;
  const req = { id: 'q' + Date.now().toString(36), created: new Date().toISOString(), t0: +r.t0.toFixed(3), t1: +r.t1.toFixed(3),
    lo: r.lo, hi: r.hi, note_ids: [...S.sel], text };
  (S.state.requests ||= []).push(req);
  S.region = null;
  renderNoteInfo(); renderEdits(); updateAskButton(); draw();
  await save();
  showTab('edits');
}

function deleteRequest(id) {
  S.state.requests = (S.state.requests || []).filter(q => q.id !== id);
  renderEdits(); updateAskButton(); draw(); save();
}

function openRequests() { return (S.state.requests || []).filter(q => !S.ai.replies[q.id]); }

function renderNoteInfo() {
  const box = $('noteInfo');
  const form = askForm();
  if (!S.sel.size) {
    box.innerHTML = form ? '<b>Region selected</b> <span class="muted">(no notes)</span>' : '<span class="muted">Click a note to inspect it. Drag to box-select. Select something, then press N to leave Claude a note about it.</span>';
    if (form) box.appendChild(form);
    return;
  }
  const ns = [...S.sel].map(id => S.byId.get(id)).filter(Boolean);
  if (ns.length > 1) {
    box.innerHTML = `<b>${ns.length} notes selected</b><p class="muted">Delete removes, R restores, arrows nudge/transpose, drag to move.</p>
      <button id="selDel">Remove</button> <button id="selRestore">Restore</button>`;
  } else {
    const n = ns[0];
    const edits = n.edits.map(id => S.P.edits.find(e => e.id === id)).filter(Boolean);
    box.innerHTML = `<div class="kv">
      <div>note</div><div><b>${pname(n.pitch)}</b>${n.pitch !== n.origPitch ? ` (was ${pname(n.origPitch)})` : ''} · id ${n.id}</div>
      <div>onset</div><div class="mono">${n.on.toFixed(3)}s ${Math.abs(n.moved) > 0.0005 ? `(orig ${n.origOn.toFixed(3)}, ${n.moved > 0 ? '+' : ''}${(n.moved * 1000).toFixed(1)} ms)` : ''}</div>
      <div>duration</div><div class="mono">${((n.off - n.on) * 1000).toFixed(0)} ms</div>
      <div>velocity</div><div><input type="range" id="velIn" min="1" max="127" value="${n.vel}"> <span id="velV">${n.vel}</span></div>
      <div>status</div><div>${n.deleted ? '<span style="color:var(--del)">removed</span>' : 'kept'}${n.prot ? ' · protected ornament' : ''}${n.manual ? ' · your edit' : ''}</div>
      <div>edits</div><div>${edits.map(e => `${isAccepted(e) ? '✓' : '✗'} ${e.label}`).join('<br>') || '—'}</div></div>
      <p><button id="selDel">Remove</button> <button id="selRestore">Restore</button></p>`;
    const vi = $('velIn');
    vi.oninput = () => { $('velV').textContent = vi.value; };
    vi.onchange = () => commit(() => { manual(n.id).vel = +vi.value; });
  }
  if (form) box.appendChild(form);
  $('selDel').onclick = () => commit(() => { for (const n of ns) { const m = manual(n.id); m.deleted = true; m.restored = false; cleanManual(n.id); } });
  $('selRestore').onclick = () => commit(() => { for (const n of ns) { delete S.state.manual[n.id]; if (n.delEdit && isAccepted(S.P.edits.find(e => e.id === n.delEdit))) manual(n.id).restored = true; } });
}

// ------------------------------------------------------------------ playback

function playbackNotes(src) {
  if (src === 'orig') return { notes: S.P.notes.map(n => ({ ...n })), ccs: S.P.ccs };
  return { notes: S.final.filter(n => !n.deleted).map(n => ({ pitch: n.pitch, vel: n.vel, on: n.on, off: n.off })), ccs: S.finalCcs };
}
function startPlayback(from, to) {
  if (!player.lookup) return;
  const { notes, ccs } = playbackNotes(S.source);
  player.metronome = $('metro').checked;
  player.play(notes, ccs, from, to, S.beats);
  $('play').textContent = '❚❚ Pause';
}
function togglePlay() {
  if (player.playing) { S.playhead = player.position(); player.stop(); $('play').textContent = '▶ Play'; draw(); return; }
  startPlayback(S.playhead, null);
}
function restartIfPlaying() { if (player.playing && !S.audition) { const p = player.position(); player.stop(); S.playhead = p; startPlayback(p, null); } }
function audition(e, src) {
  const a = Math.max(0, e.t0 - 1.5), b = e.type === 'tempo' ? Math.min(e.t1, e.t0 + 12) : e.t1 + 1.5;
  setSource(src, true);
  S.playhead = a; S.audition = true;
  startPlayback(a, b);
}
function setSource(src, quiet) {
  S.source = src;
  $('srcClean').classList.toggle('on', src === 'clean'); $('srcOrig').classList.toggle('on', src === 'orig');
  if (!quiet) restartIfPlaying();
  draw();
}
player.onTick = t => {
  S.playhead = t; updateClock();
  if ($('follow').checked) { const x = t2x(t), W = cv.clientWidth; if (x > W * 0.85 || x < 0) S.view.t0 = t - (W * 0.15) / S.view.pps; }
  draw();
};
player.onEnd = () => { $('play').textContent = '▶ Play'; S.audition = false; };
function currentSection(t) {
  const secs = S.P.sections;
  for (const s of secs) if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s;
  return t < secs[0].start ? secs[0] : secs[secs.length - 1];
}
function updateClock() {
  $('clock').textContent = fmt(S.playhead);
  if (S.P) { const s = currentSection(S.playhead); $('secName').textContent = `${s.index + 1}/${S.P.sections.length} · ${s.label}`; $('secName').title = `${s.label} (${s.mode}) · ${fmt(s.start)} – ${fmt(s.end)}`; }
}

// Button / key navigation (trackpad-free). Moving the playhead also moves playback if playing.
const nav = {
  seek(t, viewT0) {
    S.playhead = Math.max(0, Math.min(t, S.P.end));
    if (viewT0 !== undefined) S.view.t0 = viewT0;
    else { const x = t2x(S.playhead), W = cv.clientWidth; if (x < 0 || x > W - 20) S.view.t0 = S.playhead - (W * 0.1) / S.view.pps; }
    updateClock(); restartIfPlaying(); draw();
  },
  showSection(s) {
    const W = cv.clientWidth, span = s.end - s.start;
    S.view.pps = Math.max(4, Math.min(1500, (W * 0.92) / Math.max(1, span)));
    nav.seek(s.start, s.start - (W * 0.04) / S.view.pps);
    highlightSection(s.index);
  },
  start() { nav.seek(0, -0.5); },
  end() {
    const lastOn = Math.max(...S.final.filter(n => !n.deleted).map(n => n.on));
    const W = cv.clientWidth;
    nav.seek(lastOn, Math.max(-0.5, S.P.end - (W * 0.9) / S.view.pps));
  },
  prevSection() {
    const cur = currentSection(S.playhead);
    const target = (S.playhead - cur.start > 0.75 || cur.index === 0) ? cur : S.P.sections[cur.index - 1];
    nav.showSection(target);
  },
  nextSection() {
    const cur = currentSection(S.playhead);
    if (S.playhead < cur.start - 1e-6) return nav.showSection(cur);
    const nxt = S.P.sections[cur.index + 1];
    if (nxt) nav.showSection(nxt);
  },
  zoom(f) {
    // keep the playhead fixed on screen if it's visible, otherwise zoom around the view centre
    const W = cv.clientWidth, px = t2x(S.playhead);
    zoomAt(px >= 0 && px <= W ? px : W / 2, f);
  },
  fit() { const W = cv.clientWidth; S.view.pps = Math.max(2, (W - 30) / (S.P.end + 1)); S.view.t0 = -0.5; draw(); },
};

// ------------------------------------------------------------------ FX panel

function renderFx() {
  const fx = player.fx, box = $('fxPanel'); box.innerHTML = '';
  const unit = (name, key, sliders) => {
    const u = document.createElement('div'); u.className = 'unit' + (key && !fx[key].on ? ' off' : '');
    if (key) {
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = fx[key].on; c.id = 'fx-' + key;
      c.onchange = () => { fx[key].on = c.checked; u.classList.toggle('off', !c.checked); apply(); };
      u.appendChild(c);
    }
    const l = document.createElement('label'); l.className = 'name'; l.textContent = name; if (key) l.htmlFor = 'fx-' + key; u.appendChild(l);
    for (const [lbl, obj, prop, min, max, st, show] of sliders) {
      const s = document.createElement('input'); s.type = 'range'; s.min = min; s.max = max; s.step = st; s.value = obj[prop]; s.title = lbl;
      const v = document.createElement('span'); v.className = 'val'; v.textContent = show(obj[prop]);
      s.oninput = () => { obj[prop] = +s.value; v.textContent = show(+s.value); apply(); };
      const sl = document.createElement('span'); sl.className = 'muted'; sl.textContent = lbl;
      u.append(sl, s, v);
    }
    box.appendChild(u);
  };
  const pct = v => Math.round(v * 100) + '%', sec = v => v.toFixed(1) + 's', ms = v => Math.round(v * 1000) + 'ms', db = v => (v > 0 ? '+' : '') + v + 'dB';
  unit('Reverb', 'reverb', [['mix', fx.reverb, 'mix', 0, 1, 0.01, pct], ['size', fx.reverb, 'size', 0.5, 6, 0.1, sec]]);
  unit('Delay', 'delay', [['mix', fx.delay, 'mix', 0, 0.8, 0.01, pct], ['time', fx.delay, 'time', 0.05, 1, 0.01, ms], ['feedback', fx.delay, 'feedback', 0, 0.85, 0.01, pct]]);
  unit('Chorus', 'chorus', [['mix', fx.chorus, 'mix', 0, 1, 0.01, pct], ['depth', fx.chorus, 'depth', 0, 1, 0.01, pct]]);
  unit('Drive', 'drive', [['amount', fx.drive, 'amount', 0, 1, 0.01, pct]]);
  unit('EQ', 'eq', [['bass', fx.eq, 'low', -12, 12, 1, db], ['treble', fx.eq, 'high', -12, 12, 1, db]]);
  unit('Compressor', 'comp', []);
  unit('Volume', null, [['', fx, 'volume', 0, 1.5, 0.01, pct]]);
  const reset = document.createElement('button'); reset.textContent = 'Reset';
  reset.onclick = () => { player.setFx(JSON.parse(JSON.stringify(Audio2.FX_DEFAULTS))); renderFx(); persistFx(); };
  box.appendChild(reset);
  function apply() { player.setFx(fx); persistFx(); }
}
function persistFx() { try { localStorage.setItem('midicleaner.fx', JSON.stringify(player.fx)); } catch (e) { /* storage unavailable */ } }

// ------------------------------------------------------------------ boot

async function loadProject(name, keepView) {
  player.stop();
  const P = await (await fetch(`/api/project/${encodeURIComponent(name)}`)).json();
  S.P = P; S.name = name;
  S.state = { accepted: {}, manual: {}, requests: [], ...(P.review || {}) };
  applyAiStatus(P.status);
  S.ai.loadedMtime = P.status.proposals_mtime;
  // Claude may ask to clear your earlier toggles on edits it re-decided (each reply applied once)
  const applied = new Set(S.state.applied_replies || []);
  for (const [qid, rep] of Object.entries(S.ai.replies)) {
    if (applied.has(qid)) continue;
    for (const id of rep.reset_overrides || []) delete S.state.accepted[id];
    applied.add(qid);
  }
  S.state.applied_replies = [...applied];
  $('banner').classList.add('hidden');
  S.undo = []; S.redo = []; S.sel.clear(); S.hotEdit = null; S.region = null;
  if (!keepView) S.playhead = 0;
  $('saveState').textContent = P.review ? 'loaded saved review' : 'AI defaults';
  compute();
  const ps = P.notes.map(n => n.pitch);
  if (!keepView) {
    S.view.t0 = -0.5; S.view.pps = Math.max(8, (cv.clientWidth - 40) / 60);
    fitPitch(Math.min(...ps), Math.max(...ps));
  }
  renderFilters(); renderEdits(); renderSections(); renderNoteInfo(); updateClock(); updateAskButton(); draw();
  $('status').textContent = `${P.notes.length} notes · ${P.sections.length} sections · ${P.edits.filter(e => !e.info).length} proposed edits`;
  try { localStorage.setItem('midicleaner.project', name); } catch (e) { /* ignore */ }
}

function applyAiStatus(st) {
  S.ai.replies = st.replies || {};
  S.ai.running = st.running;
  S.ai.available = st.claude_available;
  S.ai.log = st.log;
}

function updateAskButton() {
  const b = $('askAI'), n = openRequests().length;
  b.textContent = S.ai.running ? 'Claude is working…' : `Ask Claude${n ? ` (${n})` : ''}`;
  b.disabled = S.ai.running || !n;
  b.classList.toggle('primary', !!n && !S.ai.running);
  b.title = S.ai.available ? 'Run Claude Code (headless) on your open notes. It re-plans those regions and replies here.'
    : 'claude CLI not found. In your Claude Code session run: /clean-midi reassess ' + (S.name || '');
  $('aiLog').textContent = S.ai.running ? (S.ai.log || '').split('\n').filter(Boolean).slice(-1)[0] || '' : '';
}

async function askClaude() {
  await save();
  const r = await fetch(`/api/reassess/${encodeURIComponent(S.name)}`, { method: 'POST', body: '{}' });
  const j = await r.json();
  if (!j.ok) { $('status').textContent = j.message; return; }
  S.ai.running = true; updateAskButton(); renderEdits();
}

async function pollAi() {
  if (!S.name) return;
  try {
    const st = await (await fetch(`/api/status/${encodeURIComponent(S.name)}`)).json();
    const wasRunning = S.ai.running, before = JSON.stringify(S.ai.replies);
    applyAiStatus(st);
    if (before !== JSON.stringify(S.ai.replies) || wasRunning !== st.running) { renderEdits(); draw(); }
    if (wasRunning && !st.running) $('status').textContent = st.exit_code ? `Claude exited with code ${st.exit_code}; see work/${S.name}/ai_log.txt` : 'Claude finished';
    if (st.proposals_mtime > S.ai.loadedMtime + 0.5 && !st.running) $('banner').classList.remove('hidden');
    updateAskButton();
  } catch (e) { /* server restarting */ }
}

async function setInstrument(id) {
  $('status').textContent = 'loading samples…';
  $('instrument').disabled = true;
  try { await player.setInstrument(id); $('status').textContent = `${player.inst.name} ready`; }
  catch (err) { $('status').textContent = 'sample load failed: ' + err; }
  $('instrument').disabled = false;
  S.state.instrument = id;
}

async function boot() {
  try { const fx = JSON.parse(localStorage.getItem('midicleaner.fx')); if (fx && fx.reverb) player.fx = Object.assign(JSON.parse(JSON.stringify(Audio2.FX_DEFAULTS)), fx); } catch (e) { /* ignore */ }
  const sel = $('instrument');
  for (const i of Audio2.INSTRUMENTS) { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name; sel.appendChild(o); }
  sel.onchange = () => { const wasPlaying = player.playing; const p = player.position(); player.stop(); setInstrument(sel.value).then(() => { if (wasPlaying) { S.playhead = p; startPlayback(p, null); } }); };
  const projects = await (await fetch('/api/projects')).json();
  const ps = $('project');
  for (const p of projects) { const o = document.createElement('option'); o.value = p.name; o.textContent = p.name + (p.reviewed ? ' ✓' : ''); ps.appendChild(o); }
  ps.onchange = () => loadProject(ps.value);
  $('play').onclick = () => { player.ensure(); togglePlay(); };
  $('stop').onclick = () => { player.stop(); $('play').textContent = '▶ Play'; S.playhead = Math.max(0, S.view.t0 + 0.5); updateClock(); draw(); };
  $('srcClean').onclick = () => setSource('clean'); $('srcOrig').onclick = () => setSource('orig');
  $('metro').onchange = () => { player.metronome = $('metro').checked; };
  $('ghosts').onchange = () => { S.ghosts = $('ghosts').checked; draw(); };
  $('snap').onchange = () => { S.snap = $('snap').checked; };
  $('undo').onclick = undo; $('redo').onclick = redo; $('save').onclick = save;
  $('help').onclick = () => $('helpDlg').showModal();
  $('navStart').onclick = nav.start; $('navEnd').onclick = nav.end;
  $('navPrev').onclick = nav.prevSection; $('navNext').onclick = nav.nextSection;
  $('zoomIn').onclick = () => nav.zoom(1.5); $('zoomOut').onclick = () => nav.zoom(1 / 1.5); $('zoomFit').onclick = nav.fit;
  $('askAI').onclick = askClaude;
  $('reloadBtn').onclick = async () => { await save(); await loadProject(S.name, true); $('status').textContent = 'Reloaded Claude\'s updated proposals (your decisions kept)'; };
  setInterval(pollAi, 3000);
  $('fxToggle').onclick = () => { $('fxPanel').classList.toggle('hidden'); resize(); };
  $('exportMid').onclick = async () => {
    S.state.fx = player.fx; S.state.instrument = player.inst.id;
    $('status').textContent = 'rendering MIDI…';
    const r = await fetch(`/api/export/${encodeURIComponent(S.name)}`, { method: 'POST', body: JSON.stringify(S.state) });
    if (!r.ok) { $('status').textContent = 'export failed: ' + (await r.text()).slice(0, 200); return; }
    const blob = await r.blob();
    download(blob, `${S.name}.clean.mid`);
    S.dirty = false; $('saveState').textContent = 'saved + exported';
    $('status').textContent = `wrote work/${S.name}/${S.name}.clean.mid · ` + (r.headers.get('X-Render-Log') || '').split(' | ')[1];
  };
  $('exportWav').onclick = async () => {
    if (!player.lookup) return;
    $('status').textContent = 'rendering WAV (this takes a few seconds)…';
    const { notes, ccs } = playbackNotes(S.source);
    const blob = await player.renderWav(notes, ccs, S.P.end, m => $('status').textContent = m);
    download(blob, `${S.name}.${S.source === 'orig' ? 'original' : 'clean'}.${player.inst.id}.wav`);
    $('status').textContent = 'WAV exported (' + (S.source === 'orig' ? 'original' : 'cleaned') + ', ' + player.inst.name + ')';
  };
  window.addEventListener('beforeunload', ev => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  new ResizeObserver(resize).observe($('rollWrap'));
  renderFx();
  let want = null; try { want = localStorage.getItem('midicleaner.project'); } catch (e) { /* ignore */ }
  const pick = projects.find(p => p.name === want) || projects[projects.length - 1];
  if (!pick) { $('status').textContent = 'No projects in work/. Run the pipeline first.'; return; }
  ps.value = pick.name;
  await loadProject(pick.name);
  const m = /t=([\d.]+)-([\d.]+)/.exec(location.hash);  // e.g. #t=120-130 opens zoomed there
  if (m) { zoomTo(+m[1], +m[2]); S.playhead = +m[1]; updateClock(); }
  const inst = S.state.instrument || 'salamander';
  if (S.state.fx) { player.fx = Object.assign(JSON.parse(JSON.stringify(Audio2.FX_DEFAULTS)), S.state.fx); renderFx(); }
  sel.value = inst;
  setInstrument(inst);
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

boot();
