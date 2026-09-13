/**
 * Worker-thread pool member for tools/train_from_human_replay.js's per-generation fitness pass
 * (2026-09-11, per user request: "並列でお願い" -- population-vs-decisionPoints scoring is embarrassingly
 * parallel with zero shared state between genomes, same opportunity ga_train.js's own worker pool
 * (tools/ga_worker.js) already exploits for its self-play games).
 *
 * Unlike ga_worker.js (stateless between jobs -- any worker can run any job), each worker here is bound
 * for its ENTIRE LIFETIME to one fixed slice of the full decisionPoints array, handed to it once at
 * construction via workerData.decisionPointsSlice. This is why the main thread talks to this pool via a
 * simple "broadcast the same genomes to every worker, wait for everyone's one reply" pattern
 * (runOnEveryWorker in train_from_human_replay.js) rather than ga_train.js's dynamic greedy job queue --
 * a request here can only ever be answered by the specific worker holding the matching data slice, not by
 * whichever worker happens to be free first.
 *
 * Message protocol:
 *   in:  { genomes: [genome, genome, ...] } -- the WHOLE current population, same array sent to every
 *        worker
 *   out: { results: [{rankSum, top1Count}, ...] } -- one entry per input genome, over just THIS worker's
 *        own decisionPointsSlice; the main thread sums rankSum/top1Count for a given genome across every
 *        worker's reply, then divides by the GLOBAL decisionPoints.length (not any one slice's own
 *        length), to get that genome's real avgRank/top1Rate -- see lib/human_replay_scoring.js's own doc.
 */

'use strict';

const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { getLevel } = require('../src/ai/levels');
const { evaluateFitness } = require('./lib/human_replay_scoring');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');
const { aiLevel, decisionPointsSlice } = workerData;

const raw = loadGameData(DATA_PATH);
const index = buildDataIndex(raw);
const level = getLevel(aiLevel);

parentPort.on('message', ({ genomes }) => {
  const results = genomes.map((genome) => {
    const { rankSum, top1Count } = evaluateFitness(genome, decisionPointsSlice, index, level);
    return { rankSum, top1Count };
  });
  parentPort.postMessage({ results });
});
