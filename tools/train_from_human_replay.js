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
 * same rank). avgRank is the mean of this across every decision point. A fixed ANCHOR_COUNT=1 slot (the
 * exact, unmutated real table) is carried every generation, same live "is anything actually better than
 * today's real table, on THIS specific human data" signal ga_train.js's own anchor gives.
 *
 * Usage: node tools/train_from_human_replay.js <generations> <populationSize> <outputDir> <replayJsonPath> [replayJsonPath...]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { getLevel } = require('../src/ai/levels');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { applyInPlace } = require('../src/ai/simulator');
const { mutateGenomePercent } = require('../src/ai/ga');
const turnFlow = require('../src/turn-flow');
const rng = require('../src/rng');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const PLAYER_ID = 'P1'; // every replay this tool has seen so far has the human playing Alice/P1
const AI_LEVEL = 'LV4';
const ROUNDS_TO_USE = [3, 4];

// Same constants/style as tools/ga_train.js's own --seed-real path, for consistency.
const MUTATION_RATE = 0.1;
const MUTATION_PERCENT = 0.2;
const BIG_MUTATION_CHANCE = 0.1;
const BIG_MUTATION_PERCENT = 0.3;
const ELITE_FRACTION = 0.2;
const ANCHOR_COUNT = 1;

function parseArgs() {
  const [genArg, popArg, outDirArg, ...replayPaths] = process.argv.slice(2);
  const generations = Number(genArg);
  const populationSize = Number(popArg);
  if (!Number.isInteger(generations) || generations < 1 || !Number.isInteger(populationSize) || populationSize < 2 || !outDirArg || replayPaths.length === 0) {
    console.error('Usage: node tools/train_from_human_replay.js <generations> <populationSize> <outputDir> <replayJsonPath> [replayJsonPath...]');
    process.exit(1);
  }
  return { generations, populationSize, outputDir: path.resolve(outDirArg), replayPaths };
}

/** Every legal move for playerId at `state` under both possible hasPlacedDieThisTurn values (that flag
 * isn't itself part of GameState -- see move-generator.js's own context param), tagged with which
 * context produced it. Mirrors tools/analyze_human_replay.js's own candidatesForBothContexts exactly. */
function candidatesForBothContexts(moveGenerator, state, index, playerId) {
  const out = [];
  for (const hasPlacedDieThisTurn of [false, true]) {
    for (const move of moveGenerator.generateMoves(state, index, playerId, { hasPlacedDieThisTurn })) {
      out.push({ move, hasPlacedDieThisTurn });
    }
  }
  return out;
}

/** Walks one replay file, reconstructing every ROUNDS_TO_USE-round TURN decision PLAYER_ID actually made
 * (same match-by-exact-resulting-state approach as analyze_human_replay.js), and returns each as
 * {resultStates: GameState[], humanIndex: number} -- resultStates[humanIndex] is what actually happened;
 * every other entry is a legal alternative the human didn't take. Move application happens here, ONCE,
 * regardless of how many generations/genomes will later re-score these same states. */
