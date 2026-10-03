#!/usr/bin/env python3
"""Stage 2: turn analysis.json + plan.json into reviewable edit proposals.

    python3 pipeline/propose.py work/<name>

Writes work/<name>/proposals.json (loaded by the editor) and work/<name>/review.md
(diagnostics the AI must read and *doubt* before handing off).

Design rules (see .claude/skills/clean-midi/SKILL.md):
- Section boundaries are fixed points in time. Every timing edit maps each boundary to itself,
  so total length and each section's length never change.
- Tempo regularization is a time-warp of tracked beats onto an ideal grid, not quantization:
  everything between two beats stretches proportionally, so ornaments, rolls, grace notes and
  feel survive and distinct onsets cannot collapse together.
- rubato sections are never warped. Ornaments (trills/tremolos) move rigidly, never internally.
- Every change is a separate edit holding per-note deltas against the original, so edits
  compose additively and any one can be reverted on its own.
"""
import json
import os
import sys

import numpy as np
from scipy.ndimage import gaussian_filter1d

sys.path.insert(0, os.path.dirname(__file__))
from analyze import pname  # noqa: E402

FS = 200  # beat tracker resolution (5 ms)


# --------------------------------------------------------------------------- beat tracking


def onset_strength(clusters, notes_by_id, end):
    """Onset salience: velocity sum, boosted for bass notes and chords (downbeat-ish cues)."""
    x = np.zeros(int(end * FS) + 4 * FS)
    for c in clusters:
        ns = [notes_by_id[i] for i in c["ids"]]
        w = sum(n["vel"] for n in ns) / 127.0
        w *= 1.0 + 0.25 * (min(n["pitch"] for n in ns) < 55) + 0.1 * (len(ns) - 1)
        x[int(round(c["t"] * FS))] += w
    return gaussian_filter1d(x, 3.0)


def local_period(x, t, hint_p, half=5.0):
    """Refine the beat period near t: autocorrelation peak within +-12% of the hint."""
    a, b = int(max(0, t - half) * FS), int((t + half) * FS)
    seg = x[a:b] - x[a:b].mean()
    if len(seg) < FS or not seg.any():
        return hint_p
    ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
    lo, hi = int(hint_p * 0.88 * FS), int(hint_p * 1.12 * FS) + 1
    if hi >= len(ac):
        return hint_p
    # combine first and second multiple for stability
    score = ac[lo:hi].copy()
    for k in range(lo, hi):
        if 2 * k < len(ac):
            score[k - lo] += 0.5 * ac[2 * k]
    return (lo + int(np.argmax(score))) / FS


def track_beats(x, start, end, hint_bpm, tightness=120.0):
    """Dynamic-programming beat tracker (after Ellis 2007) with both endpoints pinned.
    The local period follows the music (so slow drift doesn't break it), but each step is
    penalised for deviating from it, so isolated hesitations show up as long beats."""
    hp = 60.0 / hint_bpm
    s, e = int(round(start * FS)), int(round(end * FS))
    n = e - s + 1
    # local period curve, sampled every 2 s
    ts = np.arange(start, end + 2, 2.0)
    ps = np.array([local_period(x, t, hp) for t in ts])
    ps = np.clip(gaussian_filter1d(ps, 1.5), hp * 0.85, hp * 1.15)
    P = np.interp(np.arange(n) / FS + start, ts, ps) * FS
    o = x[s:e + 1] / (x[s:e + 1].max() + 1e-9)
    score = np.full(n, -np.inf)
    back = np.full(n, -1)
    score[0] = o[0]
    for i in range(1, n):
        lo, hi = int(i - 1.45 * P[i]), int(i - 0.6 * P[i])
        if hi < 0:
            continue
        lo = max(lo, 0)
        cand = np.arange(lo, hi + 1)
        prev = score[cand]
        ok = np.isfinite(prev)
        if not ok.any():
            continue
        pen = -tightness * np.log((i - cand) / P[i]) ** 2 / 100.0
        tot = np.where(ok, prev + pen, -np.inf)
        k = int(np.argmax(tot))
        score[i] = tot[k] + o[i]
        back[i] = cand[k]
    if not np.isfinite(score[-1]):
        raise RuntimeError(f"beat tracking failed for section {start:.2f}-{end:.2f}")
    beats = [n - 1]
    while beats[-1] > 0:
        beats.append(back[beats[-1]])
    return [start + b / FS for b in reversed(beats)][:-1] + [end]


