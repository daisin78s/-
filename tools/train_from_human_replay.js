/**
 * Tunes ONLY the 3R/4R portion of a 評価値 genome so that a human's OWN actual decisions (from
 * main.js-exported replay JSON files) rank as highly as possible among every legal alternative the AI's
 * own MoveGenerator+Evaluator would have considered at the same points (2026-09-06, per user request:
 * "今の評価値の出し方が最善ではない...人間がさした手をAIの候補手上位に来るように分析したい 人間の悪手の
 * 改善をしたいわけではない" -- treats the human's replay as ground truth, not something to critique;
 * only round 3/4 are used since with just a handful of replay games, round 1/2 decisions wouldn't have
 * enough samples per situation and would just overfit to a handful of specific boards).
 *
 * No games are ever actually played here -- this is NOT tools/ga_train.js's self-play loop. Every
 * decision point (a human TURN dispatch, reconstructed the same way tools/analyze_human_replay.js does:
 * generate every legal candidate under both hasPlacedDieThisTurn values, apply each, keep whichever
 * produces the next recorded snapshot exactly) is extracted ONCE up front, with every candidate's own
 * RESULTING state pre-computed (move application never depends on the genome, only scoring does) -- so
 * each generation's fitness pass is just re-scoring already-known states with that genome's own eval
 * table, no simulation at all. This is why it can run far more generations per second than self-play GA.
 *
 * Fitness (lower is better, same sign convention as tools/ga_train.js's own avgRank): for each decision
 * point, the human's actual move's rank among all candidates under that genome's own scoring (1 = the
 * genome would have picked it outright; ties broken by competition ranking, i.e. equal scores share the
 * same rank). avgRank is the mean of this across every decision point. One unmutated anchor slot per
 * `anchors` entry (see below) is carried every generation, same live "is anything actually better than
 * this reference table, on THIS specific human data" signal ga_train.js's own single real-table anchor
 * gives -- generalized here to more than one reference table.
 *
 * Per-replay human seat (2026-09-11 fix): earlier replay batches all happened to have the human at P1, so
 * this used to hardcode PLAYER_ID='P1' for every file -- broke on a 2026-09-11 batch of 13 replays where
 * the human's seat varied (P1/P2/P3/P4) across files, which would have silently trained on AI-vs-AI
 * decisions as if they were "human ground truth" (this pipeline already had one such contamination
 * incident, see output/human_replay_train_20260906..._CONTAMINATED_build_choice_bug). Each replay arg now
 * takes an explicit `path=playerId` suffix (default P1 when omitted, for old callers).
 *
 * Extra GA seed/anchor genomes (2026-09-11, per user request): besides the hand-tuned game.xlsx table
 * (always anchor #0), any number of `--seed-genome=<path>` genomes -- either a tools/ga_train.js
 * best_genome.json, or a raw gen_XXXX.json population checkpoint (its best individual by avgRank is
 * picked out) -- can be added. Each is BOTH kept as its own unmutated anchor every generation (so its
 * avgRank against this human data reads straight off the per-generation log -- a live "does self-play
 * convergence look anything like this human's play" signal, since self-play optimizes a different
 * objective, winning against other bots, than this tool's own, ranking a human's actual moves highly) AND
 * used as a mutation/crossover seed for part of the initial population.
 *
 * Crossover (2026-09-11, per user request: "遺伝子のように評価値を交差させたものを使ってみるのはどう" --
 * ga_train.js's own doc explicitly deferred crossover as unneeded complexity for ITS run; here, with
 * multiple qualitatively different seed genomes now in play (hand-tuned vs. two self-play generations) and
 * generations costing only seconds (no simulation), trying it is cheap). See src/ai/ga.js's crossoverGenome
 * for the operator itself (uniform per-(round,id) coin-flip between two parents); used both when building
 * the initial population (crossing every distinct pair of seed genomes, alongside plain single-seed
 * mutants) and per-offspring during reproduction (CROSSOVER_CHANCE below).
 *
 * Parallelized (2026-09-11, per user request: "並列でお願い" -- a timing test showed 81s/generation
 * single-threaded at population=100, i.e. ~22.5h for 1000 generations) across a tools/ga_train.js-style
 * worker_threads pool -- see createWorkerPool/runOnEveryWorker's own docs for why this pool's shape
 * (each worker permanently bound to one fixed slice of decisionPoints) needs a simpler "broadcast to
 * everyone, wait for everyone" protocol instead of ga_train.js's own dynamic greedy job queue.
 *
 * Resume (2026-09-11, per user request: "1000が終わったらそのまま2000 3000と進めてもらっていいですか" --
 * same staged-continuation idea as ga_train.js's own resumeFromDir): `--resume=<previousOutputDir>` loads
 * that dir's final_population.json (the whole evaluated population as of its last completed generation,
 * written at the end of every run alongside best_genome.json) as this run's STARTING population instead of
 * reseeding fresh from the anchors, and loads its best_genome.json as this run's starting `bestEver` so the
 * all-time-best comparison stays correct across the resume boundary (a genome can drop out of the
 * population via elitism-vs-newer-mutants without ever having been beaten -- best_genome.json is the only
 * place that survives regardless). Generation numbering continues from where the resumed run left off, and
 * `<moreGenerations>` means "how many MORE generations to run," not a new total. progress.csv is appended
 * to (not overwritten) when resuming into that same directory.
 *
 * Train/validation split (2026-09-11, per user request: "これは数が増えればいいというものではない？" --
 * without this, more generations always makes TRAINING avgRank look better even once the genome has
 * started memorizing these exact 256 decision points' own quirks rather than learning anything that
 * generalizes, and nothing in the numbers would ever reveal that had started happening). A replay arg
 * prefixed `val:` is held out of the fitness computation entirely (never sent to the worker pool, never
 * part of `allDecisionPoints`/`totalDecisionPointCount`) and instead scored, once per generation on the
 * MAIN thread only (cheap: one genome, not the whole population), against the CURRENT GENERATION's own
 * best-by-training individual -- reported alongside the training numbers every generation and in
 * progress.csv's val_avg_rank/val_top1_rate columns. Training avgRank improving while validation avgRank
 * stalls or worsens is the actual signal that further generations have stopped generalizing and started
 * memorizing -- watch for that divergence rather than assuming more generations is strictly better.
 *
 * Usage: node tools/train_from_human_replay.js <moreGenerations> <populationSize> <outputDir>
 *          [--seed-genome=<path>]... [--resume=<previousOutputDir>]
 *          <replayJsonPath>[=playerId] [val:replayJsonPath[=playerId]...]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { getLevel } = require('../src/ai/levels');
const { MoveGenerator } = require('../src/ai/move-generator');
const { applyInPlace } = require('../src/ai/simulator');
const { mutateGenomePercent, crossoverGenome } = require('../src/ai/ga');
const turnFlow = require('../src/turn-flow');
const rng = require('../src/rng');
const { candidatesForBothContexts, reconstructDecision } = require('./lib/replay_reconstruction');
const { evaluateFitness } = require('./lib/human_replay_scoring');
const { loadSeedGenome } = require('./lib/genome_io');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'train_from_human_replay_worker.js');
const DEFAULT_PLAYER_ID = 'P1'; // default when a replay arg omits an explicit =playerId suffix
const AI_LEVEL = 'LV4';
const ROUNDS_TO_USE = [3, 4];
// 2026-09-11, per user request ("並列でお願い" / "いくつ並列にするかはお任せ") after a timing test showed
// 81s/generation single-threaded at population=100 (1000 generations would've taken ~22.5h) -- same
// core-count convention as ga_train.js's own WORKER_COUNT (leaves 2 cores free for the OS/this session).
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

// Same constants/style as tools/ga_train.js's own --seed-real path, for consistency.
const MUTATION_RATE = 0.1;
const MUTATION_PERCENT = 0.2;
const BIG_MUTATION_CHANCE = 0.1;
const BIG_MUTATION_PERCENT = 0.3;
const ELITE_FRACTION = 0.2;
const CROSSOVER_CHANCE = 0.3; // fraction of non-elite offspring built by crossing two elite parents before mutating, rather than mutating a single parent

function parseArgs() {
  const seedGenomePaths = [];
  let resumeFromDir = null;
  const positional = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--seed-genome=')) seedGenomePaths.push(arg.slice('--seed-genome='.length));
    else if (arg.startsWith('--resume=')) resumeFromDir = path.resolve(arg.slice('--resume='.length));
    else positional.push(arg);
  }
  const [genArg, popArg, outDirArg, ...replaySpecs] = positional;
  const generations = Number(genArg);
  const populationSize = Number(popArg);
  if (!Number.isInteger(generations) || generations < 1 || !Number.isInteger(populationSize) || populationSize < 2 || !outDirArg || replaySpecs.length === 0) {
    console.error('Usage: node tools/train_from_human_replay.js <moreGenerations> <populationSize> <outputDir> [--seed-genome=<path>]... [--resume=<previousOutputDir>] <replayJsonPath>[=playerId] [val:replayJsonPath[=playerId]...]');
    process.exit(1);
  }
  // Split on the LAST '=' -- a Windows replay path never contains '=', so this is unambiguous, and
  // matches every path this tool has actually been called with so far (no need to escape anything).
  const replays = replaySpecs.map((spec) => {
    const isValidation = spec.startsWith('val:');
    const rest = isValidation ? spec.slice('val:'.length) : spec;
    const eq = rest.lastIndexOf('=');
    return eq === -1
      ? { path: rest, playerId: DEFAULT_PLAYER_ID, isValidation }
      : { path: rest.slice(0, eq), playerId: rest.slice(eq + 1), isValidation };
  });
  return { generations, populationSize, outputDir: path.resolve(outDirArg), replays, seedGenomePaths, resumeFromDir };
}

/** Walks one replay file, reconstructing every ROUNDS_TO_USE-round TURN decision `playerId` actually made
 * (see tools/lib/replay_reconstruction.js's reconstructDecision for how -- notably, a placement that
 * opens a BUILD candidate choice is correctly treated as ONE decision spanning multiple replay steps, not
 * mistaken for "placed and declined to build", which was never actually possible), and returns each as
 * {resultStates: GameState[], humanIndex: number} -- resultStates[humanIndex] is what actually happened;
 * every other entry is a legal alternative the human didn't take. Move application happens here, ONCE,
 * regardless of how many generations/genomes will later re-score these same states. */
