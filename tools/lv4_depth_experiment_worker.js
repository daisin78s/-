/**
 * Worker-thread pool member for tools/lv4_depth_experiment.js (2026-09-13, per user request: "全く同じ盤
 * 面で すべてAILV4のものと そのうち1プレイヤーだけ深度の深いものに変えて100戦回す...時間とのコスパの良
 * いものを探す" -- does AI LV4 score higher if given a wider/deeper search in rounds 3/4, and is it worth
 * the extra time?).
 *
 * Unlike tools/ga_worker.js (bare-genome, no lookahead, playGameForFitness), this plays a FULL game via
 * game-runner.js's own playGame -- the only path that supports AIPlayer lookahead/rollout at all, and
 * mixed per-seat configs via levelByPlayerId (2026-09-13 extended, see game-runner.js's own doc, to also
 * accept an inline {evaluatorOptions, moveGeneratorOptions, aiOptions} object per seat, not just a
 * registered LEVELS name -- exactly what this experiment needs for its one-off depth variants).
 *
 * Message protocol:
 *   in:  { jobId, seed, levelByPlayerId: {P1..P4: 'LV4' | {evaluatorOptions, moveGeneratorOptions, aiOptions}} }
 *   out: { jobId, historyByPlayerId } -- historyByPlayerId[playerId] = {finalScore, rank, ...}, same shape
 *        playGame() itself returns.
 */

'use strict';

const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const { loadSeedGenome } = require('./lib/genome_io');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

const raw = loadGameData(DATA_PATH);
const index = buildDataIndex(raw);
// 2026-09-13, per user request ("評価値は今進化させているもので良さそうなのを使って"): every seat uses
// the SAME table regardless -- either the hand-tuned game.xlsx real table, or (when workerData.genomePath
// is given) a self-play-GA-evolved genome (tools/ga_train.js's own best_genome.json) -- so any score
// difference between variants stays attributable to search depth alone, not a scoring-policy mismatch.
const evalTable = (workerData && workerData.genomePath) ? loadSeedGenome(workerData.genomePath).genome : buildEvalTable(raw);
const synergyTable3 = buildResourceSynergyTable(raw);
const synergyTable2 = buildConJobSynergyTable(raw);
// Every seat in this experiment is LV4-family, and real AI LV4 always uses smart onboarding (see
// main.js's own JOB/CON/RESOURCE picks) -- matches tools/ga_worker.js's own resourceCardPicker wiring.
const resourceCardPicker = (candidateIds, state, idx, player) =>
  pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

parentPort.on('message', (job) => {
  const { jobId, seed, levelByPlayerId } = job;
  const { historyByPlayerId } = playGame(
    seed, PLAYER_NAMES, index, evalTable, undefined, undefined, undefined, levelByPlayerId, resourceCardPicker, synergyTable2
  );
  parentPort.postMessage({ jobId, historyByPlayerId });
});
