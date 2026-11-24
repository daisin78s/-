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
// 追加色ダイスのD欄もデータから自動 (2026-11-24, per user「Dの欄すべて 自動で変わるようにして」「増えた数だけ数える」「すぐ自動に切り替える」):
// 1つの「D」をやめ、ゲーム終了時の追加色ダイス(ふつうの5個より多い分)の数で D1(1個)/D2(2個)/D3(3個以上) に分けて数える。
const COLOR_DICE_UNITS = ['D1', 'D2', 'D3'];
const COLOR_DICE_BASELINE = 5;
/** 追加色ダイスの数 -> その項目(D1/D2/D3)。0個ならnull。 */
function colorDiceUnit(extraCount) {
  if (!(extraCount > 0)) return null;
  return COLOR_DICE_UNITS[Math.min(extraCount, COLOR_DICE_UNITS.length) - 1];
}

function unitIdOfFace(sheet, faceId) {
  if (sheet === 'CON' || sheet === 'M' || sheet === 'JOB') return faceId;
  return faceId.replace(/[AB]$/, '');
}

function stripLevel(name) {
  return String(name).replace(/LV\d+$/, '');
}

/** @returns {{byUnit: Object<string,Object<string,number>>, unitByName: Object<string,string>}} */
function buildEvalAllTable(raw) {
  const unitByName = {};
  for (const u of COLOR_DICE_UNITS) unitByName[u] = u;
  for (const sheet of UNIT_SHEETS) {
    for (const row of raw[sheet] || []) {
      const name = stripLevel(row.NAME || row.ID);
      if (!unitByName[name]) unitByName[name] = unitIdOfFace(sheet, row.ID);
    }
  }
  const cells = {};
  // 対角のマス(同じ性格どうし)= その性格(CONの面)の単体の強さ (2026-11-21, per user: 表と裏を選ぶ時に「その性格の平均順位の
  // 良さも点にして足す」「自動」「全部の試合」) -- tools/write_eval_all_sheet.py が 65×(2.5−平均順位) を書く。
  // 組み合わせの点(byUnit)には入れない(使うのは smart-onboarding.js の pickConFace だけ)。
  const solo = {};
  for (const row of raw['評価値ALL'] || []) {
    const a = unitByName[row.NAME];
    if (!a) continue;
    for (const [key, value] of Object.entries(row)) {
      const b = unitByName[key];
      if (b && b === a && typeof value === 'number') solo[a] = value;
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
  return { byUnit, unitByName, solo, lv: buildLvTable(raw) };
}

// LV2のカードはLV別の相性を使う (2026-11-24, per user「LVアップ後のカードを別の項目として使う…おねがい」):
// 評価値ALL_LV シート(tools/write_eval_all_sheet.py が LV別の相性のデータから書く)は A/B/C を面ごと(基礎学問LV1 / 基礎学問LV2)
// に分けた表。LV2のカードを含む組み合わせは、このシートに数があればそれを使い、無ければ評価値ALLの値のまま。
// 評価値ALLの固定のマス(-100以下)はそのまま優先する。
function buildLvTable(raw) {
  const faceByName = {};
  const lv2Faces = new Set();
  for (const sheet of UNIT_SHEETS) {
    for (const row of raw[sheet] || []) {
      faceByName[row.NAME || row.ID] = row.ID;
      if ((sheet === 'A' || sheet === 'B' || sheet === 'C') && row.LEVEL === 2) lv2Faces.add(row.ID);
    }
  }
  const byFace = {};
  for (const row of raw['評価値ALL_LV'] || []) {
    const a = faceByName[row.NAME];
    if (!a) continue;
    for (const [key, value] of Object.entries(row)) {
      const b = faceByName[key];
      if (key === 'NAME' || !b || b === a || typeof value !== 'number') continue;
      (byFace[a] || (byFace[a] = {}))[b] = value;
      if (!(byFace[b] && typeof byFace[b][a] === 'number')) (byFace[b] || (byFace[b] = {}))[a] = value;
    }
  }
  return { byFace, lv2Faces };
}

/** 対角のマス(単体の強さ)。無ければ 0。 */
function soloValue(table, unit) {
  return (table.solo && table.solo[unit]) || 0;
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
 * tools/card_pair_stats.js's holdingUnits, so the table's data and its use line up exactly.
 * 2026-11-24 (per user「D欄を、性格以外との組み合わせでもゲーム中に使う…おねがい」): 追加色ダイスの D1/D2/D3 も1つの
 * 項目として入れる(カード・ジョブ・性格すべてとの組み合わせを足す)。 */
function heldUnits(state, index, player) {
  return heldEntries(state, index, player).map((e) => e.unit);
}

/** heldUnits と同じ並びで {unit, face}(face = LV別の表で引く面。A/B/Cは今の面、それ以外は unit と同じ)。 */
function heldEntries(state, index, player) {
  const seen = new Set();
  const result = [];
  const add = (unit, face) => { if (!seen.has(unit)) { seen.add(unit); result.push({ unit, face }); } };
  for (const physicalId of player.ownedCardPhysicalIds) {
    const card = state.cards[physicalId];
    const faceId = card ? card.currentFaceId : physicalId;
    const entry = index.byId.get(faceId);
    if (!entry || !UNIT_SHEETS.includes(entry.sheet)) continue;
    add(unitIdOfFace(entry.sheet, faceId), faceId);
  }
  if (player.conPhysicalId && player.conFace) add(`${player.conPhysicalId}${player.conFace}`, `${player.conPhysicalId}${player.conFace}`);
  if (player.jobCardId) add(player.jobCardId, player.jobCardId);
  const dice = colorDiceUnit((player.dice || []).filter((d) => d.kind === 'COLOR').length - COLOR_DICE_BASELINE);
  if (dice) add(dice, dice);
  return result;
}

/** 持っているもの全部の組み合わせの点の合計。LV2のカードを含む組み合わせは評価値ALL_LVの数を使う(buildLvTable参照)。 */
function heldPairSumWithLevels(table, state, index, player) {
  const entries = heldEntries(state, index, player);
  const lv = table.lv;
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    const row = table.byUnit[a.unit];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      const base = (row && row[b.unit]) || 0;
      if (lv && base > FIXED_CELL_MAX && (lv.lv2Faces.has(a.face) || lv.lv2Faces.has(b.face))) {
        const cell = lv.byFace[a.face] && lv.byFace[a.face][b.face];
        total += typeof cell === 'number' ? cell : base;
      } else {
        total += base;
      }
    }
  }
  return total;
}
const FIXED_CELL_MAX = -100; // 評価値ALLの固定のマス(-100以下、tools/write_eval_all_sheet.pyのFIXED_MAX)

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

module.exports = { buildEvalAllTable, soloValue, pairValue, pairValueByName, heldUnits, heldPairSum, heldPairSumWithLevels, COLOR_DICE_NAME, COLOR_DICE_UNITS, COLOR_DICE_BASELINE, colorDiceUnit };

})();
