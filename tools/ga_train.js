/**
 * "AI LV4" genetic-algorithm training (2026-08-27, per user request: "完全ランダムウォークから第一世代
 * 第二世代という風に進化させていく方式でAIを作りたい"). Evolves a full 評価値-shaped eval-table (see
 * src/ai/ga.js's own doc: {1:{id:value},2:{...},3:{...},4:{...}}, exactly eval-table.js's own
 * buildEvalTable() shape) from scratch via self-play fitness, no hand-tuned starting point.
 *
 * Design (agreed with the user across a design discussion, 2026-08-27):
 *  - "Generation 0" is a one-time baseline measurement only: every seat uses RandomEvaluator (see
 *    random-evaluator.js) -- a genuinely knowledge-free policy that picks uniformly among every legal
 *    move MoveGenerator offers, free actions included ("フリーアクションを考慮するかどうか" ->
 *    "含めるほうで"). There is no eval-table to mutate FROM this baseline, so it is measured once for
 *    comparison and never fed into the real population.
 *  - Generation 1 is a fresh population of genomes, each independently randomly-initialized (see
 *    src/ai/ga.js's randomGenome) -- this, not Generation 0, is where the real evolving population starts.
 *  - Fitness per generation: shuffle the population, split into groups of 4, play GAMES_PER_INDIVIDUAL
 *    such shuffles' worth of games (so every individual gets ~GAMES_PER_INDIVIDUAL games), average FINAL
 *    RANK (1-4, lower is better) per individual across all its games -- rank rather than raw score, since
 *    raw score varies a lot game-to-game (card availability, dice luck) in ways unrelated to genome
 *    quality, while relative placement against 3 same-generation opponents is a steadier signal.
 *  - Selection: top ELITE_FRACTION of the population (by lowest avg rank) survive unchanged into the next
 *    generation; every remaining slot is a mutated copy (src/ai/ga.js's mutateGenome) of a uniformly
 *    random elite parent. No crossover in this first pass -- kept simple deliberately; can be added later
 *    if plain mutation converges too slowly.
 *  - No lookahead during training (every seat's AIPlayer uses its default lookaheadExtraTurns:0/"LV1"
 *    equivalent) -- training is meant to evolve the SCORING function first; search depth is a separate,
 *    later concern once a good evaluator exists (agreed with the user: keeps each training game cheap).
 *
 * Checkpointing: every generation's full population + fitness stats are written to
 * <outputDir>/gen_XXXX.json (so a run can be inspected or resumed by hand), and the single best-ever
 * genome is always (over)written to <outputDir>/best_genome.json -- this is the file whose shape can be
 * pasted directly into game.xlsx's 評価値 sheet if it ever outperforms the hand-tuned table.
 *
 * Usage: node tools/ga_train.js <generations> [populationSize] [gamesPerIndividual] [outputDir] [resumeFromDir]
 * Population size must be a multiple of 4 (one game = 4 seats, no partial/refilled groups).
 *
 * resumeFromDir (2026-08-27, per user request: "今日の18：00より前にすべて終わったら追加で50世代づつ増や
 * して"): an existing run's output directory whose highest-numbered gen_XXXX.json becomes THIS run's
 * starting population (instead of a fresh random one), and whose generation number this run's own
 * numbering continues from -- e.g. resuming a finished 150-generation run for another 50 writes
 * gen_0151..gen_0200 into outputDir (which may be the same directory, to extend it in place, or a new
 * one to branch off). populationSize is ignored when resuming (the resumed population's own size is
 * used); Generation-0's baseline is skipped (the pure-random baseline never changes run to run, so
 * there's nothing new to measure).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { randomGenome, mutateGenome } = require('../src/ai/ga');
const { RandomEvaluator } = require('../src/ai/random-evaluator');
const { Evaluator } = require('../src/ai/evaluator');
const { playGameForFitness } = require('../src/ai/game-runner');
const rng = require('../src/rng');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

const RANDOM_INIT_MIN = -10;
const RANDOM_INIT_MAX = 10;
const MUTATION_RATE = 0.1; // per-(round,id) probability of being nudged each generation
const MUTATION_AMOUNT = 2; // max +/- nudge when mutated
const ELITE_FRACTION = 0.2; // top fraction of the population carried over unchanged each generation
const BASELINE_GAMES = 20; // one-time Generation-0 (pure random) measurement sample size

function parseArgs() {
  const generations = Number(process.argv[2]);
  const populationSize = process.argv[3] ? Number(process.argv[3]) : 20;
  const gamesPerIndividual = process.argv[4] ? Number(process.argv[4]) : 4;
  const outputDir = process.argv[5] ? path.resolve(process.argv[5]) : path.join(PROJECT_ROOT, 'output', 'ga_train');
  const resumeFromDir = process.argv[6] ? path.resolve(process.argv[6]) : null;
  if (!Number.isInteger(generations) || generations < 1) {
    console.error('Usage: node tools/ga_train.js <generations> [populationSize] [gamesPerIndividual] [outputDir] [resumeFromDir]');
    process.exit(1);
  }
  if (!Number.isInteger(populationSize) || populationSize < 4 || populationSize % 4 !== 0) {
    console.error('populationSize must be a positive multiple of 4 (one game = 4 seats).');
    process.exit(1);
  }
  if (!Number.isInteger(gamesPerIndividual) || gamesPerIndividual < 1) {
    console.error('gamesPerIndividual must be a positive integer.');
    process.exit(1);
  }
  return { generations, populationSize, gamesPerIndividual, outputDir, resumeFromDir };
}

/** Reads resumeFromDir's highest-numbered gen_XXXX.json (see parseArgs' own doc on resumeFromDir) and
 * returns {startGeneration, population} -- startGeneration is that file's own generation number (this
 * run's numbering continues from startGeneration+1), population is its genomes in ranked order. */
