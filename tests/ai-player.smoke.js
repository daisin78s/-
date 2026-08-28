/**
 * Smoke test for src/ai/ai-player.js. Uses stub MoveGenerator/Simulator/Evaluator rather than real
 * game data -- AIPlayer's whole point (confirmed 2026-08-01: "AIロジック/評価関数/合法手生成/シミュ
 * レーションを完全に分離") is that it only depends on those three interfaces, so this tests its own
 * "generate -> simulate -> evaluate -> pick best, no randomness" contract in isolation. Real-data
 * end-to-end behavior is covered by ai-game-runner.smoke.js.
 * Run: node tests/ai-player.smoke.js
 */

'use strict';

const { AIPlayer } = require('../src/ai/ai-player');

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

/** Each stub move carries {id, ok, score} -- ok controls whether Simulator "succeeds", score is what
 * Evaluator hands back for the resulting (stub) state. lookaheadExtraTurns:0 pins these to the original
 * pure-1-ply behavior -- these stub moves have no `type` field, so the 2026-08-03 lookahead rollout
 * (which branches on move.type) would just see an empty move list on every rollout step and stop
 * immediately; that's harmless with the same final answer either way *for these specific stubs*, but
 * asserting it explicitly here keeps these tests about the 1-ply contract, not an accident of the mock
 * shape -- see the "lookahead" tests below for a stub that actually exercises the rollout. */
function makeAIPlayer(moves) {
  // forcedBzConversionMove/forcedJob004ConversionMove: () => null (2026-08-04/28) -- AIPlayer.selectMove/
  // #greedyMove both check these first now (see move-generator.js's own doc); these stubs never need
  // either to fire, so they're just no-ops here, but the stub still needs both methods to exist.
  const moveGenerator = { generateMoves: () => moves, forcedBzConversionMove: () => null, forcedJob004ConversionMove: () => null };
  const simulator = { apply: (state, index, move) => ({ state: { afterMoveId: move.id }, result: { success: move.ok } }) };
  const evaluator = { score: (state) => moves.find((m) => m.id === state.afterMoveId).score };
  return new AIPlayer(null, moveGenerator, evaluator, simulator, { lookaheadExtraTurns: 0 });
}

// ---------------------------------------------------------------------------
// Picks the single highest-scoring legal move.
// ---------------------------------------------------------------------------
{
  const moves = [
    { id: 'A', ok: true, score: 5 },
    { id: 'B', ok: true, score: 12 },
    { id: 'C', ok: true, score: 3 },
  ];
  const ai = makeAIPlayer(moves);
  check('Picks the move with the highest evaluated score', ai.selectMove({}, 'P1', {}).id, 'B');
}

// ---------------------------------------------------------------------------
// Ties are broken deterministically by generation order (first-max-wins) -- never random, so the same
// input always yields the same output (confirmed 2026-08-01: "途中でランダム要素を入れないでください").
// ---------------------------------------------------------------------------
{
  const moves = [
    { id: 'first', ok: true, score: 10 },
    { id: 'second', ok: true, score: 10 },
    { id: 'third', ok: true, score: 10 },
  ];
  const ai = makeAIPlayer(moves);
  const picks = new Set();
  for (let i = 0; i < 20; i++) picks.add(ai.selectMove({}, 'P1', {}).id);
  check('A 3-way tie always resolves to the same (first) move across repeated calls', [...picks], ['first']);
}

// ---------------------------------------------------------------------------
// Moves the Simulator rejects (result.success:false) are never chosen, even with the highest score --
// defensive, since MoveGenerator should only ever offer legal moves, but AIPlayer must not trust that
// blindly.
// ---------------------------------------------------------------------------
{
  const moves = [
    { id: 'illegal-but-tempting', ok: false, score: 999 },
    { id: 'legal', ok: true, score: 1 },
  ];
  const ai = makeAIPlayer(moves);
  check('A move the Simulator rejects is skipped regardless of its score', ai.selectMove({}, 'P1', {}).id, 'legal');
}

