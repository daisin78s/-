/**
 * Smoke test for src/ai/eval-table.js against real data (data/game.json's "評価値" sheet).
 * Run: node tests/ai-eval-table.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData } = require('../src/data-loader');
const { buildEvalTable, evalValue, isStructurallyBlankRound } = require('../src/ai/eval-table');

const raw = loadGameData(path.join(__dirname, '..', 'data', 'game.json'));

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

const table = buildEvalTable(raw);

// ---------------------------------------------------------------------------
// buildEvalTable: one entry per ID per round, straight from the "評価値" sheet's 1R/2R/3R/4R columns.
// ---------------------------------------------------------------------------
// 2026-10-28: compared against the sheet row itself rather than hard-coded numbers -- the sheet is now
// rewritten automatically whenever the 進化AI anchor challenge promotes a new genome (tools/
// ga_anchor_promote.js, which runs this suite before shipping), so fixed values here would block every
// promotion. What's checked is unchanged: each value comes through from the sheet's 1R-4R columns as-is.
const sheetRow = (id) => raw['評価値'].find((row) => row.ID === id);
const sheetValues = (id) => ['1R', '2R', '3R', '4R'].map((c) => sheetRow(id)[c]);
check('D (colored die) value per round comes through unchanged from the sheet', [1, 2, 3, 4].map((r) => evalValue(table, r, 'D')), sheetValues('D'));
check('VP value per round comes through unchanged from the sheet', [1, 2, 3, 4].map((r) => evalValue(table, r, 'VP')), sheetValues('VP'));
check('VP 4R value (endgame VP weighted highest)', evalValue(table, 4, 'VP') > evalValue(table, 1, 'VP'), true);
check('K value per round comes through unchanged from the sheet', [1, 2, 3, 4].map((r) => evalValue(table, r, 'K')), sheetValues('K'));

// ---------------------------------------------------------------------------
// evalValue: missing IDs/blank cells default to 0, never throw.
// ---------------------------------------------------------------------------
check('Unknown ID returns 0 rather than throwing', evalValue(table, 1, 'NO_SUCH_ID'), 0);
// A synthetic table (not real data, 2026-09-14 -- a real card's row can no longer be assumed to stay all-
// zero forever once GA evolution can nudge any currently-0 cell away from 0, see src/ai/ga.js's own
// ZERO_ESCAPE_STEP_BY_ROUND doc) with one genuinely all-zero row, isolating this from whatever the real
// sheet's own values happen to be right now.
check('A card with all-zero rows (e.g. a monument) returns 0', evalValue({ 1: { ZEROID: 0 }, 2: { ZEROID: 0 }, 3: { ZEROID: 0 }, 4: { ZEROID: 0 } }, 1, 'ZEROID'), 0);

// ---------------------------------------------------------------------------
// evalValue: round is clamped to [1,4] -- callers may pass state.round directly, which for round 0
// (pre-game) or a hypothetical round 5+ should fall back to the nearest real column, not throw/NaN.
// ---------------------------------------------------------------------------
check('Round 0 clamps to round 1', evalValue(table, 0, 'D'), evalValue(table, 1, 'D'));
check('Round 5 clamps to round 4', evalValue(table, 5, 'D'), evalValue(table, 4, 'D'));

// ---------------------------------------------------------------------------
// An upgraded face's value is meant to be cumulative, not incremental (confirmed 2026-08-01) --
// this test only asserts the *data* follows that convention where it's already filled in, not that
// eval-table.js enforces it (the sheet is the source of truth, eval-table.js just reads it verbatim).
// ---------------------------------------------------------------------------
check('A001B (upgraded face) 1R value is greater than A001A\'s (cumulative, not incremental)', evalValue(table, 1, 'A001B') > evalValue(table, 1, 'A001A'), true);

// ---------------------------------------------------------------------------
// isStructurallyBlankRound (2026-09-14, per user request: "進化で動かす評価値 1r 2rに出てこないカードは
// 空白にしてください") -- wave-1 special-shop cards (A/B/C 201-299, either tier) can't be built before
// round 2; wave-2 (A/B/C 301-399) not before round 3; M401-403 not before round 3 either (no hard round
// gate in code, but per the user's own observation, shops practically never empty out that early).
// buildEvalTable forces these to exactly 0 regardless of what the sheet actually contains.
// ---------------------------------------------------------------------------
check('Wave-1 special card (A202A) has no 1R value', isStructurallyBlankRound('A202A', 1), true);
check('...but DOES have a real 2R/3R/4R value', [2, 3, 4].map((r) => isStructurallyBlankRound('A202A', r)), [false, false, false]);
check('Wave-2 special card (A301B) has no 1R or 2R value', [1, 2].map((r) => isStructurallyBlankRound('A301B', r)), [true, true]);
check('...but DOES have a real 3R/4R value', [3, 4].map((r) => isStructurallyBlankRound('A301B', r)), [false, false]);
check('M401 (晩餐会) has no 1R or 2R value', [1, 2].map((r) => isStructurallyBlankRound('M401', r)), [true, true]);
check('A plain resource row (D) is never blank in any round', [1, 2, 3, 4].map((r) => isStructurallyBlankRound('D', r)), [false, false, false, false]);
check('An ordinary card (A001A, not a special-shop/extra-monument id) is never blank in any round', [1, 2, 3, 4].map((r) => isStructurallyBlankRound('A001A', r)), [false, false, false, false]);
check('buildEvalTable forces A202A\'s 1R to exactly 0 even if the sheet somehow had a nonzero value', evalValue(buildEvalTable({ '評価値': [{ ID: 'A202A', '1R': 999, '2R': 5 }] }), 1, 'A202A'), 0);
check('...while its own 2R (not pinned) passes through unchanged', evalValue(buildEvalTable({ '評価値': [{ ID: 'A202A', '1R': 999, '2R': 5 }] }), 2, 'A202A'), 5);

// 評価値ALLの対角のマス = 性格の単体の強さ (2026-11-21): soloValue で読めて、組み合わせの点には入らず、
// pickConFace(表と裏を選ぶ)で足される。
{
  const evalAll = require('../src/ai/eval-all');
  const smart = require('../src/ai/smart-onboarding');
  const { buildDataIndex } = require('../src/data-loader');
  const raw2 = JSON.parse(JSON.stringify(raw));
  raw2['評価値ALL'].find((r) => r.NAME === '臆病')['臆病'] = 200;
  raw2['評価値ALL'].find((r) => r.NAME === '虚栄')['虚栄'] = '';
  const before = evalAll.buildEvalAllTable(raw);
  const after = evalAll.buildEvalAllTable(raw2);
  check('soloValue reads the diagonal cell (臆病 = CON003B)', evalAll.soloValue(after, 'CON003B'), 200);
  check('soloValue is 0 when the diagonal is blank (虚栄 = CON003A)', evalAll.soloValue(after, 'CON003A'), 0);
  check('the diagonal is not a pair value', evalAll.pairValue(after, 'CON003B', 'CON003B'), 0);
  const state = { players: [{ id: 'P1', conPhysicalId: 'CON003' }] };
  // 虚栄の方がジョブとの相性が良い(ただし差が200より小さい)ジョブ。評価値ALLは自動で変わるので、数字は決め打ちしない。
  const kyoeiJob = raw.JOB.map((j) => j.ID).find((j) => {
    const diff = evalAll.pairValueByName(before, '虚栄', j) - evalAll.pairValueByName(before, '臆病', j);
    return diff > 0 && diff < 200;
  });
  check('pickConFace: 虚栄 (A) wins on its job synergy when 臆病 has no solo value', smart.pickConFace(state, buildDataIndex(raw), 'P1', kyoeiJob, evalAll.buildEvalAllTable({ ...raw, '評価値ALL': raw['評価値ALL'].map((r) => ({ ...r, '虚栄': r.NAME === '虚栄' ? '' : r['虚栄'], '臆病': r.NAME === '臆病' ? '' : r['臆病'] })) }), { seed: 1 }), 'A');
  check('pickConFace: a big solo value flips it to 臆病 (B)', smart.pickConFace(state, buildDataIndex(raw2), 'P1', kyoeiJob, after, { seed: 1 }), 'B');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
