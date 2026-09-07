/**
 * Seat-rotated head-to-head tournament between 4 FIXED 評価値 variants (2026-09-07, per user request:
 * "gameエクセルのAIと gameエクセルから進化させた AI*2 リプレイから学習させたAIの4体で同じ盤面を持つように
 * 100戦対戦させて平均勝率や平均得点だして"). Unlike tools/ga_train.js (which evolves a whole POPULATION
 * generation over generation), this plays a one-shot tournament among exactly 4 already-fixed genomes:
 *
 *   - 基本AI    -- game.xlsx's own real 評価値 table, untouched (buildEvalTable(raw)).
 *   - 進化AI1/2 -- 2 self-play GA runs that evolved starting from 基本AI (best_genome.json from
 *                  output/ga_train_seedreal_20260904 and output/ga_train_from_best_score_20260906,
 *                  picked 2026-09-07 as the 2 best-performing completed runs on file).
 *   - リプレイAI -- tools/train_from_human_replay.js's own best_genome.json (only R3/R4 differ from
 *                  the real table; R1/R2 stay identical to 基本AI by that tool's own design).
 *
 * "同じ盤面を持つように" (per user, confirmed 2026-09-07): reuses the EXACT seat-rotation method
 * tools/ga_train.js's own evaluatePopulationFitness already uses internally for its self-play fitness
 * evaluation -- for each of totalGames/4 independently-seeded boards, all 4 variants play that ONE
 * shared board 4 times, cycling which variant sits at P1/P2/P3/P4 each time (a variant's own seat never
 * repeats within its own board's 4 rotations). Since board setup (maps/shops/dice rolls/JOB pool/CON
 * deal) is entirely determined by the seed, not by which genome ends up at which player id, all 4
 * rotations of one board share the exact same underlying "luck" -- this cancels seat-order and
 * board-luck noise between the 4 variants far more than just averaging over more independent games would
 * (see [[feedback_ai_benchmark_seat_rotation]] memory for why this is now the STANDING method for any
 * AI-comparison in this repo, not just this one run).
 *
 * Reuses tools/ga_worker.js as-is (already fully generic: {jobId, genomes:[g0,g1,g2,g3], seed} in,
 * {jobId, rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId} out) -- no new worker script needed.
 *
 * Usage: node tools/ai_variant_tournament.js <totalGames> [outputJsonPath] [replayGenomePath]
 *   totalGames must be a positive multiple of 4 (one board's 4 seat rotations = 4 games).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { loadGameData } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ga_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

const EVI_GENOME_1_PATH = path.join(PROJECT_ROOT, 'output', 'ga_train_seedreal_20260904', 'best_genome.json');
const EVI_GENOME_2_PATH = path.join(PROJECT_ROOT, 'output', 'ga_train_from_best_score_20260906', 'best_genome.json');
const DEFAULT_REPLAY_GENOME_PATH = path.join(PROJECT_ROOT, 'output', 'human_replay_train_20260907_v2', 'best_genome.json');

function parseArgs() {
  const [totalArg, outputArg, replayArg] = process.argv.slice(2);
  const totalGames = Number(totalArg);
  if (!Number.isInteger(totalGames) || totalGames < 4 || totalGames % 4 !== 0) {
    console.error('Usage: node tools/ai_variant_tournament.js <totalGames> [outputJsonPath] [replayGenomePath]');
    console.error('totalGames must be a positive multiple of 4.');
    process.exit(1);
  }
  return {
    totalGames,
    outputPath: outputArg ? path.resolve(outputArg) : null,
    replayGenomePath: replayArg ? path.resolve(replayArg) : DEFAULT_REPLAY_GENOME_PATH,
  };
}

function loadVariants(replayGenomePath) {
  const raw = loadGameData(DATA_PATH);
  const realGenome = buildEvalTable(raw);
  const eviGenome1 = JSON.parse(fs.readFileSync(EVI_GENOME_1_PATH, 'utf8')).genome;
  const eviGenome2 = JSON.parse(fs.readFileSync(EVI_GENOME_2_PATH, 'utf8')).genome;
  const replayGenome = JSON.parse(fs.readFileSync(replayGenomePath, 'utf8')).genome;
  return [
    { name: '基本AI', source: 'game.xlsx real table', genome: realGenome },
    { name: '進化AI1', source: 'ga_train_seedreal_20260904/best_genome.json', genome: eviGenome1 },
    { name: '進化AI2', source: 'ga_train_from_best_score_20260906/best_genome.json', genome: eviGenome2 },
    { name: 'リプレイAI', source: path.relative(PROJECT_ROOT, replayGenomePath), genome: replayGenome },
  ];
}

function createWorkerPool(count) {
  return Array.from({ length: count }, () => new Worker(WORKER_SCRIPT));
}

function terminateWorkerPool(pool) {
  for (const worker of pool) worker.terminate();
}

/** Same greedy first-idle dispatch as ga_train.js's own runJobsOnPool -- see that file's doc. */
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
        if (completedCount % 4 === 0 || completedCount === jobs.length) {
          process.stdout.write(`\r${completedCount}/${jobs.length} games done...`);
        }
      });
      worker.on('error', reject);
      assignNext(worker);
    }
  });
}