// ---------------------------------------------------------------------------
// No legal moves at all (or every move rejected) -> null, not a thrown error or a fallback guess.
// ---------------------------------------------------------------------------
{
  const ai = makeAIPlayer([]);
  check('No moves available returns null', ai.selectMove({}, 'P1', {}), null);
}
{
  const moves = [{ id: 'A', ok: false, score: 1 }, { id: 'B', ok: false, score: 2 }];
  const ai = makeAIPlayer(moves);
  check('Every move rejected returns null', ai.selectMove({}, 'P1', {}), null);
}

// ---------------------------------------------------------------------------
// Lookahead (2026-08-03, per user feedback: "先読みの深さを増やす 次のターンまで読めるように...VPの
// 高いモニュメントが取れそうなら取りに行くように"): a tiny 2-turn stub game where turn 1 offers X
// (immediate score 5) or Y (immediate score 10, the pure-1-ply "obvious" choice), each followed by a
// mandatory END_TURN, then a single turn-2 move whose score depends entirely on which path was taken --
// X leads to a big turn-2 payoff (50), Y leads to a small one (2). lookaheadExtraTurns:0 must still pick
// Y (nothing beyond the immediate move exists to it); lookaheadExtraTurns:1 must pick X, since only the
// rollout can see that X's total (5 then 50) beats Y's (10 then 2).
// ---------------------------------------------------------------------------
function makeLookaheadStubs() {
  const moveGenerator = {
    generateMoves: (state, index, playerId, context) => {
      if (state.path === undefined) return [{ type: 'PLACE_DIE', playerId, id: 'X' }, { type: 'PLACE_DIE', playerId, id: 'Y' }];
      if (context.hasPlacedDieThisTurn && !state.turn1Ended) return [{ type: 'END_TURN', playerId }];
      if (state.turn1Ended && !context.hasPlacedDieThisTurn) return [{ type: 'PLACE_DIE', playerId, id: 'BUILD' }];
      return [];
    },
    forcedBzConversionMove: () => null, // see makeAIPlayer's own comment
    forcedJob004ConversionMove: () => null,
  };
  const simulator = {
    apply: (state, index, move) => {
      if (move.type === 'PLACE_DIE' && move.id === 'X') return { state: { path: 'X', turn1Score: 5 }, result: { success: true } };
      if (move.type === 'PLACE_DIE' && move.id === 'Y') return { state: { path: 'Y', turn1Score: 10 }, result: { success: true } };
      if (move.type === 'END_TURN') return { state: { ...state, turn1Ended: true }, result: { success: true } };
      if (move.type === 'PLACE_DIE' && move.id === 'BUILD') return { state: { ...state, finalScore: state.path === 'X' ? 50 : 2 }, result: { success: true } };
      return { state, result: { success: false } };
    },
  };
  const evaluator = { score: (state) => (state.finalScore !== undefined ? state.finalScore : state.turn1Score !== undefined ? state.turn1Score : 0) };
  return { moveGenerator, evaluator, simulator };
}
{
  const { moveGenerator, evaluator, simulator } = makeLookaheadStubs();
  const greedyAI = new AIPlayer(null, moveGenerator, evaluator, simulator, { lookaheadExtraTurns: 0 });
  check('With no lookahead, picks the immediately-higher-scoring move (Y, 10 > 5)', greedyAI.selectMove({}, 'P1', { hasPlacedDieThisTurn: false }).id, 'Y');
}
{
  const { moveGenerator, evaluator, simulator } = makeLookaheadStubs();
  const lookaheadAI = new AIPlayer(null, moveGenerator, evaluator, simulator, { lookaheadExtraTurns: 1 });
  check('With 1-turn lookahead, picks the move that sets up a much better next turn (X: 5 then 50 beats Y: 10 then 2)', lookaheadAI.selectMove({}, 'P1', { hasPlacedDieThisTurn: false }).id, 'X');
}

