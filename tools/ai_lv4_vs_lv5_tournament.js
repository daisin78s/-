/**
 * Head-to-head AI LV4 vs AI LV5 tournament (2026-09-16, per user request: "AILV4と5を400戦させて平均得点
 * や平均勝率を見たい" -- both levels share the exact same 評価値 table, per user's own confirmation
 * "同じ条件なので", so this is purely a search-algorithm comparison: LV4's beamWidth6/lookahead1 vs LV5's
 * beamWidth3/lookahead2/crossRoundLookahead).
 *
 * Same seat-rotation fairness method as every other AI comparison in this repo (see
 * tools/ai_lookahead_variant_tournament.js/ai_variant_tournament.js's own docs and
 * [[feedback_ai_benchmark_seat_rotation]]): one shared board per 4 games, "4戦づつ" per the user's own
 * standing instruction. With only 2 distinct levels filling 4 seats, each board's 4 rotations cycle
 * [LV4,LV4,LV5,LV5] by one seat each time, so each level visits every seat position exactly twice across
 * a board's 4 games -- cancels seat-order bias the same way the 4-distinct-variant case does.
 *
 * Reuses tools/lookahead_variant_worker.js as-is (already generic: {jobId, levelByPlayerId, seed} in,
 * calls game-runner.js's playGame with real AIPlayer search per seat -- levelByPlayerId here uses plain
 * "LV4"/"LV5" strings, resolved via src/ai/levels.js's own registry, not inline option objects).
 *
 * Usage: node tools/ai_lv4_vs_lv5_tournament.js [boardCount] [outputJsonPath]
 * boardCount defaults to 100 (x4 rotations = 400 games).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'lookahead_variant_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

const BOARD_COUNT = Number(process.argv[2]) || 100;
const OUTPUT_PATH = process.argv[3] ? path.resolve(process.argv[3]) : path.join(PROJECT_ROOT, 'output', `lv4_vs_lv5_tournament_${Date.now()}.json`);

const SEAT_LABELS_BASE = ['LV4', 'LV4', 'LV5', 'LV5'];

function createWorkerPool(count) {
  return Array.from({ length: count }, () => new Worker(WORKER_SCRIPT));
}
function terminateWorkerPool(pool) {
  for (const worker of pool) worker.terminate();
}

function runJobsOnPool(pool, jobs) {
  return new Promise((resolve, reject) => {
    if (jobs.length === 0) { resolve([]); return; }
    const results = new Array(jobs.length);
    let nextJobIndex = 0;
    let completedCount = 0;
    const assignNext = (worker) => {
      if (nextJobIndex >= jobs.length) return;
      worker.postMessage(jobs[nextJobIndex++]);
    };
    for (const worker of pool) {
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.on('message', (msg) => {
        results[msg.jobId] = msg;
        completedCount++;
        if (completedCount === jobs.length) resolve(results);
        else assignNext(worker);
      });
      worker.on('error', reject);
      assignNext(worker);
    }
  });
}

async function main() {
  const pool = createWorkerPool(WORKER_COUNT);
  console.log(`Worker pool: ${WORKER_COUNT} threads (this machine has ${os.cpus().length} CPU cores).`);
  console.log(`Boards: ${BOARD_COUNT} x 4 rotations = ${BOARD_COUNT * 4} games. LV4 vs LV5.`);

  const jobs = [];
  const seatLabelsByJob = [];
  for (let boardIdx = 0; boardIdx < BOARD_COUNT; boardIdx++) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const seatLabels = [0, 1, 2, 3].map((seat) => SEAT_LABELS_BASE[(seat + rotation) % 4]);
      const levelByPlayerId = {};
      seatLabels.forEach((label, seat) => { levelByPlayerId[`P${seat + 1}`] = label; });
      seatLabelsByJob.push(seatLabels);
      jobs.push({ jobId: jobs.length, seed: `lv4-vs-lv5-board-${boardIdx}-rot${rotation}`, levelByPlayerId });
    }
  }

  const t0 = Date.now();
  const results = await runJobsOnPool(pool, jobs);
  console.log(`Done: ${jobs.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  terminateWorkerPool(pool);

  const stats = { LV4: { games: 0, wins: 0, scoreSum: 0, rankSum: 0 }, LV5: { games: 0, wins: 0, scoreSum: 0, rankSum: 0 } };
  let errorCount = 0;
  for (let i = 0; i < jobs.length; i++) {
    const result = results[i];
    if (result.error) { errorCount++; console.error(`Job ${i} error: ${result.error}`); continue; }
    const seatLabels = seatLabelsByJob[i];
    for (let seat = 0; seat < 4; seat++) {
      const playerId = `P${seat + 1}`;
      const label = seatLabels[seat];
      const s = stats[label];
      s.games++;
      s.scoreSum += result.scoreByPlayerId[playerId];
      s.rankSum += result.rankByPlayerId[playerId];
      if (result.rankByPlayerId[playerId] === 1) s.wins++;
    }
  }

  console.log('\nResults:');
  for (const label of ['LV4', 'LV5']) {
    const s = stats[label];
    console.log(`  ${label}: games=${s.games} winRate=${(s.wins / s.games).toFixed(3)} avgScore=${(s.scoreSum / s.games).toFixed(2)} avgRank=${(s.rankSum / s.games).toFixed(2)}`);
  }
  if (errorCount > 0) console.log(`\n${errorCount} games errored out of ${jobs.length}.`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ boardCount: BOARD_COUNT, totalGames: jobs.length, errorCount, stats }, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
