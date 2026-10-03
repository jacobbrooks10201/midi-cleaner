# MIDI Cleaner

To clean a take, follow `.claude/skills/clean-midi/SKILL.md` (`/clean-midi <file.mid>`). Its golden rule
(total length and per-section lengths are fixed, and notes are never added) overrides everything else.

- All pipeline times are on the trimmed timeline (first note = 0). Don't subtract the trim again.
- `work/<name>/plan.json` is where the AI's musical decisions live. Always include a `why`.
- After changing pipeline code: re-run `propose.py` on `work/improv_2026-10-02_ai_test` and check that review.md shows 0 merges / 0 swaps
  and that `render.py --defaults` prints the expected length and boundaries.
- Editor: `python3 serve.py` → http://localhost:8765. Python deps: numpy, scipy only.
