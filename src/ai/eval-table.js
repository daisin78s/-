(function () {
'use strict';

/**
 * Loads data/game.xlsx's "評価値" sheet (data/game.json's "評価値" key, converted generically by
 * tools/xlsx_to_json.py like any other sheet -- rows are {ID, "1R","2R","3R","4R"}) into a lookup
 * table: { 1: {ID: value}, 2: {...}, 3: {...}, 4: {...} }.
 *
 * Confirmed design (2026-08-01, see [[project-dice-wp]] chat with the user):
 *  - Base resource rows (VP/K/A/B/C/Z/wD/D/BZ) are the per-round value of *holding* one unit of that
 *    resource/die.
 *  - Card rows (A001A.."M012") are ONLY the qualitative value the data's own COST/VP/ONCE columns
 *    can't already express (ongoing PASSIVE/TAP worth, emblem set-collection value, board-altering
 *    ONCE effects like a MAP tier flip, etc.) -- printed VP, COST, and ONCE-granted resources (fixed
 *    counts like ADD(2wD) *and* dynamic ones like ADD(COUNT(天)*wD)) are deliberately NOT baked in
 *    here; Evaluator derives those automatically from the card's own data row instead, so tuning a
 *    resource's weight doesn't require re-entering every card that happens to grant it.
 *  - Upgrade (B-face) card values are cumulative, not incremental (e.g. A001A=20, A001B=30, not 10).
 *  - JOB/CON rows currently exist but are all blank (0) -- combination-dependent value not modeled
 *    yet, confirmed out of scope for the first AI pass.
 *  - A008A/B008A/C008A/A008B/B008B/C008B have no 1R entry (blank/0) -- they're the special-shop-only
 *    cards (SHOP201-203, ROUND_MIN=2 -- see setup.js's SPECIAL_SHOP_SLOT_IDS), structurally unbuildable
 *    in round 1.
 */
function buildEvalTable(rawData) {
  const rows = rawData['評価値'] || [];
  const byRound = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const row of rows) {
    for (const round of [1, 2, 3, 4]) {
      const raw = row[`${round}R`];
      byRound[round][row.ID] = typeof raw === 'number' ? raw : 0;
    }
  }
  return byRound;
}

/** Looks up id's evaluation value at `round` (clamped to 1..4 -- rounds are always 1-4 in this game,
 * but callers computing "value N rounds from now" can overshoot past 4). Missing ids (not in the
 * sheet at all) or blank cells both resolve to 0, not an error -- an unscored card should never crash
 * evaluation, just contribute nothing beyond its auto-derived VP/COST/ONCE value. */
function evalValue(table, round, id) {
  const clamped = Math.max(1, Math.min(4, round));
  const forRound = table[clamped];
  return (forRound && forRound[id]) || 0;
}

module.exports = { buildEvalTable, evalValue };

})();
