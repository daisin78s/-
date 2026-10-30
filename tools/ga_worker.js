/**
 * Worker-thread pool member for tools/ga_train.js (2026-09-05, per user request: "継続できる前提で最速
 *化お願い" -- this machine has 16 CPU cores but training previously used exactly 1, playing every game
 * strictly one at a time). Each worker loads the game data + "AI LV4" smart-onboarding synergy tables
 * ONCE at startup (same setup ga_train.js's own main thread does), then plays whatever single 4-seat
 * game jobs the main thread hands it over `parentPort`, entirely independently of every other worker --
 * no shared mutable state between workers at all (each job's own `seed` string is already unique,
 * assigned by the main thread before dispatch, so results stay exactly as reproducible as the old
 * sequential loop was, just computed out of order across threads instead of in order on one).
 *
 * Message protocol (plain objects, structured-clone-safe -- genomes are plain {round:{id:value}}
 * objects, nothing exotic):
 *   in:  { jobId, genomes: [g0,g1,g2,g3], seed, aiLevel? }
 *   out: { jobId, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId, holdingsByPlayerId }
 *
 * aiLevel (2026-09-17, per user request: "現在の最良データをもとにAILV5で...進めてください" -- see
 * ga_train.js's own --ai-level doc): when present (e.g. "LV3", the strongest level -- "LV5" before 2026-10-27, same settings), each seat's Evaluator/AIPlayer/
 * MoveGenerator get that src/ai/levels.js entry's own evaluatorOptions/aiOptions/moveGeneratorOptions,
 * so fitness is measured through that level's actual full search instead of the plain bare, no-lookahead
 * default every prior run used. Omitted (undefined): byte-for-byte the original behavior.
 */

'use strict';

const path = require('path');
const { parentPort } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { playGameForFitness } = require('../src/ai/game-runner');
const { getLevel } = require('../src/ai/levels');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const { holdingUnits } = require('./card_pair_stats');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

let index;
let synergyTable3;
let synergyTable2;
function loadData() {
  const raw = loadGameData(DATA_PATH);
  index = buildDataIndex(raw);
  synergyTable3 = buildResourceSynergyTable(raw);
  synergyTable2 = buildConJobSynergyTable(raw);
}
loadData();
const resourceCardPicker = (candidateIds, state, idx, player) =>
  pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

parentPort.on('message', (job) => {
  // 評価値ALLの自動更新の後 (2026-10-30, see tools/eval_all_update.js): game.json を読み直す。返事はしない。
  if (job.reloadData) { loadData(); return; }
  const { jobId, genomes, seed, aiLevel } = job;
  const level = aiLevel ? getLevel(aiLevel) : null;
  const evaluatorByPlayerId = {};
  genomes.forEach((genome, seat) => {
    evaluatorByPlayerId[`P${seat + 1}`] = new Evaluator(index, genome, level ? level.evaluatorOptions : undefined);
  });
  const moveGenerator = level ? new MoveGenerator(level.moveGeneratorOptions) : undefined;
  const { state, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId } = playGameForFitness(
    seed, PLAYER_NAMES, index, evaluatorByPlayerId, moveGenerator, resourceCardPicker, synergyTable2,
    level ? level.aiOptions : undefined,
  );
  // カード相性表 (2026-10-27, see tools/card_pair_stats.js) -- every seat's final holdings, tallied by the main thread.
  const holdingsByPlayerId = {};
  for (const player of state.players) holdingsByPlayerId[player.id] = holdingUnits(state, index, player);
  parentPort.postMessage({ jobId, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId, holdingsByPlayerId });
});
