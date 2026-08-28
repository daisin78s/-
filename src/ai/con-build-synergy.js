(function () {
'use strict';

/**
 * Synergy lookup for game.xlsx's 評価値_4 sheet (2026-08-28, "AI LV4" -- wiring a CON-face x LV1-card
 * BUILD-time evaluation adjustment, per user bug report: 憤怒(CON005B, PASSIVE=WHITE_DICE_CAP(0)) still
 * built 双星の加護(B201A, ONCE=ADD(2wD), immediately lost to the cap) despite this sheet already holding
 * -200 for that exact pairing -- because 評価値_4 had never actually been read by any code; this module
 * (plus evaluator.js's own conBuildAware policy) is what finally wires it in.
 *
 * Rows are one of two kinds:
 *   - The single literal row "D" (2026-08-28: renamed from "色ダイス" per user request, to match the
 *     main 評価値 sheet's own "D" row naming eval-table.js/evaluator.js's v('D') already reads) -- per
 *     user clarification, "追加色ダイス" specifically: a bonus/penalty applied once per color die a
 *     player holds PAST the normal 5-die baseline (however it was gained -- e.g. 訓練場/AREA007's
 *     ADD(D)/CHANGE(...,D); confirmed no per-die acquisition tracking is needed) -- see evaluator.js's
 *     own score() for the exact max(0, count-5) formula.
 *   - LV1 card names (e.g. "双星の加護LV1") -- a flat bonus/penalty for owning that card, meant to apply
 *     at every tier of it (an LV2 upgrade still matches its own LV1 row -- see normalizeToLv1Name;
 *     confirmed with the user: 憤怒's wD-cap problem is exactly as real for 双星の加護LV2).
 * Columns are CON face names (12, e.g. "憤怒") directly -- no id translation needed on that side.
 * Blank cells mean 0 (no opinion), same convention as eval-table.js's own buildEvalTable.
 */

const COLOR_DICE_ROW_NAME = 'D';

function buildConBuildSynergyTable(rawData) {
  const rows = rawData['評価値_4'] || [];
  const table = {};
  for (const row of rows) {
    const name = row.NAME;
    if (!name) continue;
    const entry = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'NAME') continue;
      if (typeof value === 'number') entry[key] = value;
    }
    table[name] = entry;
  }
  return table;
}

/** table[rowName][conFaceName], defaulting to 0 for an unknown row/face or a blank cell. */
function synergyValue(table, rowName, conFaceName) {
  const row = table[rowName];
  if (!row) return 0;
  return row[conFaceName] || 0;
}

/** "双星の加護LV2" -> "双星の加護LV1" (2026-08-28, per user confirmation that an upgraded card keeps
 * applying its base card's own 評価値_4 entry, since that sheet only ever lists a card's LV1 name).
 * No-op for a name that already ends in "LV1", or doesn't end in "LV<n>" at all (e.g. "色ダイス"). */
function normalizeToLv1Name(name) {
  return name.replace(/LV\d+$/, 'LV1');
}

module.exports = { buildConBuildSynergyTable, synergyValue, normalizeToLv1Name, COLOR_DICE_ROW_NAME };

})();
