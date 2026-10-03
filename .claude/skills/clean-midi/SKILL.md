---
name: clean-midi
description: Clean a recorded piano-improvisation MIDI for a soundtrack, keeping it locked to the video. Trims lead-in silence, splits the take into tempo/meter sections, regularizes tempo by beat-warping (never naive quantization), removes stutters, evens rolled chords, protects trills, and proposes fat-finger removals. Everything ends up as reviewable proposals in the browser editor. Use when the user gives a .mid take to clean, asks to re-review one, or says "reassess" (handle the notes they left in the editor).
---

# Clean a performance MIDI (AI-reviewed pipeline)

You are the reviewer in this pipeline. The scripts produce *evidence and candidates*; you
make the musical judgments, write them into `plan.json`, and **doubt your own output** before
handing it to the user, who validates everything in the editor.

## The golden rule (never violate)

The take was played to picture. **Total length and every section's length are fixed.**
- Section boundaries are pinned in time. Timing edits happen *inside* sections only.
- The only global time change is trimming lead-in silence: the first note goes to 0:00. This
  is always done, and the user aligns the video to that first note.
- Never add notes. You may only propose removals, timing moves, and nothing else.
- `render.py` and the editor both check this (length unchanged, boundaries pinned, nothing crossing
  a boundary). If anything you do breaks it, it's a bug: stop and fix it.

## Steps

```bash
python3 pipeline/analyze.py <take.mid>            # -> work/<name>/analysis.json, report.md, plan.json (auto)
# read report.md, inspect the music, write work/<name>/plan.json
python3 pipeline/propose.py work/<name>           # -> proposals.json + review.md (diagnostics)
# read review.md critically; fix plan.json; re-run propose until it survives your doubt
python3 pipeline/render.py work/<name> --defaults # sanity: length + boundaries print
python3 serve.py                                  # editor at http://localhost:8765 (run in background)
```

Your eyes on the music: `python3 pipeline/look.py work/<name> notes|beats|slips|rolls ...`.
**Look at notes before deciding anything.** Every number in the report is a hint, not a verdict.
All times are on the trimmed timeline. Don't subtract the trim again (it's an easy mistake: the
report and look output are already trimmed).

## 1. Sections (tempo / meter / mode)

Start from `report.md`'s local-tempo table. Peaks related by 2x or 3x show the metric
hierarchy: 177 and 59 means three beats per bar, so 3/4. Then confirm with `look notes`: a
bass note on the downbeat, accompaniment pattern, where phrases breathe.

Each section in `plan.json`:

```json
{"start": 50.818, "bpm_hint": 172, "num": 3, "den": 4, "mode": "steady",
 "label": "Waltz A'", "note": "why you chose this",
 "anchor_every_bars": "auto", "max_shift_beats": 0.5, "keep_feel": "auto",
 "remove_beats": [], "add_beats": [], "beats": null}
```
- `start` must be a **downbeat as played** (an onset time from `look notes`). The last section
  may take `end` (defaults to the last onset; the tail after it is left untouched).
- `bpm_hint` is the beat tempo (beat = 1/den note). Make it accurate to ±10%: the tracker
  only searches ±15% around it.
- **mode** (choose deliberately):
  - `steady`: one tempo, re-pinned to the played timeline every N bars (phrases) so it can't
    drift away from the picture. `"auto"` picks the longest phrase length (whole section, then
    16/8/4/2/1 bars) whose largest beat shift stays ≤ `max_shift_beats`.
  - `ramp`: a deliberate accelerando or ritardando across the section (a linear tempo change is fitted).
  - `rubato`: **not changed at all.** The tempo map follows the playing so DAW bar lines
    still make sense. Use it for expressive passages.
- Make rubato phrases their own sections (broadening into a cadence, the bar before and through
  a big trill, free intros/outros, recitative-like melody). The rest of the section can then be steady.

### Rubato vs stutter vs feel vs drift: decide which you're looking at
| What the beat intervals show | It is | Do |
|---|---|---|
| One beat (maybe two) much longer or shorter, steady on both sides | **stutter** (hesitation, small gap error) | steady mode absorbs it across the section |
| Several consecutive beats swell/shrink smoothly, often at phrase ends or harmonic events | **rubato** | separate `rubato` section |
| The *same* beat position long/short in nearly every bar (e.g. beat 4 always +25%) | **feel / lilt** | keep it (`keep_feel` auto does this); never call it a stutter |
| Slow tempo change over many bars (177 → 160 over 40 bars) | **drift** | steady with phrase anchors, or split |
| A deliberate, steady push or pull over a few bars | **accel/rit** | `ramp` |

`review.md` gives you per-bar tempo, the feel template, a rubato score (> 1.5 suggests rubato),
stutters, and downbeat evidence. Use `look beats` to see what actually lands on each beat.

### Beat tracking mistakes are common: catch them
- A bar of tempo wildly off its neighbours (e.g. 201 among 155s) usually means a phantom or
  missing beat, not a performance event. Look at it, then use `remove_beats` / `add_beats`
  (times within 40 ms of the tracked beat) or give the section an explicit `beats` list.
- If `bars` isn't an integer in a steady section, the start isn't on a downbeat, the meter is
  wrong, or a beat was inserted or dropped. Check downbeat evidence (position 0 should be strongest).

## 2. Doubt the regularization (most important)

This is why a human-like reviewer exists. **If timing changes make notes shift or bunch up a lot,
assume you're wrong.** The warp never quantizes: each tracked beat moves to its ideal grid
position and everything between two beats stretches proportionally, so ornaments, grace notes,
and swing survive. It can still be wrong if the beats are wrong. In `review.md`:
- **guard merges / swaps must be 0.** A merge (two distinct onsets collapsing together) or a
  swap (notes changing order) means a bad beat or a bad boundary. Fix the plan; don't ship it.
