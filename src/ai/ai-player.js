(function () {
'use strict';

const { compareDicePriority } = require('./die-priority');
const { compareExSlotPreference } = require('./slot-priority');

/**
 * AIPlayer: picks ONE move at a time. "Generate legal moves -> evaluate -> pick the best" (confirmed
 * 2026-08-01, no randomness anywhere in this loop: ties are broken by move order, first-max wins, so
 * the same state always produces the same choice). Driving a whole turn (repeatedly calling selectMove
 * until END_TURN) or a whole game is deliberately NOT this class's job -- see game-runner.js -- so this
 * stays swappable for a different algorithm (minimax/MCTS/a genetic-algorithm-tuned Evaluator) without
 * touching how turns/games get driven, or MoveGenerator/Evaluator/Simulator's own logic.
 *
 * Lookahead (2026-08-03, per user feedback: "先読みの深さを増やす 次のターンまで読めるように...3R 4R
 * でVPの高いモニュメントが取れそうなら取りに行くように"): scoring only the state right after ONE move
 * (the original behavior, still available via lookaheadExtraTurns:0) can't see a build that only
 * becomes affordable after a *later* die placement -- e.g. banking resources now that only pay off once
 * a high-value die lands on a monument-eligible AREA on this player's *next* turn. selectMove now does
 * a bounded 2-stage search instead of pure 1-ply greedy:
 *   1. Score every legal move 1-ply deep (cheap -- this is the original algorithm), rank them.
 *   2. Expand only the top `beamWidth` candidates further, each via a GREEDY ROLLOUT that keeps playing
 *      this same player's own moves (1-ply greedy from here on, not more branching) through the rest of
 *      the current turn and `lookaheadExtraTurns` more of their own turns, then scores the final state.
 * The candidate whose rollout ends in the best state wins. Beam-limiting step 2 keeps the cost roughly
 * linear in lookaheadExtraTurns instead of exponential -- full exhaustive multi-ply search was not
 * attempted given this project's existing ~10s/game budget at 1-ply.
 *
 * Deliberate simplification (own-turns-only, no opponent modeling): the rollout never simulates any
 * other player's turn -- it just keeps calling this same playerId's own moves as if their next turn
 * were immediately available, ignoring whatever the board/shops/other players' resources would
 * actually look like after the real intervening turns. This means the rollout can't tell if a
 * monument/shop card it's "banking toward" gets taken by someone else first -- it only answers "can I,
 * personally, reach a better position a bit further out", not "will I actually get there uncontested".
 * Modeling opponents accurately would mean running their own AIPlayer.selectMove for every intervening
 * turn, which is both significantly more expensive and a separate, larger design step from this one.
 *
 * Default stays lookaheadExtraTurns:0 (no lookahead, the original behavior) -- turning it on measurably
 * slows a full game down (a real game went from ~10s to roughly a minute in local testing), so callers
 * opt in deliberately rather than every existing AIPlayer() construction (src/ai/game-runner.js's
 * playGame, tools/ai_batch_run.js, tools/ai_data_report.js) silently inheriting the cost. main.js's
 * "AI LV1"/"AI LV2" player-role selector is exactly this: two separate AIPlayer instances, one at each
 * setting (2026-08-03, per user feedback: "先程のAIをLV1 新しく作ったAIをLV2として...選べるように").
 */

class AIPlayer {
  /** @param {DataIndex} index
   *  @param {import('./move-generator').MoveGenerator} moveGenerator
   *  @param {import('./evaluator').Evaluator} evaluator
   *  @param {import('./simulator').Simulator} simulator
   *  @param {{lookaheadExtraTurns?: number, beamWidth?: number, maxRolloutMoves?: number,
   *    roundOverrides?: Object<number,{lookaheadExtraTurns?: number, beamWidth?: number,
   *    maxRolloutMoves?: number}>}} [options]
   *    lookaheadExtraTurns: how many of this player's own future turns (beyond the current one) the
   *      rollout plays through before scoring. Default 0 (pure 1-ply, no lookahead -- see this class's
   *      own doc for why the default stays cheap); pass 1 for "read through the next turn".
   *    beamWidth: how many top 1-ply candidates get a rollout at all (the rest are assumed unlikely to
   *      end up best after further search). Default 6.
   *    maxRolloutMoves: safety valve against a runaway rollout (mirrors game-runner.js's driveTurn
   *      MAX_MOVES), not a real gameplay limit. Default 60.
   *    roundOverrides (2026-08-10, "AI LV3": per user request "4Rのみ最後まで深堀させます" +
   *      "R4だけビーム幅も広げるでいきます"): {round: {...same 3 fields...}} -- for the given
   *      state.round, whichever of these 3 fields are present replace the base value above for that
   *      selectMove() call only (any field left out falls back to the base value, not 0/undefined).
   *      main.js's aiPlayerLv3 uses this for round 4: a generously large lookaheadExtraTurns/
   *      maxRolloutMoves (round 4 is the LAST round, so the own-turns-only rollout -- see this class's
   *      own doc -- naturally terminates once #greedyMove finds nothing left to do, i.e. once this
   *      player's dice for the round run out; a large cap just means that natural end is what actually
   *      stops it, not an artificial early cutoff, "reading to the very end" as requested) alongside a
   *      wider beamWidth (round 4 is also the only round where the extra cost is bounded -- there's no
   *      round 5 to also pay it in). Every other round, and every other AI level (LV1/LV2's shared
   *      AIPlayer instances never pass this option), keeps using the flat base values, unaffected.
   *    dieScarcityTieBreak (2026-08-28, "AI LV4", default false): when true, ties in selectMove's 1-ply
   *      score (several moves reaching the exact same score, e.g. multiple of this player's own dice can
   *      all reach the same outcome) are broken by src/ai/die-priority.js's compareDicePriority instead
   *      of plain move-generation order -- see that module's own doc for the exact rule. false/omitted
   *      (LV1/2/3) keeps selectMove byte-for-byte unchanged.
   *    preferExOnOwnTerritory (2026-08-31, "AI LV4", default false): when true, ties in selectMove's
   *      1-ply score are ALSO broken (checked before dieScarcityTieBreak) by src/ai/slot-priority.js's
   *      compareExSlotPreference -- among placements onto an AREA this player already owns, an EX slot is
   *      preferred over any other slot (see that module's own doc for why). Self-disables for round 4 (the
   *      user's own "4Rは例外で"). false/omitted (LV1/2/3) keeps selectMove byte-for-byte unchanged.
   */
  constructor(index, moveGenerator, evaluator, simulator, options) {
    this.index = index;
    this.moveGenerator = moveGenerator;
    this.evaluator = evaluator;
    this.simulator = simulator;
    const opts = options || {};
    this.lookaheadExtraTurns = opts.lookaheadExtraTurns !== undefined ? opts.lookaheadExtraTurns : 0;
    this.beamWidth = opts.beamWidth || 6;
    this.maxRolloutMoves = opts.maxRolloutMoves || 60;
    this.roundOverrides = opts.roundOverrides || {};
    this.dieScarcityTieBreak = !!opts.dieScarcityTieBreak;
    this.preferExOnOwnTerritory = !!opts.preferExOnOwnTerritory;
  }

  /** Resolves the base lookaheadExtraTurns/beamWidth/maxRolloutMoves against this.roundOverrides[round]
   * (see the constructor's own doc) -- a no-op (returns the flat base values unchanged) whenever round
   * has no override entry, so every AIPlayer built without roundOverrides behaves exactly as before. */
  #effectiveOptions(round) {
    const override = this.roundOverrides[round] || {};
    return {
      lookaheadExtraTurns: override.lookaheadExtraTurns !== undefined ? override.lookaheadExtraTurns : this.lookaheadExtraTurns,
      beamWidth: override.beamWidth !== undefined ? override.beamWidth : this.beamWidth,
      maxRolloutMoves: override.maxRolloutMoves !== undefined ? override.maxRolloutMoves : this.maxRolloutMoves,
    };
  }

  /** The full forced-move chain, checked (in this fixed order) before ANY scored search -- shared by
   * selectMove's own top-level call and #greedyMove's per-step call during a rollout (2026-08-31,
   * factored out of what used to be 2 separately-maintained copies of this exact same chain). Returns
   * the first applicable forced Move, or null if none applies -- see each MoveGenerator#forcedXxx
   * method's own doc for why it exists and why the order matters. */
  #checkForcedMoves(state, playerId, context) {
    const forcedPureGainC = this.moveGenerator.forcedPureGainCTap(state, this.index, playerId);
    if (forcedPureGainC) return forcedPureGainC;
    const forcedFeeConversion = this.moveGenerator.forcedFeeConversionMove(state, this.index, playerId);
    if (forcedFeeConversion) return forcedFeeConversion;
    const forced = this.moveGenerator.forcedBzConversionMove(state, this.index, playerId, context);
    if (forced) return forced;
    const forcedJob004 = this.moveGenerator.forcedJob004ConversionMove(state, this.index, playerId);
    if (forcedJob004) return forcedJob004;
    const forcedEndSignLv2 = this.moveGenerator.forcedEndSignLv2Move(state, this.index, playerId);
    if (forcedEndSignLv2) return forcedEndSignLv2;
    const forcedTrainingGroundBuild = this.moveGenerator.forcedTrainingGroundBuildMove(state, this.index, playerId, context);
    if (forcedTrainingGroundBuild) return forcedTrainingGroundBuild;
    const forcedTrainingGroundKPrep = this.moveGenerator.forcedTrainingGroundKPrepMove(state, this.index, playerId, context);
    if (forcedTrainingGroundKPrep) return forcedTrainingGroundKPrep;
    const forcedTrainingGround = this.moveGenerator.forcedTrainingGroundMove(state, this.index, playerId, context);
    if (forcedTrainingGround) return forcedTrainingGround;
    return null;
  }

  /**
   * @param {GameState} state
   * @param {string} playerId
   * @param {{hasPlacedDieThisTurn: boolean}} context - see move-generator.js's own doc
   * @returns {Object|null} the single best legal Move, or null if none exist
   */
  selectMove(state, playerId, context) {
    const forcedAtTop = this.#checkForcedMoves(state, playerId, context);
    if (forcedAtTop) return forcedAtTop;
    const moves = this.moveGenerator.generateMoves(state, this.index, playerId, context);
    const scored = [];
    for (const move of moves) {
      const { state: resultState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) continue; // defensive -- MoveGenerator should only ever offer legal moves
      scored.push({ move, resultState, score: this.evaluator.score(resultState, playerId) });
    }
    if (scored.length === 0) return null;
    // First-max-wins tie-break (no randomness) -- stable sort keeps MoveGenerator's own generation
    // order for equal scores, same guarantee the original pure-1-ply version made. preferExOnOwnTerritory
    // (checked first) and dieScarcityTieBreak (AI LV4) replace that generation-order tie-break with
    // slot-priority.js's/die-priority.js's own rules instead; every other level leaves both null, so the
    // `|| 0 || 0` keeps this identical to the original single-line sort.
    const exSlotTieBreak = this.preferExOnOwnTerritory ? compareExSlotPreference(state, this.index, playerId) : null;
    const dieTieBreak = this.dieScarcityTieBreak ? compareDicePriority(state, state.round) : null;
    scored.sort((a, b) => (b.score - a.score)
      || (exSlotTieBreak ? exSlotTieBreak(a.move, b.move) : 0)
      || (dieTieBreak ? dieTieBreak(a.move, b.move) : 0));
    const { lookaheadExtraTurns, beamWidth, maxRolloutMoves } = this.#effectiveOptions(state.round);
    if (lookaheadExtraTurns <= 0) return scored[0].move;

    // Beam de-duplication (2026-08-30, per user request: "結果として同じような手は間引くようにできます
    // か"): candidates that tie EXACTLY at 1-ply -- e.g. a die-value-change/free-action applied to two
    // interchangeable dice -- are, in practice, almost always "the same idea" wearing a different move
    // object. Without this, several of the limited beamWidth rollout slots could go to near-identical
    // variants of one idea instead of genuinely different alternatives, which then never get a rollout at
    // all (and could lose out purely because their own 1-ply score was a hair lower). scored is already
    // sorted by score descending, so exact-score duplicates are adjacent -- keep only the first (i.e.
    // whichever tie-break already preferred) of each distinct score before taking the top beamWidth.
    // Deliberately an EXACT match, not a "close enough" epsilon band -- the evaluator's own weighted-sum
    // scores make a genuine tie a good proxy for redundancy, but two merely-close scores could still be
    // real, distinct strategic options worth their own rollout.
    const deduped = [];
    let lastScore = null;
    for (const candidate of scored) {
      if (candidate.score === lastScore) continue;
      deduped.push(candidate);
      lastScore = candidate.score;
    }

    let best = scored[0].move;
    let bestDeepScore = -Infinity;
    for (const candidate of deduped.slice(0, beamWidth)) {
      const deepScore = this.#rolloutScore(candidate.resultState, playerId, candidate.move, lookaheadExtraTurns, maxRolloutMoves);
      if (deepScore > bestDeepScore) {
        bestDeepScore = deepScore;
        best = candidate.move;
      }
    }
    return best;
  }

  /** Continues playing playerId's own moves, 1-ply greedy from here on (no further branching -- see
   * this class's own doc for why), through the rest of the current turn and lookaheadExtraTurns more of
   * their own turns, then scores the resulting state. `firstMove` is the move that produced `state`,
   * used only to seed hasPlacedDieThisTurn/turnsLeft correctly for the very first step. lookaheadExtraTurns/
   * maxRolloutMoves are passed in explicitly (2026-08-10, not read from `this`) since selectMove now
   * resolves them per-round via #effectiveOptions -- see roundOverrides' own doc. */
  #rolloutScore(state, playerId, firstMove, lookaheadExtraTurns, maxRolloutMoves) {
    // JOB003/道化 (2026-08-20 fix, per user bug report -- see game-runner.js driveTurn's matching comment
    // for the full story): PLACE_WILDCARD_DIE counts as "placed a die this turn" too, both here and below.
    let hasPlacedDieThisTurn = firstMove.type === 'PLACE_DIE' || firstMove.type === 'PLACE_WILDCARD_DIE' || firstMove.type === 'PLACE_DICE_GROUP' || firstMove.type === 'PASS_DIE';
    let turnsLeft = lookaheadExtraTurns;
    let steps = 0;
    while (steps < maxRolloutMoves) {
      steps++;
      const move = this.#greedyMove(state, playerId, hasPlacedDieThisTurn);
      if (!move) break; // nothing legal (shouldn't normally happen -- canEndTurn eventually frees this up)
      const { state: nextState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) break; // defensive, same as selectMove's own loop
      state = nextState;
      if (move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP' || move.type === 'PASS_DIE') hasPlacedDieThisTurn = true;
      if (move.type === 'END_TURN') {
        if (turnsLeft <= 0) break; // rollout horizon reached right at a turn boundary
        turnsLeft--;
        hasPlacedDieThisTurn = false; // a "next turn" nominally starts here (opponents not simulated)
      }
    }
    return this.evaluator.score(state, playerId);
  }

  /** Plain 1-ply-greedy move choice, reusing the same generate+score+pick-best logic as
   * lookaheadExtraTurns:0's selectMove -- deliberately not recursive (that's the whole point of
   * stopping branching once inside a rollout, see this class's own doc). Also checks every forced move
   * first (BZ/JOB004/B202B/訓練場), same as selectMove -- without this, a rollout simulating this player's
   * own future turns would never account for them, making the lookahead inconsistent with how selectMove
   * will actually behave once that turn really arrives. */
  #greedyMove(state, playerId, hasPlacedDieThisTurn) {
    const context = { hasPlacedDieThisTurn };
    const forcedMove = this.#checkForcedMoves(state, playerId, context);
    if (forcedMove) return forcedMove;
    const moves = this.moveGenerator.generateMoves(state, this.index, playerId, context);
    let best = null;
    let bestScore = -Infinity;
    for (const move of moves) {
      const { state: resultState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) continue;
      const score = this.evaluator.score(resultState, playerId);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return best;
  }
}

module.exports = { AIPlayer };

})();
