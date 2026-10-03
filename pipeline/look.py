#!/usr/bin/env python3
"""Look closely at the music, the way the AI reviewer needs to before deciding anything.

    python3 pipeline/look.py work/<name> notes 150 160     # onset clusters (pitch/vel/dur) in a time range
    python3 pipeline/look.py work/<name> beats 150 160     # tracked beats + what lands on each (needs proposals.json)
    python3 pipeline/look.py work/<name> slips             # every slip candidate with +-0.4 s of context
    python3 pipeline/look.py work/<name> rolls             # every roll candidate with its strikes

All times are on the trimmed timeline (first note = 0).
"""
import json
import os
import sys

NAMES = "C C# D D# E F F# G G# A A# B".split()


def nm(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def main():
    wd, cmd = sys.argv[1], sys.argv[2]
    A = json.load(open(os.path.join(wd, "analysis.json")))
    nb = {n["id"]: n for n in A["notes"]}
    order = sorted(A["notes"], key=lambda n: n["on"])
    if cmd == "notes":
        t0, t1 = float(sys.argv[3]), float(sys.argv[4])
        prev = None
        for c in A["clusters"]:
            if t0 <= c["t"] < t1:
                ns = sorted((nb[i] for i in c["ids"]), key=lambda n: n["pitch"])
                d = "" if prev is None else f"+{(c['t'] - prev) * 1000:.0f}"
                print(f"{c['t']:9.3f} {d:6} " + " ".join(
                    f"{nm(n['pitch'])}/v{n['vel']}/{(n['off'] - n['on']) * 1000:.0f}ms#{n['id']}" for n in ns))
                prev = c["t"]
    elif cmd == "beats":
        P = json.load(open(os.path.join(wd, "proposals.json")))
        t0, t1 = float(sys.argv[3]), float(sys.argv[4])
        for s in P["sections"]:
            bt, num = s["beats"], s["num"]
            for bi in range(len(bt) - 1):
                a, b = bt[bi], bt[bi + 1]
                if not (t0 <= a < t1):
                    continue
                ns = [n for n in order if a - 0.03 <= n["on"] < b - 0.03]
                txt = " ".join(nm(n["pitch"]) + (f"+{(n['on'] - a) * 1000:.0f}" if n["on"] - a > 0.03 else "")
                               for n in ns)
                print(f"[{s['index']} {s['label'][:14]:14}] {'|' if bi % num == 0 else ' '} bar{bi // num + 1:3}.{bi % num + 1} "
                      f"{a:8.3f} {int((b - a) * 1000):4}ms grid {s['grid'][bi]:8.3f}  {txt}")
    elif cmd == "slips":
        for s in A["slips"]:
            print(f"\n## id {s['id']} {s['pitch']} @{s['t']} [{s['kind']} {s['confidence']}] {s['why']}")
            for n in order:
                if s["t"] - 0.4 <= n["on"] <= s["t"] + 0.4:
                    mark = ">>" if n["id"] == s["id"] else "  "
                    print(f"   {mark} {n['on']:8.3f} {nm(n['pitch']):4} v{n['vel']:3} {int((n['off'] - n['on']) * 1000):4}ms #{n['id']}")
    elif cmd == "rolls":
        for r in A["rolls"]:
            print(f"\n## roll first-note {r['strikes'][0][0]} @{r['t0']} {r['label']} gaps {r['gaps_ms']} unevenness {r['unevenness']}")
            for st in r["strikes"]:
                print("   " + " ".join(f"{nm(nb[i]['pitch'])}@{nb[i]['on']:.3f}/v{nb[i]['vel']}" for i in st))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
