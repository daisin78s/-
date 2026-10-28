/**
 * カード×カードの相性表 (2026-10-27, per user request: "AILV3をもっと強くしたい そのために全カード×全カード
 * エクセルを作って両方のカードを持っているときのAI戦の勝率を書き込む それをAIの評価値作成に生かしたい 進化AI
 * を進めるときにそれを記載していかせるようにお願い" + 回答: 勝率は「平均順位」、表に入れるのは「初期資源以外
 * すべて」、データ集めは「進化AI」の対戦に乗せる、"カードの能力が変わったときは その行と列は削除").
 *
 * tools/ga_train.js calls addGame() for every training game (each worker reports every seat's final holdings
 * + rank, see ga_worker.js) and save() once per generation, so stopping a run at any point keeps everything
 * up to the last finished generation. The tally accumulates across every GA run in one fixed file
 * (STATS_PATH), not per run -- the more games the better, regardless of which lineage played them.
 *
 * Unit of a row/column ("カード"):
 *  - A/B/C: the physical card (A001 = LV1 and LV2 together -- LV2 is the same card upgraded, not a different card).
 *  - M: the card itself (M001).
 *  - JOB: the card itself (JOB001).
 *  - CON: the chosen FACE (CON001A 祝福 / CON001B 色欲 are entirely different abilities).
 *  - RESOURCE (初期資源) cards are excluded.
 *
 * "能力が変わったら行と列を削除": each unit's data-sheet ability columns (FINGERPRINT_COLUMNS, every face of
 * the card) are stored as a fingerprint. Whenever the stats file is loaded and a unit's current fingerprint
 * differs from the stored one, every number involving that unit (its own row, column and solo stats) is
 * dropped and counting restarts from 0 for it. A change made only in code (e.g. 食料長官's bonus lives in
 * executor.js, not in its data row) can't be seen this way -- clear those by hand:
 *     node tools/card_pair_stats.js reset JOB008 [more ids...]
 *
 * Regenerate the Excel by hand (ga_train.js already does this every generation):
 *     node tools/card_pair_stats.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// CARD_PAIR_STATS_ROOT (2026-10-28): デスクトップの「進化AI」フォルダ(このリポジトリのコピーで進化AIを動かす
// 場所)からも、ゲームのフォルダの同じ相性表に足し込めるようにする -- 指定が無ければ今まで通りこのフォルダ。
const STATS_ROOT = process.env.CARD_PAIR_STATS_ROOT ? path.resolve(process.env.CARD_PAIR_STATS_ROOT) : PROJECT_ROOT;
const STATS_PATH = path.join(STATS_ROOT, 'output', 'card_pair_stats.json');
const XLSX_PATH = path.join(STATS_ROOT, 'カード相性.xlsx');
const XLSX_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'card_pair_stats_to_xlsx.py');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');

const UNIT_SHEETS = ['A', 'B', 'C', 'M', 'JOB', 'CON'];
// Ability-bearing columns only -- NAME/INST/アイコン/WARNING/NOTE are wording, not ability.
const FINGERPRINT_COLUMNS = ['DICE', 'COST', 'EMBLEM_A', 'EMBLEM_B', 'EMBLEM_C', 'VP', 'LEVEL', 'ONCE', 'TAP', 'PASSIVE', 'TURNEND', 'START_ORDER', 'AUTO'];

/** Face row id -> unit id (see this file's own doc on what a unit is). */
function unitIdOfFace(sheet, faceId) {
  if (sheet === 'CON' || sheet === 'M' || sheet === 'JOB') return faceId;
  return faceId.replace(/[AB]$/, '');
}

/** Every unit in the current data, in sheet order, with its name and ability fingerprint. */
function listUnits(raw) {
  const units = [];
  const byId = {};
  for (const sheet of UNIT_SHEETS) {
    for (const row of raw[sheet] || []) {
      const unitId = unitIdOfFace(sheet, row.ID);
      if (!byId[unitId]) {
        byId[unitId] = { id: unitId, sheet, name: (row.NAME || unitId).replace(/LV\d$/, ''), faces: [] };
        units.push(byId[unitId]);
      }
      byId[unitId].faces.push(FINGERPRINT_COLUMNS.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\u0001'));
    }
  }
  for (const u of units) u.fingerprint = u.faces.slice().sort().join('\u0002');
  return units;
}

/** Units one player holds at game end (initial-resource cards excluded). */
function holdingUnits(state, index, player) {
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
  return [...result].sort();
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function emptyStats() {
  return { games: 0, fingerprints: {}, resetLog: [], solo: {}, pair: {} };
}

function dropUnit(stats, unitId, reason) {
  delete stats.solo[unitId];
  for (const key of Object.keys(stats.pair)) {
    const [a, b] = key.split('|');
    if (a === unitId || b === unitId) delete stats.pair[key];
  }
  stats.resetLog.push({ unitId, reason, at: new Date().toISOString() });
}

/** Loads the accumulated tally and drops every unit whose ability changed since it was last saved. */
function load(raw) {
  const stats = fs.existsSync(STATS_PATH) ? JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) : emptyStats();
  const units = listUnits(raw);
  const current = {};
  for (const u of units) current[u.id] = u.fingerprint;
  const dropped = [];
  for (const [unitId, fp] of Object.entries(stats.fingerprints)) {
    if (current[unitId] === undefined) { dropUnit(stats, unitId, 'カードが無くなった'); dropped.push(unitId); continue; }
    if (current[unitId] !== fp) { dropUnit(stats, unitId, '能力が変わった'); dropped.push(unitId); }
  }
  stats.fingerprints = current;
  return { stats, dropped };
}

/** @param {Object<string,string[]>} holdingsByPlayerId  @param {Object<string,number>} rankByPlayerId */
function addGame(stats, holdingsByPlayerId, rankByPlayerId) {
  stats.games++;
  for (const [playerId, units] of Object.entries(holdingsByPlayerId)) {
    const rank = rankByPlayerId[playerId];
    for (const u of units) {
      const s = stats.solo[u] || (stats.solo[u] = { n: 0, rankSum: 0 });
      s.n++; s.rankSum += rank;
    }
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const key = pairKey(units[i], units[j]);
        const p = stats.pair[key] || (stats.pair[key] = { n: 0, rankSum: 0 });
        p.n++; p.rankSum += rank;
      }
    }
  }
}

/** Writes the tally JSON, then the Excel (an open/locked Excel only skips the Excel, never the JSON). */
function save(stats) {
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats));
  try {
    execFileSync('python', [XLSX_SCRIPT, STATS_PATH, DATA_PATH, XLSX_PATH], { stdio: 'pipe' });
  } catch (e) {
    console.error(`  (カード相性.xlsx update failed, continuing anyway -- Excelで開いたままだと書けません: ${String(e.stderr || e.message).trim()})`);
  }
}

module.exports = { STATS_PATH, XLSX_PATH, listUnits, holdingUnits, load, addGame, save, dropUnit };

if (require.main === module) {
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const { stats, dropped } = load(raw);
  if (dropped.length) console.log(`能力が変わった/無くなったため削除: ${dropped.join(', ')}`);
  if (process.argv[2] === 'reset') {
    const ids = process.argv.slice(3);
    if (ids.length === 0) { console.error('Usage: node tools/card_pair_stats.js reset <unitId> [...]'); process.exit(1); }
    for (const id of ids) dropUnit(stats, id, '手動で削除');
    console.log(`削除: ${ids.join(', ')}`);
  }
  save(stats);
  console.log(`${stats.games}試合分 -> ${XLSX_PATH}`);
}