def snap_beats_to_onsets(beats, cluster_times, period, tol=0.18):
    """Move each tracked beat onto the onset cluster it represents (if one is within tol*period),
    so beat times are the played times, not tracker frames. Endpoints stay fixed."""
    ct = np.asarray(cluster_times)
    out = [beats[0]]
    for b in beats[1:-1]:
        j = int(np.searchsorted(ct, b))
        best = None
        for k in (j - 1, j):
            if 0 <= k < len(ct) and abs(ct[k] - b) <= tol * period:
                if best is None or abs(ct[k] - b) < abs(best - b):
                    best = ct[k]
        out.append(float(best) if best is not None else b)
    out.append(beats[-1])
    # never leave a sliver beat (e.g. a snap landing on a boundary): drop beats < 0.5 period apart
    clean = [out[0]]
    for b in out[1:-1]:
        if b - clean[-1] >= 0.5 * period and out[-1] - b >= 0.5 * period:
            clean.append(b)
    clean.append(out[-1])
    return clean


# --------------------------------------------------------------------------- grids and warp


def anchored_grid(beats, anchor_idx, template=None):
    """Steady spacing between consecutive pinned beats (anchor_idx includes 0 and N).
    With a feel template, each beat position keeps its share of the bar."""
    g = list(beats)
    num = len(template) if template else 1
    for a, b in zip(anchor_idx, anchor_idx[1:]):
        w = [template[i % num] if template else 1.0 for i in range(a, b)]
        cum = np.concatenate([[0], np.cumsum(w)]) / sum(w)
        for j, i in enumerate(range(a, b + 1)):
            g[i] = beats[a] + (beats[b] - beats[a]) * cum[j]
    return g


def steady_grid(beats, num, anchor_bars, anchor_times, max_shift_beats, template=None):
    """Steady tempo, optionally re-pinned every `anchor_bars` bars (phrases) so the
    regularized grid never strays too far from the played timeline.
    anchor_bars="auto": longest phrase length whose max beat shift stays <= max_shift_beats."""
    N = len(beats) - 1
    P = (beats[-1] - beats[0]) / N
    pinned = {0, N}
    for t in anchor_times:
        pinned.add(int(np.argmin(np.abs(np.asarray(beats) - t))))

    def build(K):
        idx = set(pinned)
        if K:
            idx.update(range(0, N, K * num))
        idx = sorted(idx)
        return anchored_grid(beats, idx, template), idx

    if anchor_bars == "auto":
        for K in (None, 16, 8, 4, 2, 1):
            g, idx = build(K)
            if max(abs(a - b) for a, b in zip(g, beats)) / P <= max_shift_beats:
                return g, idx, K
        return g, idx, 1
    g, idx = build(anchor_bars or None)
    return g, idx, anchor_bars


def ideal_grid(beats, mode):
    """Ideal beat times sharing both endpoints with the tracked beats."""
    t0, t1 = beats[0], beats[-1]
    N = len(beats) - 1
    if mode == "ramp":
        per = np.diff(beats)
        i = np.arange(N)
        # robust slope (ignore stutters): fit on clipped periods
        med = np.median(per)
        clipped = np.clip(per, med * 0.8, med * 1.2)
        b = np.polyfit(i, clipped, 1)[0] if N > 2 else 0.0
        a = ((t1 - t0) - b * i.sum()) / N
        per_ideal = a + b * i
        return list(t0 + np.concatenate([[0], np.cumsum(per_ideal)]))
    return list(np.linspace(t0, t1, N + 1))