- **max shift** over about 0.35 beat after anchoring: is it a real stutter fix (fine) or drift or
  a tracking error (split, ramp, or rubato)?
- Many stutters in one section usually mean wrong tempo, wrong meter, a feel the template missed,
  or rubato. Real stutters are rare and isolated.
- A section where nearly every beat moves 50–150 ms isn't being "cleaned", it's being rewritten. Reconsider.

## 3. Ornaments: trills and tremolos are never edited
Detected automatically (fast two-note alternation). Every note starting inside an ornament's
span moves **rigidly** with the warp (internal timing untouched) and can't be deleted. If you
spot one the detector missed (a mordent, a turn, a measured tremolo), add it:
`"extra_protect": [{"ids": [..], "why": "..."}]`.

## 4. Rolled chords
A candidate is ≥3 strikes in one direction with chordal leaps and keys held. Strikes < 20 ms
apart count as one strike (that's ordinary chord spread, not a roll). The fix keeps the roll's
total span exactly and evens the gaps between strikes. Defaults: on when unevenness ≥ 0.2,
**off inside rubato sections** and for slow flourishes > 300 ms (those are melodic gestures).
Override with `"roll_decisions": {"<first note id>": {"action": "even"|"keep", "why": "..."}}`.

## 5. Note removals (fat-fingers, missed notes)
Candidates: **graze** (adjacent key hit with a stronger note), **prestrike** (a fumbled early hit
re-struck soon after), **wrong-note** (out of key, short, corrected by a neighbour),
**ghost** (barely touched). Look at each with `look slips`, then decide:
- Delete when it's clearly unintended: soft and short next to a strong intended note,
  out of the local key, anticipating the next chord, a lingering finger from the last chord.
- **Keep** ornaments (turns, mordents, graces that make melodic sense), soft chord tones,
  arpeggio and tremolo texture notes. When it might be intentional, keep it as a proposal
  that is *off by default* and say why.
- Look for slips the detector missed (the partner note of a fumbled pair, for example) and
  add them via `delete_extra: [{"id": N, "why": "..."}]`.
- Record every decision with a one-line *why* in `slip_decisions` (the user reads these).

## 6. Hand-off
When review.md is clean (0 merges, 0 swaps, integer bars in steady sections, each stutter and
max shift explained):
1. Start the editor (`python3 serve.py`, background) and give the user the URL.
2. Summarize in a few lines: sections (mode/tempo/why), what was removed and kept and why, anything
   you're unsure of and want their ears on (point to edit ids/times).
3. The editor's ▶ / A buttons audition each edit cleaned vs original, and B toggles A/B globally.

## 7. After the user reviews
`work/<name>/review.json` holds their overrides (`accepted`: edit id → bool, `manual`: per-note
tweaks). Read it and note where they disagreed with your defaults (e.g. "keeps soft graces",
"prefers rubato on cadences"). Use that on the next take. Save durable preferences to memory.
Final MIDI: the editor's **Export MIDI** (or `python3 pipeline/render.py work/<name>`) writes
`work/<name>/<name>.clean.mid` with a tempo map whose bar lines follow the cleaned beats.

## 8. Reassess requests from the editor

The user can box-select a region or notes in the editor and leave a note ("this is a grace note,
keep it", "tempo drags here", "this should be rubato"). Notes are stored in
`work/<name>/review.json` under `requests` (`id, t0, t1, lo, hi, note_ids, text`). A request is
**open** until `work/<name>/ai_replies.json` has an entry for its id. They reach you from the
editor's **Ask Claude** button (headless run) or from `/clean-midi reassess [name]` in a session.

For each open request:
1. Read the note and look at the region yourself: `look.py notes t0 t1`, `look.py beats t0 t1`, the
   proposal edits touching those notes, and the section's diagnostics. The user's ears outrank the
   heuristics, so treat the note as strong evidence. Don't treat it as license to break the golden rule:
   if it asks for something impossible (adding notes, changing a section's length), say so and
   offer the nearest allowed fix.
2. Change only what the note concerns, in `plan.json`: slip/roll decisions, `delete_extra`,
   `extra_protect`, section mode/boundaries/beat fixes/anchors (a boundary may move only to another
   played downbeat, and both sides' lengths change together only if the user asked for a
   re-sectioning). Write the `why` as "per user note qXXX: ...".
3. Re-run `python3 pipeline/propose.py work/<name>` and re-check review.md (0 merges, 0 swaps).
4. Write the reply into `work/<name>/ai_replies.json` (merge with what's there, never drop entries):
   ```json
   {"<request id>": {"reply": "one or two sentences: what you concluded and did",
                     "changes": ["del-1349 now ON: ...", "section 'Chorale' split at 170.35"],
                     "reset_overrides": ["del-1349"], "at": "<ISO time>"}}
   ```
   `reset_overrides` lists edit ids whose *old* manual toggle by the user should be cleared so
   your new default shows. Only include ids the note was about.
5. Don't edit `review.json`. It's the user's (the editor may be saving it). The editor sees the
   new proposals.json and offers a Reload that keeps the user's decisions.

When finished, report briefly. In a headless run that report goes to `work/<name>/ai_log.txt`.

## Starting a new take

`/clean-midi <path/to/take.mid>`: the file can live anywhere. The project name is the file name
(without .mid) and its workspace is `work/<name>/`. Re-running analyze on the same name keeps an
existing `plan.json`. Delete it (or the folder) for a fully fresh start. When the review is done,
make sure the editor server is running (`curl -s localhost:8765/api/projects`; if it isn't, start
`python3 serve.py` in the background) and tell the user the project is in the editor's dropdown.
