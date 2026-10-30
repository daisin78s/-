(function () {
'use strict';

/**
 * game.xlsx's 評価値ALL sheet (2026-10-30, per user request: "評価値ALLシート作りました これにすべての組み合わせを
 * いれて それを使うのはどうでしょうか" + answer "c" = 評価値_JOB/評価値_CON are no longer read at all -- every
 * pairing now lives in this one sheet). A symmetric "card x card" table over the same 68 units as
 * tools/card_pair_stats.js's カード相性 table, plus one extra "D" row/column:
 *   - A/B/C: the physical card by its LV-less name ("訓練場の支配" covers both LV1 and LV2).
 *   - M / JOB: the card's own name.
 *   - CON: the chosen FACE's name ("祝福", "色欲" -- two faces of one card are entirely different abilities).
 *   - "D": 追加色ダイス (a color die beyond the normal 5), not a card -- carried over from the old 評価値_JOB/
 *     評価値_CON "D" rows (per user: "いれて").
 * Header row: "NAME" then every unit name; first column: every unit name. A cell is the evaluation-point
 * bonus (or penalty) for one player holding both units at once. Blank = 0.
 *
 * Who writes the cells: tools/write_eval_all_sheet.py, automatically from the カード相性 data every 500
 * 進化AI games (per user: "500ごとに更新") -- plus-only from data (per user: "プラス効果は入力 マイナスは一部
 * 以外 入力しない マイナスを入力すると AIがとらなくなり 検証できなくなる"), and every cell <= -100 or in the
 * D row/column is a hand-set fixed value the writer never overwrites (per user: "データをとるまでもなくマイ
 * ナスは明らかなので-100くらいを入れておいて" for the old 評価値_CON -1000 cells, e.g. 憤怒 x 基礎学問).
 *
 * Read symmetrically: (a,b) is used if it holds a number, else (b,a) -- the writer always fills both, but a
 * value hand-typed into only one triangle still counts.
 */

const UNIT_SHEETS = ['A', 'B', 'C', 'M', 'JOB', 'CON'];
const COLOR_DICE_NAME = 'D';

function unitIdOfFace(sheet, faceId) {
  if (sheet === 'CON' || sheet === 'M' || sheet === 'JOB') return faceId;
  return faceId.replace(/[AB]$/, '');
}

function stripLevel(name) {
  return String(name).replace(/LV\d+$/, '');
}

/** @returns {{byUnit: Object<string,Object<string,number>>, unitByName: Object<string,string>}} */
function buildEvalAllTable(raw) {
  const unitByName = { [COLOR_DICE_NAME]: COLOR_DICE_NAME };
  for (const sheet of UNIT_SHEETS) {
    for (const row of raw[sheet] || []) {
      const name = stripLevel(row.NAME || row.ID);
      if (!unitByName[name]) unitByName[name] = unitIdOfFace(sheet, row.ID);
    }
  }
  const cells = {};
  for (const row of raw['評価値ALL'] || []) {
    const a = unitByName[row.NAME];
    if (!a) continue;
    for (const [key, value] of Object.entries(row)) {
      const b = unitByName[key];
      if (key === 'NAME' || !b || b === a || typeof value !== 'number') continue;
      (cells[a] || (cells[a] = {}))[b] = value;
    }
  }
  const byUnit = {};
  for (const [a, row] of Object.entries(cells)) {
    for (const [b, value] of Object.entries(row)) {
      (byUnit[a] || (byUnit[a] = {}))[b] = value;
      const mirror = cells[b] && cells[b][a];
      if (typeof mirror !== 'number') (byUnit[b] || (byUnit[b] = {}))[a] = value;
    }
  }
  return { byUnit, unitByName };
}

function pairValue(table, unitA, unitB) {
  const row = table.byUnit[unitA];
  return (row && row[unitB]) || 0;
}

/** Same lookup by display names -- an "LV1"/"LV2" suffix on either name is ignored. */
function pairValueByName(table, nameA, nameB) {
  const a = table.unitByName[stripLevel(nameA)];
  const b = table.unitByName[stripLevel(nameB)];
  return a && b ? pairValue(table, a, b) : 0;
}

/** Units one player holds right now (initial-resource cards excluded) -- same rule as
 * tools/card_pair_stats.js's holdingUnits, so the table's data and its use line up exactly. */
function heldUnits(state, index, player) {
  const result = new Set();
  for (const physicalId of player.ownedCardPhysicalIds) {
    const card = state.cards[physicalId];
    const faceId = card ? card.currentFaceId : physicalId;
    const entry = index.byId.get(faceId);
    if (!entry || !UNIT_SHEETS.includes(entry.sheet)) continue;
    result.add(unitIdOfFace(entry.sheet, faceId));
  }
  if (player.conPhysicalId && player.conFace) result.add(`${player.conPhysicalId}${player.conFace}`);
  if (player.jobCardId) result.add(player.jobCardId);
  return [...result];
}

/** Sum of every pair among `units`. */
function heldPairSum(table, units) {
  let total = 0;
  for (let i = 0; i < units.length; i++) {
    const row = table.byUnit[units[i]];
    if (!row) continue;
    for (let j = i + 1; j < units.length; j++) total += row[units[j]] || 0;
  }
  return total;
}

module.exports = { buildEvalAllTable, pairValue, pairValueByName, heldUnits, heldPairSum, COLOR_DICE_NAME };

})();