class Warp:
    """Monotone piecewise-linear time map through (src, dst) anchor pairs; identity outside."""

    def __init__(self, pairs):
        pairs = sorted(set((round(a, 6), round(b, 6)) for a, b in pairs))
        self.src = np.array([p[0] for p in pairs])
        self.dst = np.array([p[1] for p in pairs])

    def __call__(self, t):
        if len(self.src) == 0 or t <= self.src[0] or t >= self.src[-1]:
            return t
        return float(np.interp(t, self.src, self.dst))


# --------------------------------------------------------------------------- diagnostics


def detect_feel(beats, num):
    """A consistent per-beat-position timing pattern inside the bar (e.g. beat 4 always long,
    waltz lilt). That is the player's feel, not an error. Returns (template, strength, consistency)
    where template is the mean share of the bar each beat position takes (sums to num)."""
    per = np.diff(beats)
    nbars = len(per) // num
    if num < 2 or nbars < 3:
        return None
    bars = per[:nbars * num].reshape(nbars, num)
    shares = bars / bars.sum(axis=1, keepdims=True) * num   # 1.0 = even
    mean = shares.mean(axis=0)
    dev = np.log(mean)
    k = int(np.argmax(np.abs(dev)))
    consistency = float(np.mean(np.sign(np.log(shares[:, k])) == np.sign(dev[k])))
    strength = float(np.abs(dev).max())
    return dict(template=[round(float(v), 4) for v in mean], strength=round(strength, 3),
                consistency=round(consistency, 2), position=k + 1,
                significant=bool((strength >= 0.06 and consistency >= 0.75) or (strength >= 0.03 and consistency >= 0.8)))


def beat_diagnostics(beats, clusters_t, period, num=4):
    """Per-beat interval ratio vs a local moving median. Classifies isolated outliers as
    stutters vs smooth phrase-level motion (rubato evidence). A consistent in-bar pattern
    (feel) is factored out first, so a deliberate lilt is never reported as a stutter."""
    per = np.diff(beats)
    N = len(per)
    if N < 4:
        return dict(stutters=[], rubato_score=0.0, onset_support=1.0, smooth_dev=0.0, feel=None)
    feel = detect_feel(beats, num)
    lr = np.log(per / np.median(per))
    if feel and feel["significant"]:
        lr = lr - np.log(np.array([feel["template"][i % num] for i in range(N)]))
    smooth = np.array([np.median(lr[max(0, i - 3):i + 4]) for i in range(N)])
    resid = lr - smooth
    stutters = []
    for i in range(N):
        if abs(resid[i]) > 0.16:
            nb = [abs(resid[j]) for j in (i - 1, i + 1) if 0 <= j < N]
            if all(v < 0.12 for v in nb):  # isolated: steady on both sides
                stutters.append(dict(beat=i, t=round(beats[i], 3), t_end=round(beats[i + 1], 3),
                                     ratio=round(float(np.exp(lr[i] - smooth[i])), 3)))
    ct = np.asarray(clusters_t)
    support = np.mean([np.min(np.abs(ct - b)) < 0.05 for b in beats[1:-1]]) if N > 1 else 1.0
    smooth_dev = float(np.std(smooth))
    # rubato: phrase-level tempo swings (std of the smoothed log tempo) plus weak beat support
    rub = smooth_dev / 0.06 + max(0.0, 0.75 - support) / 0.25
    return dict(stutters=stutters, rubato_score=round(rub, 2), onset_support=round(float(support), 2),
                smooth_dev=round(smooth_dev, 3), resid_std=round(float(np.std(resid)), 3), feel=feel)


# --------------------------------------------------------------------------- main


