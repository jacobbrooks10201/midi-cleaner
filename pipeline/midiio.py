"""Minimal dependency-free MIDI reader/writer.

Everything downstream works in absolute seconds. Reading resolves the file's
tempo map; writing takes a list of (start_sec, bpm, num, den) sections and
converts seconds back to ticks.
"""
import struct
from dataclasses import dataclass, field


@dataclass
class Note:
    id: int
    pitch: int
    vel: int
    on: float   # seconds
    off: float  # seconds
    ch: int = 0


@dataclass
class CC:
    id: int
    num: int
    val: int
    t: float
    ch: int = 0


@dataclass
class Song:
    notes: list = field(default_factory=list)
    ccs: list = field(default_factory=list)
    end: float = 0.0           # end-of-track time in seconds
    tpq: int = 480
    tempos: list = field(default_factory=list)   # (tick, us_per_qn)
    timesigs: list = field(default_factory=list)  # (tick, num, den)


def _vlq(b, i):
    v = 0
    while True:
        c = b[i]
        i += 1
        v = (v << 7) | (c & 0x7F)
        if c < 0x80:
            return v, i


def _enc_vlq(v):
    out = [v & 0x7F]
    v >>= 7
    while v:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    return bytes(reversed(out))


def read(path):
    d = open(path, "rb").read()
    if d[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    hlen = struct.unpack(">I", d[4:8])[0]
    _fmt, ntr, div = struct.unpack(">HHH", d[8:14])
    if div & 0x8000:
        raise ValueError("SMPTE time division not supported")
    p = 8 + hlen
    raw = []  # (tick, order, kind, data)
    order = 0
    for _ in range(ntr):
        if d[p:p + 4] != b"MTrk":
            break
        L = struct.unpack(">I", d[p + 4:p + 8])[0]
        b = d[p + 8:p + 8 + L]
        p += 8 + L
        i = tick = 0
        rs = None
        while i < len(b):
            dt, i = _vlq(b, i)
            tick += dt
            s = b[i]
            if s == 0xFF:
                ty = b[i + 1]
                ln, j = _vlq(b, i + 2)
                data = b[j:j + ln]
                i = j + ln
                raw.append((tick, order, "meta", (ty, data)))
            elif s in (0xF0, 0xF7):
                ln, j = _vlq(b, i + 1)
                i = j + ln
            else:
                if s & 0x80:
                    rs = s
                    i += 1
                hi, ch = rs >> 4, rs & 0xF
                if hi in (0xC, 0xD):
                    a, bb = b[i], 0
                    i += 1
                else:
                    a, bb = b[i], b[i + 1]
                    i += 2
                raw.append((tick, order, "ev", (hi, ch, a, bb)))
            order += 1
    raw.sort(key=lambda r: (r[0], r[1]))

    song = Song(tpq=div)
    for tick, _, kind, data in raw:
        if kind == "meta" and data[0] == 0x51:
            song.tempos.append((tick, int.from_bytes(data[1], "big")))
        elif kind == "meta" and data[0] == 0x58:
            song.timesigs.append((tick, data[1][0], 2 ** data[1][1]))
    if not song.tempos or song.tempos[0][0] != 0:
        song.tempos.insert(0, (0, 500000))

    tmap = []  # (tick, sec, us_per_qn)
    sec = 0.0
    last_tick, last_us = 0, song.tempos[0][1]
    for tk, us in song.tempos:
        sec += (tk - last_tick) * last_us / 1e6 / div
        tmap.append((tk, sec, us))
        last_tick, last_us = tk, us

    def t2s(tick):
        k = 0
        while k + 1 < len(tmap) and tmap[k + 1][0] <= tick:
            k += 1
        tk, s, us = tmap[k]
        return s + (tick - tk) * us / 1e6 / div

    open_notes = {}
    max_tick = 0
    for tick, _, kind, data in raw:
        max_tick = max(max_tick, tick)
        if kind != "ev":
            continue
        hi, ch, a, bb = data
        t = t2s(tick)
        if hi == 9 and bb > 0:
            if (ch, a) in open_notes:  # retrigger without note-off: close previous
                n = open_notes.pop((ch, a))
                n.off = t
            n = Note(len(song.notes), a, bb, t, t, ch)
            song.notes.append(n)
            open_notes[(ch, a)] = n
        elif hi == 8 or (hi == 9 and bb == 0):
            n = open_notes.pop((ch, a), None)
            if n:
                n.off = t
        elif hi == 0xB:
            song.ccs.append(CC(len(song.ccs), a, bb, t, ch))
    song.end = t2s(max_tick)
    for n in open_notes.values():
        n.off = song.end
    return song


def write(path, notes, ccs, sections, end, tpq=480):
    """Write a single-track MIDI whose tempo map follows a beat grid.

    notes: dicts with pitch, vel, on, off (seconds), optional ch
    ccs:   dicts with num, val, t (seconds), optional ch
    sections: dicts with keys num, den, beats (list of beat times in seconds, first = section
              start, last = section end). Consecutive sections share boundary times.
    end:   end-of-track time in seconds.
    Each beat interval gets its own tempo, so wall-clock time is preserved exactly (to the
    microsecond rounding of MIDI tempo) and bar lines land on the beats."""
    times, ticks = [], []
    tempo_evs, sig_evs = [], []
    tick = 0
    for s in sections:
        tpb = tpq * 4 // s["den"]
        b = s["beats"]
        nb = len(b) - 1
        if not times:
            times.append(b[0])
            ticks.append(0)
        sig_evs.append((tick, s["num"], s["den"]))
        rem = nb % s["num"]
        if rem and nb > rem:  # trailing partial bar gets its own short time signature
            sig_evs.append((tick + (nb - rem) * tpb, rem, s["den"]))
        for k in range(nb):
            dur = b[k + 1] - b[k]
            us = int(round(dur * 1e6 * s["den"] / 4))  # MIDI tempo is per quarter note
            tempo_evs.append((tick, us))
            tick += tpb
            times.append(b[k + 1])
            ticks.append(tick)
    last_us = tempo_evs[-1][1] if tempo_evs else 500000
    times_a, ticks_a = times, ticks

    def s2t(t):
        if t <= times_a[0]:
            return 0
        if t >= times_a[-1]:
            return int(round(ticks_a[-1] + (t - times_a[-1]) * 1e6 / last_us * tpq))
        lo, hi = 0, len(times_a) - 1
        while hi - lo > 1:
            m = (lo + hi) // 2
            if times_a[m] <= t:
                lo = m
            else:
                hi = m
        f = (t - times_a[lo]) / (times_a[hi] - times_a[lo])
        return int(round(ticks_a[lo] + f * (ticks_a[hi] - ticks_a[lo])))

    evs = []  # (tick, prio, bytes)
    prev_us = None
    for tk, us in tempo_evs:
        if prev_us is None or abs(us - prev_us) > 0:
            evs.append((tk, 0, b"\xFF\x51\x03" + us.to_bytes(3, "big")))
            prev_us = us
    prev_sig = None
    for tk, num, den in sig_evs:
        if (num, den) != prev_sig:
            evs.append((tk, 0, bytes([0xFF, 0x58, 4, num, max(0, den.bit_length() - 1), 24, 8])))
            prev_sig = (num, den)
    for c in ccs:
        evs.append((s2t(c["t"]), 2, bytes([0xB0 | c.get("ch", 0), c["num"], c["val"]])))
    for n in notes:
        on, off = s2t(n["on"]), s2t(n["off"])
        if off <= on:
            off = on + 1
        ch = n.get("ch", 0)
        evs.append((on, 3, bytes([0x90 | ch, n["pitch"], max(1, min(127, n["vel"]))])))
        evs.append((off, 1, bytes([0x80 | ch, n["pitch"], 0])))
    evs.sort(key=lambda e: (e[0], e[1]))
    end_tick = max([s2t(end)] + [e[0] for e in evs])
    body = bytearray()
    last = 0
    for tk, _, data in evs:
        body += _enc_vlq(tk - last) + data
        last = tk
    body += _enc_vlq(end_tick - last) + b"\xFF\x2F\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, tpq))
        f.write(b"MTrk" + struct.pack(">I", len(body)) + body)
