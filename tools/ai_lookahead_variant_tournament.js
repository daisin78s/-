/**
 * Compares 4 AI LV4-based (beamWidth, lookaheadExtraTurns) search settings for rounds 1-3 -- labeled
 * "61"/"62"/"31"/"32" per the user's own shorthand (2026-09-16 consultation: is a smaller beamWidth or a
 * deeper lookahead worth its extra cost?). Round 4's own roundOverrides (lookaheadExtraTurns:20,
 * beamWidth:10, maxRolloutMoves:200) stays exactly AI LV4's real one for every variant, per user request
 * ("それはそのままで") -- only the base (round 1-3) values differ between variants.
 *
 * Two phases, both over the SAME 25 board seeds (per user spec):
 *   Phase A (strength): each board's 4 seat rotations, one game per rotation (100 games total) -- the
 *     same "one shared board, 4 rotations so all 4 variants see identical luck" method already used by
 *     ga_train.js/ai_variant_tournament.js. Reports win rate + avg score per variant.
 *   Phase B (cost): each board played ONCE with all 4 seats using the SAME variant (25 games x 4
 *     variants = 100 games) -- no rotation needed since there's nothing to compare seat-to-seat within a
 *     single-variant game. Reports avg wall-clock time per game + avg score per variant.
 *
 * Usage: node tools/ai_lookahead_variant_tournament.js [boardCount] [outputJsonPath] [seedPrefix] [--phaseA-only]
 * boardCount defaults to 25. seedPrefix (default "lookahead-variant-board") lets a re-run use a fresh,
 * independent set of boards instead of reproducing the exact same ones (2026-09-16, per user request:
 * "念のため...もう一度お願い" -- "別の盤面で" -- a re-run with the SAME seeds would just replay identical
 * games, telling nothing new). --phaseA-only skips Phase B (cost) when only the strength comparison needs
 * re-checking.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'lookahead_variant_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

const PHASE_A_ONLY = process.argv.includes('--phaseA-only');
const positional = process.argv.slice(2).filter((arg) => arg !== '--phaseA-only');
const BOARD_COUNT = Number(positional[0]) || 25;
const OUTPUT_PATH = positional[1] ? path.resolve(positional[1]) : path.join(PROJECT_ROOT, 'output', `lookahead_variant_tournament_${Date.now()}.json`);
const SEED_PREFIX = positional[2] || 'lookahead-variant-board';

// AI LV4's own real settings (src/ai/levels.js), only beamWidth/lookaheadExtraTurns swapped per variant.
const ROUND4_OVERRIDE = { 4: { lookaheadExtraTurns: 20, beamWidth: 10, maxRolloutMoves: 200 } };
const BASE_EVALUATOR_OPTIONS = { qstAware: true, conBuildAware: true, monumentIncentiveAware: true };
const BASE_MOVE_GENERATOR_OPTIONS = { preferCastleOverSenate: true };

function makeVariant(beamWidth, lookaheadExtraTurns) {
  return {
    evaluatorOptions: BASE_EVALUATOR_OPTIONS,
    moveGeneratorOptions: BASE_MOVE_GENERATOR_OPTIONS,
    aiOptions: {
      lookaheadExtraTurns,
      beamWidth,
      roundOverrides: ROUND4_OVERRIDE,
      dieScarcityTieBreak: true,
      preferExOnOwnTerritory: true,
    },
  };
}

const VARIANTS = {
  '61': makeVariant(6, 1),
  '62': makeVariant(6, 2),
  '31': makeVariant(3, 1),
  '32': makeVariant(3, 2),
};
const VARIANT_LABELS = Object.keys(VARIANTS);

function createWorkerPool(count) {
  return Array.from({ length: count }, () => new Worker(WORKER_SCRIPT));
}
function terminateWorkerPool(pool) {
  for (const worker of pool) worker.terminate();
}

/** Same greedy first-idle dispatch as tools/ga_train.js's own runJobsOnPool. */
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
  console.log(`Boards: ${BOARD_COUNT}. Variants: ${VARIANT_LABELS.join(', ')}.`);

  const boardSeeds = Array.from({ length: BOARD_COUNT }, (_, i) => `${SEED_PREFIX}-${i}`);

  // ---- Phase A: strength (seat-rotated, 4 games per board) ----
  console.log('\n=== Phase A: strength (seat-rotated) ===');
  const phaseAJobs = [];
  for (let boardIdx = 0; boardIdx < BOARD_COUNT; boardIdx++) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const levelByPlayerId = {};
      for (let seat = 0; seat < 4; seat++) {
        const variantLabel = VARIANT_LABELS[(seat + rotation) % 4];
        levelByPlayerId[`P${seat + 1}`] = VARIANTS[variantLabel];
      }
      phaseAJobs.push({
        jobId: phaseAJobs.length,
        seed: `${boardSeeds[boardIdx]}-rot${rotation}`,
        levelByPlayerId,
        __seatLabels: [0, 1, 2, 3].map((seat) => VARIANT_LABELS[(seat + rotation) % 4]),
      });
    }
  }
  const t0 = Date.now();
  const phaseAResults = await runJobsOnPool(pool, phaseAJobs.map(({ jobId, seed, levelByPlayerId }) => ({ jobId, seed, levelByPlayerId })));
  console.log(`Phase A done: ${phaseAJobs.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  const phaseAStats = {};
  for (const label of VARIANT_LABELS) phaseAStats[label] = { games: 0, wins: 0, scoreSum: 0, rankSum: 0 };
  for (let i = 0; i < phaseAJobs.length; i++) {
    const result = phaseAResults[i];
    const seatLabels = phaseAJobs[i].__seatLabels;
    if (result.error) { console.error(`Phase A job ${i} error: ${result.error}`); continue; }
    for (let seat = 0; seat < 4; seat++) {
      const playerId = `P${seat + 1}`;
      const label = seatLabels[seat];
      const stats = phaseAStats[label];
      stats.games++;
      stats.scoreSum += result.scoreByPlayerId[playerId];
      stats.rankSum += result.rankByPlayerId[playerId];
      if (result.rankByPlayerId[playerId] === 1) stats.wins++;
    }
  }
  console.log('\nPhase A results (strength):');
  for (const label of VARIANT_LABELS) {
    const s = phaseAStats[label];
    console.log(`  ${label}: games=${s.games} winRate=${(s.wins / s.games).toFixed(3)} avgScore=${(s.scoreSum / s.games).toFixed(2)} avgRank=${(s.rankSum / s.games).toFixed(2)}`);
  }

  // ---- Phase B: cost (uniform, 1 game per board per variant) ----
  let phaseBStats = null;
  if (!PHASE_A_ONLY) {
    console.log('\n=== Phase B: cost (uniform seats) ===');
    const phaseBJobs = [];
    for (const label of VARIANT_LABELS) {
      for (let boardIdx = 0; boardIdx < BOARD_COUNT; boardIdx++) {
        const levelByPlayerId = { P1: VARIANTS[label], P2: VARIANTS[label], P3: VARIANTS[label], P4: VARIANTS[label] };
        phaseBJobs.push({ jobId: phaseBJobs.length, seed: `${boardSeeds[boardIdx]}-uniform-${label}`, levelByPlayerId, __label: label });
      }
    }
    const t1 = Date.now();
    const phaseBResults = await runJobsOnPool(pool, phaseBJobs.map(({ jobId, seed, levelByPlayerId }) => ({ jobId, seed, levelByPlayerId })));
    console.log(`Phase B done: ${phaseBJobs.length} games in ${((Date.now() - t1) / 1000).toFixed(1)}s.`);

    phaseBStats = {};
    for (const label of VARIANT_LABELS) phaseBStats[label] = { games: 0, scoreSum: 0, elapsedMsSum: 0 };
    for (let i = 0; i < phaseBJobs.length; i++) {
      const result = phaseBResults[i];
      const label = phaseBJobs[i].__label;
      if (result.error) { console.error(`Phase B job ${i} error: ${result.error}`); continue; }
      const stats = phaseBStats[label];
      stats.games++;
      stats.elapsedMsSum += result.elapsedMs;
      for (let seat = 0; seat < 4; seat++) stats.scoreSum += result.scoreByPlayerId[`P${seat + 1}`];
    }
    console.log('\nPhase B results (cost):');
    for (const label of VARIANT_LABELS) {
      const s = phaseBStats[label];
      console.log(`  ${label}: games=${s.games} avgTimePerGame=${(s.elapsedMsSum / s.games / 1000).toFixed(2)}s avgScore(all4seats)=${(s.scoreSum / (s.games * 4)).toFixed(2)}`);
    }
  }

  terminateWorkerPool(pool);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ boardCount: BOARD_COUNT, phaseA: phaseAStats, phaseB: phaseBStats }, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
