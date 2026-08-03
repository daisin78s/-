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
  // forcedBzConversionMove: () => null (2026-08-04) -- AIPlayer.selectMove/#greedyMove both check this
  // first now (see move-generator.js's own doc); these stubs never need it to fire, so it's just a
  // no-op here, but the stub still needs the method to exist.
  const moveGenerator = { generateMoves: () => moves, forcedBzConversionMove: () => null };
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

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
