(function () {
'use strict';

const { compareDicePriority } = require('./die-priority');
const { compareExSlotPreference } = require('./slot-priority');
const turnFlow = require('../turn-flow');
const rng = require('../rng');

// "AI LV5" cross-round lookahead (see AIPlayer's own crossRoundLookahead option doc): a solo dice-move
// candidate is exactly one of these 4 move types (matches the same list #rolloutScore's own
// hasPlacedDieThisTurn tracking already checks for).
const DICE_MOVE_TYPES = new Set(['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE']);

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
   *    beamWidths (2026-09-13, per user request: "5→3→2→2→1のようにはできない？" -- a genuine multi-ply
   *      NARROWING beam search, one ply per own turn, as an alternative to the beamWidth/lookaheadExtraTurns
   *      rollout above (see #deepBeamSearch's own doc for exactly how it works and why it's a fully
   *      separate code path rather than a variant of #rolloutScore). When set (a non-empty array, e.g.
   *      [5,3,2,2,1]), OVERRIDES lookaheadExtraTurns/beamWidth entirely for that selectMove() call --
   *      every existing level leaves this unset/null, so nothing about their behavior changes.
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
   *    crossRoundLookahead (2026-09-16, "AI LV5", default false): lets #rolloutScore peek 1 turn into the
   *      NEXT round instead of always stopping once this player's own dice for the CURRENT round run out
   *      early (see #rolloutScore's own doc on the exact mechanism and #forceOpponentsFinishRound for how
   *      the other 3 seats get fast-forwarded through their own remaining round dice). Motivation (per
   *      user): this game deals its strongest cards in round 2/3, so an own-turns-only rollout that never
   *      sees past the CURRENT round can't tell "hoard resources now, spend them on a round-3 card" from
   *      "spend them now" -- it just sees the immediate round's own numbers either way. Disabled (false)
   *      for LV1-4, whose #rolloutScore stays byte-for-byte unchanged. Never engages in round 4 (no round
   *      5 to peek into -- see #rolloutScore's own round check).
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
    this.beamWidths = opts.beamWidths || null;
    this.roundOverrides = opts.roundOverrides || {};
    this.dieScarcityTieBreak = !!opts.dieScarcityTieBreak;
    this.preferExOnOwnTerritory = !!opts.preferExOnOwnTerritory;
    this.crossRoundLookahead = !!opts.crossRoundLookahead;
    // Hard wall-clock cap on one selectMove() call's own-turns-only rollout (2026-09-14, per user
    // report: a replay showed 40-56s decisions in round 4). Root cause found and fixed separately
    // (see #rolloutScore's own GAME_END check below) -- this is a safety net on TOP of that fix, not
    // instead of it, for whatever other expensive-but-legal exploration this own-turns-only rollout
    // might still stumble into (e.g. the legitimate multi-map resource-generation chains found during
    // that investigation, which are real but not worth arbitrarily deep exploration this late in a
    // round). 0/null/Infinity disables it -- tests that construct AIPlayer directly never pass this,
    // so their determinism (see this class's own top-of-file doc) is unaffected as long as they finish
    // well under the default. Checked only inside the rollout loops, never around the cheap top-level
    // 1-ply scoring pass, so selectMove always returns at least that 1-ply-best move no matter what.
    this.maxDecisionTimeMs = opts.maxDecisionTimeMs !== undefined ? opts.maxDecisionTimeMs : 10000;
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
      beamWidths: override.beamWidths !== undefined ? override.beamWidths : this.beamWidths,
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
    // real, distinct strategic options worth their own rollout. Computed unconditionally (moved ahead of
    // the lookaheadExtraTurns<=0 early return, 2026-09-13) since #deepBeamSearch needs it too.
    const deduped = [];
    let lastScore = null;
    for (const candidate of scored) {
      if (candidate.score === lastScore) continue;
      deduped.push(candidate);
      lastScore = candidate.score;
    }

    const { lookaheadExtraTurns, beamWidth, maxRolloutMoves, beamWidths } = this.#effectiveOptions(state.round);
    const deadline = this.maxDecisionTimeMs ? Date.now() + this.maxDecisionTimeMs : Infinity;
    if (beamWidths && beamWidths.length > 0) return this.#deepBeamSearch(deduped, playerId, beamWidths, maxRolloutMoves, deadline);
    if (lookaheadExtraTurns <= 0) return scored[0].move;

    // crossRoundLookahead's "planned own turns this round" (2026-09-16, "AI LV5"): computed ONCE here,
    // from `state` (before ANY of the beamWidth candidates' own moves), not per-candidate -- see this
    // option's own constructor doc. Using the pre-move count keeps the trigger condition identical across
    // every candidate being compared in this one decision (a candidate that happens to place vs. pass a
    // die would otherwise see a slightly different post-move dice count, which must NOT change which
    // candidates get the round-crossing treatment -- see #rolloutScore's own doc on why this also has to
    // stay fixed even if a bonus die shows up mid-rollout).
    let plannedOwnTurnsThisRound = null;
    if (this.crossRoundLookahead && state.round >= 1 && state.round <= 3) {
      const player = state.players.find((p) => p.id === playerId);
      const ownUnplacedDiceCount = player.dice.filter((d) => d.placedMapId === null && !d.passed).length;
      if (ownUnplacedDiceCount <= lookaheadExtraTurns) plannedOwnTurnsThisRound = ownUnplacedDiceCount;
    }

    let best = scored[0].move;
    let bestDeepScore = -Infinity;
    for (const candidate of deduped.slice(0, beamWidth)) {
      // Once the time budget is already spent, don't start yet another candidate's rollout -- keep
      // whichever candidate (rolled-out or, worst case, the plain 1-ply best) is already `best`.
      if (Date.now() > deadline) break;
      const deepScore = this.#rolloutScore(candidate.resultState, playerId, candidate.move, lookaheadExtraTurns, maxRolloutMoves, deadline, plannedOwnTurnsThisRound);
      if (deepScore > bestDeepScore) {
        bestDeepScore = deepScore;
        best = candidate.move;
      }
    }
    return best;
  }

  /** AI LV5 only (crossRoundLookahead): randomly fast-forwards every player OTHER than playerId through
   * ALL of their remaining round dice -- no free actions, no BARE_TAP, just a uniformly-random pick among
   * PLACE_DIE/PLACE_WILDCARD_DIE/PLACE_DICE_GROUP/PASS_DIE each step, then END_TURN once they have none
   * left -- until it's genuinely playerId's own turn again. Since playerId's own dice for this round are
   * already exhausted by the time this is called (see #rolloutScore's own call site), that can only mean
   * the round has actually advanced (simulator.js's own END_TURN handling calls endRound/startRound the
   * moment isRoundOver() goes true, exactly as it would in a real game) -- this is purely a cheap stand-in
   * for "let the other 3 players finish their turns" so the round genuinely ends, not an attempt to play
   * them well (this rollout still never tries to predict what an opponent would actually choose).
   * `#checkForcedMoves` is still honored for each opponent (BZ/JOB004/etc. are mandatory board-state
   * corrections, not discretionary "free actions" in the sense the user meant to exclude here) --
   * skipping those could leave a player stuck unable to reach END_TURN at all.
   * @returns {GameState|null} the state once it's playerId's turn again, or null if this got stuck (no
   *   legal move for some opponent, e.g. an unpayable USAGE_FEE with RESOURCE_TOTAL_LIMIT blocking
   *   END_TURN and no free action allowed to fix it) or ran past the deadline/safety step cap -- callers
   *   fall back to stopping the rollout where it already was, same as if crossRoundLookahead were off. */
  #forceOpponentsFinishRound(state, playerId, deadline) {
    const MAX_STEPS = 300; // safety valve -- a real round never needs anywhere near this many individual moves
    let openTurnPlayerId = null;
    let openTurnHasPlacedDie = false;
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      if (Date.now() > deadline) return null;
      if (state.phase === 'GAME_END') return null;
      const next = turnFlow.getNextTurn(state);
      if (next.type === 'TURN' && next.playerId === playerId) return state; // round has genuinely advanced
      if (next.type === 'ONBOARDING_NEEDED') {
        // Round 1 only (turnFlow.getNextTurn's own gate): an opponent who hasn't taken their first turn
        // yet needs JOB/CON/initial-resources resolved before they can place any dice at all -- same
        // uniform-random pick LV1-3's own onboarding already uses (game-runner.js#driveOnboarding),
        // matching this whole mechanism's "cheap, not trying to play opponents well" philosophy.
        const gameRunner = require('./game-runner');
        gameRunner.driveOnboarding(state, this.index, next.playerId, this.evaluator);
        continue;
      }
      if (next.type === 'ROUND_OVER') {
        // Every player's dice are already placed/passed, but the actual endRound()/startRound()
        // transition only happens as a side effect of simulator.js processing an END_TURN move (see its
        // own END_TURN case) -- if the very last die across all 4 players got placed/passed WITHOUT that
        // same step also being (or immediately triggering) an END_TURN, getNextTurn briefly reports this
        // gap state instead of TURN for anyone. Same defensive fallback game-runner.js's own playGame
        // loop already has for this ("not expected to fire in practice" there, but does fire here since
        // this loop's random dice-move-first ordering routinely places an opponent's last die a step
        // before their own END_TURN).
        turnFlow.endRound(state, this.index);
        if (state.phase !== 'GAME_END') turnFlow.startRound(state);
        continue;
      }
      if (next.type !== 'TURN') return null; // ONBOARDING_NEEDED already handled above -- shouldn't reach here
      const opponentId = next.playerId;
      const context = { hasPlacedDieThisTurn: opponentId === openTurnPlayerId ? openTurnHasPlacedDie : false };
      const forcedMove = this.#checkForcedMoves(state, opponentId, context);
      // Candidates to try, forced move first if any, then a shuffled run of the dice moves, then a bare
      // END_TURN as the last resort -- a BUILD-carrying PLACE_DIE's own buildCandidateIndex can fail
      // INSUFFICIENT_RESOURCES on apply despite MoveGenerator having offered it (the same defensive
      // "should only ever offer legal moves, but don't treat a miss as fatal" tolerance selectMove's own
      // 1-ply scoring loop already has -- see its own comment), so a single random pick with no retry was
      // aborting this whole cross-round attempt on what's really just one candidate's bad luck.
      let candidateMoves;
      if (forcedMove) {
        candidateMoves = [forcedMove];
      } else {
        const moves = this.moveGenerator.generateMoves(state, this.index, opponentId, context);
        const diceMoves = rng.shuffle(state.rng, moves.filter((m) => DICE_MOVE_TYPES.has(m.type)));
        const endTurnMove = moves.find((m) => m.type === 'END_TURN');
        candidateMoves = endTurnMove ? [...diceMoves, endTurnMove] : diceMoves;
      }
      let applied = null;
      for (const candidate of candidateMoves) {
        const { state: nextState, result } = this.simulator.apply(state, this.index, candidate);
        if (result.success) { applied = { move: candidate, nextState }; break; }
      }
      if (!applied) return null; // stuck -- every candidate failed (or none existed) for this opponent
      state = applied.nextState;
      if (DICE_MOVE_TYPES.has(applied.move.type)) { openTurnPlayerId = opponentId; openTurnHasPlacedDie = true; }
      else if (applied.move.type === 'END_TURN') { openTurnPlayerId = null; openTurnHasPlacedDie = false; }
    }
    return null;
  }

  /** Continues playing playerId's own moves, 1-ply greedy from here on (no further branching -- see
   * this class's own doc for why), through the rest of the current turn and lookaheadExtraTurns more of
   * their own turns, then scores the resulting state. `firstMove` is the move that produced `state`,
   * used only to seed hasPlacedDieThisTurn/turnsLeft correctly for the very first step. lookaheadExtraTurns/
   * maxRolloutMoves are passed in explicitly (2026-08-10, not read from `this`) since selectMove now
   * resolves them per-round via #effectiveOptions -- see roundOverrides' own doc.
   *
   * plannedOwnTurnsThisRound (2026-09-16, "AI LV5"/crossRoundLookahead, null for LV1-4): computed ONCE by
   * selectMove from the state BEFORE any of this decision's beamWidth candidates were applied (see that
   * call site's own doc for why it must be fixed up front rather than re-checked here) -- the exact
   * number of this player's own turns to play out in the CURRENT round before treating the round as
   * "over" for this rollout's purposes, regardless of how many unplaced dice this player actually still
   * has by then (e.g. a bonus color die picked up mid-rollout must NOT change this count, or two
   * candidates that differ only in "gained a bonus die or not" would end up scored against DIFFERENT
   * rounds' eval columns -- a comparison the user specifically flagged as unfair). Once that many of this
   * player's own turns have completed, #forceOpponentsFinishRound is used to genuinely finish the round
   * (the other 3 seats play out their own remaining dice randomly), then exactly 1 further turn of this
   * player's own (real, evaluated, free-actions-allowed) play continues in the new round before stopping
   * -- never more than 1, regardless of how much of the original lookaheadExtraTurns budget is left
   * unspent (confirmed with the user: "残りダイス1個でも追加ターンは1つだけ"). Left null, this parameter
   * changes nothing -- #rolloutScore behaves exactly as it did before this option existed. */
  #rolloutScore(state, playerId, firstMove, lookaheadExtraTurns, maxRolloutMoves, deadline, plannedOwnTurnsThisRound = null) {
    // JOB003/道化 (2026-08-20 fix, per user bug report -- see game-runner.js driveTurn's matching comment
    // for the full story): PLACE_WILDCARD_DIE counts as "placed a die this turn" too, both here and below.
    let hasPlacedDieThisTurn = firstMove.type === 'PLACE_DIE' || firstMove.type === 'PLACE_WILDCARD_DIE' || firstMove.type === 'PLACE_DICE_GROUP' || firstMove.type === 'PASS_DIE';
    let turnsLeft = lookaheadExtraTurns;
    // AI LV5 only (plannedOwnTurnsThisRound !== null): counts this player's own completed turns since
    // this rollout started, compared against the fixed plan (see this method's own doc) rather than the
    // dynamic per-step hasAnyUnplacedDie check below. crossedRoundTurnsRemaining starts null (not yet
    // crossed); once #forceOpponentsFinishRound succeeds it's set to 1, counting down to a hard stop
    // after exactly that many further turns of this player's own play, regardless of turnsLeft/dice state.
    let ownTurnsCompletedThisRound = 0;
    let crossedRoundTurnsRemaining = null;
    let steps = 0;
    while (steps < maxRolloutMoves) {
      // GAME_END guard (2026-09-14, per user report of a 40-56s decision, root-caused via a replay
      // where round 4's last few dice took tens of seconds despite having no legal way to gain more
      // dice or untap anything): this own-turns-only rollout (see this class's own top-of-file doc on
      // why opponents aren't simulated) never advances any OTHER player's turn, so once THIS player's
      // own END_TURN makes turnFlow.isRoundOver() look true (every player, opponents included, frozen
      // at "no unplaced dice left" -- trivially true once this is genuinely the last player still
      // placing dice in round 4), simulator.js's own END_TURN handling calls turnFlow.endRound()
      // for real: it unconditionally untaps EVERY owned card and returns EVERY die to "unplaced"
      // before checking state.round >= 4 and only THEN setting state.phase to GAME_END. Without this
      // check, the loop below can't tell that happened -- it just sees a state with plenty of
      // untapped cards and unplaced dice again and keeps "playing" up to lookaheadExtraTurns more
      // fictional turns through a game that has already ended, repeating this reset (confirmed via
      // instrumentation: 186 separate endRound() firings in one single selectMove call) and paying the
      // full cost of #bareTapMoves' die-value-change reachability scan (#dieReachableOutcomes) fresh
      // each time for cards that only exist as untapped because of this loop -- none of which
      // corresponds to anything that can happen in the real game. Checked at the very top, before
      // #greedyMove/simulator.apply even run for this step, since anything past GAME_END is pure
      // fiction the evaluator should just score as-is rather than build on.
      if (state.phase === 'GAME_END') break;
      // Hard wall-clock cap (see constructor's own maxDecisionTimeMs doc) -- a safety net for whatever
      // OTHER expensive-but-legal exploration this own-turns-only rollout might still find (e.g. the
      // legitimate multi-map resource-generation chains found during the same investigation), on top
      // of the GAME_END fix above rather than instead of it.
      if (Date.now() > deadline) break;
      steps++;
      const move = this.#greedyMove(state, playerId, hasPlacedDieThisTurn);
      if (!move) break; // nothing legal (shouldn't normally happen -- canEndTurn eventually frees this up)
      const { state: nextState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) break; // defensive, same as selectMove's own loop
      state = nextState;
      if (move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP' || move.type === 'PASS_DIE') hasPlacedDieThisTurn = true;
      if (move.type === 'END_TURN') {
        // AI LV5's post-crossing turn: exactly crossedRoundTurnsRemaining more turns, full stop after
        // that regardless of turnsLeft or dice state (see this method's own doc -- "残りダイス1個でも
        // 追加ターンは1つだけ").
        if (crossedRoundTurnsRemaining !== null) {
          crossedRoundTurnsRemaining--;
          if (crossedRoundTurnsRemaining <= 0) break;
          hasPlacedDieThisTurn = false;
          continue;
        }
        if (turnsLeft <= 0) break; // rollout horizon reached right at a turn boundary
        ownTurnsCompletedThisRound++;
        // AI LV5's fixed plan (see this method's own doc for why this must be a precomputed count, not a
        // live hasAnyUnplacedDie re-check): once this player's own committed turns for the CURRENT round
        // are done, try to genuinely finish the round (other 3 seats resolved randomly) and continue for
        // exactly 1 more turn in the new round instead of just stopping here.
        if (plannedOwnTurnsThisRound !== null && ownTurnsCompletedThisRound >= plannedOwnTurnsThisRound) {
          const crossedState = this.#forceOpponentsFinishRound(state, playerId, deadline);
          if (crossedState) {
            state = crossedState;
            crossedRoundTurnsRemaining = 1;
            hasPlacedDieThisTurn = false;
            continue;
          }
          break; // couldn't force the crossing (stuck/timeout) -- fall back to stopping here, as LV1-4 would
        }
        // Stop simulating further "own future turns" once this player has no unplaced dice left at all
        // (2026-09-14, per user report: watching a replay, the AI spent tens of seconds on its very LAST
        // real die because the rollout kept simulating up to lookaheadExtraTurns more "own turns" even
        // after dice ran out -- with 0 unplaced dice, there is nothing left to do this round except chase
        // owned-card TAP/untap chains, which this own-turns-only rollout (see this class's own top-of-
        // file doc on why opponents aren't simulated) would keep re-exploring as if this player's next
        // turn were immediately available again, when in the real game the other 3 players (and likely
        // the round itself) go first -- burning real computation for lookahead that doesn't correspond to
        // anything that will realistically happen soon). Checked here, not before choosing `move` itself,
        // so the CURRENT turn's own last legitimate actions (a die-free TAP, END_TURN itself) are always
        // still taken -- only ADDITIONAL turns beyond this one get skipped. Array.isArray guard: a real
        // GameState always has `.players`, but tests/ai-player.smoke.js's own lightweight lookahead stubs
        // (plain {path, turn1Score, ...} objects, no `.players` at all) don't -- falls back to the old
        // "keep going" behavior for anything that doesn't look like a real GameState, rather than
        // misreading "no players field" as "no dice left" and cutting a stub's own simulated turn short.
        const currentPlayer = Array.isArray(state.players) && state.players.find((p) => p.id === playerId);
        const hasAnyUnplacedDie = !Array.isArray(state.players) || (currentPlayer && currentPlayer.dice.some((d) => d.placedMapId === null && !d.passed));
        if (!hasAnyUnplacedDie) break;
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

  /** Genuine multi-ply NARROWING beam search (2026-09-13, per user request: "5→3→2→2→1のようにできない
   * か" -- unlike #rolloutScore/selectMove's own beamWidth+lookaheadExtraTurns combo above, which expands
   * each of `beamWidth` 1-ply candidates via ONE single-path GREEDY rollout each (branching factor 1 past
   * the very first ply), this keeps `beamWidths[i]` distinct candidate lineages alive at EVERY ply, one
   * ply per own turn (matching how the user described this: "1自分のターンごと"). `beamWidths=[5,3,2,2,1]`
   * means: the 5 best root candidates (already 1-ply-scored+deduped by the caller) survive; each one's own
   * turn is completed greedily (#finishTurnGreedy -- branching happens at TURN boundaries only, not within
   * a turn's own die-placement/build-choice/etc. sequence); their combined next-turn children are pooled
   * and narrowed to the GLOBAL top 3 (not top-3-per-parent, standard beam search); this repeats down to 2,
   * then 2 again, then the single best of THOSE becomes the final answer -- the root move whose lineage it
   * descends from is what selectMove actually returns and plays now.
   *
   * Cost is roughly sum(beamWidths[i] * avg-legal-moves-per-turn) rather than beamWidth*lookaheadExtraTurns
   * *rollout-steps-per-turn -- for the [5,3,2,2,1] example this is typically CHEAPER than a wide/long
   * single-path rollout while actually keeping multiple live alternatives instead of committing to one
   * greedy path after the first choice (see this class's own top-of-file doc on why the OLD rollout can
   * cheaply widen breadth at ply 1 but never regains any branching after that).
   *
   * A fully separate code path from #rolloutScore/#finishTurnGreedy-less rollout on purpose -- no existing
   * level (LV1-4) sets `beamWidths`, so none of their behavior changes by so much as a rounding difference.
   * maxRolloutMoves here is a PER-TURN safety valve (this method's own #finishTurnGreedy call), not the
   * single PER-ROLLOUT total budget #rolloutScore's own maxRolloutMoves is -- a deliberately simpler,
   * separate semantic for this separate method, not a change to the old one. */
  #deepBeamSearch(rootCandidates, playerId, beamWidths, maxRolloutMoves) {
    let beam = rootCandidates.slice(0, beamWidths[0]).map((c) => ({
      rootMove: c.move,
      turnEndState: this.#finishTurnGreedy(c.resultState, playerId, this.#startedTurn(c.move), maxRolloutMoves),
    }));

    for (let ply = 1; ply < beamWidths.length; ply++) {
      const frontier = [];
      for (const node of beam) {
        for (const c of this.#firstMoveCandidatesForTurn(node.turnEndState, playerId)) {
          frontier.push({ rootMove: node.rootMove, score: c.score, resultState: c.resultState, move: c.move });
        }
      }
      if (frontier.length === 0) break; // every surviving lineage ran out of legal moves (round/game end)
      frontier.sort((a, b) => b.score - a.score);
      beam = frontier.slice(0, beamWidths[ply]).map((s) => ({
        rootMove: s.rootMove,
        turnEndState: this.#finishTurnGreedy(s.resultState, playerId, this.#startedTurn(s.move), maxRolloutMoves),
      }));
    }

    let best = beam[0];
    let bestScore = this.evaluator.score(best.turnEndState, playerId);
    for (const node of beam.slice(1)) {
      const score = this.evaluator.score(node.turnEndState, playerId);
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best.rootMove;
  }

  /** Whether `move` counts as "this turn's die has been placed" -- same predicate #rolloutScore/driveTurn
   * already use in a few places, factored out here since #deepBeamSearch needs it at two call sites. */
  #startedTurn(move) {
    return move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP' || move.type === 'PASS_DIE';
  }

  /** Plays out the REST of the current turn only (never more than one turn, unlike #rolloutScore which
   * keeps going for lookaheadExtraTurns more) via #greedyMove, starting from `state` with
   * `hasPlacedDieThisTurn` already known. Stops once the turn actually ends (END_TURN) or maxRolloutMoves
   * (a per-turn cap here, see #deepBeamSearch's own doc) is hit. */
  #finishTurnGreedy(state, playerId, hasPlacedDieThisTurn, maxRolloutMoves) {
    let steps = 0;
    while (steps < maxRolloutMoves) {
      steps++;
      const move = this.#greedyMove(state, playerId, hasPlacedDieThisTurn);
      if (!move) break;
      const { state: nextState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) break;
      state = nextState;
      if (this.#startedTurn(move)) hasPlacedDieThisTurn = true;
      if (move.type === 'END_TURN') break;
    }
    return state;
  }

  /** Generates+scores+dedupes candidates for the FIRST move of a NEW turn from `state` (a turn-ending
   * state) -- same forced-move-check+generate+score logic as selectMove's own top-level candidate pass
   * (including the exact-score dedup, see selectMove's own doc on why), reused by #deepBeamSearch to
   * expand one ply. A brand-new turn always starts with hasPlacedDieThisTurn:false, same convention
   * #rolloutScore's own turn-boundary handling uses. */
  #firstMoveCandidatesForTurn(state, playerId) {
    const context = { hasPlacedDieThisTurn: false };
    const forcedMove = this.#checkForcedMoves(state, playerId, context);
    if (forcedMove) {
      const { state: resultState, result } = this.simulator.apply(state, this.index, forcedMove);
      if (!result.success) return [];
      return [{ move: forcedMove, resultState, score: this.evaluator.score(resultState, playerId) }];
    }
    const moves = this.moveGenerator.generateMoves(state, this.index, playerId, context);
    const scored = [];
    for (const move of moves) {
      const { state: resultState, result } = this.simulator.apply(state, this.index, move);
      if (!result.success) continue;
      scored.push({ move, resultState, score: this.evaluator.score(resultState, playerId) });
    }
    scored.sort((a, b) => b.score - a.score);
    const deduped = [];
    let lastScore = null;
    for (const candidate of scored) {
      if (candidate.score === lastScore) continue;
      deduped.push(candidate);
      lastScore = candidate.score;
    }
    return deduped;
  }
}

module.exports = { AIPlayer };

})();
