/**
 * Worker-thread pool member for tools/ai_lookahead_variant_tournament.js (2026-09-16, per user request
 * to compare 4 AI LV4-based (beamWidth, lookaheadExtraTurns) search settings for rounds 1-3: "6 1"/"6
 * 2"/"3 1"/"3 2" -- round 4's own roundOverrides stays exactly AI LV4's real one for every variant, per
 * user request: "それはそのままで"). Unlike tools/ga_worker.js (bare 1-ply Evaluator per seat, no
 * lookahead at all -- used for GA fitness), this plays a real game via game-runner.js's playGame with a
 * genuine AIPlayer (lookahead enabled) per seat, using playGame's own levelByPlayerId inline-spec support
 * (2026-09-13) to give each seat its own aiOptions.
 *
 * Message protocol:
 *   in:  { jobId, levelByPlayerId: {P1:{...},P2:{...},P3:{...},P4:{...}}, seed }
 *   out: { jobId, rankByPlayerId, scoreByPlayerId, elapsedMs } | { jobId, error }
 */

'use strict';

const path = require('path');
const { parentPort } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

const raw = loadGameData(DATA_PATH);
const index = buildDataIndex(raw);
const evalTable = buildEvalTable(raw);
const synergyTable3 = buildResourceSynergyTable(raw);
const synergyTable2 = buildConJobSynergyTable(raw);
const resourceCardPicker = (candidateIds, state, idx, player) =>
  pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

parentPort.on('message', (job) => {
  const { jobId, levelByPlayerId, seed } = job;
  const t0 = Date.now();
  try {
    const { historyByPlayerId } = playGame(
      seed, PLAYER_NAMES, index, evalTable,
      undefined, undefined, undefined,
      levelByPlayerId, resourceCardPicker, synergyTable2,
    );
    const rankByPlayerId = {};
    const scoreByPlayerId = {};
    for (const playerId of Object.keys(historyByPlayerId)) {
      rankByPlayerId[playerId] = historyByPlayerId[playerId].rank;
      scoreByPlayerId[playerId] = historyByPlayerId[playerId].finalScore;
    }
    parentPort.postMessage({ jobId, rankByPlayerId, scoreByPlayerId, elapsedMs: Date.now() - t0 });
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});