function extractDecisionPoints(replayPath, moveGenerator, index, playerId) {
  const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
  const decisionPoints = [];
  let reconstructed = 0;
  let skipped = 0;
  let i = 0;
  while (i < replay.length - 1) {
    const state = replay[i];
    if (state.phase === 'GAME_END') break;
    if (!ROUNDS_TO_USE.includes(state.round)) { i++; continue; }
    let next;
    try { next = turnFlow.getNextTurn(state); } catch (e) { i++; continue; }
    if (next.type !== 'TURN' || next.playerId !== playerId) { i++; continue; }

    const matched = reconstructDecision(replay, i, moveGenerator, index, playerId);
    if (!matched) { skipped++; i++; continue; }
    reconstructed++;
    i += matched.consumedSteps;

    // Re-applies every candidate under the SAME context the matched move actually used, to build the
    // full sibling result-state list this decision gets ranked against (reconstructDecision itself only
    // returns the winning move, not every alternative's own resulting state).
    const sameContextCandidates = candidatesForBothContexts(moveGenerator, state, index, playerId).filter((c) => c.hasPlacedDieThisTurn === matched.hasPlacedDieThisTurn);
    const resultStates = [];
    let humanIndex = -1;
    for (const candidate of sameContextCandidates) {
      const clone = structuredClone(state);
      const result = applyInPlace(clone, index, candidate.move);
      if (!result.success) continue;
      if (JSON.stringify(candidate.move) === JSON.stringify(matched.move)) humanIndex = resultStates.length;
      resultStates.push(clone);
    }
    decisionPoints.push({ resultStates, humanIndex, round: state.round, playerId });
  }
  return { decisionPoints, reconstructed, skipped };
}

