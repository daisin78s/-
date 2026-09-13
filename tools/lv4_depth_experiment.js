/**
 * Tests whether widening AI LV4's existing round-3/4 search (beamWidth/lookaheadExtraTurns -- see
 * ai-player.js's own doc: a wide 1-ply beam selection followed by a purely greedy single-path rollout,
 * NOT a real multi-ply narrowing beam search) actually raises final score, and at what time cost
 * (2026-09-13, per user request: "全く同じ盤面ですべてAILV4のものと そのうち1プレイヤーだけ深度の深いも
 * のに変えて100戦回す 深さはいろいろ用意してください それぞれのかかった時間も測り 得点の伸びが多いもの
 * 時間とのコスパの良いものを探す").
 *
 * Design: for each DEPTH_VARIANTS entry, plays BOARDS_PER_VARIANT independently-seeded boards, each
 * played 4 times with the SAME board/seed while rotating which ONE of the 4 seats uses that variant's
 * own (wider) aiOptions -- the other 3 seats always play plain, unmodified AI LV4 (game-runner.js's own
 * playGame with levelByPlayerId, extended 2026-09-13 to accept an inline options object per seat, not
 * just a registered LEVELS name). This is the same seat-rotation method ga_train.js/ai_variant_tournament.js
 * already use for AI comparisons -- see either file's own doc -- so seat-order/board-luck noise cancels
 * out and every variant's own seat gets exactly BOARDS_PER_VARIANT*4 (100 by default) games. A `control`
 * variant (identical to plain LV4) is always included first as a sanity baseline -- its own avgRank
 * should land near 2.5/winRate near 25% if the harness itself is unbiased.
 *
 * evaluatorOptions/moveGeneratorOptions are always exactly AI LV4's own (see src/ai/levels.js) for every
 * variant -- only aiOptions.roundOverrides (search depth) differs, so any score difference is
 * attributable to search depth alone, not a different scoring policy.
 *
 * Usage: node tools/lv4_depth_experiment.js [boardsPerVariant=25] [outputJsonPath]
 *   totalGames per variant = boardsPerVariant * 4 (100 by default, per the user's own "100戦").
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { getLevel } = require('../src/ai/levels');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'lv4_depth_experiment_worker.js');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'lv4_depth_experiment.json');
// 2026-09-13, per user request ("評価値は今進化させているもので良さそうなのを使って"): use the self-play
// GA's own current all-time-best genome (tools/ga_train.js's best_genome.json) instead of the hand-tuned
// game.xlsx real table for every seat in this experiment -- see the worker's own doc on why "every seat"
// (not just the test seat) matters for isolating the search-depth effect. Pass '' to use the real table.
const GENOME_PATH = path.join(PROJECT_ROOT, 'output', 'ga_train_seedreal_20260904', 'best_genome.json');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);
const LV4 = getLevel('LV4');

/** Builds one depth variant's inline aiOptions -- same base fields as real LV4 (dieScarcityTieBreak,
 * preferExOnOwnTerritory, round-1-3 default lookaheadExtraTurns:1) with ONLY round3/round4's own
 * roundOverrides replaced by wider values. evaluatorOptions/moveGeneratorOptions are shared, unmodified
 * LV4 objects (safe to share by reference across variants -- Evaluator/MoveGenerator never mutate them). */
function depthVariant(label, round3Override, round4Override) {
  return {
    label,
    levelSpec: {
      evaluatorOptions: LV4.evaluatorOptions,
      moveGeneratorOptions: LV4.moveGeneratorOptions,
      aiOptions: {
        ...LV4.aiOptions,
        roundOverrides: { 3: round3Override, 4: round4Override },
      },
    },
  };
}

/** Same shape as depthVariant() above but for the NEW genuine multi-ply narrowing beam search
 * (ai-player.js's #deepBeamSearch, `beamWidths` option) instead of the old beamWidth/lookaheadExtraTurns
 * rollout -- 2026-09-13, per user request: "5→3→2→2→1のようにはできない？". */
function beamSearchVariant(label, beamWidths) {
  return {
    label,
    levelSpec: {
      evaluatorOptions: LV4.evaluatorOptions,
      moveGeneratorOptions: LV4.moveGeneratorOptions,
      aiOptions: { ...LV4.aiOptions, roundOverrides: { 3: { beamWidths }, 4: { beamWidths } } },
    },
  };
}

const DEPTH_VARIANTS = [
  { label: 'control(plain LV4)', levelSpec: 'LV4' },
  depthVariant('medium', { lookaheadExtraTurns: 3, beamWidth: 10 }, { lookaheadExtraTurns: 30, beamWidth: 15, maxRolloutMoves: 300 }),
  beamSearchVariant('beam[5,3,2,2,1]', [5, 3, 2, 2, 1]),
  beamSearchVariant('beam[8,5,3,2,1]', [8, 5, 3, 2, 1]),
];

function parseArgs() {
  const [boardsArg, outputArg] = process.argv.slice(2);
  const boardsPerVariant = boardsArg ? Number(boardsArg) : 25;
  if (!Number.isInteger(boardsPerVariant) || boardsPerVariant < 1) {
    console.error('Usage: node tools/lv4_depth_experiment.js [boardsPerVariant=25] [outputJsonPath]');
    process.exit(1);
  }
  return { boardsPerVariant, outputPath: outputArg ? path.resolve(outputArg) : DEFAULT_OUTPUT_PATH };
}