function extractDecisionPoints(replayPath, moveGenerator, index) {
  const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
  const decisionPoints = [];
  let reconstructed = 0;
  let skipped = 0;
  for (let i = 0; i < replay.length - 1; i++) {
    const state = replay[i];
    const nextState = replay[i + 1];
    if (state.phase === 'GAME_END') break;
    if (!ROUNDS_TO_USE.includes(state.round)) continue;
    let next;
    try { next = turnFlow.getNextTurn(state); } catch (e) { continue; }
    if (next.type !== 'TURN' || next.playerId !== PLAYER_ID) continue;

    const candidates = candidatesForBothContexts(moveGenerator, state, index, PLAYER_ID);
    const nextStateJson = JSON.stringify(nextState);
    let matchedContext = null;
    let matchedIndex = -1;
    const sameContextResultStates = { false: [], true: [] };
    // Apply every candidate once, bucketed by context -- whichever bucket contains the actual match is
    // the one whose full sibling list becomes this decision point's candidate set (the other context's
    // candidates were never really on offer at this exact moment, see hasPlacedDieThisTurn's own doc).
    for (const candidate of candidates) {
      const clone = structuredClone(state);
      let result;
      try { result = applyInPlace(clone, index, candidate.move); } catch (e) { continue; }
      if (!result.success) continue;
      const bucket = sameContextResultStates[String(candidate.hasPlacedDieThisTurn)];
      const thisIndex = bucket.length;
      bucket.push(clone);
      // First match wins (2026-09-06 fix): candidatesForBothContexts always yields every false-context
      // candidate before any true-context one, and a BARE_TAP/FREE_ACTION/etc. move (ungated by
      // hasPlacedDieThisTurn, see move-generator.js's own generateMoves) can legitimately reach the exact
      // same resulting state under EITHER tag. Without this guard, a later true-context duplicate match
      // would silently overwrite the earlier false-context one -- and since hasPlacedDieThisTurn=true
      // suppresses every placement move entirely, that swap shrinks the candidate pool this decision gets
      // ranked against from ~dozens down to a handful, wildly inflating how often the human's move looks
      // like "the top pick" for no real reason. Preferring the first (false) match, same as
      // tools/analyze_human_replay.js's own break-on-first-match, is the more inclusive, safer default
      // whenever the true context can't be told apart from context alone.
      if (matchedContext === null && JSON.stringify(clone) === nextStateJson) { matchedContext = candidate.hasPlacedDieThisTurn; matchedIndex = thisIndex; }
    }
    if (matchedContext === null) { skipped++; continue; }
    reconstructed++;
    decisionPoints.push({ resultStates: sameContextResultStates[String(matchedContext)], humanIndex: matchedIndex, round: state.round });
  }
  return { decisionPoints, reconstructed, skipped };
}

/** Competition-ranked position (1 = best) of the human's own resulting state among every candidate's,
 * under `evaluator`'s own scoring -- ties share the same rank (matches how avgRank is computed
 * elsewhere in this project's AI tooling, e.g. turn-flow's own ranking). */
function humanRankFor(decisionPoint, evaluator) {
  const scores = decisionPoint.resultStates.map((s) => evaluator.score(s, PLAYER_ID));
  const humanScore = scores[decisionPoint.humanIndex];
  return 1 + scores.filter((s) => s > humanScore).length;
}

function evaluateFitness(genome, decisionPoints, index, level) {
  const evaluator = new Evaluator(index, genome, level.evaluatorOptions);
  let rankSum = 0;
  let top1Count = 0;
  for (const dp of decisionPoints) {
    const rank = humanRankFor(dp, evaluator);
    rankSum += rank;
    if (rank === 1) top1Count++;
  }
  return { avgRank: rankSum / decisionPoints.length, top1Rate: top1Count / decisionPoints.length };
}

