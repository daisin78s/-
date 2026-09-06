/**
 * One-off follow-up to tools/ga_train.js (2026-09-06, per user request: "過去の優秀なものをピックアップし
 * て100戦させて優秀なものからまた世代を続けてください 勝率ではなく点数で優秀なもの"). The completed
 * 361-generation run (output/ga_train_seedreal_20260904) bred every generation using avgRank (relative
 * placement against that generation's own 3 siblings) as the elitism/selection metric -- the user now
 * wants a SEPARATE pass, ranking every individual that ever appeared across the whole run by its own
 * avgScore instead (not avgRank, not winRate), since a rank-optimized genome and a score-maximizing one
 * aren't necessarily the same thing. Each individual's own recorded avgScore already came from only 30
 * games (ga_train.js's own gamesPerIndividual for that run) -- noisy enough that the single highest-
 * scoring entry in the whole history could just be a lucky sample, so the top candidates are re-measured
 * here at a much larger, less noisy sample (100 games each, self-play vs 3 copies of itself, same pattern
 * ga_train.js's own measureRealTableBaseline already uses for a single genome in isolation) before
 * trusting any of them.
 *
 * Pipeline:
 *   1. Scan every gen_*.json in sourceDir, collect every individual (generation, genome, its own
 *      avgScore/avgRank/winRate from that run), dedupe by genome content (elites carry over unchanged
 *      across many generations -- no point re-testing the identical genome twice), sort by avgScore desc.
 *   2. Re-measure the top `topK` unique genomes at `retestGames` games each via the same worker_threads
 *      pool ga_train.js uses, ranked again by the NEW, larger-sample avgScore.
 *   3. Write a report (JSON + console table) and a synthetic gen_0000.json into newOutputDir shaped
 *      exactly like ga_train.js's own resumeFromDir expects (an array of {genome} entries) -- this lets
 *      `node tools/ga_train.js <N> <pop> <games> <newOutputDir> <newOutputDir>` continue breeding from
 *      this hand-picked population using ga_train.js's own existing, already-tested resume machinery,
 *      rather than duplicating its breeding loop here. Population layout: the top `topK` re-tested
 *      genomes fill their own slots directly (preserved once each, not bred from anything else's mutation
 *      this generation), the remaining slots are mutated copies (mutateGenomePercent, same style
 *      --seed-real runs already use) of the single best re-tested genome, giving the new run some early
 *      diversity to explore around the best-known point. Slot 0 gets overwritten by ga_train.js's own
 *      ANCHOR_COUNT logic regardless of what's written here, so nothing special is done for it.
 *
 * Usage: node tools/ga_pick_by_score.js <sourceDir> [topK] [retestGames] [newOutputDir]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { mutateGenomePercent } = require('../src/ai/ga');
const rng = require('../src/rng');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ga_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);
const POPULATION_SIZE = 20;
const MUTATION_RATE = 0.1;
const MUTATION_PERCENT = 0.2;

function parseArgs() {
  const [sourceDirArg, topKArg, retestGamesArg, newOutputDirArg] = process.argv.slice(2);
  if (!sourceDirArg) {
    console.error('Usage: node tools/ga_pick_by_score.js <sourceDir> [topK] [retestGames] [newOutputDir]');
    process.exit(1);
  }
  const sourceDir = path.resolve(sourceDirArg);
  const topK = topKArg ? Number(topKArg) : 15;
  const retestGames = retestGamesArg ? Number(retestGamesArg) : 100;
  const newOutputDir = newOutputDirArg
    ? path.resolve(newOutputDirArg)
    : path.join(PROJECT_ROOT, 'output', `ga_train_from_best_score_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
  return { sourceDir, topK, retestGames, newOutputDir };
}

/** Every individual ever recorded in sourceDir's gen_XXXX.json checkpoints, deduped by genome content
 * (JSON.stringify -- genomes are plain nested number objects, safe to compare this way), keeping the
 * FIRST generation each distinct genome was seen at (purely for reporting -- an elite surviving unchanged
 * for 50 generations is the same genome, re-testing it 50 times would be pure waste). */
function collectUniqueHistoricalIndividuals(sourceDir) {
  const files = fs.readdirSync(sourceDir).filter((f) => /^gen_\d{4}\.json$/.test(f)).sort();
  const seen = new Map(); // genomeStr -> {generation, genome, avgScore, avgRank, winRate}
  for (const file of files) {
    const { generation, population } = JSON.parse(fs.readFileSync(path.join(sourceDir, file), 'utf8'));
    for (const entry of population) {
      const key = JSON.stringify(entry.genome);
      if (!seen.has(key)) {
        seen.set(key, { generation, genome: entry.genome, avgScore: entry.avgScore, avgRank: entry.avgRank, winRate: entry.winRate });
      }
    }
  }
  return Array.from(seen.values());
}

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

/** Re-measures each of `candidates` (array of genomes) in isolation -- 4 copies of the SAME genome
 * playing itself, `retestGames` times, same self-play pattern ga_train.js's own measureRealTableBaseline
 * uses -- rather than mixing candidates into the same 4-seat games, so one candidate's result can never
 * be inflated/deflated by which other candidates it happened to be seated against. */
