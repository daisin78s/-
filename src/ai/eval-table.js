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
 *  - The SHOP201-203 special-shop cards (A201/A202/B201/B202/C201/C202, both tiers, wave 1; A301/B301/
 *    C301, both tiers, wave 2 -- renumbered from a single A008/B008/C008 wave by the 2026-08-24
 *    SHOP201-203 rework's card renumbering) have no 1R entry (blank/0), and the wave-2 ids have no 2R
 *    entry either -- see setup.js's SPECIAL_SHOP_SLOT_IDS/prepareShops for the round gating that makes
 *    them structurally unbuildable that early. Same for M401/M402/M403 (晩餐会/王都建設/天空の塔), no 1R
 *    or 2R entry -- see isStructurallyBlankRound's own doc for why. Force-zeroed below (2026-09-14)
 *    regardless of what the sheet actually contains, in case a stray nonzero value ever drifts back in
 *    there (e.g. via training/mutation, or a hand edit) -- these cells are never meant to hold real data.
 */
function buildEvalTable(rawData) {
  const rows = rawData['評価値'] || [];
  const byRound = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const row of rows) {
    for (const round of [1, 2, 3, 4]) {
      const raw = row[`${round}R`];
      byRound[round][row.ID] = isStructurallyBlankRound(row.ID, round) ? 0 : (typeof raw === 'number' ? raw : 0);
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

/** Whether id's cell at `round` is STRUCTURALLY blank -- the card/monument in question cannot possibly be
 * owned that early in a real game, so any nonzero value sitting there is meaningless noise, not a real
 * signal (2026-09-14, per user request: "進化で動かす評価値 1r 2rに出てこないカードは空白にしてくださ
 * い"). Two sources, both already-established round gates elsewhere in this codebase, just not previously
 * enforced ON the 評価値 table itself:
 *  - SHOP201-203 special-shop cards (board.js's own specialShopMinRound, see its doc): wave 1
 *    (A201/A202/B201/B202/C201/C202, either tier) can't be BUILT before round 2, so has no real 1R value;
 *    wave 2 (A301/B301/C301, either tier) can't be built before round 3, so has no real 1R OR 2R value.
 *    This function's own doc already claimed this convention existed (see buildEvalTable's header comment)
 *    -- it just wasn't actually enforced anywhere until now, which is how A202A's 1R cell drifted to a
 *    nonzero value over many generations of training/mutation despite being structurally unreachable.
 *  - M401/M402/M403 (晩餐会/王都建設/天空の塔): no hard round gate in code (setup.js's prepareShops holds
 *    them back in state.extraMonumentPool until any shop's own pool empties, not a fixed round), but per
 *    the user's own observation from real games, that practically never happens before round 3 -- treated
 *    the same as wave 2 here (no 1R or 2R value) on that basis.
 * Used by ga.js's randomGenome/mutateGenome/mutateGenomePercent to keep these cells pinned at exactly 0
 * through every generation, rather than wasting genome search space (and, once written back into
 * game.xlsx by tools/apply_evolved_genome.py, spreadsheet clarity) mutating a value nothing can ever
 * actually query in a real game. */
function isStructurallyBlankRound(id, round) {
  if (id === 'M401' || id === 'M402' || id === 'M403') return round <= 2;
  const match = /^[A-Z]+(\d+)[A-Z]$/.exec(id);
  if (!match) return false;
  const num = Number(match[1]);
  if (num >= 200 && num < 300) return round === 1;
  if (num >= 300 && num < 400) return round <= 2;
  return false;
}

module.exports = { buildEvalTable, evalValue, isStructurallyBlankRound };

})();
