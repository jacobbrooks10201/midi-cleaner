# MIDI Cleaner

An AI-reviewed cleanup pipeline and browser editor for piano improvisations recorded to picture.

**Golden rule:** total length and each section's length never change, so the MIDI stays locked
to the video. Video-aligned takes (recorder sidecar `<take>.json` saying MIDI 0:00 = video 0:00) keep their lead-in;
other takes have the lead-in trimmed so the first note lands at 0:00 (`analyze.py --trim auto|yes|no`).

## Use

In Claude Code, in this folder:

```
/clean-midi path/to/take.mid
```

Claude runs the pipeline, reviews the music itself (see `.claude/skills/clean-midi/SKILL.md`),
and starts the editor. Or do it by hand:

```bash
python3 pipeline/analyze.py raw_midi/take.mid          # evidence + candidates
$EDITOR work/take/plan.json                   # sections, modes, decisions
python3 pipeline/propose.py work/take         # proposals + review.md diagnostics
python3 serve.py                              # http://localhost:8765
```

Needs only Python 3 with numpy + scipy and a modern browser. Samples are bundled in `editor/samples` (works offline).

## What it does

| | |
|---|---|
| Lead-in silence | kept for video-aligned takes, else trimmed (pedal state before the first note is kept at 0:00) |
| Sections | by tempo and meter, each **steady**, **ramp** (accel/rit), or **rubato** (untouched) |
| Tempo regularization | beat-warp onto an even grid between pinned boundaries, not quantization. Intra-beat timing stretches proportionally. Long sections are re-pinned every N bars so nothing drifts off picture |
| Feel | a consistent in-bar lilt (e.g. beat 4 always long) is detected and kept |
| Stutters | isolated hesitations get absorbed by the section's regularization |
| Trills / tremolos | detected and protected: they move rigidly and are never edited |
| Rolled chords | same total span, strikes evenly spaced |
| Fat-fingers / missed notes | proposed removals with evidence and an AI verdict. Notes are never added |
| Picture sync | `max_shift_ms` caps how far any note can drift from where it was played; phrase anchors are adaptive; specific notes can be pinned with `anchors` |
| Guards | merges, order swaps, boundary crossings, shift size: shown in review.md and live in the editor |

## Editor

- Piano roll with ghosts of original positions, removed notes, protected ornaments, section bands, bar numbers, and the pedal lane.
- Every edit can be accepted or rejected (or a whole group at once), and auditioned cleaned (▶) vs original (A). **B** toggles A/B, **M** turns on the click.
- Your own edits: delete, restore, drag, resize, nudge, transpose, velocity, with full undo/redo.
- **Notes to Claude:** box-select a region or notes, press **N**, and type what's wrong ("this is a grace note, keep it", "tempo drags here").
  **Ask Claude** runs Claude Code headless on your open notes (allowed to read and edit files and run `python3 pipeline/*` only). It re-plans just
  those regions and replies on each note. Reload to see the new proposals; your decisions are kept. You can also say `/clean-midi reassess` in a Claude Code session.
- Instruments: Salamander Grand, GM piano, Rhodes, FM EP, clean and jazz electric guitar, nylon and steel acoustic, harpsichord, celesta, music box, vibes, marimba, harp, strings, pad.
- **FX** strip: reverb, delay, chorus, drive, EQ, compressor, volume. These affect playback and WAV export only, never the MIDI.
- **Save** writes `work/<name>/review.json`. **Export MIDI** renders `work/<name>/<name>.clean.mid` with a tempo map that follows the cleaned beats. **Export WAV** renders audio with the current instrument and effects.

## Files

```
pipeline/midiio.py   dependency-free MIDI read/write (tempo map from beat grid)
pipeline/analyze.py  lead-in (keep/trim), onset clusters, local tempo, ornaments, rolls, slip candidates
pipeline/propose.py  beat tracking, warps, feel, anchors, rolls, removals, guards -> proposals.json
pipeline/render.py   apply decisions -> cleaned MIDI (+ timing verification)
pipeline/look.py     look at notes/beats/slips/rolls (for the AI reviewer)
serve.py             local server + save/export API
editor/              the browser editor
```
