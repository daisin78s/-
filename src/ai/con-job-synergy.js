(function () {
'use strict';

/**
 * Synergy lookup for game.xlsx's 評価値_JOB sheet (added 2026-08-27, for "AI LV4"'s JOB/CON selection --
 * per user design: "評価値2で マイナスのついている組み合わせは選ばない プラスの組み合わせは積極的に選
 * ぶ"). Rows are one of three kinds:
 *   - CON face names (e.g. "祝福") -- unconditional: choosing that face always counts as achieving it,
 *     no board-state check needed (see smart-onboarding.js's own doc for how this feeds into pickJob).
 *   - LV1 card names (e.g. "城下町の支配LV1") -- achieved only if that specific card is actually
 *     buildable this turn (real dice/resources/shop contents), never just "sitting in the shop".
 *   - The single literal row "D" (2026-08-28: renamed from "色ダイス" per user request, to match the
 *     main 評価値 sheet's own "D" row naming) -- achieved only if gaining an extra color die is
 *     actually reachable this turn (e.g. via 訓練場/AREA007, resources permitting).
 * Columns are JOB ids (JOB001-011) directly, not names -- no translation needed on that side.
 * A cell's value is the bonus (or penalty) for holding that JOB were that row's condition to be true.
 * Blank cells mean 0 (no opinion), same convention as eval-table.js's own buildEvalTable.
 */

const COLOR_DICE_ROW_NAME = 'D';

/** table[rowName][jobId], defaulting to 0 for an unknown row/job or a blank cell. */
function buildConJobSynergyTable(rawData) {
  const rows = rawData['評価値_JOB'] || [];
  const table = {};
  for (const row of rows) {
    const name = row.ID; // 評価値_JOB's own header column is literally "ID", holding each row's NAME text
    if (!name || name === 'NAME') continue; // the "NAME" row is 評価値_JOB's own JOB-id-to-JOB-name legend, not real data
    const entry = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'ID') continue;
      if (typeof value === 'number') entry[key] = value;
    }
    table[name] = entry;
  }
  return table;
}

function synergyValue(table, rowName, jobId) {
  const row = table[rowName];
  if (!row) return 0;
  return row[jobId] || 0;
}

/** NAME -> faceId for every CON face (2026-08-27, for matching 評価値_JOB's CON-face rows back to a real
 * conPhysicalId+face). */
function buildConFaceIdByName(rawData) {
  const map = {};
  for (const row of rawData.CON || []) map[row.NAME] = row.ID;
  return map;
}

/** NAME -> faceId for every LV1 A/B/C card (2026-08-27, for matching 評価値_JOB's card rows -- all LV1
 * names -- back to a real buildable faceId). */
function buildLv1CardFaceIdByName(rawData) {
  const map = {};
  for (const sheet of ['A', 'B', 'C']) {
    for (const row of rawData[sheet] || []) {
      if (row.LEVEL === 1) map[row.NAME] = row.ID;
    }
  }
  return map;
}

module.exports = { buildConJobSynergyTable, synergyValue, buildConFaceIdByName, buildLv1CardFaceIdByName, COLOR_DICE_ROW_NAME };

})();
