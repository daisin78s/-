(function () {
'use strict';

/**
 * Synergy lookup for game.xlsx's 評価値_初期資源 sheet (added 2026-08-27 as 評価値_3, renamed 2026-08-29,
 * for "AI LV4"'s initial-RESOURCE-card selection -- per user design: "資源カードの選び方を説明します 評価
 * 値3のシートを見ます"). Rows are CON face names (13, e.g. "潔癖") and JOB names (11, e.g. "権力者");
 * columns are specific RESOURCE-card ONCE effect texts (e.g. "ADD(A,K)"). A cell's value is the
 * bonus/penalty applied to a resource card's effective priority when the acting player holds that CON
 * face or can see that JOB in this game's JOB pool (see resource-card-selection's own doc for how these
 * get summed). Blank cells mean no adjustment (0), same blank-is-0 convention eval-table.js's own
 * buildEvalTable uses.
 */

function buildResourceSynergyTable(rawData) {
  const rows = rawData['評価値_初期資源'] || [];
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

/** table[name][onceEffect], defaulting to 0 for an unknown name or a blank/missing cell. */
function synergyValue(table, name, onceEffect) {
  const row = table[name];
  if (!row) return 0;
  return row[onceEffect] || 0;
}

module.exports = { buildResourceSynergyTable, synergyValue };

})();
