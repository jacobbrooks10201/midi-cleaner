#!/usr/bin/env python3
"""Stage 1: analyze a raw performance MIDI.

    python3 pipeline/analyze.py path/to/take.mid [--work work/] [--trim auto|yes|no]

Lead-in silence: --trim yes moves the first note to 0:00. --trim no keeps the file's own clock
(use it when MIDI 0:00 is already video 0:00). auto (default) keeps the clock if a sidecar
<take>.json next to the MIDI declares "time_zero" (the recorder's video-aligned takes), else trims.

Writes work/<name>/:
  analysis.json  - trimmed notes/pedal, detections (trills, rolls, slip candidates),
                   local tempo curve, onset clusters
  plan.auto.json - machine-suggested section plan (the AI reviews and copies it to plan.json)
  report.md      - readable summary for the AI reviewer

Nothing here changes notes. All times are on the pipeline timeline: file time minus `trim`
(trim = 0 when the lead-in is kept, so pipeline time == video time).
"""
import argparse
import json
import os
import shutil
import sys

import numpy as np
from scipy.ndimage import gaussian_filter1d

sys.path.insert(0, os.path.dirname(__file__))
import midiio  # noqa: E402

NAMES = "C C# D D# E F F# G G# A A# B".split()
FS = 100  # onset-signal sample rate (Hz)