function main() {
  const { generations, populationSize, outputDir, replayPaths } = parseArgs();
  fs.mkdirSync(outputDir, { recursive: true });

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const realTable = buildEvalTable(raw);
  const ids = Object.keys(realTable[1]);
  const level = getLevel(AI_LEVEL);
  const moveGenerator = new MoveGenerator(level.moveGeneratorOptions);

  console.log(`Extracting round ${ROUNDS_TO_USE.join('/')} decision points for ${PLAYER_ID} from ${replayPaths.length} replay file(s)...`);
  let allDecisionPoints = [];
  let totalReconstructed = 0;
  let totalSkipped = 0;
  for (const replayPath of replayPaths) {
    const { decisionPoints, reconstructed, skipped } = extractDecisionPoints(replayPath, moveGenerator, index);
    console.log(`  ${path.basename(replayPath)}: ${reconstructed} reconstructed, ${skipped} skipped`);
    allDecisionPoints = allDecisionPoints.concat(decisionPoints);
    totalReconstructed += reconstructed;
    totalSkipped += skipped;
  }
  console.log(`Total: ${totalReconstructed} decision points (${totalSkipped} skipped), by round: ${ROUNDS_TO_USE.map((r) => `${r}R=${allDecisionPoints.filter((d) => d.round === r).length}`).join(', ')}`);
  if (allDecisionPoints.length === 0) {
    console.error('No decision points extracted -- nothing to train on.');
    process.exit(1);
  }

  const runId = Date.now();
  const runRng = rng.createRng(`train-from-human-${runId}`);
  const mutate = (genome) => mutateGenomePercent(genome, runRng, MUTATION_RATE, MUTATION_PERCENT, BIG_MUTATION_CHANCE, BIG_MUTATION_PERCENT);
  const withAnchor = (pop) => { const result = pop.slice(); for (let i = 0; i < ANCHOR_COUNT; i++) result[i] = realTable; return result; };
  const realTableStr = JSON.stringify(realTable);

  const anchorFitness = evaluateFitness(realTable, allDecisionPoints, index, level);
  console.log(`\nReal table (anchor) on this human data: avgRank=${anchorFitness.avgRank.toFixed(2)} (of ~${(allDecisionPoints.reduce((s, d) => s + d.resultStates.length, 0) / allDecisionPoints.length).toFixed(0)} candidates/decision avg), top1Rate=${(anchorFitness.top1Rate * 100).toFixed(1)}%`);

  let population = withAnchor(Array.from({ length: populationSize }, () => mutate(realTable)));
  let bestEver = { avgRank: Infinity };
  const progressCsvPath = path.join(outputDir, 'progress.csv');
  fs.writeFileSync(progressCsvPath, 'generation,best_avg_rank,best_top1_rate,anchor_avg_rank,anchor_top1_rate\n');

  for (let gen = 1; gen <= generations; gen++) {
    const t0 = Date.now();
    const fitness = population.map((genome) => evaluateFitness(genome, allDecisionPoints, index, level));
    const ranked = fitness.map((f, i) => ({ ...f, genome: population[i] })).sort((a, b) => a.avgRank - b.avgRank);
    const anchor = ranked.find((r) => JSON.stringify(r.genome) === realTableStr);

    console.log(`Generation ${gen}/${generations}: best avgRank=${ranked[0].avgRank.toFixed(2)} (top1Rate=${(ranked[0].top1Rate * 100).toFixed(1)}%)${anchor ? `, anchor avgRank=${anchor.avgRank.toFixed(2)}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    fs.appendFileSync(progressCsvPath, `${gen},${ranked[0].avgRank.toFixed(3)},${ranked[0].top1Rate.toFixed(3)},${anchor ? anchor.avgRank.toFixed(3) : ''},${anchor ? anchor.top1Rate.toFixed(3) : ''}\n`);

    if (ranked[0].avgRank < bestEver.avgRank) {
      bestEver = ranked[0];
      fs.writeFileSync(path.join(outputDir, 'best_genome.json'), JSON.stringify({ generation: gen, avgRank: bestEver.avgRank, top1Rate: bestEver.top1Rate, genome: bestEver.genome }, null, 2));
    }
    if (gen === generations) break;

    const eliteCount = Math.max(1, Math.round(populationSize * ELITE_FRACTION));
    const elites = ranked.slice(0, eliteCount).map((r) => r.genome);
    const nextPopulation = elites.slice();
    while (nextPopulation.length < populationSize) {
      const parent = elites[Math.floor(rng.next(runRng) * elites.length)];
      nextPopulation.push(mutate(parent));
    }
    population = withAnchor(nextPopulation);
  }

  console.log(`\nDone. Best genome (avgRank=${bestEver.avgRank.toFixed(2)}, top1Rate=${(bestEver.top1Rate * 100).toFixed(1)}%) written to ${path.join(outputDir, 'best_genome.json')}`);
}

main();
