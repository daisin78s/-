/**
 * カードを「何ラウンド目に取ったか」と最終順位の集計 (2026-11-24, per user「評価値を 勝率に連動させるのはどう？」→
 * 案「まず記録を増やす: 進化AIの試合で、カードを取ったラウンドも記録」に「おねがい」)。
 *
 * 進化AI(tools/ga_hillclimb.js)の1試合ごとに、各プレイヤーの人生の記録(PlayerState.lifeStoryLog: ACQUIRE/LEVELUP、
 * どのラウンドか)から「どのカードを何ラウンド目に取った/LVアップしたか」を取り出し、そのプレイヤーの最終順位と一緒に
 * 数える。ゲームの動きは何も変えない(記録を読むだけ)。
 *
 * 保存先: <STATS_ROOT>/output/card_acq_stats.json (STATS_ROOTはcard_pair_stats.jsと同じ、CARD_PAIR_STATS_ROOT)。
 *   { games, players: {n, rankSum},  // 全プレイヤー(比べる基準)
 *     acq: { 単位ID: { ACQUIRE: { "1": {n, rankSum}, ... "4": ... }, LEVELUP: { ... } } },
 *     fingerprints: { 単位ID: 能力の指紋 } }
 * 単位IDはcard_pair_stats.jsと同じ(A/B/Cは面の無いID例 "A005"、Mは面のID)。カードの能力が変わったら、
 * そのカードの記録は捨てて数え直す(load参照、相性のデータと同じ決まり)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cardPairStats = require('./card_pair_stats');

const STATS_ROOT = process.env.CARD_PAIR_STATS_ROOT ? path.resolve(process.env.CARD_PAIR_STATS_ROOT) : path.resolve(__dirname, '..');
const STATS_PATH = path.join(STATS_ROOT, 'output', 'card_acq_stats.json');
const KINDS = ['ACQUIRE', 'LEVELUP'];

function unitOfFace(index, faceId) {
  const entry = index.byId.get(faceId);
  if (!entry) return null;
  if (entry.sheet === 'A' || entry.sheet === 'B' || entry.sheet === 'C') return faceId.replace(/[AB]$/, '');
  if (entry.sheet === 'M') return faceId;
  return null;
}

/** 1人分: [{unit, kind, round}] (同じカード・同じ種類は最初の1回だけ)。 */
function acquisitionsOf(index, player) {
  const out = [];
  const seen = new Set();
  for (const ev of player.lifeStoryLog || []) {
    if (!KINDS.includes(ev.type)) continue;
    const unit = unitOfFace(index, ev.faceId);
    if (!unit) continue;
    const key = `${unit}|${ev.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ unit, kind: ev.type, round: ev.round });
  }
  return out;
}

function emptyStats() {
  return { games: 0, players: { n: 0, rankSum: 0 }, acq: {}, fingerprints: {}, resetLog: [] };
}

/** 読み込んで、能力が変わったカードの記録を捨てる。 */
function load(raw) {
  const stats = fs.existsSync(STATS_PATH) ? JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) : emptyStats();
  const current = {};
  for (const u of cardPairStats.listUnits(raw)) current[u.id] = u.fingerprint;
  for (const [unit, fp] of Object.entries(stats.fingerprints || {})) {
    if (current[unit] === fp) continue;
    delete stats.acq[unit];
    stats.resetLog.push({ unit, reason: current[unit] === undefined ? 'カードが無くなった' : '能力が変わった', at: new Date().toISOString() });
  }
  stats.fingerprints = current;
  return stats;
}

/** @param {Object<string,{unit,kind,round}[]>} acqByPlayerId @param {Object<string,number>} rankByPlayerId */
function addGame(stats, acqByPlayerId, rankByPlayerId) {
  stats.games++;
  for (const [playerId, list] of Object.entries(acqByPlayerId)) {
    const rank = rankByPlayerId[playerId];
    if (typeof rank !== 'number') continue;
    stats.players.n++;
    stats.players.rankSum += rank;
    for (const { unit, kind, round } of list) {
      const byKind = stats.acq[unit] || (stats.acq[unit] = {});
      const byRound = byKind[kind] || (byKind[kind] = {});
      const cell = byRound[round] || (byRound[round] = { n: 0, rankSum: 0 });
      cell.n++;
      cell.rankSum += rank;
    }
  }
}

function save(stats) {
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats));
}

module.exports = { STATS_PATH, acquisitionsOf, load, addGame, save };
