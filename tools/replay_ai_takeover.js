/**
 * Takes over a recorded human replay from a given snapshot and re-plays the SAME game (identical
 * starting board/shop/dice/JOB pool/CON deal -- GameState.rng's own {state:<int>} continues deterministic
 * from wherever the snapshot left it, no original seed string needed) with EVERY seat driven by an AI
 * level instead, reporting what score the human's own seat would have ended up with under full AI control
 * (2026-09-06, per user request: "人間のリプレイをAIに人間の候補手なしにプレイさせると何点くらいになる？
 * 例 人間48点 AI25点").
 *
 * All 4 seats are handed to AI, not just the human's own -- once the human's seat's decisions diverge from
 * what's in the replay, the OTHER seats' own recorded actions no longer apply either (they were reacting
 * to a board state that no longer exists past that point), so there is no way to "keep the other 3 seats'
 * real moves" and only substitute one. This reports a "same deal, everyone plays it out fresh from the
 * takeover point" baseline, not a "swap just this one seat mid-game" simulation.
 *
 * --start-round=N (2026-09-13, per user request: "人間の手を3R 4RだけAI LV4と進化最新のAIにやらせて得点
 * 差がどのくらいあるか見たい"): takeover starts from the FIRST snapshot with state.round===N instead of
 * the very start of the game (default 1, i.e. the original from-scratch behavior, unchanged) -- rounds
 * before N stay exactly as the human actually played them (real recorded snapshots, never re-simulated),
 * and only round N onward gets handed to AI. Lets rounds 1-2 stay real while only 3-4 get the AI-vs-human
 * score comparison this was requested for.
 *
 * --genome=<path> (2026-09-13, same request): uses a tools/ga_train.js-style genome file (best_genome.json
 * or a raw gen_XXXX.json checkpoint, via lib/genome_io.js's loadSeedGenome) as the eval table instead of
 * game.xlsx's own real table, while keeping the given aiLevel's own evaluatorOptions/moveGeneratorOptions/
 * aiOptions (policy + search depth) unchanged -- isolates "which weights" as the only variable, same
 * pattern tools/lv4_depth_experiment.js already uses.
 *
 * Usage: node tools/replay_ai_takeover.js <replayJsonPath> [humanPlayerId=P1] [aiLevel=LV4] [--start-round=N] [--genome=<path>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { getLevel } = require('../src/ai/levels');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { Simulator } = require('../src/ai/simulator');
const { AIPlayer } = require('../src/ai/ai-player');
const gameRunner = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const { loadSeedGenome } = require('./lib/genome_io');
const turnFlow = require('../src/turn-flow');
const scoring = require('../src/scoring');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');

function parseArgs() {
  let startRound = 1;
  let genomePath = null;
  const positional = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--start-round=')) startRound = Number(arg.slice('--start-round='.length));
    else if (arg.startsWith('--genome=')) genomePath = arg.slice('--genome='.length);
    else positional.push(arg);
  }
  const [replayPathArg, humanPlayerIdArg, aiLevelArg] = positional;
  if (!replayPathArg) {
    console.error('Usage: node tools/replay_ai_takeover.js <replayJsonPath> [humanPlayerId=P1] [aiLevel=LV4] [--start-round=N] [--genome=<path>]');
    process.exit(1);
  }
  return { replayPathArg, humanPlayerId: humanPlayerIdArg || 'P1', levelName: aiLevelArg || 'LV4', startRound, genomePath };
}

function main() {
  const { replayPathArg, humanPlayerId, levelName, startRound, genomePath } = parseArgs();

  const replay = JSON.parse(fs.readFileSync(replayPathArg, 'utf8'));
  const humanFinalScore = scoring.rankPlayers(JSON.parse(JSON.stringify(replay[replay.length - 1])), buildDataIndex(loadGameData(DATA_PATH)))
    .find((r) => r.playerId === humanPlayerId).score;

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = genomePath ? loadSeedGenome(genomePath).genome : buildEvalTable(raw);
  const level = getLevel(levelName);
  const evaluator = new Evaluator(index, evalTable, level.evaluatorOptions);
  const moveGenerator = new MoveGenerator(level.moveGeneratorOptions);
  const simulator = new Simulator();
  const synergyTable2 = buildConJobSynergyTable(raw);
  const synergyTable3 = buildResourceSynergyTable(raw);
  const resourceCardPicker = (candidateIds, state, idx, player) => pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

  const startSnapshot = startRound <= 1 ? replay[0] : replay.find((s) => s.round === startRound);
  if (!startSnapshot) {
    console.error(`No snapshot found with round===${startRound} in this replay -- nothing to take over from.`);
    process.exit(1);
  }
  const state = structuredClone(startSnapshot);
  const aiPlayersByPlayerId = {};
  for (const player of state.players) {
    aiPlayersByPlayerId[player.id] = new AIPlayer(index, moveGenerator, evaluator, simulator, level.aiOptions);
  }

  // Every player's SELECT_RESOURCE_CARDS choice (if still pending at this exact snapshot) needs the same
  // smart-onboarding pick "AI LV4" games use elsewhere -- game-runner.js's own setupGame handles this
  // internally when building a state from scratch, but this state already exists, so it's resolved here
  // directly instead.
  for (const player of state.players) {
    const choice = state.pendingChoices.find((c) => c.playerId === player.id && c.kind === 'SELECT_RESOURCE_CARDS');
    if (!choice) continue;
    const pair = resourceCardPicker(choice.context.candidates, state, index, player);
    require('../src/setup').chooseResourceCards(state, player.id, pair);
  }
  if (!state.turnOrder || state.turnOrder.length === 0) {
    require('../src/setup').computeStartOrder(state, index);
    require('../src/qst').setupQuests(state);
  }
  if (state.round === 0) turnFlow.startRound(state);

  let openTurnPlayerId = null;
  let openTurnHasPlacedDie = false;
  const MAX_ITERATIONS = 2000;
  let iterations = 0;
  while (state.phase !== 'GAME_END' && iterations < MAX_ITERATIONS) {
    iterations++;
    const next = turnFlow.getNextTurn(state);
    if (next.type === 'ROUND_OVER') {
      turnFlow.endRound(state, index);
      if (state.phase !== 'GAME_END') turnFlow.startRound(state);
      openTurnPlayerId = null;
      continue;
    }
    if (next.type === 'ONBOARDING_NEEDED') {
      gameRunner.driveSmartOnboarding(state, index, next.playerId, synergyTable2, moveGenerator, simulator);
      continue;
    }
    const roundBeforeTurn = state.round;
    const initialHasPlacedDie = next.playerId === openTurnPlayerId ? openTurnHasPlacedDie : false;
    const moves = gameRunner.driveTurn(state, index, next.playerId, aiPlayersByPlayerId[next.playerId], initialHasPlacedDie);
    const endedTurn = moves.some((m) => m.move.type === 'END_TURN' && m.result.success);
    if (endedTurn || state.round > roundBeforeTurn) {
      openTurnPlayerId = null;
    } else {
      openTurnPlayerId = next.playerId;
      openTurnHasPlacedDie = initialHasPlacedDie || moves.some((m) => ['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE'].includes(m.move.type) && m.result.success);
    }
  }
  if (state.phase !== 'GAME_END') {
    console.error(`Did not reach GAME_END within ${MAX_ITERATIONS} iterations -- aborting.`);
    process.exit(1);
  }

  const rankings = scoring.rankPlayers(state, index);
  const takeoverDesc = startRound <= 1 ? 'all 4 seats AI-controlled from the same starting deal' : `all 4 seats AI-controlled from round ${startRound} onward (rounds 1-${startRound - 1} kept exactly as actually played)`;
  console.log(`${path.basename(replayPathArg)} (AI level ${levelName}${genomePath ? `, genome=${path.relative(path.join(__dirname, '..'), genomePath)}` : ''}, ${takeoverDesc}):`);
  rankings.forEach((r, i) => console.log(`  #${i + 1}: ${r.playerId}${r.playerId === humanPlayerId ? ' (human\'s own seat)' : ''} score=${r.score}`));
  const aiScoreForHumanSeat = rankings.find((r) => r.playerId === humanPlayerId).score;
  console.log(`\nHuman's ACTUAL score in this game: ${humanFinalScore}`);
  console.log(`AI's score for the same seat: ${aiScoreForHumanSeat} (gap: ${aiScoreForHumanSeat - humanFinalScore >= 0 ? '+' : ''}${aiScoreForHumanSeat - humanFinalScore})`);
}

main();
