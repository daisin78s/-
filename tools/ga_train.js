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
const { execFileSync } = require('child_process');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { randomGenome, mutateGenome, mutateGenomePercent } = require('../src/ai/ga');
const { RandomEvaluator } = require('../src/ai/random-evaluator');
const { Evaluator } = require('../src/ai/evaluator');
const { playGameForFitness } = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const rng = require('../src/rng');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];
const PROGRESS_XLSX_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ga_progress_to_xlsx.py');

const RANDOM_INIT_MIN = -10;
const RANDOM_INIT_MAX = 10;
const MUTATION_RATE = 0.1; // per-(round,id) probability of being nudged each generation
const MUTATION_AMOUNT = 2; // max +/- nudge when mutated (randomGenome-seeded runs only, see mutate() below)
const MUTATION_PERCENT = 0.2; // max +/-20% nudge when mutated (--seed-real runs only, see mutate() below)
const ELITE_FRACTION = 0.2; // top fraction of the population carried over unchanged each generation
const BASELINE_GAMES = 20; // one-time Generation-0 (pure random) measurement sample size

/** --seed-real (2026-09-04, per user request: "それを０からやると時間がかかるので　今ある評価値から進め
 * たらどうかと思う") -- a bare flag, not tied to a positional slot, so it can be dropped in anywhere on
 * the command line without shifting generations/populationSize/etc. When present, Generation 1's initial
 * population is small mutations of the REAL current game.xlsx 評価値 table (via mutateGenomePercent, see
 * its own doc) instead of randomGenome's uniform-random spread -- lets a run start from an already-
 * competitive point rather than pure noise. Incompatible with resumeFromDir (that already supplies its
 * own starting population from a previous run). */
const SEED_REAL_FLAG = '--seed-real';

