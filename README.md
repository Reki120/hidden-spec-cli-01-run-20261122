# Build mend, one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Reki120/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Reki120/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

An entry for the make.fun bounty "Build mend, one patch tool for every AI edit format" —
`mend`, a command-line tool that applies the edits AI models write, in all four formats they
write them in, to a tree of text files, exactly as the kit's SPEC.md specifies.

## What it does

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` reads a patch in one of four
formats — a unified diff (line numbers may be wrong), SEARCH/REPLACE blocks, a V4A patch, or
text-editor tool calls as JSON — and applies every edit, or none of them. The format is
detected when `--format` is not given. Output is one line per changed path (`A`, `D`, `M`,
`R old -> new`) and a closing `ok: <n> files`; a failed patch prints one `error: <code>
<path>` line per failed edit and a `failed: <k> of <n> edits` line, and writes nothing.

## How it reads

- **Three matching tiers.** Old lines are looked for exactly first, then with trailing
  spaces and tabs ignored, then with leading whitespace ignored too, so an edit still lands
  when the model drifted the whitespace or re-indented the block. At the loosest tier the
  replacement lines are re-indented from the patch's indentation to the file's. `--strict`
  keeps only the exact tier.
- **Unified diffs** are read section by section — `diff --git` headers, `---`/`+++` pairs,
  renames, creations and deletions — and each hunk is placed at the occurrence nearest its
  stated line number, corrected by the drift of the hunks before it. A `\ No newline` marker
  after a hunk's last context or added line decides whether the result ends with a line
  break.
- **SEARCH/REPLACE blocks** take the nearest path line above them (skipping blanks and code
  fences) and must match exactly once at their tier, or the block is ambiguous.
- **V4A patches** run their chunks under a cursor: an `@@` anchor moves the cursor past the
  line it names, each chunk takes the first match at or after the cursor, and
  `*** End of File` pins a chunk to the file's last line.
- **JSON edits** (`create`, `str_replace`, `insert`) are applied exactly, with CRLF files
  read and written back in CRLF.

Every path is checked for safety before anything else about its edit, each edit is applied
to the tree as the earlier edits left it, and a failed edit changes nothing: the writes
happen only when no edit failed, and `--check` never writes at all. Each file keeps its own
line break (LF or CRLF) and its own final-break state across an edit.

## Files

- `main.ts` — the CLI itself, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as the kit has it; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — the kit's practice checker, for running the public practice set locally.
