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
const { playGame, driveTurn, driveOnboarding } = require('../src/ai/game-runner');
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
// JOB010/革命家's PICK_JOB_REPLACEMENT (2026-08-21): driveOnboarding must resolve this synchronously
// (random pick, same policy as its UNTAP_CHOICE handling in driveTurn) rather than leaving it dangling
// in state.pendingChoices -- an AI player has no other code path that would ever surface/resolve it.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('job010-ai-onboarding');
  setup.createPlayers(state, PLAYER_NAMES);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  setup.dealConCards(state);
  state.cards.B005.ownerId = 'P2'; // simulate 革命の兆し already taken, forcing the replacement-choice branch (2026-08-24 rework: this used to be B007)
  state.jobPool = ['JOB010']; // force driveOnboarding's random JOB pick to land on JOB010
  driveOnboarding(state, index, 'P1', evalTable);
  check('driveOnboarding leaves no dangling PICK_JOB_REPLACEMENT choice for the AI player', state.pendingChoices.some((c) => c.kind === 'PICK_JOB_REPLACEMENT'), false);
  const p1 = state.players.find((p) => p.id === 'P1');
  assertTrue('P1 ends up with some job (the replacement, not JOB010)', !!p1.jobCardId && p1.jobCardId !== 'JOB010');
  check('...and it is actually owned', p1.ownedCardPhysicalIds.includes(p1.jobCardId), true);
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
//
// 'ai-integration-smoke-2' used to be this seed until 2026-08-27, when it started landing the AI in a
// genuine game-rules deadlock (not a code bug): a player can owe a USAGE_FEE with literally zero of
// every resource a free action could convert, with no way to ever pay it or end their turn. A human
// player has undo to escape this (confirmed acceptable with the user); fixing it for the AI is deferred
// ("レアケースなのであとで変更を考えます"). Swapped to '-3', which completes normally, since this test's
// own point is just "some second seed also finishes", not this specific one.
// ---------------------------------------------------------------------------
{
  const { state: state2 } = playGame('ai-integration-smoke-3', PLAYER_NAMES, index, evalTable);
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

// ---------------------------------------------------------------------------
// PLACE_DICE_GROUP (2026-08-21, per user request "AIがダイスを２個使ってモニュメントを獲得できるように
// してほしい"): an AI whose only 2 unplaced dice sum to >6 actually builds a monument via driveTurn, not
// just wastes them on 2 separate single-die placements -- exercised through the real engine/real data,
// not just move-generator.js/simulator.js in isolation (see their own smoke tests for that).
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('ai-place-dice-group-integration');
  setup.createPlayers(state, PLAYER_NAMES);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  const p1 = state.players.find((p) => p.id === 'P1');
  p1.resources.BZ = 30; // affords whatever monument the combined buildValue reaches
  p1.dice = [4, 5].map((v, i) => {
    const die = createDie(`test-group-integration-${i}`, 'COLOR');
    die.value = v;
    return die;
  });
  // P2-P4 each need at least one still-unplaced die too (found via direct debugging) -- otherwise
  // isRoundOver (every player's dice all placed-or-passed) is vacuously true the instant P1's own
  // END_TURN runs (an empty dice array trivially satisfies "every die placed/passed"), triggering a real
  // endRound() -- which correctly rerolls/un-places every COLOR die for the next round, including the
  // ones P1 just placed -- purely a test-setup artifact of giving only P1 any dice at all, not a bug in
  // PLACE_DICE_GROUP itself (the monument is already built and owned by then regardless).
  for (const otherId of ['P2', 'P3', 'P4']) {
    const other = state.players.find((p) => p.id === otherId);
    other.dice.push(createDie(`test-group-integration-other-${otherId}`, 'COLOR'));
  }
  // Every M-sheet monument with DICE>=7 (M001-M006) has a printed VP comparable to (or higher than) the
  // low-threshold ones a single die could otherwise always reach (M007-M012, DICE<=6 -- getBuildCandidates
  // has no other gating for M, so a lone die trivially builds one of those too) -- so both A/B/C/SPECIAL
  // shop slots AND every low-threshold monument are cleared here, leaving M001-M006 (DICE 12..7, all
  // genuinely unreachable by either lone die (4 or 5) alone) as literally the only buildable candidates,
  // forcing driveTurn to actually compare "spend both dice on one monument" against every alternative.
  // round=4 (2026-08-21, found via direct debugging -- see move-generator.js's own PLACE_DICE_GROUP doc):
  // evaluator.js's v('D') (the *option value* of an unplaced die) currently outweighs any single
  // monument's VP payoff in round 1 (v('D')=50 forfeited per die vs. VP*v(VP)<=6*10=60 total for 2 dice,
  // a net loss) -- round 4 makes committing both dice free (v('D')=0) while every VP is worth 1000, which
  // is when this feature is actually meant to matter (per the user's own framing: dice too big to place
  // singly, late enough that holding them has no value left).
  state.round = 4;
  state.shops.M.slots = { SHOP001: 'M001', SHOP002: 'M002', SHOP003: 'M003', SHOP004: 'M004', SHOP005: 'M005', SHOP006: 'M006' };
  for (const slotId of Object.keys(state.shops.NORMAL.slots)) state.shops.NORMAL.slots[slotId] = null;
  for (const slotId of Object.keys(state.shops.SPECIAL.slots)) state.shops.SPECIAL.slots[slotId] = null;

  const evaluator = new Evaluator(index, evalTable);
  const moveGenerator = new MoveGenerator();
  const simulator = new Simulator();
  const aiPlayer = new AIPlayer(index, moveGenerator, evaluator, simulator);

  const moves = driveTurn(state, index, 'P1', aiPlayer, false);
  const groupMove = moves.find((m) => m.move.type === 'PLACE_DICE_GROUP');
  assertTrue('driveTurn actually takes a PLACE_DICE_GROUP move when it dominates the alternatives', !!groupMove);
  check('...it succeeded', groupMove && groupMove.result.success, true);
  const resultP1 = state.players.find((p) => p.id === 'P1');
  check('Both dice ended up placed', resultP1.dice.every((d) => d.placedMapId !== null), true);
  check('A monument was actually built', resultP1.ownedCardPhysicalIds.length, 1);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