/** Splits `allDecisionPoints` into `count` contiguous, roughly-equal-length slices (by decision-point
 * COUNT, not by each one's own candidate-count -- good enough load-balancing for a near-linear speedup;
 * see createWorkerPool's own doc for why an even split even matters here). */
function partitionDecisionPoints(allDecisionPoints, count) {
  const sliceSize = Math.ceil(allDecisionPoints.length / count);
  const slices = [];
  for (let i = 0; i < count; i++) slices.push(allDecisionPoints.slice(i * sliceSize, (i + 1) * sliceSize));
  return slices.filter((s) => s.length > 0);
}

/** Spawns one persistent tools/train_from_human_replay_worker.js thread per slice of
 * `decisionPointSlices`, each permanently bound (via workerData) to its own slice for its whole lifetime
 * -- unlike ga_train.js's pool (tools/ga_worker.js, where any worker can run any job), a worker here holds
 * data no other worker has, so requests can't be load-balanced across idle workers the way ga_train.js's
 * greedy queue does; see runOnEveryWorker below for the resulting simpler "broadcast to everyone, wait for
 * everyone" protocol this shape calls for instead. */
function createWorkerPool(decisionPointSlices, aiLevel) {
  return decisionPointSlices.map((decisionPointsSlice) => new Worker(WORKER_SCRIPT, { workerData: { aiLevel, decisionPointsSlice } }));
}