async function retestCandidates(pool, candidates, retestGames, runId) {
  const jobs = [];
  candidates.forEach((genome, candidateIndex) => {
    for (let g = 0; g < retestGames; g++) {
      jobs.push({
        jobId: jobs.length,
        candidateIndex,
        genomes: [genome, genome, genome, genome],
        seed: `ga-pick-${runId}-${candidateIndex}-${g}`,
      });
    }
  });
  const results = await runJobsOnPool(pool, jobs);

  const scoreSumByCandidate = new Array(candidates.length).fill(0);
  const rankSumByCandidate = new Array(candidates.length).fill(0);
  const winCountByCandidate = new Array(candidates.length).fill(0);
  const gamesByCandidate = new Array(candidates.length).fill(0);
  jobs.forEach((job, i) => {
    const { rankByPlayerId, scoreByPlayerId } = results[i];
    for (const playerId of ['P1', 'P2', 'P3', 'P4']) {
      scoreSumByCandidate[job.candidateIndex] += scoreByPlayerId[playerId];
      rankSumByCandidate[job.candidateIndex] += rankByPlayerId[playerId];
      if (rankByPlayerId[playerId] === 1) winCountByCandidate[job.candidateIndex]++;
      gamesByCandidate[job.candidateIndex]++;
    }
  });

  return candidates.map((genome, i) => ({
    genome,
    avgScore: scoreSumByCandidate[i] / gamesByCandidate[i],
    avgRank: rankSumByCandidate[i] / gamesByCandidate[i],
    winRate: winCountByCandidate[i] / gamesByCandidate[i],
    gamesPlayed: gamesByCandidate[i],
  }));
}

async function main() {
  const { sourceDir, topK, retestGames, newOutputDir } = parseArgs();

  console.log(`Scanning ${sourceDir} for every historical individual...`);
  const unique = collectUniqueHistoricalIndividuals(sourceDir);
  console.log(`Found ${unique.length} distinct genomes across the run's history.`);

  unique.sort((a, b) => b.avgScore - a.avgScore);
  const shortlist = unique.slice(0, topK);
  console.log(`\nTop ${shortlist.length} by their own original (noisy, low-sample) avgScore:`);
  shortlist.forEach((c, i) => console.log(`  #${i + 1}: gen${c.generation} avgScore=${c.avgScore.toFixed(2)} avgRank=${c.avgRank.toFixed(2)} winRate=${(c.winRate * 100).toFixed(0)}%`));

  const pool = createWorkerPool(WORKER_COUNT);
  console.log(`\nWorker pool: ${WORKER_COUNT} threads. Re-testing ${shortlist.length} candidates at ${retestGames} games each (self-play)...`);
  const runId = Date.now();
  let retested;
  try {
    const t0 = Date.now();
    retested = await retestCandidates(pool, shortlist.map((c) => c.genome), retestGames, runId);
    retested = retested.map((r, i) => ({ ...r, originalGeneration: shortlist[i].generation }));
    retested.sort((a, b) => b.avgScore - a.avgScore);
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);
  } finally {
    terminateWorkerPool(pool);
  }

  console.log(`Re-tested ranking (by avgScore, ${retestGames} games each):`);
  retested.forEach((c, i) => console.log(`  #${i + 1}: originally gen${c.originalGeneration}, avgScore=${c.avgScore.toFixed(2)} avgRank=${c.avgRank.toFixed(2)} winRate=${(c.winRate * 100).toFixed(0)}% (n=${c.gamesPlayed})`));

  const best = retested[0];
  console.log(`\nBest by re-tested avgScore: originally gen${best.originalGeneration}, avgScore=${best.avgScore.toFixed(2)}.`);

  fs.mkdirSync(newOutputDir, { recursive: true });
  fs.writeFileSync(path.join(newOutputDir, 'pick_by_score_report.json'), JSON.stringify({
    sourceDir, topK, retestGames, shortlistByOriginalAvgScore: shortlist, retested,
  }, null, 2));

  // Seed population for ga_train.js's own resumeFromDir: the re-tested candidates fill their own slots
  // unchanged, remaining slots are mutated copies of the single best one -- see this file's own top doc.
  const runRng = rng.createRng(`ga-pick-seed-${runId}`);
  const seedPopulation = retested.map((r) => r.genome);
  while (seedPopulation.length < POPULATION_SIZE) {
    seedPopulation.push(mutateGenomePercent(best.genome, runRng, MUTATION_RATE, MUTATION_PERCENT));
  }
  fs.writeFileSync(path.join(newOutputDir, 'gen_0000.json'), JSON.stringify({
    generation: 0,
    population: seedPopulation.map((genome) => ({ genome })),
  }, null, 2));

  console.log(`\nSeed population (${seedPopulation.length} genomes: top ${retested.length} re-tested + ${seedPopulation.length - retested.length} mutated copies of the best) written to ${path.join(newOutputDir, 'gen_0000.json')}.`);
  console.log(`Continue training with:\n  node tools/ga_train.js <generations> ${POPULATION_SIZE} <gamesPerIndividual> ${newOutputDir} ${newOutputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
