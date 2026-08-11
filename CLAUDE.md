# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

「ダイスWP」("Dice WP") — a 4-player board game, implemented as a single-page client-side web app
with **zero build step and zero server dependency**. `index.html` must keep working when simply
double-clicked open as a `file://` page (no bundler, no `npm start`, no fetch of local files). Because
of that constraint:

- Game data lives in `data/game.data.js`, a plain `<script>`-loaded JS file that assigns
  `window.GAME_DATA` (not `fetch()`-loaded JSON — `file://` pages can't fetch local files).
- Every `src/*.js` file is loaded via its own `<script src="...">` tag, in dependency order, using a
  tiny CommonJS shim defined inline in `index.html` (`window.require`/`window.module`/
  `window.__captureModule`). The **same** `src/*.js` files also run unmodified under plain Node for
  tests/tools (real `require`/`module.exports` there). Never assume a bundler or `import`/`export`
  syntax — this codebase is deliberately dual-environment, dependency-order-sensitive, plain-script JS.
- When adding a new `src/*.js` file (or `src/ai/*.js`), you must also add its `<script src="...">` +
  `<script>__captureModule('name')</script>` pair to `index.html`, placed after every module it
  `require()`s (see the "Depends on:" comment above each existing pair).

## Repo location — read this first

This repo lives at `C:\Users\miwa\Desktop\ダイスWPの続き\game` and has a GitHub remote (`origin` →
`https://github.com/daisin78s/-.git`, branch `main`). **The user plays the live game on an iPad**,
via GitHub Pages at `https://daisin78s.github.io/-/` (confirmed live 2026-08-11 — serves `main`'s
`index.html`/`main.js`/`style.css` directly, no build step or `.github/workflows` involved), which
reads whatever is currently pushed to `origin/main` (not this local working copy) — so a code change
is not "live" for the user until it's committed and pushed. **After any change gets committed, push
to `origin main`** so the iPad picks it up — GitHub Pages typically takes **up to ~10 minutes** to
reflect a new push, so don't be surprised if the iPad still shows the old version immediately after
pushing; that's expected propagation delay, not a failed deploy. Don't assume "update the tablet /
iPad version" means a CSS/responsive-layout task; confirm with the user whether they mean pushing to
GitHub vs. an actual layout bug at tablet viewport widths (these are two very different tasks and have
been confused before).

There is a **separate, unrelated, older `game` folder** at
`C:\Users\miwa\OneDrive\デスクトップ\game` — it only contains a handful of data/test files, not the
real app, and a fresh session's default working directory sometimes starts there instead of here. If
`index.html`/`main.js`/`style.css` aren't in your current directory, you're very likely in that other
folder — switch to `C:\Users\miwa\Desktop\ダイスWPの続き\game` instead of building anything from
scratch.

The `claude_memory_dice_wp` folder one level up (`C:\Users\miwa\Desktop\ダイスWPの続き\claude_memory_dice_wp`)
holds memory files carried over from another PC (dev log, DSL/flow/QST/UI-requirement specs,
collaboration-style feedback) — read these at the start of a session to pick up prior context, since
this machine's own autonomous memory doesn't carry over from that other PC.

## Collaboration style — ask before guessing

When a card/rule text, DSL semantics, or an architecture-level design choice has more than one
reasonable reading, **ask before implementing** rather than guessing — this is a data-driven DSL
system where a wrong guess about intent tends to cause expensive rework once more cards depend on
the same assumption. This applies to genuine open questions (e.g. "how should the player pick a
dice-placement target in the UI" — multiple defensible designs) — not routine implementation
details (variable names, which existing helper to reuse, etc.), and it doesn't mean asking
step-by-step permission ("can I do X next?") once a plan is already unambiguous. See
`claude_memory_dice_wp/feedback_dice_wp_collaboration_style.md` (one level up from this repo) for
the fuller history behind this and related norms (push cadence, headless-screenshot UI-verification
workflow).

**Don't make unrequested changes alongside a requested one — ask first.** When told to change one
thing (a card's effect, a number, a condition), change only that thing; don't also touch adjacent
details (icon, wording, unrelated formatting) that weren't part of the instruction, and don't
over-implement a simple rule change into something more complex than asked. Past mistakes cited by
the user: changing C001A's effect also changed its icon, when the icon should have stayed as-is;
and a "2K→2A" change should have been expressed as a plain rule addition ("if the player only has
1K, it becomes 1A") rather than a more complex implementation. If a requested change seems to imply
a side-effect elsewhere, ask whether that side-effect is wanted instead of just doing it.

**Speak up when free, even if a background task is still running.** Some tools here run long
in the background — e.g. `node tools/ai_batch_run.js 200` for a 200-game AI battle, or
`ai_data_report.js` regenerating `AI.DATA.xlsx` — and it's tempting to treat the whole task as
"not done yet" until that finishes. Instead, as soon as there's no more foreground work to do,
tell the user the background job is still running and that you're ready for the next task in the
meantime, rather than going quiet until the background result lands.

**A question is not an implementation instruction.** When the user phrases something as a question
— "○○はできますか / can XX be done?", "○○はどうですか / what about XX?" — rather than a direct
instruction, don't start implementing from that alone. Answer the question first (e.g. "here's how
that could be done"), and if it needs more clarity before building, say so explicitly ("before
that, can I ask a few things?") rather than guessing and building. Only move to implementation once
the user has actually asked for it.

**Flag predictable downsides before implementing, not after.** If you can foresee that a requested
change will cause a problem elsewhere — breaks another card/rule interaction, degrades existing
behavior, conflicts with a documented decision — say so before writing the code, not as a surprise
once it's already built. This is a specific case of the "ask before guessing" rule above: a
foreseeable downside is itself a form of ambiguity worth surfacing (does the user still want this,
knowing the tradeoff, or is there a better way?).

## Commands

Run a single smoke test file directly with Node (no test runner/framework — each file is a self-contained
script with its own pass/fail counter and `process.exit(1)` on failure):

```
node tests/board.smoke.js
```

Run the whole suite (every `tests/*.smoke.js` file, then the DSL validator), stopping at the first
failure — this is `run_all_tests.bat`'s own logic, reproduced here as a one-liner since the `.bat` is
Windows-`pause`-interactive:

```
for %f in (tests\*.smoke.js) do node "%f" || goto :eof
node tools\validate_dsl.js
```

Validate every DSL string across the whole dataset parses/lowers cleanly (independent of any one card's
test coverage):

```
node tools/validate_dsl.js
```

Regenerate `data/game.json` + `data/game.data.js` after editing the master spreadsheet
(`data/game.xlsx`, gitignored — only the compiled output is tracked):

```
python tools/xlsx_to_json.py
```

AI tuning/reporting tools (see each file's own top-of-file doc for full flag details):

```
node tools/ai_batch_run.js <N> [outputPath]                                    # N AI-vs-AI games -> match history TSV
node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath]    # N games -> AI.DATA.xlsx report
node tools/ai_level_comparison.js <N> [outputJsonPath]                         # LV1/LV2/LV3 mixed-level battles
node tools/ai_aggregate_report.js [logPath]                                    # aggregate stats from an existing TSV
```

Running the app itself: just open `index.html` (double-click, or `file://` in a browser) — no server
needed. A local static server (e.g. `python -m http.server`) also works fine for automated/headless
browser testing and is sometimes more reliable for that than raw `file://` under some tooling.

## Architecture

**Layering** (each layer only calls into the one below it):

- `game-state.js` — the `GameState` shape + `createEmptyGameState`/`cloneState` (uses
  `structuredClone`). Pure data, no rules.
- `dsl-parser.js` → `command-builder.js` — card/area effect text (the ONCE/TAP/PASSIVE/TURNEND/ACTION
  spreadsheet columns) is a small custom DSL, e.g. `CHANGE(K,A,2)`, `ADD(3VP)`, `ON(GET(K),...)`.
  `dsl-parser.js` tokenizes/parses it into an AST (grammar documented in that file's own header
  comment); `command-builder.js` lowers the AST into flat `Command` objects.
- `executor.js` — the only place that actually mutates `GameState` by running lowered `Command`s
  (payment, resource limits, TAP reactions, free actions, `canEndTurn`/usage-fee gating, etc.).
- `board.js` — dice placement (`placeDice`/`placeDiceGroup`) and BUILD/UPGRADE resolution; needs
  shop/map state `executor.js` doesn't have, so it's a separate layer on top rather than folded in.
- `setup.js` / `turn-flow.js` — one-time game setup (steps 1-8: maps/shops/dice/JOB draft/CON
  choice/initial resources) and the ROUND_START → onboarding-interleaved-with-turns → TURNEND →
  ROUND_END orchestration.
- `qst.js`, `scoring.js`, `undo.js` — QST side-objective cards (data-driven, no per-card branching),
  final VP tally, and the single-snapshot undo checkpoint.
- `src/ai/` — a self-contained AI stack, layered the same way: `move-generator.js` (enumerate every
  legal `Move` for a player) → `simulator.js` (`applyInPlace`: apply one `Move` to a `GameState`) →
  `evaluator.js` (score a resulting `GameState`, driven by `eval-table.js`'s spreadsheet-derived
  weights) → `ai-player.js` (`AIPlayer.selectMove`: generate + simulate + score + pick-best, with an
  optional bounded lookahead/rollout). `game-runner.js` drives a whole game via this stack for the
  CLI tools; `main.js` drives it move-by-move itself (see below) so pacing can be visible in the UI.
- `data-loader.js` / `data/game.json` — normalized card/board data, loaded once into an in-memory
  `DataIndex` (`buildDataIndex`) for fast lookup by every layer above.

**`main.js`** is the UI layer: renders `GameState` to the DOM and translates clicks into calls on the
layers above — it holds no game rules of its own, only UI-only scratch state (selection, open modals,
pacing mode, replay/debug history). It is a **plain classic script, not wrapped in an IIFE**, so its
top-level `function`/`let` declarations are real globals (`window.render`, `window.STATE`, etc.) —
relevant if you ever need to drive/inspect it from outside (e.g. headless-browser testing).

Card/area effect text and every non-obvious game-rule decision is explained inline, in detail, at its
own definition site — comments frequently quote the user's own Japanese phrasing verbatim as the
source of truth for a rule (e.g. `"使用料回収は未回収の使用料がある限り何回でも使えるようにかえてくだ
さい"`). Read the surrounding comment before changing behavior that looks arbitrary; it almost always
documents a specific bug report or design decision, not an accident. Comments also reference external
wiki-style docs not present in this repo (`[[project-dice-wp-flow-spec]]`,
`[[project-dice-wp-ui-requirements]]`, `[[project-dice-wp-dsl-spec]]`) — treat these as historical
citations, not files to go looking for locally.

**Testing style**: `tests/*.smoke.js` are plain Node scripts (not Jest/Mocha) — each builds real game
data via `data-loader.js` + `setup.js`, runs assertions through a local `check(label, actual,
expected)` helper that does a JSON-stringify comparison, and prints a final `N passed, M failed` line.
Mirror this pattern (and the existing file's naming: `<module>.smoke.js`) for new tests rather than
introducing a test framework.