def main():
    wd = sys.argv[1]
    A = json.load(open(os.path.join(wd, "analysis.json")))
    plan = json.load(open(os.path.join(wd, "plan.json")))
    notes = A["notes"]
    nb = {n["id"]: n for n in notes}
    ccs = A["ccs"]
    clusters = A["clusters"]
    ct = [c["t"] for c in clusters]
    x = onset_strength(clusters, nb, A["end"])

    protected_groups = [dict(ids=o["ids"], t0=o["t0"], label=o["label"], kind=o["kind"]) for o in A["ornaments"]]
    for grp in plan.get("extra_protect", []):
        ids = grp["ids"] if isinstance(grp, dict) else [grp]
        protected_groups.append(dict(ids=ids, t0=min(nb[i]["on"] for i in ids),
                                     label=(grp.get("why") if isinstance(grp, dict) else "protected by AI"),
                                     kind="protected"))
    # Protected *regions*: every note starting inside an ornament's span moves rigidly with it
    # (so accompaniment under a trill keeps its alignment and nothing can leapfrog).
    regions = []
    for g in sorted(protected_groups, key=lambda g: g["t0"]):
        t1 = max(nb[i]["on"] for i in g["ids"])
        if regions and g["t0"] <= regions[-1][1] + 0.05:
            regions[-1][1] = max(regions[-1][1], t1)
        else:
            regions.append([g["t0"], t1])
    rigid = {}  # note id -> anchor time for rigid motion
    for n in notes:
        for a, b in regions:
            if a - 0.03 <= n["on"] <= b + 0.03:
                rigid[n["id"]] = a
    for g in protected_groups:
        for i in g["ids"]:
            rigid.setdefault(i, g["t0"])

    # ------------------------------------------------------------- sections
    secs = sorted(plan["sections"], key=lambda s: s["start"])
    last_onset = max(n["on"] for n in notes)
    out_secs = []
    for k, s in enumerate(secs):
        start = s["start"]
        end = secs[k + 1]["start"] if k + 1 < len(secs) else s.get("end", last_onset)
        mode = s.get("mode", "steady")
        hint = s["bpm_hint"]
        P = 60.0 / hint
        if s.get("beats"):
            beats = [start] + [b for b in s["beats"] if start < b < end] + [end]
            src = "plan"
        else:
            beats = track_beats(x, start, end, hint, s.get("tightness", 120.0))
            beats = snap_beats_to_onsets(beats, ct, P)
            src = "tracker"
        for t in s.get("remove_beats", []):
            beats = [b for b in beats if b in (beats[0], beats[-1]) or abs(b - t) > 0.04]
        for t in s.get("add_beats", []):
            if start < t < end and all(abs(b - t) > 0.04 for b in beats):
                beats = sorted(beats + [t])
        diag = beat_diagnostics(beats, ct, P, s.get("num", 4))
        num = s.get("num", 4)
        ph = np.zeros(num)
        for bi, b in enumerate(beats[:-1]):
            j = int(np.argmin(np.abs(np.asarray(ct) - b)))
            if abs(ct[j] - b) < 0.05:
                ns = [nb[i] for i in clusters[j]["ids"]]
                ph[bi % num] += sum(n["vel"] for n in ns if n["pitch"] < 57) / 127 + 0.3 * len(ns)
        ph = (ph / (ph.max() + 1e-9)).round(2).tolist()
        bar_tempo = []
        for bi in range(0, len(beats) - num, num):
            dur = beats[bi + num] - beats[bi]
            bar_tempo.append((bi // num + 1, beats[bi], 60.0 * num / dur))
        anchors_used, anchor_bars = [0, len(beats) - 1], None
        if mode == "steady":
            feel = diag["feel"]
            keep_feel = s.get("keep_feel", "auto")
            use_tpl = feel["template"] if feel and (keep_feel is True or (keep_feel == "auto" and feel["significant"])) else None
            grid, anchors_used, anchor_bars = steady_grid(
                beats, s.get("num", 4), s.get("anchor_every_bars", "auto"), s.get("anchors", []),
                s.get("max_shift_beats", 0.5), use_tpl)
            diag["feel_kept"] = bool(use_tpl)
        elif mode == "ramp":
            grid = ideal_grid(beats, mode)
        else:
            grid = list(beats)
        N = len(beats) - 1
        out_secs.append(dict(
            index=k, start=round(start, 6), end=round(end, 6), mode=mode, num=s.get("num", 4),
            den=s.get("den", 4), label=s.get("label", f"Section {k + 1}"), note=s.get("note", ""),
            beats=[round(b, 6) for b in beats], grid=[round(g, 6) for g in grid], beat_source=src,
            n_beats=N, bars=round(N / s.get("num", 4), 2), phase_weights=ph, bar_tempo=bar_tempo,
            anchors=[round(beats[i], 6) for i in anchors_used], anchor_every_bars=anchor_bars,
            bpm=round(60.0 * N / (end - start), 3) if end > start else hint, diag=diag))

    # ------------------------------------------------------------- edits
    edits = []

    def section_of(t):
        for s in out_secs:
            if s["start"] - 1e-6 <= t < s["end"] - 1e-6:
                return s["index"]
        return out_secs[-1]["index"] if t >= out_secs[-1]["end"] else 0

    # tempo warps, one edit per non-rubato section
    for s in out_secs:
        if s["mode"] == "rubato":
            continue
        w = Warp(list(zip(s["beats"], s["grid"])))
        nd, cd = {}, {}
        maxd, maxd_t = 0.0, s["start"]
        for n in notes:
            if not (s["start"] - 1e-6 <= n["on"] < s["end"] - 1e-6):
                continue
            if n["id"] in rigid:
                d = w(rigid[n["id"]]) - rigid[n["id"]]
                don = doff = d
            else:
                don = w(n["on"]) - n["on"]
                doff = w(min(n["off"], s["end"])) - min(n["off"], s["end"])
            if abs(don) > 1e-4 or abs(doff) > 1e-4:
                nd[n["id"]] = [round(don, 5), round(doff, 5)]
            if abs(don) > abs(maxd):
                maxd, maxd_t = don, n["on"]
        for c in ccs:
            if s["start"] - 1e-6 <= c["t"] < s["end"] - 1e-6:
                d = w(c["t"]) - c["t"]
                if abs(d) > 1e-4:
                    cd[c["id"]] = round(d, 5)
        P = (s["end"] - s["start"]) / max(1, s["n_beats"])
        s["max_shift"] = round(maxd, 4)
        s["max_shift_t"] = round(maxd_t, 3)
        s["max_shift_beats"] = round(abs(maxd) / P, 3)
        stut = s["diag"]["stutters"]
        edits.append(dict(
            id=f"tempo-{s['index']}", type="tempo", section=s["index"], t0=s["start"], t1=s["end"],
            label=f"{s['label']}: {s['mode']} {s['bpm']:.1f} bpm {s['num']}/{s['den']}",
            rationale=(f"Warp {s['n_beats']} tracked beats onto an even grid between fixed boundaries "
                       f"({s['start']:.3f}s to {s['end']:.3f}s). Largest shift {maxd*1000:+.0f} ms at "
                       f"{maxd_t:.2f}s ({s['max_shift_beats']:.2f} beat)."
                       + (f" Removes {len(stut)} stutter(s)." if stut else "")),
            confidence=None, default=s.get("default", True), notes=nd, ccs=cd, deletes=[]))
        for st in stut:
            edits.append(dict(
                id=f"stutter-{s['index']}-{st['beat']}", type="stutter", section=s["index"],
                t0=st["t"], t1=st["t_end"], info=True,
                label=f"stutter: beat {st['beat'] + 1} was {st['ratio']:.2f}x its neighbours",
                rationale="Isolated hesitation with steady beats either side; absorbed by the section tempo warp.",
                notes={}, ccs={}, deletes=[], default=True))

    # ornaments: informational, protected
    for k, g in enumerate(protected_groups):
        t1 = max(nb[i]["off"] for i in g["ids"])
        edits.append(dict(id=f"protect-{k}", type="ornament", section=section_of(g["t0"]),
                          t0=g["t0"], t1=round(t1, 4), info=True, ids=g["ids"],
                          label=g["label"], rationale="Protected: never deleted; moves rigidly with the tempo warp.",
                          notes={}, ccs={}, deletes=[], default=True))

    # rolls
    rdec = plan.get("roll_decisions", {})
    for k, r in enumerate(A["rolls"]):
        dec = rdec.get(str(r["strikes"][0][0]), {})  # keyed by the roll's first note id (stable)
        if any(i in rigid for st in r["strikes"] for i in st):
            continue
        strikes = [[nb[i] for i in st] for st in r["strikes"]]
        first = [min(n["on"] for n in st) for st in strikes]
        tgt = np.linspace(first[0], first[-1], len(strikes))
        nd = {}
        for st, f, tg in zip(strikes, first, tgt):
            for n in st:
                d = tg - f
                if abs(d) > 1e-4:
                    nd[n["id"]] = [round(d, 5), round(max(0.0, d) if n["off"] < tg + 0.03 else 0.0, 5)]
        sec_mode = out_secs[section_of(r["t0"])]["mode"]
        auto = "even" if (r["unevenness"] >= 0.2 and sec_mode != "rubato" and r["span"] <= 0.3) else "keep"
        default = dec.get("action", auto) == "even"
        if sec_mode == "rubato" and not dec:
            dec = dict(why="In a rubato section: proposed only, off by default.")
        elif r["span"] > 0.3 and not dec:
            dec = dict(why="Slow arpeggiated flourish (> 300 ms), likely a melodic gesture: off by default.")
        edits.append(dict(
            id=f"roll-{r['strikes'][0][0]}", type="roll", section=section_of(r["t0"]), t0=r["t0"], t1=r["t1"] + 0.05,
            label=r["label"], confidence=None, default=default,
            rationale=(dec.get("why", "") + " " if dec.get("why") else "") +
            f"Strikes evenly spaced across the same {r['span']*1000:.0f} ms span (was gaps {r['gaps_ms']} ms).",
            notes=nd, ccs={}, deletes=[]))

    # deletions
    sdec = {int(k): v for k, v in plan.get("slip_decisions", {}).items()}
    seen = set()
    for c in A["slips"] + [dict(id=e["id"], kind="ai", confidence=1.0, why=e.get("why", ""),
                                 pitch=pname(nb[e["id"]]["pitch"]), t=nb[e["id"]]["on"])
                            for e in plan.get("delete_extra", [])]:
        if c["id"] in seen or c["id"] in rigid:
            continue
        seen.add(c["id"])
        dec = sdec.get(c["id"], {})
        action = dec.get("action", "delete" if c["confidence"] >= 0.7 else "keep")
        n = nb[c["id"]]
        edits.append(dict(
            id=f"del-{c['id']}", type="delete", section=section_of(n["on"]), t0=n["on"], t1=n["off"],
            label=f"remove {c['pitch']} @ {n['on']:.2f}s ({c['kind']})", confidence=c["confidence"],
            rationale=c["why"] + (f" | AI: {dec['why']}" if dec.get("why") else ""),
            default=action == "delete", notes={}, ccs={}, deletes=[c["id"]]))

    # ------------------------------------------------------------- guard: what would defaults do?
    final = {n["id"]: [n["on"], n["off"]] for n in notes}
    deleted = set()
    for e in edits:
        if e.get("info") or not e["default"]:
            continue
        for i, (a, b) in e["notes"].items():
            final[int(i)][0] += a
            final[int(i)][1] += b
        deleted.update(e["deletes"])
    live = sorted((i for i in final if i not in deleted), key=lambda i: nb[i]["on"])
    merges, swaps = [], []
    for a, b in zip(live, live[1:]):
        oa, ob = nb[a]["on"], nb[b]["on"]
        fa, fb = final[a][0], final[b][0]
        if ob - oa >= 0.035 and abs(fb - fa) < 0.012:
            merges.append((a, b))
        if ob - oa >= 0.012 and fb < fa - 0.005:
            swaps.append((a, b))
    neg = [i for i in live if final[i][1] - final[i][0] < 0.01]
    bounds_ok = all(abs(Warp(list(zip(s["beats"], s["grid"])))(s["end"]) - s["end"]) < 1e-6 for s in out_secs)

    P = dict(
        name=A["name"], source=A["source"], trim=A["trim"], end=A["end"], tpq=A["tpq"],
        notes=notes, ccs=ccs, sections=out_secs, edits=edits,
        guard=dict(merges=merges, swaps=swaps, too_short=neg, boundaries_fixed=bounds_ok),
    )
    with open(os.path.join(wd, "proposals.json"), "w") as f:
        json.dump(P, f)

    # ------------------------------------------------------------- review.md
    L = [f"# Review: {A['name']}\n", "Read this critically. Anything flagged here is a reason to doubt the plan.\n"]
    L.append(f"- boundaries fixed: **{bounds_ok}** | total length {A['end']:.3f}s unchanged by construction")
    L.append(f"- guard: {len(merges)} onset merges, {len(swaps)} order swaps, {len(neg)} too-short notes "
             "(all should be 0; any merge means a warp is collapsing distinct notes = probably a tracking error)\n")
    for a, b in merges[:20]:
        L.append(f"  - MERGE {pname(nb[a]['pitch'])}@{nb[a]['on']:.3f} + {pname(nb[b]['pitch'])}@{nb[b]['on']:.3f}")
    for a, b in swaps[:20]:
        L.append(f"  - SWAP {pname(nb[a]['pitch'])}@{nb[a]['on']:.3f} / {pname(nb[b]['pitch'])}@{nb[b]['on']:.3f}")
    L.append("\n## Sections\n")
    L.append("| # | label | mode | start | end | dur | beats | bars | bpm | max shift | rubato score | onset support | stutters |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in out_secs:
        d = s["diag"]
        L.append(f"| {s['index']} | {s['label']} | {s['mode']} | {s['start']:.3f} | {s['end']:.3f} | "
                 f"{s['end']-s['start']:.3f} | {s['n_beats']} | {s['bars']} | {s['bpm']:.1f} | "
                 f"{s.get('max_shift', 0)*1000:+.0f}ms ({s.get('max_shift_beats', 0):.2f}b) @ {s.get('max_shift_t', 0):.1f}s | "
                 f"{d['rubato_score']} | {d['onset_support']} | {len(d['stutters'])} |")
    L.append("\nHeuristics: rubato score > 1.5 suggests phrase-level rubato (consider mode=rubato). "
             "max shift > 0.35 beat suggests drift; consider ramp or splitting the section. "
             "bars not an integer means the boundary is not on a downbeat or the meter is wrong.\n")
    for s in out_secs:
        per = np.diff(s["beats"])
        L.append(f"### {s['index']} {s['label']} ({s['mode']}, beats from {s['beat_source']}, "
                 f"anchored every {s['anchor_every_bars']} bars -> {len(s['anchors'])} pinned beats)\n")
        row = " ".join(f"{p*1000:.0f}" for p in per)
        L.append(f"beat intervals ms: {row}\n")
        for st in s["diag"]["stutters"]:
            L.append(f"- stutter at {st['t']:.2f}s: {st['ratio']}x")
        f = s["diag"].get("feel")
        if f:
            L.append(f"feel: beat shares {f['template']} (strength {f['strength']}, consistency {f['consistency']}, "
                     f"significant={f['significant']}, kept={s['diag'].get('feel_kept', False)})")
        L.append(f"\ndownbeat evidence (bass+accent weight by beat position mod {s['num']}, 0 = section start): "
                 + ", ".join(f"{k}:{v}" for k, v in enumerate(s["phase_weights"])) + "\n")
        L.append("bar tempo profile (bar@time=bpm): " + " ".join(
            f"{b}@{t:.1f}={v:.0f}" for b, t, v in s["bar_tempo"]) + "\n")
    L.append("\n## Edits\n")
    for e in edits:
        if e["type"] in ("tempo", "stutter"):
            continue
        L.append(f"- [{'ON ' if e['default'] else 'off'}] {e['id']} {e['label']} :: {e['rationale']}")
    with open(os.path.join(wd, "review.md"), "w") as f:
        f.write("\n".join(L) + "\n")
    print(f"wrote {wd}/proposals.json, review.md | {len(edits)} edits | merges {len(merges)} swaps {len(swaps)}")


if __name__ == "__main__":
    main()
