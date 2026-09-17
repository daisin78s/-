/**
 * Worker-thread pool member for tools/ai_data_report.js's concurrency>1 path (2026-09-16, per user
 * request to tools/run_ai_battle.js: "4戦同時にできるようにしてほしい"). Each worker loads the game data
 * + LV4/LV5 smart-onboarding synergy tables ONCE at startup (same pattern as tools/ga_worker.js/
 * tools/lookahead_variant_worker.js), then plays whatever single full game jobs the main thread hands it
 * over parentPort, returning the exact same {state, historyByPlayerId, roundDetailByPlayerId,
 * activationCounts} shape playGame() itself returns so the main thread's processGameResult can aggregate
 * it identically to a sequentially-played game.
 *
 * Message protocol:
 *   in:  { jobId, seed, aiLevel }
 *   out: { jobId, seed, state, historyByPlayerId, roundDetailByPlayerId, activationCounts }
 *      | { jobId, seed, error, stack }
 */

'use strict';

const path = require('path');
const { parentPort } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');
const { getLevel } = require('../src/ai/levels');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

const raw = loadGameData(DATA_PATH);
const index = buildDataIndex(raw);
const evalTable = buildEvalTable(raw);
// Built unconditionally at startup (cheap, one-time) rather than per-job -- see ai_data_report.js's own
// matching setup for why LV4/LV5 specifically get this wiring.
const synergyTable3 = buildResourceSynergyTable(raw);
const synergyTable2 = buildConJobSynergyTable(raw);
const resourceCardPicker = (candidateIds, state, idx, player) =>
  pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

parentPort.on('message', (job) => {
  const { jobId, seed, aiLevel } = job;
  try {
    const { aiOptions, moveGeneratorOptions, evaluatorOptions } = getLevel(aiLevel);
    const usesSmartOnboarding = aiLevel === 'LV4' || aiLevel === 'LV5';
    const { state, historyByPlayerId, roundDetailByPlayerId, activationCounts } = playGame(
      seed, PLAYER_NAMES, index, evalTable, aiOptions, moveGeneratorOptions, evaluatorOptions,
      undefined, usesSmartOnboarding ? resourceCardPicker : undefined, usesSmartOnboarding ? synergyTable2 : undefined,
    );
    parentPort.postMessage({ jobId, seed, state, historyByPlayerId, roundDetailByPlayerId, activationCounts });
  } catch (err) {
    parentPort.postMessage({ jobId, seed, error: err.message, stack: err.stack });
  }
});