function terminateWorkerPool(pool) {
  for (const worker of pool) worker.terminate();
}

/** Sends `payload` to EVERY worker in `pool` and resolves once every one of them has replied exactly
 * once, as an array in pool order (not ga_train.js's dynamic job-queue pattern -- see createWorkerPool's
 * own doc on why that doesn't apply here: every worker must answer its own request, none can be skipped
 * or handed to a different free worker). */
function runOnEveryWorker(pool, payload) {
  return Promise.all(pool.map((worker) => new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.postMessage(payload);
  })));
}

/** Scores every genome in `population` against the FULL (unpartitioned) decisionPoints set by fanning the
 * population out to every worker in `pool` (each holding one slice) and summing each genome's
 * rankSum/top1Count across every worker's reply before dividing by `totalDecisionPointCount` -- see
 * lib/human_replay_scoring.js's own doc on why summing raw counts first, not averaging each worker's own
 * avgRank, is the correct way to combine partial slices. */
async function scorePopulationOnPool(pool, population, totalDecisionPointCount) {
  const workerReplies = await runOnEveryWorker(pool, { genomes: population });
  return population.map((_, i) => {
    let rankSum = 0;
    let top1Count = 0;
    for (const reply of workerReplies) {
      rankSum += reply.results[i].rankSum;
      top1Count += reply.results[i].top1Count;
    }
    return { avgRank: rankSum / totalDecisionPointCount, top1Rate: top1Count / totalDecisionPointCount };
  });
}