// ---------------------------------------------------------------------------
// Forced BZ conversion (2026-08-04, per user feedback: "JOB004の効果は使えるときは必ず使う") --
// selectMove short-circuits straight to moveGenerator.forcedBzConversionMove's result when non-null,
// WITHOUT ever consulting generateMoves/Evaluator -- proven here by making generateMoves/evaluator throw
// if called at all, so the test only passes if the short-circuit genuinely skipped them.
// ---------------------------------------------------------------------------
{
  const forcedMove = { type: 'BARE_TAP', playerId: 'P1', physicalId: 'JOB004' };
  const moveGenerator = {
    generateMoves: () => { throw new Error('generateMoves should not be called when a forced move applies'); },
    forcedBzConversionMove: () => forcedMove,
  };
  const evaluator = { score: () => { throw new Error('Evaluator.score should not be called when a forced move applies'); } };
  const simulator = { apply: () => { throw new Error('Simulator.apply should not be called when a forced move applies'); } };
  const ai = new AIPlayer(null, moveGenerator, evaluator, simulator, { lookaheadExtraTurns: 0 });
  check('selectMove returns the forced move directly, bypassing generateMoves/Evaluator/Simulator entirely', ai.selectMove({}, 'P1', {}), forcedMove);
}

// ---------------------------------------------------------------------------
// roundOverrides (2026-08-10, "AI LV3": per user request "4Rのみ最後まで深堀させます" +
// "R4だけビーム幅も広げるでいきます"): base lookaheadExtraTurns/beamWidth/maxRolloutMoves apply as
// normal for any round with no matching entry in roundOverrides; for a round that DOES have one, only
// the fields actually present in that entry replace the base value -- reuses the same X/Y/BUILD
// lookahead stub game as the plain lookahead tests above, since "does lookahead actually kick in"
// (X vs Y) is exactly what distinguishes an effective lookaheadExtraTurns of 0 from 1+.
// ---------------------------------------------------------------------------
{
  const { moveGenerator, evaluator, simulator } = makeLookaheadStubs();
  const ai = new AIPlayer(null, moveGenerator, evaluator, simulator, {
    lookaheadExtraTurns: 0,
    roundOverrides: { 4: { lookaheadExtraTurns: 1 } },
  });
  check(
    'A round with no roundOverrides entry (round 1) uses the base lookaheadExtraTurns (0 -> picks Y)',
    ai.selectMove({ round: 1 }, 'P1', { hasPlacedDieThisTurn: false }).id,
    'Y',
  );
}
{
  const { moveGenerator, evaluator, simulator } = makeLookaheadStubs();
  const ai = new AIPlayer(null, moveGenerator, evaluator, simulator, {
    lookaheadExtraTurns: 0,
    roundOverrides: { 4: { lookaheadExtraTurns: 1 } },
  });
  check(
    "A round WITH a roundOverrides entry (round 4) uses the override's lookaheadExtraTurns (1 -> picks X), not the base 0",
    ai.selectMove({ round: 4 }, 'P1', { hasPlacedDieThisTurn: false }).id,
    'X',
  );
}
{
  // Partial override -- roundOverrides[4] only sets beamWidth, not lookaheadExtraTurns -- must still
  // fall back to the base lookaheadExtraTurns (1, not 0/undefined) for the fields it didn't mention.
  const { moveGenerator, evaluator, simulator } = makeLookaheadStubs();
  const ai = new AIPlayer(null, moveGenerator, evaluator, simulator, {
    lookaheadExtraTurns: 1,
    roundOverrides: { 4: { beamWidth: 99 } },
  });
  check(
    "A roundOverrides entry that omits lookaheadExtraTurns falls back to the base value (1 -> still picks X), not 0",
    ai.selectMove({ round: 4 }, 'P1', { hasPlacedDieThisTurn: false }).id,
    'X',
  );
}

// ---------------------------------------------------------------------------
// dieScarcityTieBreak (2026-08-28, "AI LV4"): when several moves tie on 1-ply score, and each carries a
// die (PLACE_DIE/PLACE_WILDCARD_DIE's dieId, or PLACE_DICE_GROUP's dieIds), the die-priority rule in
// src/ai/die-priority.js picks which one to prefer instead of plain generation order. These stubs build
// a real-shaped `state.players[*].dice` (all that die-priority.js reads) and tie every candidate move's
// score so only the tie-break itself is under test.
// ---------------------------------------------------------------------------
function makeDiceState(round, diceByPlayer) {
  return {
    round,
    players: Object.entries(diceByPlayer).map(([id, dice]) => ({ id, dice })),
  };
}
function die(id, value, kind = 'COLOR', placedMapId = null) {
  return { id, value, kind, placedMapId };
}
function makeTieBreakAIPlayer(moves, options) {
  const moveGenerator = { generateMoves: () => moves, forcedBzConversionMove: () => null, forcedJob004ConversionMove: () => null };
  const simulator = { apply: (state, index, move) => ({ state: { afterMoveId: move.id }, result: { success: true } }) };
  const evaluator = { score: (state) => 10 }; // every candidate ties on score -- only the tie-break matters
  return new AIPlayer(null, moveGenerator, evaluator, simulator, options);
}

