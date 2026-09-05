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
 *   in:  { jobId, genomes: [g0,g1,g2,g3], seed }
 *   out: { jobId, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId }
 */

'use strict';

const path = require('path');
const { parentPort } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { Evaluator } = require('../src/ai/evaluator');
const { playGameForFitness } = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

const raw = loadGameData(DATA_PATH);
const index = buildDataIndex(raw);
const synergyTable3 = buildResourceSynergyTable(raw);
const synergyTable2 = buildConJobSynergyTable(raw);
const resourceCardPicker = (candidateIds, state, idx, player) =>
  pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

parentPort.on('message', (job) => {
  const { jobId, genomes, seed } = job;
  const evaluatorByPlayerId = {};
  genomes.forEach((genome, seat) => {
    evaluatorByPlayerId[`P${seat + 1}`] = new Evaluator(index, genome);
  });
  const { rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId } = playGameForFitness(
    seed, PLAYER_NAMES, index, evaluatorByPlayerId, undefined, resourceCardPicker, synergyTable2
  );
  parentPort.postMessage({ jobId, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId });
});
