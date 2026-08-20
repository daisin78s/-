/**
 * Integration smoke test for src/ai/game-runner.js: drives full AI-vs-AI games (setupGame ->
 * onboarding -> every round -> GAME_END) using the real engine and real data. Slower than the other
 * ai-*.smoke.js files (a full 4-player game takes several seconds) since it's exercising the whole
 * stack, not one class in isolation -- kept to a small, fixed set of seeds on purpose.
 * Run: node tests/ai-game-runner.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame, driveTurn } = require('../src/ai/game-runner');
const { createEmptyGameState, createDie, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { Simulator } = require('../src/ai/simulator');
const { AIPlayer } = require('../src/ai/ai-player');

const raw = loadGameData(path.join(__dirname, '..', 'data', 'game.json'));
const index = buildDataIndex(raw);
const evalTable = buildEvalTable(raw);
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------------------
// A full 4-player AI-vs-AI game reaches GAME_END (not stuck in an infinite loop / MAX_ITERATIONS
// safety valve) -- this is the exact regression this integration test exists to catch: 2026-08-02's
// stuck-AI bugs (see [[project-dice-wp]]) all manifested as state.phase staying 'ROUND' forever.
// ---------------------------------------------------------------------------
const { state: state1, historyByPlayerId: history1, roundDetailByPlayerId: roundDetail1 } = playGame('ai-integration-smoke-1', PLAYER_NAMES, index, evalTable);
check('A full game reaches GAME_END, not stuck at MAX_ITERATIONS', state1.phase, 'GAME_END');

// ---------------------------------------------------------------------------
// QST's rank-based rewards (2026-08-09) settle automatically by GAME_END -- state.qstRewardsGranted is
// populated (turn-flow.js's endRound), and roundDetailByPlayerId[playerId].qstScore (tools/
// ai_data_report.js's own source for the new "QST平均得点" columns) matches it exactly, one entry per
// player, every value a non-negative integer (VP only ever goes up from a reward, never down).
// ---------------------------------------------------------------------------
{
  assertTrue('state.qstRewardsGranted is populated at GAME_END', !!state1.qstRewardsGranted);
  check('qstRewardsGranted has one entry per player', Object.keys(state1.qstRewardsGranted).sort(), ['P1', 'P2', 'P3', 'P4']);
  for (const playerId of Object.keys(state1.qstRewardsGranted)) {
    assertTrue(`${playerId}: qstRewardsGranted value is a non-negative integer`, Number.isInteger(state1.qstRewardsGranted[playerId]) && state1.qstRewardsGranted[playerId] >= 0);
    check(`${playerId}: roundDetailByPlayerId.qstScore matches state.qstRewardsGranted`, roundDetail1[playerId].qstScore, state1.qstRewardsGranted[playerId]);
  }
}

// ---------------------------------------------------------------------------
// historyByPlayerId has exactly the 6 fields the user specified (2026-08-01: "IDでCON JOB 1R目に建築
// したはじめのカード 1R目に手に入れた色D 最終得点"; rank added 2026-08-20 for tools/ai_data_report.js's
// new "平均順位" metric), one entry per player, well-formed values.
// ---------------------------------------------------------------------------
{
  const playerIds = Object.keys(history1);
  check('One history entry per player', playerIds.sort(), ['P1', 'P2', 'P3', 'P4']);
  const ranks = [];
  for (const playerId of playerIds) {
    const h = history1[playerId];
    check(`${playerId}: history has exactly the 6 specified fields`, Object.keys(h).sort(), ['conFaceId', 'finalScore', 'firstRound1BuildFaceId', 'jobFaceId', 'rank', 'round1DDiceGained'].sort());
    assertTrue(`${playerId}: conFaceId looks like a CON face ID`, /^CON\d+[AB]$/.test(h.conFaceId));
    // JOB ids dropped their trailing tier letter (2026-08-0X) -- unlike CON/firstRound1BuildFaceId
    // below (still real A/B-tiered decks), a JOB id is now always bare, e.g. "JOB005".
    assertTrue(`${playerId}: jobFaceId looks like a JOB face ID`, /^JOB\d+$/.test(h.jobFaceId));
    // Tier suffix is optional (2026-08-05, fix: this regex never actually allowed a Monument build --
    // M-series cards have no A/B tier at all, e.g. "M002", unlike A/B/C decks which always have one --
    // this just hadn't been exercised by this seed's history until the usage-fee softlock fix below let
    // the game actually run this far).
    assertTrue(`${playerId}: firstRound1BuildFaceId is NONE or a card face ID`, h.firstRound1BuildFaceId === 'NONE' || /^[A-Z]+\d+[AB]?$/.test(h.firstRound1BuildFaceId));
    assertTrue(`${playerId}: round1DDiceGained is a non-negative integer`, Number.isInteger(h.round1DDiceGained) && h.round1DDiceGained >= 0);
    assertTrue(`${playerId}: finalScore is a finite number`, Number.isFinite(h.finalScore));
    assertTrue(`${playerId}: rank is an integer 1-4`, Number.isInteger(h.rank) && h.rank >= 1 && h.rank <= 4);
    check(`${playerId}: roundDetailByPlayerId.rank matches history.rank`, roundDetail1[playerId].rank, h.rank);
    ranks.push(h.rank);
  }
  check('The 4 players\' ranks are exactly 1,2,3,4 (no ties -- turn-order tie-break always resolves them)', ranks.sort(), [1, 2, 3, 4]);
}

// ---------------------------------------------------------------------------
// No randomness anywhere in the AI's own decision-making (confirmed 2026-08-01): the RNG seed alone
// must fully determine the outcome, so the same seed run twice produces an identical result.
// ---------------------------------------------------------------------------
{
  const { state: state1b, historyByPlayerId: history1b } = playGame('ai-integration-smoke-1', PLAYER_NAMES, index, evalTable);
  check('Same seed run twice reaches GAME_END both times', state1b.phase, 'GAME_END');
  check('Same seed run twice produces identical historyByPlayerId', history1b, history1);
}

// ---------------------------------------------------------------------------
// A second, different seed also completes cleanly -- guards against a fix that only happens to work
// for one specific seed/board layout.
// ---------------------------------------------------------------------------
{
  const { state: state2 } = playGame('ai-integration-smoke-2', PLAYER_NAMES, index, evalTable);
  check('A second seed also reaches GAME_END', state2.phase, 'GAME_END');
}

// ---------------------------------------------------------------------------
// levelByPlayerId (2026-08-10, for tools/ai_level_comparison.js's random level-mix battles -- see
// game-runner.js's playGame doc): every player gets src/ai/levels.js's per-level AIPlayer instead of
// one uniform config shared by all 4 seats.
// ---------------------------------------------------------------------------
{
  // All 4 seats assigned "LV1" (levels.js's entry: every option undefined, same as the default uniform
  // path's own defaults) must behave IDENTICALLY to the plain no-options call for the same seed --
  // proves levelByPlayerId's per-distinct-level AIPlayer construction doesn't itself change behavior,
  // only which config gets used.
  const seed = 'ai-integration-smoke-level-mix-uniform';
  const plain = playGame(seed, PLAYER_NAMES, index, evalTable);
  const allLv1 = playGame(seed, PLAYER_NAMES, index, evalTable, undefined, undefined, undefined, { P1: 'LV1', P2: 'LV1', P3: 'LV1', P4: 'LV1' });
  check('levelByPlayerId with every seat on "LV1" matches the plain uniform call exactly (same seed)', allLv1.historyByPlayerId, plain.historyByPlayerId);
}
{
  // Genuinely mixed levels (LV1/LV2/LV3 all present in one game) still reaches GAME_END cleanly -- the
  // main regression this test guards against (mirrors the "reaches GAME_END" tests above, but for the
  // mixed-construction path specifically).
  const { state } = playGame('ai-integration-smoke-level-mix', PLAYER_NAMES, index, evalTable, undefined, undefined, undefined, { P1: 'LV1', P2: 'LV2', P3: 'LV3', P4: 'LV1' });
  check('A mixed-level game (LV1/LV2/LV3 in one game) also reaches GAME_END', state.phase, 'GAME_END');
}

// ---------------------------------------------------------------------------
// Regression (2026-08-20, per user bug report: "AIが道化を選んだ時 ラウンド1の1ターン目ですべてのダイス
//4個をいきなり使ってスタートしました") -- PLACE_WILDCARD_DIE (JOB003/道化's own die-placement move) was
// missing from every "did this move count as placing a die this turn" check in game-runner.js/
// ai-player.js/main.js, so a ☆-owning AI kept seeing hasPlacedDieThisTurn:false forever and placed every
// remaining die in one single driveTurn call instead of stopping after the first, exactly the reported
// symptom. driveTurn itself (game-runner.js's own copy of this tracking) is exercised directly here
// against a minimal hand-built state, rather than relying on a full game happening to draft JOB003.
// ---------------------------------------------------------------------------
{
  function freshWildcardState() {
    const state = createEmptyGameState('ai-wildcard-one-die-per-turn');
    setup.createPlayers(state, ['Alice', 'Bob']);
    setup.prepareMaps(state, index);
    setup.prepareShops(state, index);
    const p1 = state.players.find((p) => p.id === 'P1');
    p1.jobCardId = 'JOB003';
    const jobInst = createCardInstance('JOB003');
    jobInst.ownerId = 'P1';
    state.cards[jobInst.physicalId] = jobInst;
    p1.ownedCardPhysicalIds.push(jobInst.physicalId);
    p1.resources = { K: 50, A: 50, B: 50, C: 50, Z: 50, BZ: 50, VP: 0 };
    p1.dice = [1, 2, 3, 4].map((v, i) => {
      const die = createDie(`test-wildcard-turn-${i}`, 'COLOR');
      die.value = v;
      return die;
    });
    return state;
  }
  const evaluator = new Evaluator(index, evalTable);
  const moveGenerator = new MoveGenerator();
  const simulator = new Simulator();
  const aiPlayer = new AIPlayer(index, moveGenerator, evaluator, simulator);

  const state = freshWildcardState();
  const moves = driveTurn(state, index, 'P1', aiPlayer, false);
  const placedDiceCount = state.players.find((p) => p.id === 'P1').dice.filter((d) => d.placedMapId !== null).length;
  check('A ☆-owning (JOB003) AI places exactly 1 die per driveTurn call, not all 4 at once', placedDiceCount, 1);
  const placementMoves = moves.filter((m) => m.move.type === 'PLACE_DIE' || m.move.type === 'PLACE_WILDCARD_DIE');
  check('...and driveTurn\'s own move log shows exactly 1 placement move', placementMoves.length, 1);
  check('...specifically a PLACE_WILDCARD_DIE (JOB003\'s own move type)', placementMoves[0].move.type, 'PLACE_WILDCARD_DIE');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