def pname(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


# --------------------------------------------------------------------------- load


def sidecar_says_aligned(path):
    """The recorder writes <take>.json; "time_zero" means the MIDI clock already is the video clock."""
    try:
        with open(os.path.splitext(path)[0] + ".json") as f:
            return bool(json.load(f).get("time_zero"))
    except (OSError, ValueError):
        return False


def load_trimmed(path, do_trim=True):
    song = midiio.read(path)
    if not song.notes:
        raise SystemExit("no notes in file")
    trim = min(n.on for n in song.notes) if do_trim else 0.0
    notes = [
        dict(id=n.id, pitch=n.pitch, vel=n.vel, on=round(n.on - trim, 6),
             off=round(n.off - trim, 6), ch=n.ch)
        for n in song.notes
    ]
    # Pedal/CC events before the first note collapse to t=0 keeping only the final state per controller.
    ccs, pre = [], {}
    for c in song.ccs:
        t = c.t - trim
        if t <= 0:
            pre[(c.ch, c.num)] = c
        else:
            ccs.append(dict(id=c.id, num=c.num, val=c.val, t=round(t, 6), ch=c.ch))
    ccs = [dict(id=c.id, num=c.num, val=c.val, t=0.0, ch=c.ch) for c in pre.values()] + ccs
    ccs.sort(key=lambda c: (c["t"], c["id"]))
    return song, trim, notes, ccs


# --------------------------------------------------------------------------- helpers


def onset_clusters(notes, win=0.035):
    """Group near-simultaneous onsets into strike events."""
    order = sorted(notes, key=lambda n: n["on"])
    clusters, cur = [], [order[0]]
    for n in order[1:]:
        if n["on"] - cur[0]["on"] < win:
            cur.append(n)
        else:
            clusters.append(cur)
            cur = [n]
    clusters.append(cur)
    return [dict(t=c[0]["on"], ids=[n["id"] for n in c],
                 w=round(sum(n["vel"] for n in c) / 127.0, 3),
                 bass=min(n["pitch"] for n in c)) for c in clusters]


def onset_signal(clusters, end, sigma=1.5):
    x = np.zeros(int(end * FS) + 4 * FS)
    for c in clusters:
        x[int(round(c["t"] * FS))] += c["w"]
    return gaussian_filter1d(x, sigma)


def pedal_down_at(ccs, t):
    v = 0
    for c in ccs:
        if c["num"] != 64:
            continue
        if c["t"] > t:
            break
        v = c["val"]
    return v >= 64


def local_tempo(x, a, b, lo=40, hi=220):
    """Autocorrelation tempo estimate for window [a,b) seconds. Returns ranked (bpm, score)."""
    seg = x[int(a * FS):int(b * FS)]
    if len(seg) < 2 * FS or seg.sum() == 0:
        return []
    seg = seg - seg.mean()
    ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
    ac = ac / (ac[0] + 1e-9)
    out = []
    for bpm in np.arange(lo, hi + 1, 1.0):
        P = 60.0 / bpm
        v = 0.0
        for k, wk in ((1, 1.0), (2, 0.6), (3, 0.4), (4, 0.3)):
            i = P * k * FS
            i0 = int(i)
            if i0 + 1 < len(ac):
                fr = i - i0
                v += wk * ((1 - fr) * ac[i0] + fr * ac[i0 + 1])
        out.append((float(bpm), float(v)))
    out.sort(key=lambda r: -r[1])
    # keep distinct peaks only
    peaks = []
    for bpm, v in out:
        if all(abs(bpm - p) > 4 for p, _ in peaks):
            peaks.append((bpm, round(v, 3)))
        if len(peaks) == 4:
            break
    return peaks


# --------------------------------------------------------------------------- detectors


def detect_ornaments(notes, max_ioi=0.17, min_notes=5):
    """Trills (|interval| <= 3 semitones) and tremolos (<= 12) = rapid alternation of two pitches.
    These are protected: nothing is deleted and their internal timing is never changed."""
    by_pitch = {}
    for n in notes:
        by_pitch.setdefault(n["pitch"], []).append(n)
    pitches = sorted(by_pitch)
    found = []
    for i, a in enumerate(pitches):
        for b in pitches[i + 1:]:
            if b - a > 12:
                break
            seq = sorted(by_pitch[a] + by_pitch[b], key=lambda n: n["on"])
            run = [seq[0]]
            for n in seq[1:] + [None]:
                ok = (n is not None and n["pitch"] != run[-1]["pitch"]
                      and 0.02 < n["on"] - run[-1]["on"] < max_ioi)
                if ok:
                    run.append(n)
                    continue
                if len(run) >= min_notes:
                    found.append(dict(lo=a, hi=b, ids=[r["id"] for r in run],
                                      t0=run[0]["on"], t1=run[-1]["off"]))
                run = [n] if n is not None else []
    # merge overlapping detections that share notes; prefer the longer one
    found.sort(key=lambda f: -len(f["ids"]))
    taken, out = set(), []
    for f in found:
        if taken.intersection(f["ids"]):
            continue
        taken.update(f["ids"])
        span = f["hi"] - f["lo"]
        kind = "trill" if span <= 3 else "tremolo"
        ons = [n["on"] for n in notes if n["id"] in set(f["ids"])]
        rate = (len(ons) - 1) / max(1e-6, max(ons) - min(ons))
        out.append(dict(kind=kind, pitches=[f["lo"], f["hi"]], ids=f["ids"],
                        t0=round(f["t0"], 4), t1=round(f["t1"], 4), rate_hz=round(rate, 2),
                        label=f"{kind} {pname(f['lo'])}/{pname(f['hi'])}, {len(f['ids'])} notes"))
    out.sort(key=lambda o: o["t0"])
    return out


def detect_rolls(notes, protected, max_gap=0.13, min_strikes=3, max_span=0.7):
    """Rolled chords: >=3 strikes in one pitch direction, mostly chordal leaps, keys held together.
    Returns per roll the strikes (each strike may be several near-simultaneous notes)."""
    order = [n for n in sorted(notes, key=lambda n: (n["on"], n["pitch"])) if n["id"] not in protected]
    # strikes: notes within 20 ms count as one strike (chord spread, not arpeggiation)
    strikes = []
    for n in order:
        if strikes and n["on"] - strikes[-1][0]["on"] < 0.02:
            strikes[-1].append(n)
        else:
            strikes.append([n])

    def sp(s):
        return sum(n["pitch"] for n in s) / len(s)

    rolls, i = [], 0
    while i < len(strikes) - 2:
        chain = [strikes[i]]
        direction = 0
        j = i + 1
        while j < len(strikes):
            prev, cur = chain[-1], strikes[j]
            gap = cur[0]["on"] - prev[0]["on"]
            if gap > max_gap or cur[0]["on"] - chain[0][0]["on"] > max_span:
                break
            d = np.sign(sp(cur) - sp(prev))
            step = abs(sp(cur) - sp(prev))
            if d == 0 or (direction and d != direction) or step < 2:
                break
            direction = direction or d
            chain.append(cur)
            j += 1
        if len(chain) >= min_strikes:
            ons = [s[0]["on"] for s in chain]
            gaps = np.diff(ons)
            leaps = np.mean([abs(sp(b) - sp(a)) >= 3 for a, b in zip(chain, chain[1:])])
            # held together? first strike still sounding at last strike onset (or any overlap chain)
            held = np.mean([max(n["off"] for n in a) > b[0]["on"] for a, b in zip(chain, chain[1:])])
            # A real roll is audibly arpeggiated: >= 60 ms total and >= 25 ms per step on average.
            # Tighter spreads are ordinary chord "flam" (part of touch) and are left alone.
            if leaps >= 0.6 and held >= 0.6 and gaps.mean() >= 0.025 and ons[-1] - ons[0] >= 0.06:
                cv = float(gaps.std() / gaps.mean())
                rolls.append(dict(
                    strikes=[[n["id"] for n in s] for s in chain],
                    t0=round(ons[0], 4), t1=round(ons[-1], 4), span=round(ons[-1] - ons[0], 4),
                    direction="up" if direction > 0 else "down",
                    gaps_ms=[round(g * 1000) for g in gaps], unevenness=round(cv, 3),
                    label=f"rolled chord {'up' if direction > 0 else 'down'} "
                          f"{pname(min(n['pitch'] for n in chain[0]))}..{pname(max(n['pitch'] for n in chain[-1]))}"))
            i = j
        else:
            i += 1
    return rolls


def key_weights(notes, t, half=6.0):
    """Pitch-class weight profile around time t (duration x velocity weighted)."""
    w = np.zeros(12)
    for n in notes:
        if abs(n["on"] - t) <= half:
            w[n["pitch"] % 12] += min(n["off"] - n["on"], 1.5) * n["vel"]
    return w / (w.sum() + 1e-9)


def detect_slips(notes, protected, roll_ids):
    """Candidate fat-fingers / missed notes. Each candidate carries the evidence so the AI can judge."""
    order = sorted(notes, key=lambda n: n["on"])
    out = {}

    def add(n, kind, conf, why):
        prev = out.get(n["id"])
        if prev is None or conf > prev["confidence"]:
            out[n["id"]] = dict(id=n["id"], kind=kind, confidence=round(conf, 2), why=why,
                                pitch=pname(n["pitch"]), t=round(n["on"], 3), vel=n["vel"],
                                dur_ms=round((n["off"] - n["on"]) * 1000))

    vels = np.array([n["vel"] for n in order])
    for i, n in enumerate(order):
        if n["id"] in protected:
            continue
        dur = n["off"] - n["on"]
        kw = key_weights(order, n["on"])
        rare = kw[n["pitch"] % 12] < 0.03
        loc = vels[max(0, i - 15):i + 15]
        soft = n["vel"] < np.percentile(loc, 30)
        # 1) neighbour graze: adjacent key struck together with a stronger, longer note
        for m in order[max(0, i - 8):i + 8]:
            if m is n:
                continue
            dp = abs(m["pitch"] - n["pitch"])
            if dp in (1, 2) and abs(m["on"] - n["on"]) <= 0.06:
                mdur = m["off"] - m["on"]
                if n["vel"] <= 0.7 * m["vel"] and dur <= max(0.15, 0.6 * mdur):
                    conf = 0.55 + 0.2 * rare + 0.15 * (dur < 0.09) + 0.1 * (n["vel"] < 0.45 * m["vel"])
                    add(n, "graze", min(conf, 0.95),
                        f"adjacent to {pname(m['pitch'])} (v{m['vel']}, {round(mdur*1000)}ms) struck "
                        f"{round((n['on']-m['on'])*1000):+d}ms apart; this one v{n['vel']}, {round(dur*1000)}ms"
                        + ("; out of local key" if rare else ""))
        # 2) pre-strike: same key hit again shortly after, first hit short & softer (a fumbled entry)
        for m in order[i + 1:i + 12]:
            gap = m["on"] - n["on"]
            if gap > 0.25:
                break
            if m["pitch"] == n["pitch"] and gap > 0.03 and dur < 0.12 and n["vel"] <= 0.85 * m["vel"] \
                    and n["id"] not in roll_ids:
                add(n, "prestrike", 0.45 + 0.15 * (dur < 0.07) + 0.1 * soft,
                    f"same key re-struck {round(gap*1000)}ms later at v{m['vel']}; this hit v{n['vel']}, "
                    f"{round(dur*1000)}ms")
        # 3) wrong note corrected: out-of-key, short, followed by a neighbouring in-key note
        if rare and dur < 0.16:
            for m in order[i + 1:i + 8]:
                if m["on"] - n["on"] > 0.35:
                    break
                if abs(m["pitch"] - n["pitch"]) in (1, 2) and kw[m["pitch"] % 12] >= 0.03:
                    add(n, "wrong-note", 0.5 + 0.15 * soft + 0.1 * (dur < 0.09),
                        f"out of local key, {round(dur*1000)}ms, followed {round((m['on']-n['on'])*1000)}ms later "
                        f"by in-key neighbour {pname(m['pitch'])}")
                    break
        # 4) ghost: barely-touched key
        if dur < 0.07 and n["vel"] < 22 and n["id"] not in roll_ids:
            add(n, "ghost", 0.4 + 0.2 * rare, f"very short ({round(dur*1000)}ms) and very soft (v{n['vel']})"
                + ("; out of local key" if rare else ""))
    return sorted(out.values(), key=lambda c: c["t"])


# --------------------------------------------------------------------------- sections


def tempo_curve(x, end, win=10.0, hop=2.0):
    out = []
    t = 0.0
    while t < end - 2:
        peaks = local_tempo(x, t, min(end, t + win))
        out.append(dict(t=round(t + win / 2, 2), peaks=peaks))
        t += hop
    return out


def suggest_sections(clusters, curve, end):
    """Rough proposal: split at long silences and where the dominant tactus jumps > 12%.
    The AI is expected to refine meter, boundaries, and mode."""
    def tactus(peaks):
        # choose the strongest peak inside 60..200 (beat-level)
        for bpm, _ in peaks:
            if 60 <= bpm <= 200:
                return bpm
        return peaks[0][0] if peaks else None

    pts = [(c["t"], tactus(c["peaks"])) for c in curve if c["peaks"]]
    # median-smooth
    vals = [p[1] for p in pts]
    sm = [float(np.median(vals[max(0, i - 2):i + 3])) for i in range(len(vals))]
    bounds = [0.0]
    cur = sm[0]
    for (t, _), v in zip(pts, sm):
        if abs(v - cur) / cur > 0.12 and t - bounds[-1] > 12:
            # move boundary to nearest strong onset
            near = min(clusters, key=lambda c: abs(c["t"] - (t - 5)) - 0.02 * c["w"])
            bounds.append(round(near["t"], 3))
            cur = v
    secs = []
    for k, b in enumerate(bounds):
        e = bounds[k + 1] if k + 1 < len(bounds) else None
        mid = [v for (t, _), v in zip(pts, sm) if t >= b and (e is None or t < e)]
        bpm = float(np.median(mid)) if mid else sm[-1]
        secs.append(dict(start=b, bpm_hint=round(bpm, 1), num=4, den=4, mode="regular",
                         note="auto: meter unknown, review"))
    return secs


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("midi")
    ap.add_argument("--work", default=os.path.join(os.path.dirname(__file__), "..", "work"))
    ap.add_argument("--trim", choices=["auto", "yes", "no"], default="auto")
    args = ap.parse_args()
    aligned = sidecar_says_aligned(args.midi)
    do_trim = args.trim == "yes" or (args.trim == "auto" and not aligned)

    name = os.path.splitext(os.path.basename(args.midi))[0]
    wd = os.path.abspath(os.path.join(args.work, name))
    os.makedirs(wd, exist_ok=True)

    song, trim, notes, ccs = load_trimmed(args.midi, do_trim)
    end = round(song.end - trim, 6)
    last_off = max(n["off"] for n in notes)
    clusters = onset_clusters(notes)
    x = onset_signal(clusters, end)
    curve = tempo_curve(x, end)
    orn = detect_ornaments(notes)
    protected = {i for o in orn for i in o["ids"]}
    rolls = [r for r in detect_rolls(notes, protected)
             if not any(o["t0"] - 0.05 <= r["t0"] <= o["t1"] for o in orn)]
    roll_ids = {i for r in rolls for s in r["strikes"] for i in s}
    slips = detect_slips(notes, protected, roll_ids)

    analysis = dict(
        source=os.path.abspath(args.midi), name=name, trim=round(trim, 6), end=end,
        lead_in_kept=not do_trim, first_note=round(min(n["on"] for n in notes), 6),
        last_note_off=round(last_off, 6), tpq=song.tpq,
        original_tempos=song.tempos, original_timesigs=song.timesigs,
        notes=notes, ccs=ccs, clusters=clusters, tempo_curve=curve,
        ornaments=orn, rolls=rolls, slips=slips,
    )
    with open(os.path.join(wd, "analysis.json"), "w") as f:
        json.dump(analysis, f)

    plan = dict(
        source=os.path.abspath(args.midi),
        sections=suggest_sections(clusters, curve, end),
        slip_decisions={},     # note id -> {"action": "delete"|"keep", "why": "..."}
        roll_decisions={},     # first note id of the roll -> {"action": "even"|"keep", "why": "..."}
        extra_protect=[],      # note ids the AI wants untouched (treated like trill notes)
        notes="",
    )
    with open(os.path.join(wd, "plan.auto.json"), "w") as f:
        json.dump(plan, f, indent=1)
    if not os.path.exists(os.path.join(wd, "plan.json")):
        shutil.copy(os.path.join(wd, "plan.auto.json"), os.path.join(wd, "plan.json"))

    # ------------------------------------------------------------- report
    L = []
    L.append(f"# Analysis: {name}\n")
    if do_trim:
        L.append(f"- trimmed leading silence: **{trim:.3f}s** (first note now at 0.000)")
    else:
        first = min(n["on"] for n in notes)
        L.append(f"- lead-in **kept**: pipeline time == file time{' == video time (sidecar)' if aligned else ''}; "
                 f"first note at {first:.3f}s. The first section must start at 0.000 (make 0 -> first downbeat its own rubato section).")
    L.append(f"- duration: {end:.3f}s (end-of-track), last note-off {last_off:.3f}s")
    L.append(f"- notes: {len(notes)}, onset clusters: {len(clusters)}, CC events: {len(ccs)}\n")
    L.append("## Local tempo (10 s windows, top autocorrelation peaks, bpm:score)\n")
    L.append("Peaks related by 2x/3x indicate the metric hierarchy (e.g. 177 and 59 => 3 beats per bar).\n")
    L.append("| t | peaks | onsets in window |")
    L.append("|---|---|---|")
    for c in curve[::2]:
        cnt = sum(1 for k in clusters if c["t"] - 5 <= k["t"] < c["t"] + 5)
        L.append(f"| {c['t']:.0f} | {', '.join(f'{b:.0f}:{s}' for b, s in c['peaks'])} | {cnt} |")
    L.append("\n## Long silences (> 0.8 s between onsets)\n")
    for a, b in zip(clusters, clusters[1:]):
        if b["t"] - a["t"] > 0.8:
            L.append(f"- {a['t']:.2f} -> {b['t']:.2f} ({b['t']-a['t']:.2f}s)")
    L.append(f"\n## Ornaments (protected, never edited): {len(orn)}\n")
    for o in orn:
        L.append(f"- {o['t0']:.2f}-{o['t1']:.2f}s {o['label']} @ {o['rate_hz']} notes/s")
    L.append(f"\n## Rolled chord candidates: {len(rolls)}\n")
    for i, r in enumerate(rolls):
        L.append(f"- [first note {r['strikes'][0][0]}] {r['t0']:.2f}s {r['label']}, span {r['span']*1000:.0f}ms, "
                 f"gaps {r['gaps_ms']} ms, unevenness {r['unevenness']}")
    L.append(f"\n## Slip candidates (fat-finger / missed): {len(slips)}\n")
    for s in slips:
        L.append(f"- id {s['id']} @ {s['t']:.3f}s {s['pitch']} [{s['kind']}, conf {s['confidence']}] {s['why']}")
    L.append("\n## Auto section suggestion (needs AI review: meter, downbeat, mode)\n")
    for s in plan["sections"]:
        L.append(f"- start {s['start']:.3f}s, ~{s['bpm_hint']} bpm")
    with open(os.path.join(wd, "report.md"), "w") as f:
        f.write("\n".join(L) + "\n")
    print(f"wrote {wd}/analysis.json, plan.auto.json, report.md")
    print(f"{'trim %.3fs' % trim if do_trim else 'lead-in kept (no trim)'} | {len(orn)} ornaments | {len(rolls)} rolls | {len(slips)} slip candidates")


if __name__ == "__main__":
    main()