{
  // Higher remaining-count value wins: value 3 has 2 dice left unplaced (d1,d3), value 5 has only 1 (d2).
  const state = makeDiceState(2, {
    P1: [die('d1', 3), die('d2', 5)],
    P2: [die('d3', 3)],
  });
  const moves = [
    { id: 'usesFive', type: 'PLACE_DIE', dieId: 'd2' },
    { id: 'usesThree', type: 'PLACE_DIE', dieId: 'd1' },
  ];
  const ai = makeTieBreakAIPlayer(moves, { dieScarcityTieBreak: true });
  check(
    'dieScarcityTieBreak prefers the die whose value has the higher remaining unplaced count (3, count 2, over 5, count 1)',
    ai.selectMove(state, 'P1', {}).id,
    'usesThree',
  );
}

{
  // Same remaining count (1 each) but different values -- round 1-2 prefers the LARGER value.
  const state = makeDiceState(1, {
    P1: [die('d1', 2), die('d2', 6)],
  });
  const moves = [
    { id: 'usesTwo', type: 'PLACE_DIE', dieId: 'd1' },
    { id: 'usesSix', type: 'PLACE_DIE', dieId: 'd2' },
  ];
  const ai = makeTieBreakAIPlayer(moves, { dieScarcityTieBreak: true });
  check(
    'Round 1-2: tied remaining count falls back to the LARGER die value (6 over 2)',
    ai.selectMove(state, 'P1', {}).id,
    'usesSix',
  );
}

{
  // Same setup, round 3-4 -- prefers the SMALLER value instead.
  const state = makeDiceState(3, {
    P1: [die('d1', 2), die('d2', 6)],
  });
  const moves = [
    { id: 'usesTwo', type: 'PLACE_DIE', dieId: 'd1' },
    { id: 'usesSix', type: 'PLACE_DIE', dieId: 'd2' },
  ];
  const ai = makeTieBreakAIPlayer(moves, { dieScarcityTieBreak: true });
  check(
    'Round 3-4: tied remaining count falls back to the SMALLER die value (2 over 6)',
    ai.selectMove(state, 'P1', {}).id,
    'usesTwo',
  );
}

{
  // Same value (so same remaining count too, both dice counted in the same value-4 bucket) -- a real
  // color die (PLACE_DIE) is preferred over a white/wildcard die (PLACE_WILDCARD_DIE) of the same value.
  const state = makeDiceState(1, {
    P1: [die('dc', 4, 'COLOR'), die('dw', 4, 'WHITE')],
  });
  const moves = [
    { id: 'usesWild', type: 'PLACE_WILDCARD_DIE', dieId: 'dw' },
    { id: 'usesColor', type: 'PLACE_DIE', dieId: 'dc' },
  ];
  const ai = makeTieBreakAIPlayer(moves, { dieScarcityTieBreak: true });
  check(
    'Same value/count: a real color die is spent before a white/wildcard die of the same value',
    ai.selectMove(state, 'P1', {}).id,
    'usesColor',
  );
}

{
  // dieScarcityTieBreak omitted (default false) -- must NOT apply this rule at all, falling back to
  // plain generation order same as every other AI level. Same dice as the very first test above, but
  // listed with the "wrong" (by die-priority) move first to prove that one still wins unmodified.
  const state = makeDiceState(2, {
    P1: [die('d1', 3), die('d2', 5)],
    P2: [die('d3', 3)],
  });
  const moves = [
    { id: 'usesFive', type: 'PLACE_DIE', dieId: 'd2' },
    { id: 'usesThree', type: 'PLACE_DIE', dieId: 'd1' },
  ];
  const ai = makeTieBreakAIPlayer(moves, {});
  check(
    'dieScarcityTieBreak:false (default) ignores die priority entirely -- first-generated move still wins ties',
    ai.selectMove(state, 'P1', {}).id,
    'usesFive',
  );
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