async function main() {
  const { generations, populationSize, outputDir, replays, seedGenomePaths, resumeFromDir } = parseArgs();
  fs.mkdirSync(outputDir, { recursive: true });

  const resumeData = resumeFromDir ? {
    population: JSON.parse(fs.readFileSync(path.join(resumeFromDir, 'final_population.json'), 'utf8')),
    best: JSON.parse(fs.readFileSync(path.join(resumeFromDir, 'best_genome.json'), 'utf8')),
  } : null;
  const startGen = resumeData ? resumeData.population.generation : 0;
  if (resumeData) console.log(`Resuming from ${resumeFromDir} (generation ${startGen}, best-ever avgRank=${resumeData.best.avgRank.toFixed(2)}) -- running ${generations} more generation(s), through generation ${startGen + generations}.\n`);

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const realTable = buildEvalTable(raw);
  const level = getLevel(AI_LEVEL);
  const moveGenerator = new MoveGenerator(level.moveGeneratorOptions);

  const anchors = [{ label: 'game.xlsx(real table)', genome: realTable }, ...seedGenomePaths.map(loadSeedGenome)];
  fs.writeFileSync(path.join(outputDir, 'anchors.json'), JSON.stringify(anchors.map((a, i) => ({ index: i, label: a.label })), null, 2));

  console.log(`Extracting round ${ROUNDS_TO_USE.join('/')} decision points from ${replays.length} replay file(s)...`);
  let allDecisionPoints = [];
  let valDecisionPoints = [];
  let totalReconstructed = 0;
  let totalSkipped = 0;
  for (const { path: replayPath, playerId, isValidation } of replays) {
    const { decisionPoints, reconstructed, skipped } = extractDecisionPoints(replayPath, moveGenerator, index, playerId);
    console.log(`  ${path.basename(replayPath)} (${playerId}${isValidation ? ', VALIDATION -- held out of training' : ''}): ${reconstructed} reconstructed, ${skipped} skipped`);
    if (isValidation) valDecisionPoints = valDecisionPoints.concat(decisionPoints);
    else allDecisionPoints = allDecisionPoints.concat(decisionPoints);
    totalReconstructed += reconstructed;
    totalSkipped += skipped;
  }
  console.log(`Total: ${totalReconstructed} decision points (${totalSkipped} skipped) -- ${allDecisionPoints.length} training, ${valDecisionPoints.length} validation (held out), by round: ${ROUNDS_TO_USE.map((r) => `${r}R=${allDecisionPoints.filter((d) => d.round === r).length + valDecisionPoints.filter((d) => d.round === r).length}`).join(', ')}`);
  if (allDecisionPoints.length === 0) {
    console.error('No training decision points extracted -- nothing to train on.');
    process.exit(1);
  }
  if (valDecisionPoints.length === 0) {
    console.log('(No val: replay given -- overfitting can\'t be detected this run; see this file\'s own doc on why that matters.)');
  }

  const runId = Date.now();
  const runRng = rng.createRng(`train-from-human-${runId}`);
  const mutate = (genome) => mutateGenomePercent(genome, runRng, MUTATION_RATE, MUTATION_PERCENT, BIG_MUTATION_CHANCE, BIG_MUTATION_PERCENT);
  const pickTwoDistinct = (arr) => {
    const i = Math.floor(rng.next(runRng) * arr.length);
    let j = Math.floor(rng.next(runRng) * arr.length);
    while (j === i && arr.length > 1) j = Math.floor(rng.next(runRng) * arr.length);
    return [arr[i], arr[j]];
  };
  const withAnchor = (pop) => { const result = pop.slice(); anchors.forEach((a, i) => { result[i] = a.genome; }); return result; };
  const anchorStrs = anchors.map((a) => JSON.stringify(a.genome));

  console.log('');
  for (const a of anchors) {
    const f = evaluateFitness(a.genome, allDecisionPoints, index, level);
    const valPart = valDecisionPoints.length > 0 ? `, VAL avgRank=${evaluateFitness(a.genome, valDecisionPoints, index, level).avgRank.toFixed(2)}` : '';
    console.log(`Anchor ${a.label} on this human data: avgRank=${f.avgRank.toFixed(2)} (of ~${(allDecisionPoints.reduce((s, d) => s + d.resultStates.length, 0) / allDecisionPoints.length).toFixed(0)} candidates/decision avg), top1Rate=${(f.top1Rate * 100).toFixed(1)}%${valPart}`);
  }

  const decisionPointSlices = partitionDecisionPoints(allDecisionPoints, WORKER_COUNT);
  const pool = createWorkerPool(decisionPointSlices, AI_LEVEL);
  console.log(`\nWorker pool: ${pool.length} threads (this machine has ${os.cpus().length} CPU cores), ${decisionPointSlices.map((s) => s.length).join('+')} decision points per slice.`);

  try {
    // Initial population: each slot either mutates a single randomly-picked anchor, or (CROSSOVER_CHANCE
    // of the time, only when >=2 anchors exist) mutates a crossover of two distinct anchors -- explores
    // both anchors' own neighborhoods and their combinations, not just the real table's. Skipped entirely
    // when resuming -- the resumed population already IS the evolved starting point.
    const seedIndividual = () => {
      if (anchors.length >= 2 && rng.next(runRng) < CROSSOVER_CHANCE) {
        const [a, b] = pickTwoDistinct(anchors);
        return mutate(crossoverGenome(a.genome, b.genome, runRng));
      }
      return mutate(anchors[Math.floor(rng.next(runRng) * anchors.length)].genome);
    };
    let population = resumeData
      ? withAnchor(resumeData.population.population.map((p) => p.genome))
      : withAnchor(Array.from({ length: populationSize }, seedIndividual));
    // bestEver starts from the RESUMED run's own best_genome.json, not Infinity -- a genome can drop out of
    // the population via elitism-vs-newer-mutants without ever having been beaten (see this file's own
    // top-of-file doc on --resume), so best_genome.json is the only thing that reliably survives a resume.
    let bestEver = resumeData ? { avgRank: resumeData.best.avgRank, top1Rate: resumeData.best.top1Rate, genome: resumeData.best.genome } : { avgRank: Infinity };
    const progressCsvPath = path.join(outputDir, 'progress.csv');
    const anchorCsvCols = anchors.map((_, i) => `anchor${i}_avg_rank,anchor${i}_top1_rate`).join(',');
    const valCsvCols = valDecisionPoints.length > 0 ? ',best_val_avg_rank,best_val_top1_rate' : '';
    if (!(resumeData && fs.existsSync(progressCsvPath))) fs.writeFileSync(progressCsvPath, `generation,best_avg_rank,best_top1_rate,${anchorCsvCols}${valCsvCols}\n`);

    const finalGen = startGen + generations;
    let lastRanked = null;
    for (let gen = startGen + 1; gen <= finalGen; gen++) {
      const t0 = Date.now();
      const fitness = await scorePopulationOnPool(pool, population, allDecisionPoints.length);
      const ranked = fitness.map((f, i) => ({ ...f, genome: population[i] })).sort((a, b) => a.avgRank - b.avgRank);
      lastRanked = ranked;
      const anchorRanked = anchorStrs.map((str) => ranked.find((r) => JSON.stringify(r.genome) === str));
      // Cheap (one genome, main thread only, never used for selection) -- see this file's own top-of-file
      // doc on why watching this drift apart from training avgRank is the actual overfitting signal.
      const valFitness = valDecisionPoints.length > 0 ? evaluateFitness(ranked[0].genome, valDecisionPoints, index, level) : null;

      const anchorLogParts = anchors.map((a, i) => anchorRanked[i] ? `${a.label} avgRank=${anchorRanked[i].avgRank.toFixed(2)}` : null).filter(Boolean);
      const valLogPart = valFitness ? `, VAL avgRank=${valFitness.avgRank.toFixed(2)} (top1Rate=${(valFitness.top1Rate * 100).toFixed(1)}%)` : '';
      console.log(`Generation ${gen}/${finalGen}: best avgRank=${ranked[0].avgRank.toFixed(2)} (top1Rate=${(ranked[0].top1Rate * 100).toFixed(1)}%)${valLogPart}${anchorLogParts.length ? `, ${anchorLogParts.join(', ')}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      const anchorCsvVals = anchorRanked.map((r) => `${r ? r.avgRank.toFixed(3) : ''},${r ? r.top1Rate.toFixed(3) : ''}`).join(',');
      const valCsvVals = valFitness ? `,${valFitness.avgRank.toFixed(3)},${valFitness.top1Rate.toFixed(3)}` : '';
      fs.appendFileSync(progressCsvPath, `${gen},${ranked[0].avgRank.toFixed(3)},${ranked[0].top1Rate.toFixed(3)},${anchorCsvVals}${valCsvVals}\n`);

      if (ranked[0].avgRank < bestEver.avgRank) {
        bestEver = ranked[0];
        fs.writeFileSync(path.join(outputDir, 'best_genome.json'), JSON.stringify({ generation: gen, avgRank: bestEver.avgRank, top1Rate: bestEver.top1Rate, genome: bestEver.genome }, null, 2));
      }
      if (gen === finalGen) break;

      const eliteCount = Math.max(1, Math.round(populationSize * ELITE_FRACTION));
      const elites = ranked.slice(0, eliteCount).map((r) => r.genome);
      const nextPopulation = elites.slice();
      while (nextPopulation.length < populationSize) {
        if (elites.length >= 2 && rng.next(runRng) < CROSSOVER_CHANCE) {
          const [a, b] = pickTwoDistinct(elites);
          nextPopulation.push(mutate(crossoverGenome(a, b, runRng)));
        } else {
          const parent = elites[Math.floor(rng.next(runRng) * elites.length)];
          nextPopulation.push(mutate(parent));
        }
      }
      population = withAnchor(nextPopulation);
    }

    // Written every run (2026-09-11, for --resume) so a follow-up invocation can continue from the exact
    // evaluated population this run ended with, not just its single best individual.
    fs.writeFileSync(path.join(outputDir, 'final_population.json'), JSON.stringify({
      generation: finalGen,
      population: lastRanked.map((r) => ({ genome: r.genome, avgRank: r.avgRank, top1Rate: r.top1Rate })),
    }, null, 2));

    console.log(`\nDone. Best genome (avgRank=${bestEver.avgRank.toFixed(2)}, top1Rate=${(bestEver.top1Rate * 100).toFixed(1)}%) written to ${path.join(outputDir, 'best_genome.json')}`);
  } finally {
    terminateWorkerPool(pool);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
