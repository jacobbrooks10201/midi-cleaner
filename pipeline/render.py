#!/usr/bin/env python3
"""Stage 3: apply edit decisions and write the cleaned MIDI.

    python3 pipeline/render.py work/<name> [--defaults] [--out path.mid]

Uses work/<name>/review.json (saved by the editor) when present, otherwise each edit's
AI default. Writes work/<name>/<name>.clean.mid and prints the timing check.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import midiio  # noqa: E402


def apply(P, review):
    acc = review.get("accepted", {})
    manual = review.get("manual", {})
    on = {n["id"]: [n["on"], n["off"]] for n in P["notes"]}
    pitch = {n["id"]: n["pitch"] for n in P["notes"]}
    vel = {n["id"]: n["vel"] for n in P["notes"]}
    cct = {c["id"]: c["t"] for c in P["ccs"]}
    deleted = set()
    accepted_tempo = set()
    for e in P["edits"]:
        if e.get("info") or not acc.get(e["id"], e["default"]):
            continue
        if e["type"] == "tempo":
            accepted_tempo.add(e["section"])
        for i, (a, b) in e["notes"].items():
            on[int(i)][0] += a
            on[int(i)][1] += b
        for i, d in e["ccs"].items():
            cct[int(i)] += d
        deleted.update(e["deletes"])
    for i, m in manual.items():
        i = int(i)
        on[i][0] += m.get("dOn", 0.0)
        on[i][1] += m.get("dOff", 0.0)
        pitch[i] += m.get("dPitch", 0)
        vel[i] = m.get("vel", vel[i])
        if m.get("deleted"):
            deleted.add(i)
        if m.get("restored"):
            deleted.discard(i)
    end = P["end"]
    notes = []
    for n in P["notes"]:
        i = n["id"]
        if i in deleted:
            continue
        a = min(max(0.0, on[i][0]), end)
        b = min(max(a + 0.01, on[i][1]), end)
        notes.append(dict(id=i, pitch=pitch[i], vel=vel[i], on=a, off=b, ch=n.get("ch", 0)))
    ccs = [dict(num=c["num"], val=c["val"], t=min(max(0.0, cct[c["id"]]), end), ch=c.get("ch", 0))
           for c in P["ccs"]]
    sections = [dict(num=s["num"], den=s["den"],
                     beats=s["grid"] if s["index"] in accepted_tempo else s["beats"])
                for s in P["sections"]]
    return notes, ccs, sections, deleted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--defaults", action="store_true", help="ignore review.json, use AI defaults")
    ap.add_argument("--out")
    a = ap.parse_args()
    P = json.load(open(os.path.join(a.workdir, "proposals.json")))
    rp = os.path.join(a.workdir, "review.json")
    review = json.load(open(rp)) if os.path.exists(rp) and not a.defaults else {}
    notes, ccs, sections, deleted = apply(P, review)
    out = a.out or os.path.join(a.workdir, f"{P['name']}.clean.mid")
    midiio.write(out, notes, ccs, sections, P["end"])
    # verify by reading back
    back = midiio.read(out)
    first = min(n.on for n in back.notes)
    print(f"wrote {out}: {len(notes)} notes ({len(deleted)} removed)")
    print(f"length {back.end:.4f}s (expected {P['end']:.4f}s), first note at {first:.4f}s")
    for s, sec in zip(P["sections"], sections):
        print(f"  {s['label']:<28} {sec['beats'][0]:9.4f} -> {sec['beats'][-1]:9.4f}  "
              f"({sec['beats'][-1]-sec['beats'][0]:.4f}s, {len(sec['beats'])-1} beats {s['num']}/{s['den']})")


if __name__ == "__main__":
    main()