function parseArgs() {
  const positional = process.argv.slice(2).filter((arg) => arg !== SEED_REAL_FLAG);
  const seedFromReal = process.argv.includes(SEED_REAL_FLAG);
  const generations = Number(positional[0]);
  const populationSize = positional[1] ? Number(positional[1]) : 20;
  const gamesPerIndividual = positional[2] ? Number(positional[2]) : 4;
  const outputDir = positional[3] ? path.resolve(positional[3]) : path.join(PROJECT_ROOT, 'output', 'ga_train');
  const resumeFromDir = positional[4] ? path.resolve(positional[4]) : null;
  if (!Number.isInteger(generations) || generations < 1) {
    console.error('Usage: node tools/ga_train.js <generations> [populationSize] [gamesPerIndividual] [outputDir] [resumeFromDir] [--seed-real]');
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
  if (seedFromReal && resumeFromDir) {
    console.error('--seed-real and resumeFromDir are mutually exclusive (resumeFromDir already supplies its own starting population).');
    process.exit(1);
  }
  return { generations, populationSize, gamesPerIndividual, outputDir, resumeFromDir, seedFromReal };
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
 * returns each individual's {avgRank, avgScore, avgRawScore, avgQstScore, winRate, gamesPlayed} by its
 * index into `population` -- winRate (2026-09-04, per user request: "勝率...を出してほしい") is the
 * fraction of its own games where it finished rank 1 (ties broken the same way turn-flow's own ranking
 * always has been, so "rank 1" here means sole 1st place, same convention historyByPlayerId.rank uses
 * elsewhere in this codebase). avgRawScore/avgQstScore (2026-09-04, per user request: "平均点（素点と
 * QSTも）", same 合計/素点/クエスト split tools/ga_report_top.js already reports) split avgScore into
 * QST's own contribution and everything else -- playGameForFitness's own qstScoreByPlayerId already
 * carries this, previously only read by ga_report_top.js's separate post-hoc replay, now captured
 * directly during training too so it's available every generation without a second replay pass.
 * resourceCardPicker/synergyTable2 (2026-08-27, "AI LV4"'s own smart onboarding, see
 * smart-onboarding.js's own doc) are passed straight through to playGameForFitness so every training
 * game already uses the same JOB/CON/resource-card selection LV4 actually plays with. */
function evaluatePopulationFitness(population, index, runRng, gamesPerIndividual, runId, generationLabel, resourceCardPicker, synergyTable2) {
  const rankSumByIndex = new Array(population.length).fill(0);
  const scoreSumByIndex = new Array(population.length).fill(0);
  const qstScoreSumByIndex = new Array(population.length).fill(0);
  const winCountByIndex = new Array(population.length).fill(0);
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
      const { rankByPlayerId, scoreByPlayerId, qstScoreByPlayerId } = playGameForFitness(seed, PLAYER_NAMES, index, evaluatorByPlayerId, undefined, resourceCardPicker, synergyTable2);
      seatIndices.forEach((idx, seat) => {
        const playerId = `P${seat + 1}`;
        rankSumByIndex[idx] += rankByPlayerId[playerId];
        scoreSumByIndex[idx] += scoreByPlayerId[playerId];
        qstScoreSumByIndex[idx] += qstScoreByPlayerId[playerId] || 0;
        if (rankByPlayerId[playerId] === 1) winCountByIndex[idx]++;
        gamesPlayedByIndex[idx]++;
      });
    }
  }

  return population.map((genome, i) => ({
    avgRank: rankSumByIndex[i] / gamesPlayedByIndex[i],
    avgScore: scoreSumByIndex[i] / gamesPlayedByIndex[i],
    avgQstScore: qstScoreSumByIndex[i] / gamesPlayedByIndex[i],
    avgRawScore: (scoreSumByIndex[i] - qstScoreSumByIndex[i]) / gamesPlayedByIndex[i],
    winRate: winCountByIndex[i] / gamesPlayedByIndex[i],
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

/** --seed-real's own reference measurement (2026-09-04, per user request, see parseArgs' own doc on
 * SEED_REAL_FLAG): plays the REAL, unmutated current game.xlsx 評価値 table against 4 copies of itself
 * (same "AI LV4" onboarding as every other game in a --seed-real run, via resourceCardPicker/
 * synergyTable2) for BASELINE_GAMES games, so there's a concrete "before" number to compare every
 * evolved generation's own avgScore against. avgRank is trivially ~2.5 here (all 4 seats are equally
 * strong copies of the same table) -- not a bug, just not a meaningful signal on its own; avgScore is
 * the actually comparable number. (avgRank *within* a later generation is still meaningful there, since
 * it's relative to that generation's own sibling population -- it's only a cross-generation/cross-this-
 * baseline comparison that rank can't support, unlike score.) */
function measureRealTableBaseline(index, realGenome, runRng, runId, resourceCardPicker, synergyTable2) {
  const rankSum = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const scoreSum = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const winCount = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const evaluator = new Evaluator(index, realGenome);
  const evaluatorByPlayerId = { P1: evaluator, P2: evaluator, P3: evaluator, P4: evaluator };
  for (let i = 0; i < BASELINE_GAMES; i++) {
    const seed = `ga-${runId}-realbaseline-${i}`;
    const { rankByPlayerId, scoreByPlayerId } = playGameForFitness(seed, PLAYER_NAMES, index, evaluatorByPlayerId, undefined, resourceCardPicker, synergyTable2);
    for (const playerId of Object.keys(rankSum)) {
      rankSum[playerId] += rankByPlayerId[playerId];
      scoreSum[playerId] += scoreByPlayerId[playerId];
      if (rankByPlayerId[playerId] === 1) winCount[playerId]++;
    }
  }
  const avgRank = Object.values(rankSum).reduce((a, b) => a + b, 0) / (BASELINE_GAMES * 4);
  const avgScore = Object.values(scoreSum).reduce((a, b) => a + b, 0) / (BASELINE_GAMES * 4);
  const winRate = Object.values(winCount).reduce((a, b) => a + b, 0) / (BASELINE_GAMES * 4);
  return { avgRank, avgScore, winRate, games: BASELINE_GAMES };
}

function main() {
  const { generations, populationSize, gamesPerIndividual, outputDir, resumeFromDir, seedFromReal } = parseArgs();
  fs.mkdirSync(outputDir, { recursive: true });

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const realTable = buildEvalTable(raw);
  const ids = Object.keys(realTable[1]);

  // "AI LV4" smart onboarding (2026-08-27/28, see smart-onboarding.js's own doc) -- every training game
  // from here on picks resource cards/JOB/CON the same way LV4 actually plays, not randomly. Generation
  // 0's own baseline (measureBaseline) deliberately stays fully random (RandomEvaluator's whole point is
  // zero knowledge), so these are never passed there.
  const synergyTable3 = buildResourceSynergyTable(raw);
  const synergyTable2 = buildConJobSynergyTable(raw);
  const resourceCardPicker = (candidateIds, state, idx, player) => pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

  const runId = Date.now();
  const runRng = rng.createRng(`ga-run-${runId}`);

  // Percentage-based (--seed-real) vs flat-amount (default, randomGenome-seeded) mutation -- see
  // mutateGenomePercent's own doc in src/ai/ga.js for why a flat delta doesn't work once real values
  // span 0..1000 depending on round. Used both for Generation 1's own seeding below and every later
  // generation's breeding step, so the whole run stays on one consistent mutation style throughout.
  const mutate = (genome) => (seedFromReal
    ? mutateGenomePercent(genome, runRng, MUTATION_RATE, MUTATION_PERCENT)
    : mutateGenome(genome, runRng, MUTATION_RATE, MUTATION_AMOUNT));

  // 固定アンカー (2026-09-04, per user request: "エクセルのものを一定数入れる", clarified as "毎世代、常に
  // 固定で存在させる", count=1) -- ANCHOR_COUNT slots of the population are forced to be the exact,
  // unmutated real 評価値 table every single generation, regardless of what elitism/breeding would
  // otherwise have put there. Unlike a one-time seed, this never drifts away and never gets bred from
  // (any of its own children breeding logic might otherwise produce), so its own fitness each generation
  // is a live, continuously-refreshed "is anything actually beating the real table right now" signal --
  // more direct than comparing against an isolated one-time baseline measurement, and self-correcting in
  // the same way the rest of the population is (each generation plays fresh games/opponents).
  const ANCHOR_COUNT = 1;
  const withAnchors = (pop) => {
    const result = pop.slice();
    for (let i = 0; i < ANCHOR_COUNT && i < result.length; i++) result[i] = realTable;
    return result;
  };
  const realTableStr = JSON.stringify(realTable);
  const findAnchor = (ranked) => ranked.find((r) => JSON.stringify(r.genome) === realTableStr) || null;

  // 世代ごとの進捗ログ (2026-09-04, per user request: "世代が変わるごとにデータを追加してほしい") --
  // CSV (not JSON) specifically so it opens directly in Excel like every other report this project
  // produces, one row appended per generation, never rewritten -- readable mid-run, not just at the end.
  const progressCsvPath = path.join(outputDir, 'progress.csv');
  if (!fs.existsSync(progressCsvPath)) {
    fs.writeFileSync(progressCsvPath, 'generation,best_avg_rank,best_avg_score,best_win_rate,anchor_avg_rank,anchor_avg_score,anchor_win_rate\n');
  }

  let population;
  let startGeneration;
  let bestEver = { avgRank: Infinity };
  if (resumeFromDir) {
    const resumed = loadResumePopulation(resumeFromDir);
    population = withAnchors(resumed.population);
    startGeneration = resumed.startGeneration;
    console.log(`Resuming from ${resumeFromDir} at generation ${startGeneration} (population size ${population.length}, ${ANCHOR_COUNT} anchor slot(s) (re-)inserted) for ${generations} more generations.`);
  } else if (seedFromReal) {
    console.log(`Real 評価値 table baseline (self-play, ${BASELINE_GAMES} games)...`);
    const baseline = measureRealTableBaseline(index, realTable, runRng, runId, resourceCardPicker, synergyTable2);
    console.log(`  avgScore=${baseline.avgScore.toFixed(1)} winRate=${(baseline.winRate * 100).toFixed(0)}% (avgRank=${baseline.avgRank.toFixed(2)}, trivially ~2.5/~25% here -- 4 equal copies of the same table; avgScore/winRate are the numbers worth comparing later generations against)`);
    fs.writeFileSync(path.join(outputDir, 'gen_0000_real_baseline.json'), JSON.stringify({ ...baseline, genome: realTable }, null, 2));
    population = withAnchors(Array.from({ length: populationSize }, () => mutate(realTable)));
    startGeneration = 0;
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
    const fitness = evaluatePopulationFitness(population, index, runRng, gamesPerIndividual, runId, gen, resourceCardPicker, synergyTable2);
    const ranked = fitness
      .map((f, i) => ({ ...f, genome: population[i] }))
      .sort((a, b) => a.avgRank - b.avgRank);
    const anchor = findAnchor(ranked);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const anchorSummary = anchor ? `, anchor avgRank=${anchor.avgRank.toFixed(2)} (avgScore=${anchor.avgScore.toFixed(1)}, winRate=${(anchor.winRate * 100).toFixed(0)}%)` : '';
    console.log(`Generation ${gen}/${finalGeneration}: best avgRank=${ranked[0].avgRank.toFixed(2)} (avgScore=${ranked[0].avgScore.toFixed(1)}, winRate=${(ranked[0].winRate * 100).toFixed(0)}%), worst avgRank=${ranked[ranked.length - 1].avgRank.toFixed(2)}${anchorSummary} (${elapsed}s)`);

    fs.writeFileSync(
      path.join(outputDir, `gen_${String(gen).padStart(4, '0')}.json`),
      JSON.stringify({ generation: gen, population: ranked.map(({ genome, avgRank, avgScore, avgRawScore, avgQstScore, winRate, gamesPlayed }) => ({ genome, avgRank, avgScore, avgRawScore, avgQstScore, winRate, gamesPlayed })) }, null, 2)
    );
    fs.appendFileSync(progressCsvPath, [
      gen,
      ranked[0].avgRank.toFixed(3), ranked[0].avgScore.toFixed(2), ranked[0].winRate.toFixed(3),
      anchor ? anchor.avgRank.toFixed(3) : '', anchor ? anchor.avgScore.toFixed(2) : '', anchor ? anchor.winRate.toFixed(3) : '',
    ].join(',') + '\n');

    // Excel progress report (2026-09-04, per user request: "エクセルに 1 2 3 4とシートを作り...") -- one
    // sheet per generation via tools/ga_progress_to_xlsx.py, same Node->Python subprocess pattern
    // ai_data_report.js already uses for ai_data_write.py. A small per-generation summary JSON (not the
    // full gen_XXXX.json) is all that script needs; written to a fixed, reused filename since nothing
    // else ever needs to read it back afterward.
    const summaryPath = path.join(outputDir, '_gen_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      generation: gen,
      anchor: anchor ? { avgRank: anchor.avgRank, avgScore: anchor.avgScore, avgRawScore: anchor.avgRawScore, avgQstScore: anchor.avgQstScore, winRate: anchor.winRate, gamesPlayed: anchor.gamesPlayed } : null,
      best: { avgRank: ranked[0].avgRank, avgScore: ranked[0].avgScore, avgRawScore: ranked[0].avgRawScore, avgQstScore: ranked[0].avgQstScore, winRate: ranked[0].winRate, gamesPlayed: ranked[0].gamesPlayed, genome: ranked[0].genome },
    }));
    try {
      execFileSync('python', [PROGRESS_XLSX_SCRIPT, outputDir, summaryPath], { stdio: 'pipe' });
    } catch (e) {
      console.error(`  (progress.xlsx update failed, continuing anyway: ${e.message})`);
    }

    if (ranked[0].avgRank < bestEver.avgRank) {
      bestEver = ranked[0];
      fs.writeFileSync(path.join(outputDir, 'best_genome.json'), JSON.stringify({ generation: gen, avgRank: bestEver.avgRank, avgScore: bestEver.avgScore, avgRawScore: bestEver.avgRawScore, avgQstScore: bestEver.avgQstScore, winRate: bestEver.winRate, genome: bestEver.genome }, null, 2));
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
      nextPopulation.push(mutate(parent));
    }
    population = withAnchors(nextPopulation);
  }

  console.log(`Done. Best genome (avgRank=${bestEver.avgRank.toFixed(2)}) written to ${path.join(outputDir, 'best_genome.json')}`);
}

main();