function createWorkerPool(count) {
  return Array.from({ length: count }, () => new Worker(WORKER_SCRIPT, { workerData: { genomePath: GENOME_PATH } }));
}

function terminateWorkerPool(pool) {
  for (const worker of pool) worker.terminate();
}

/** Same greedy first-idle dispatch as ga_train.js's own runJobsOnPool -- see that file's doc. */
function runJobsOnPool(pool, jobs, onProgress) {
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
        onProgress(completedCount, jobs.length);
        if (completedCount === jobs.length) resolve(results);
        else assignNext(worker);
      });
      worker.on('error', reject);
      assignNext(worker);
    }
  });
}

/** BOARDS_PER_VARIANT boards, each played 4 times (rotating which seat gets `levelSpec`) -- returns one
 * job per game, tagged with which playerId is the seat under test this game. */
function buildJobs(variantLabel, levelSpec, boardsPerVariant) {
  const jobs = [];
  for (let board = 0; board < boardsPerVariant; board++) {
    const seed = `lv4-depth-${variantLabel}-board${board}`;
    for (let rotation = 0; rotation < 4; rotation++) {
      const testSeatId = `P${rotation + 1}`;
      const levelByPlayerId = {};
      for (let seat = 1; seat <= 4; seat++) levelByPlayerId[`P${seat}`] = seat === rotation + 1 ? levelSpec : 'LV4';
      jobs.push({ jobId: jobs.length, seed, levelByPlayerId, testSeatId });
    }
  }
  return jobs;
}

async function runVariant(pool, variant, boardsPerVariant) {
  const jobs = buildJobs(variant.label, variant.levelSpec, boardsPerVariant);
  const t0 = Date.now();
  const results = await runJobsOnPool(pool, jobs, (done, total) => {
    process.stdout.write(`\r  [${variant.label}] ${done}/${total} games done...`);
  });
  process.stdout.write('\n');
  const elapsedSeconds = (Date.now() - t0) / 1000;

  let scoreSum = 0, rankSum = 0, wins = 0;
  const opponentScoreSum = { sum: 0, n: 0 };
  jobs.forEach((job, i) => {
    const h = results[i].historyByPlayerId;
    scoreSum += h[job.testSeatId].finalScore;
    rankSum += h[job.testSeatId].rank;
    if (h[job.testSeatId].rank === 1) wins++;
    for (const pid of Object.keys(h)) {
      if (pid === job.testSeatId) continue;
      opponentScoreSum.sum += h[pid].finalScore;
      opponentScoreSum.n++;
    }
  });

  return {
    label: variant.label,
    gamesPlayed: jobs.length,
    elapsedSeconds,
    secondsPerGame: elapsedSeconds / jobs.length,
    avgScore: scoreSum / jobs.length,
    avgRank: rankSum / jobs.length,
    winRate: wins / jobs.length,
    opponentAvgScore: opponentScoreSum.sum / opponentScoreSum.n,
  };
}

async function main() {
  const { boardsPerVariant, outputPath } = parseArgs();
  const totalGamesPerVariant = boardsPerVariant * 4;
  console.log(`${DEPTH_VARIANTS.length} variant(s), ${totalGamesPerVariant} games each (${boardsPerVariant} boards x 4 seat rotations).`);

  const pool = createWorkerPool(WORKER_COUNT);
  console.log(`Worker pool: ${WORKER_COUNT} threads (this machine has ${os.cpus().length} CPU cores).\n`);

  const summaries = [];
  try {
    for (const variant of DEPTH_VARIANTS) {
      const summary = await runVariant(pool, variant, boardsPerVariant);
      summaries.push(summary);
      console.log(`  ${variant.label}: avgScore=${summary.avgScore.toFixed(1)} avgRank=${summary.avgRank.toFixed(3)} winRate=${(summary.winRate * 100).toFixed(1)}% | ${summary.elapsedSeconds.toFixed(1)}s total (${summary.secondsPerGame.toFixed(2)}s/game)\n`);
    }
  } finally {
    terminateWorkerPool(pool);
  }

  const control = summaries[0];
  console.log('\n=== 結果まとめ (control=通常AI LV4のみ) ===');
  console.log('label'.padEnd(20), 'avgScore', 'vs control', 'avgRank', 'winRate', 'sec/game', '得点差/秒');
  for (const s of summaries) {
    const scoreDelta = s.avgScore - control.avgScore;
    const extraSecondsPerGame = s.secondsPerGame - control.secondsPerGame;
    const scorePerExtraSecond = extraSecondsPerGame > 0 ? scoreDelta / extraSecondsPerGame : null;
    console.log(
      s.label.padEnd(20),
      s.avgScore.toFixed(1).padEnd(8),
      (scoreDelta >= 0 ? '+' : '') + scoreDelta.toFixed(1),
      s.avgRank.toFixed(3).padEnd(8),
      (s.winRate * 100).toFixed(1) + '%',
      s.secondsPerGame.toFixed(2).padEnd(8),
      scorePerExtraSecond === null ? 'n/a(control)' : scorePerExtraSecond.toFixed(2)
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ boardsPerVariant, totalGamesPerVariant, summaries }, null, 2));
  console.log(`\nWrote ${outputPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