function loadResumePopulation(resumeFromDir) {
  const files = fs.readdirSync(resumeFromDir).filter((f) => /^gen_\d{4}\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No gen_XXXX.json files found in ${resumeFromDir} to resume from`);
  const { generation, population } = JSON.parse(fs.readFileSync(path.join(resumeFromDir, files[files.length - 1]), 'utf8'));
  return { startGeneration: generation, population: population.map((p) => p.genome) };
}

/** Plays enough games (population shuffled into groups of 4, repeated gamesPerIndividual times) that
 * every individual in `population` (an array of genomes) gets exactly gamesPerIndividual games, and
 * returns each individual's {avgRank, avgScore, gamesPlayed} by its index into `population`. */
function evaluatePopulationFitness(population, index, runRng, gamesPerIndividual, runId, generationLabel) {
  const rankSumByIndex = new Array(population.length).fill(0);
  const scoreSumByIndex = new Array(population.length).fill(0);
  const gamesPlayedByIndex = new Array(population.length).fill(0);
  const evaluators = population.map((genome) => new Evaluator(index, genome));

  let gameCount = 0;
  for (let round = 0; round < gamesPerIndividual; round++) {
    const order = rng.shuffle(runRng, population.map((_, i) => i));
    for (let g = 0; g < order.length; g += 4) {
      const seatIndices = order.slice(g, g + 4);
      const evaluatorByPlayerId = {};
      seatIndices.forEach((idx, seat) => { evaluatorByPlayerId[`P${seat + 1}`] = evaluators[idx]; });
      const seed = `ga-${runId}-${generationLabel}-${gameCount}`;
      gameCount++;
      const { rankByPlayerId, scoreByPlayerId } = playGameForFitness(seed, PLAYER_NAMES, index, evaluatorByPlayerId);
      seatIndices.forEach((idx, seat) => {
        const playerId = `P${seat + 1}`;
        rankSumByIndex[idx] += rankByPlayerId[playerId];
        scoreSumByIndex[idx] += scoreByPlayerId[playerId];
        gamesPlayedByIndex[idx]++;
      });
    }
  }

  return population.map((genome, i) => ({
    avgRank: rankSumByIndex[i] / gamesPlayedByIndex[i],
    avgScore: scoreSumByIndex[i] / gamesPlayedByIndex[i],
    gamesPlayed: gamesPlayedByIndex[i],
  }));
}

function measureBaseline(index, runRng, runId) {
  const rankSum = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const scoreSum = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const evaluatorByPlayerId = { P1: new RandomEvaluator(), P2: new RandomEvaluator(), P3: new RandomEvaluator(), P4: new RandomEvaluator() };
  for (let i = 0; i < BASELINE_GAMES; i++) {
    const seed = `ga-${runId}-gen0-${i}`;
    const { rankByPlayerId, scoreByPlayerId } = playGameForFitness(seed, PLAYER_NAMES, index, evaluatorByPlayerId);
    for (const playerId of Object.keys(rankSum)) {
      rankSum[playerId] += rankByPlayerId[playerId];
      scoreSum[playerId] += scoreByPlayerId[playerId];
    }
  }
  const avgRank = Object.values(rankSum).reduce((a, b) => a + b, 0) / (BASELINE_GAMES * 4);
  const avgScore = Object.values(scoreSum).reduce((a, b) => a + b, 0) / (BASELINE_GAMES * 4);
  return { avgRank, avgScore, games: BASELINE_GAMES };
}

function main() {
  const { generations, populationSize, gamesPerIndividual, outputDir, resumeFromDir } = parseArgs();
  fs.mkdirSync(outputDir, { recursive: true });

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const ids = Object.keys(buildEvalTable(raw)[1]);

  const runId = Date.now();
  const runRng = rng.createRng(`ga-run-${runId}`);

  let population;
  let startGeneration;
  let bestEver = { avgRank: Infinity };
  if (resumeFromDir) {
    const resumed = loadResumePopulation(resumeFromDir);
    population = resumed.population;
    startGeneration = resumed.startGeneration;
    console.log(`Resuming from ${resumeFromDir} at generation ${startGeneration} (population size ${population.length}) for ${generations} more generations.`);
  } else {
    console.log(`Generation 0 baseline (pure random, no eval-table, ${BASELINE_GAMES} games)...`);
    const baseline = measureBaseline(index, runRng, runId);
    console.log(`  avgRank=${baseline.avgRank.toFixed(2)} avgScore=${baseline.avgScore.toFixed(1)}`);
    fs.writeFileSync(path.join(outputDir, 'gen_0000_baseline.json'), JSON.stringify(baseline, null, 2));
    population = Array.from({ length: populationSize }, () => randomGenome(ids, runRng, RANDOM_INIT_MIN, RANDOM_INIT_MAX));
    startGeneration = 0;
  }
  const finalGeneration = startGeneration + generations;

  for (let gen = startGeneration + 1; gen <= finalGeneration; gen++) {
    const t0 = Date.now();
    const fitness = evaluatePopulationFitness(population, index, runRng, gamesPerIndividual, runId, gen);
    const ranked = fitness
      .map((f, i) => ({ ...f, genome: population[i] }))
      .sort((a, b) => a.avgRank - b.avgRank);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Generation ${gen}/${finalGeneration}: best avgRank=${ranked[0].avgRank.toFixed(2)} (avgScore=${ranked[0].avgScore.toFixed(1)}), worst avgRank=${ranked[ranked.length - 1].avgRank.toFixed(2)} (${elapsed}s)`);

    fs.writeFileSync(
      path.join(outputDir, `gen_${String(gen).padStart(4, '0')}.json`),
      JSON.stringify({ generation: gen, population: ranked.map(({ genome, avgRank, avgScore, gamesPlayed }) => ({ genome, avgRank, avgScore, gamesPlayed })) }, null, 2)
    );

    if (ranked[0].avgRank < bestEver.avgRank) {
      bestEver = ranked[0];
      fs.writeFileSync(path.join(outputDir, 'best_genome.json'), JSON.stringify({ generation: gen, avgRank: bestEver.avgRank, avgScore: bestEver.avgScore, genome: bestEver.genome }, null, 2));
    }

    if (gen === finalGeneration) break; // no need to breed a generation nobody will evaluate

    // population.length (not the CLI populationSize arg) is authoritative -- when resuming, the resumed
    // population's own size governs, and the CLI arg is documented as ignored in that case.
    const currentPopulationSize = population.length;
    const eliteCount = Math.max(1, Math.round(currentPopulationSize * ELITE_FRACTION));
    const elites = ranked.slice(0, eliteCount).map((r) => r.genome);
    const nextPopulation = elites.slice();
    while (nextPopulation.length < currentPopulationSize) {
      const parent = elites[Math.floor(rng.next(runRng) * elites.length)];
      nextPopulation.push(mutateGenome(parent, runRng, MUTATION_RATE, MUTATION_AMOUNT));
    }
    population = nextPopulation;
  }

  console.log(`Done. Best genome (avgRank=${bestEver.avgRank.toFixed(2)}) written to ${path.join(outputDir, 'best_genome.json')}`);
}

main();