/** Builds the seat-rotated job list for `variants` (exactly 4 of them): totalGames/4 independently
 * seeded boards, each played out across all 4 seat rotations -- see this file's own top doc. */
function buildJobs(variants, totalGames) {
  const boards = totalGames / 4;
  const jobs = [];
  for (let board = 0; board < boards; board++) {
    const seed = `tournament-4ai-board${board}`;
    for (let rotation = 0; rotation < 4; rotation++) {
      const seatIndices = [0, 1, 2, 3].map((i) => (i + rotation) % 4);
      jobs.push({ jobId: jobs.length, seatIndices, genomes: seatIndices.map((idx) => variants[idx].genome), seed });
    }
  }
  return jobs;
}

async function main() {
  const { totalGames, outputPath, replayGenomePath } = parseArgs();
  const variants = loadVariants(replayGenomePath);
  console.log('Variants:');
  variants.forEach((v) => console.log(`  ${v.name} <- ${v.source}`));

  const jobs = buildJobs(variants, totalGames);
  console.log(`\n${jobs.length} games total (${jobs.length / 4} boards x 4 seat rotations).`);

  const pool = createWorkerPool(WORKER_COUNT);
  console.log(`Worker pool: ${WORKER_COUNT} threads (this machine has ${os.cpus().length} CPU cores).`);
  const results = await runJobsOnPool(pool, jobs);
  terminateWorkerPool(pool);
  process.stdout.write('\n');

  const rankSum = new Array(variants.length).fill(0);
  const scoreSum = new Array(variants.length).fill(0);
  const qstScoreSum = new Array(variants.length).fill(0);
  const winCount = new Array(variants.length).fill(0);
  const gamesPlayed = new Array(variants.length).fill(0);
  jobs.forEach((job, i) => {
    const { rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId } = results[i];
    job.seatIndices.forEach((idx, seat) => {
      const playerId = `P${seat + 1}`;
      rankSum[idx] += rankByPlayerId[playerId];
      scoreSum[idx] += scoreByPlayerId[playerId];
      qstScoreSum[idx] += qstScoreByPlayerId[playerId] || 0;
      if (rankByPlayerId[playerId] === 1) winCount[idx]++;
      gamesPlayed[idx]++;
    });
  });

  const summary = variants.map((v, i) => ({
    name: v.name,
    source: v.source,
    gamesPlayed: gamesPlayed[i],
    avgRank: rankSum[i] / gamesPlayed[i],
    avgScore: scoreSum[i] / gamesPlayed[i],
    avgRawScore: (scoreSum[i] - qstScoreSum[i]) / gamesPlayed[i],
    avgQstScore: qstScoreSum[i] / gamesPlayed[i],
    winRate: winCount[i] / gamesPlayed[i],
  }));

  console.log('\n結果 (avgRank低いほど良い / winRate高いほど良い):');
  for (const s of summary) {
    console.log(
      `  ${s.name.padEnd(8)} games=${s.gamesPlayed} avgRank=${s.avgRank.toFixed(3)} avgScore=${s.avgScore.toFixed(1)}` +
      ` (raw=${s.avgRawScore.toFixed(1)} qst=${s.avgQstScore.toFixed(1)}) winRate=${(s.winRate * 100).toFixed(1)}%`
    );
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ totalGames, variants: variants.map((v) => ({ name: v.name, source: v.source })), summary }, null, 2));
    console.log(`\nWrote ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
