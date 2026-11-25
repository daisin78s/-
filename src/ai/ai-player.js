(function () {
'use strict';

const { compareDicePriority } = require('./die-priority');
const { compareExSlotPreference } = require('./slot-priority');
const turnFlow = require('../turn-flow');
const rng = require('../rng');
const executor = require('../executor');
const scoring = require('../scoring');
// AIの読みの中のコピーは、カードを変わった物だけ写す(game-state.jsのcloneStateCow参照)。
const { cloneStateCow: cloneState, writableCard } = require('../game-state');
const endgameCardKeys = new WeakMap(); // カード -> 目印用の文字 (AIPlayer.#endgameKey)
const { applyInPlace } = require('./simulator');
const { bareTapKind } = require('./move-generator');
const { getCardRow } = require('../data-loader');
const { parse } = require('../dsl-parser');
const { lowerProgram } = require('../command-builder');
// ダイスの目を変える/☆にするだけのタップ(基礎学問・高等学問・幾何学)。#isPointlessDieTap参照。
const DIE_ONLY_TAP_KINDS = new Set(['SET_DICE_ANY', 'SET_DIE_VALUE', 'CHANGE_DIE_VALUE', 'SET_WILDCARD']);

// "AI LV5" cross-round lookahead (see AIPlayer's own crossRoundLookahead option doc): a solo dice-move
// candidate is exactly one of these 4 move types (matches the same list #rolloutScore's own
// hasPlacedDieThisTurn tracking already checks for).
const DICE_MOVE_TYPES = new Set(['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE']);

/** 考える時に使う軽い盤面(浅いコピー、元のstateは変えない): ログ・進み具合の記録・「ターン開始に戻す」用の控え・各プレイヤーの
 * 人生の記録(lifeStoryLog、ランキングの「人生」を見る画面用)を外す。ゲームの決まりはどれも読まないので選ぶ手は変わらない。
 * (lifeStoryLogは2026-11-24から、per user「(AIを早くする案)すべて」 -- 終盤には盤面の約1割5分の大きさになり、AIが盤面を
 * コピーするたびに一緒に写していた。) */
function lightState(state) {
  const players = Array.isArray(state.players)
    ? state.players.map((p) => (p && Array.isArray(p.lifeStoryLog) && p.lifeStoryLog.length > 0 ? { ...p, lifeStoryLog: [] } : p))
    : state.players;
  return { ...state, log: [], progressLog: [], undoCheckpoint: null, players };
}

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
    // 終盤の読み切り (2026-11-24, per user「終盤全検索すれば見つけれる順だと思います」): R4では、この時間(ms)だけ
    // 自分の手を全部調べて(相手は動かない=邪魔なし)、ゲーム終了時の点が一番高い道の最初の手を選ぶ。0なら使わない
    // (進化AIなど、たくさん試合を打つ所では使わない -- main.jsのナビ・対戦相手のLV3だけが使う)。
    this.endgameSearchMs = opts.endgameSearchMs || 0;
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
    // 使用料はすぐ取る(暴食などで上限のある資源は除く -- move-generator.jsのforcedImmediateFeeMove参照、2026-11-23)。
    const forcedFee = this.moveGenerator.forcedImmediateFeeMove ? this.moveGenerator.forcedImmediateFeeMove(state, this.index, playerId) : null;
    if (forcedFee) return forcedFee;
    const forcedPureGainC = this.moveGenerator.forcedPureGainCTap(state, this.index, playerId);
    if (forcedPureGainC) return forcedPureGainC;
    const forcedFeeConversion = this.moveGenerator.forcedFeeConversionMove(state, this.index, playerId);
    if (forcedFeeConversion) return forcedFeeConversion;
    const forcedLustPowerBrokerAK = this.moveGenerator.forcedLustPowerBrokerAKMove(state, this.index, playerId);
    if (forcedLustPowerBrokerAK) return forcedLustPowerBrokerAK;
    const forced = this.moveGenerator.forcedBzConversionMove(state, this.index, playerId, context,
      (before, candidates) => this.#chooseCourtierTap(before, playerId, context, candidates));
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

  /** 宮廷人(MONUMENT_CHANGE_DIE_VALUE-shaped BZ tap) -- which die to +6 (2026-10-29, per user request:
   * "AIが宮廷人を正しく使えるように" -> agreed: pick the die whose tap leads to the best build, and "2Rいこうで
   * 同じモニュメントを選ぶなら小さい目から使う" -- keep the big dice for later). For every candidate tap
   * (each die, or skipDieChange) and every affordable build move after it, the build's result is scored
   * by this.evaluator; the best-scoring build's outcome (which card gets built/upgraded) is the target.
   * From round 2, among every (tap, build) pair reaching that same outcome, the one spending the die(s)
   * with the smallest ORIGINAL value wins (round 1: the best-scoring pair). At the top level the chosen
   * build is remembered as #plannedCourtierBuild so selectMove's very next call places that exact die
   * (otherwise the normal search could put a different, bigger die on the same card). */
  #chooseCourtierTap(before, playerId, context, candidates) {
    const player = before.players.find((p) => p.id === playerId);
    const originalValue = (dieId) => {
      const die = player && player.dice.find((d) => d.id === dieId);
      return die && typeof die.value === 'number' ? die.value : 99;
    };
    const facesOf = (st) => {
      const p = st.players.find((pl) => pl.id === playerId);
      return p.ownedCardPhysicalIds.map((id) => `${id}:${st.cards[id] && st.cards[id].currentFaceId}`);
    };
    const pairs = [];
    for (const candidate of candidates) {
      const facesBefore = new Set(facesOf(candidate.clone));
      const buildMoves = this.moveGenerator.generateMoves(candidate.clone, this.index, playerId, context)
        .filter((m) => m.buildCandidateIndex !== undefined);
      for (const buildMove of buildMoves) {
        const { state: resultState, result } = this.simulator.apply(candidate.clone, this.index, buildMove);
        if (!result.success) continue;
        const outcome = facesOf(resultState).filter((f) => !facesBefore.has(f)).map((f) => f.split(':')[1]).sort().join(',');
        const dieIds = buildMove.dieIds || (buildMove.dieId ? [buildMove.dieId] : []);
        // +5したダイスを使わずに建てる組み合わせは候補にしない (2026-11-15, per user「なおして」-- +5は置かないと
        // 手番の終わりに戻るので無駄になる。同じものを別のダイスで建てるなら、+5しない(skipDieChange)の候補が
        // 同じ手を持っている)。
        if (candidate.move.chosenDieId && !dieIds.includes(candidate.move.chosenDieId)) continue;
        const spent = dieIds.reduce((sum, id) => sum + originalValue(id), 0);
        pairs.push({ candidate, buildMove, outcome, spent, score: this.evaluator.score(resultState, playerId) });
      }
    }
    if (pairs.length === 0) return null;
    let best = pairs[0];
    for (const pair of pairs) if (pair.score > best.score) best = pair;
    if (before.round >= 2) {
      for (const pair of pairs) {
        if (pair.outcome === best.outcome && pair.spent < best.spent) best = pair;
      }
    }
    if (this.#topLevelDecision) this.#plannedCourtierBuild = { playerId, tapMove: best.candidate.move, buildMove: best.buildMove };
    return best.candidate.move;
  }

  #topLevelDecision = false;
  #plannedCourtierBuild = null;

  /**
   * @param {GameState} state
   * @param {string} playerId
   * @param {{hasPlacedDieThisTurn: boolean}} context - see move-generator.js's own doc
   * @returns {Object|null} the single best legal Move, or null if none exist
   */
  selectMove(state, playerId, context) {
    this.lastEndgame = null; // 終盤の読み切りの結果(点・手順)。読み切りをしなかった時はnull
    // 上限の無い資源の使用料は、R4の読み切りの前でも必ず先に取る (2026-11-24, per user のナビのバグ報告「使用料をすぐ取らない
    // とった後に推奨の手が変わる」-- R1〜R3は#checkForcedMovesで先に取るが、R4の読み切りはその前に手順を返していたので、
    // 使用料を後回しにする手順を勧めることがあった。先に取って損をすることは無い)。
    if (state.round >= 4 && state.phase !== 'GAME_END' && Array.isArray(state.players) && this.moveGenerator.forcedImmediateFeeMove) {
      const fee = this.moveGenerator.forcedImmediateFeeMove(state, this.index, playerId);
      if (fee) return fee;
      // タダで資源が増えるだけのカード(軍団長・皇女・貴族など、MoveGeneratorのforcedPureGainCTap)も同じく先にタップする
      // (2026-11-24, per user「同じ局面 軍団長も すぐに使っていいのでは」-- R4の読み切りはこれも最後に回していた。軍団長は
      // 白ダイスが増えるので、先に使えばこの手番から置けるダイスの選び方が広がる)。
      if (this.moveGenerator.forcedPureGainCTap) {
        const gain = this.moveGenerator.forcedPureGainCTap(state, this.index, playerId);
        if (gain) return gain;
      }
    }
    if (this.endgameSearchMs > 0 && state.round >= 4 && state.phase !== 'GAME_END' && Array.isArray(state.players)) {
      const placed = !!(context && context.hasPlacedDieThisTurn);
      // 前の読み切りで見つけた手順のとおりに盤面が進んでいれば、読み直さずに次の手を出す(2026-11-24, per user
      // 「1から」-- 自分の手番の間は相手が動かないので、読み切った手順はそのまま使える。R4の待ち時間が1手ごとに最大3秒
      // から、だいたい1手番に1回になる)。
      // 読み切れなかった(時間切れの)手順なら、短い時間(1/3)だけ読み直して、もっと点の高い手順が見つかった時だけ乗り換える。
      // context.endgameShard {index, count}: 複数のWorkerで手分けして読む時の自分の受け持ち(main.jsのaiWorkerSelectMove参照)。
      // 結果(点・手順)はlastEndgameに残し、main.jsが一番良いものを選んでadoptEndgamePlanで全員に覚えさせる。
      const shard = context && context.endgameShard;
      const planned = this.#nextPlannedEndgameStep(state, playerId, placed);
      if (planned && planned.plan.exact) {
        this.#plannedUntap = planned.step.untap;
        this.lastEndgame = { v: planned.plan.v, plan: planned.plan, reused: true };
        return planned.step.m;
      }
      const r = this.#endgameSearch(state, playerId, placed, planned ? this.endgameSearchMs / 3 : this.endgameSearchMs, shard);
      if (planned && !(r && r.v > planned.plan.v)) {
        this.#plannedUntap = planned.step.untap;
        this.lastEndgame = { v: planned.plan.v, plan: planned.plan, reused: true };
        return planned.step.m;
      }
      if (r) {
        this.#plannedUntap = r.untap;
        const plan = { steps: r.plan, v: r.v, exact: r.exact };
        this.#endgamePlans.set(playerId, plan);
        this.lastEndgame = { v: r.v, plan, reused: false };
        return r.move;
      }
    }
    // 考える時は、ログ・進み具合の記録・「ターン開始に戻す」用の控え(盤面の約半分の大きさ)を外した軽い盤面を使う
    // (2026-11-23, per user「これらは可能ならすべてやって」-- AIは盤面をたくさんコピーして手を試すので、要らない物まで毎回
    // コピーしていた。ゲームの決まりはこれらを読まないので、選ぶ手は変わらない)。元のstateは変えない(浅いコピー)。
    state = lightState(state);
    const move = this.#selectMoveInner(state, playerId, context, false);
    // 目を変えるだけのタップを選んだのに、その次に置く手がタップなしでも同じ結果(同じエリア・同じカード)になる
    // なら、タップはやめて考え直す (2026-11-23, per user「ナビ使っていますが AIが基礎学問 高等学問を全く意味なく
    // 使おうとします」「☆ダイスにしてANYマスに置いた」)。
    if (move && this.#isPointlessDieTap(state, playerId, context, move)) {
      return this.#selectMoveInner(state, playerId, context, true) || move;
    }
    const placeFirst = move ? this.#betterToPlaceBeforeConversionTap(state, playerId, context, move) : null;
    if (placeFirst) return placeFirst;
    return move;
  }

  /** 資源を替えるタップ(学者のCHANGE(K,B,7)のような、持っている分だけ替えるCHANGE)を、この手番でまだダイスを置く前に選んだ時:
   * 「先にダイスを置いてからタップ」の方がこの手番の終わりの点が高ければ、その置く手を返す(2026-11-24, per user のナビのバグ報告
   * 「推奨の手が変換してから食料を取るになっているため効率が悪い」-- 1Kしか無いのに学者をタップして1Bにし、そのあと小麦畑で6K
   * 取っていた。先に6K取ってからタップすれば7Bに替えられる)。比べるのはこの手番の終わりの盤面だけ(先読みの続きの打ち方の
   * 当たり外れで順番が決まらないように)。そうでなければnull。 */
  /** 目を変えるだけのタップ(基礎学問・高等学問・幾何学)の後、置く手の中で一番良い点(無ければ-Infinity)。 */
  #bestPlacementAfterDieTap(state, afterTap, playerId, move) {
    const card = state.cards && state.cards[move.physicalId];
    const tap = card && bareTapKind(this.index, card.currentFaceId);
    if (!tap || !DIE_ONLY_TAP_KINDS.has(tap.kind)) return -Infinity;
    let best = -Infinity;
    for (const next of this.moveGenerator.generateMoves(afterTap, this.index, playerId, { hasPlacedDieThisTurn: false })) {
      if (!DICE_MOVE_TYPES.has(next.type) || next.type === 'PASS_DIE') continue;
      const r = this.simulator.apply(afterTap, this.index, next);
      if (!r.result.success) continue;
      const v = this.evaluator.score(this.#resolveUntapChoiceQuick(r.state, playerId, true), playerId);
      if (v > best) best = v;
    }
    return best;
  }

  #betterToPlaceBeforeConversionTap(state, playerId, context, move) {
    if (move.type !== 'BARE_TAP' || (context && context.hasPlacedDieThisTurn)) return null;
    const card = state.cards && state.cards[move.physicalId];
    if (!card) return null;
    let commands;
    try { commands = lowerProgram(parse(getCardRow(this.index, card.currentFaceId).TAP || '')); } catch (e) { return null; }
    if (!commands.length || !commands.every((c) => c.type === 'CHANGE' && c.times && (c.times.kind === 'capped' || c.times.kind === 'all'))) return null;
    const MAX = 40;
    const tapFirst = this.simulator.apply(state, this.index, move);
    if (!tapFirst.result.success) return null;
    const tapFirstScore = this.evaluator.score(this.#finishTurnGreedy(tapFirst.state, playerId, false, MAX), playerId);
    // タップを除いた中で一番良い置く手を先に打ち、そのあとタップしてから手番の残りを打つ。
    const placements = this.moveGenerator.generateMoves(state, this.index, playerId, { hasPlacedDieThisTurn: false })
      .filter((m) => DICE_MOVE_TYPES.has(m.type) && m.type !== 'PASS_DIE');
    let best = null;
    for (const placement of placements) {
      const placed = this.simulator.apply(state, this.index, placement);
      if (!placed.result.success) continue;
      const tapped = this.simulator.apply(placed.state, this.index, { ...move });
      if (!tapped.result.success) continue;
      const score = this.evaluator.score(this.#finishTurnGreedy(tapped.state, playerId, true, MAX), playerId);
      if (!best || score > best.score) best = { placement, score };
    }
    return best && best.score > tapFirstScore ? best.placement : null;
  }

  /** moveが目を変えるだけのタップで、タップした後に(1手先の一番良い手として)置く手が、タップしなくても同じ
   * エリアに置けて同じカードが手に入るものならtrue。 */
  #isPointlessDieTap(state, playerId, context, move) {
    if (move.type !== 'BARE_TAP' || !move.chosenDieId) return false;
    const card = state.cards[move.physicalId];
    const tap = card && bareTapKind(this.index, card.currentFaceId);
    if (!tap || !DIE_ONLY_TAP_KINDS.has(tap.kind)) return false;
    const tapped = this.simulator.apply(state, this.index, move);
    if (!tapped.result.success) return false;
    const next = this.#greedyMove(tapped.state, playerId, !!(context && context.hasPlacedDieThisTurn));
    if (!next || (next.type !== 'PLACE_DIE' && next.type !== 'PLACE_WILDCARD_DIE') || next.dieId !== move.chosenDieId) return false;
    const afterTap = this.simulator.apply(tapped.state, this.index, next);
    if (!afterTap.result.success) return false;
    const goal = this.#placementSignature(afterTap.state, playerId);
    // タップしないで同じダイスを同じエリアのどこかのマスに置き、同じカードを選べるか
    const map = state.maps[next.mapId];
    const slotCount = map && map.slots ? map.slots.length : 0;
    const buildIndexes = next.buildCandidateIndex !== undefined ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [undefined];
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      for (const buildCandidateIndex of buildIndexes) {
        const plain = { type: 'PLACE_DIE', playerId, dieId: move.chosenDieId, mapId: next.mapId, slotIndex, ...(buildCandidateIndex !== undefined ? { buildCandidateIndex } : {}) };
        let r;
        try { r = this.simulator.apply(state, this.index, plain); } catch (e) { continue; }
        if (r.result.success && this.#placementSignature(r.state, playerId) === goal) return true;
      }
    }
    return false;
  }

  #placementSignature(state, playerId) {
    const p = state.players.find((x) => x.id === playerId);
    return p.dice.filter((d) => d.placedMapId).map((d) => `${d.id}@${d.placedMapId}`).sort().join(',') + '|'
      + p.ownedCardPhysicalIds.map((id) => state.cards[id].currentFaceId).sort().join(',');
  }

  #selectMoveInner(state, playerId, context, skipDieOnlyTaps) {
    // 宮廷人をタップした直後: その時に決めたダイスで建てる(#chooseCourtierTap参照)。タップ済みで、その手が
    // 今も成功する時だけ(違う局面なら捨てて普通に考える)。
    const planned = this.#plannedCourtierBuild;
    this.#plannedCourtierBuild = null;
    if (planned && planned.playerId === playerId) {
      const card = state.cards[planned.tapMove.physicalId];
      if (card && card.tapped && this.simulator.apply(state, this.index, planned.buildMove).result.success) return planned.buildMove;
    }
    this.#topLevelDecision = true;
    let forcedAtTop;
    try { forcedAtTop = this.#checkForcedMoves(state, playerId, context); } finally { this.#topLevelDecision = false; }
    if (forcedAtTop) return forcedAtTop;
    let moves = this.moveGenerator.generateMoves(state, this.index, playerId, context);
    if (skipDieOnlyTaps) {
      moves = moves.filter((m) => {
        if (m.type !== 'BARE_TAP') return true;
        const c = state.cards[m.physicalId];
        const t = c && bareTapKind(this.index, c.currentFaceId);
        return !(t && DIE_ONLY_TAP_KINDS.has(t.kind));
      });
    }
    const scored = [];
    for (const move of moves) {
      const applied = this.simulator.apply(state, this.index, move);
      if (!applied.result.success) continue; // defensive -- MoveGenerator should only ever offer legal moves
      // この手でアンタップするカードを選ぶことになる(軍団長LV2・皇女など)なら、選んだ後の盤面で点をつける(2026-11-23)。
      const placedNow = !!(context && context.hasPlacedDieThisTurn) || DICE_MOVE_TYPES.has(move.type);
      const resultState = this.#resolveUntapChoiceQuick(applied.resultState || applied.state, playerId, placedNow);
      let score = this.evaluator.score(resultState, playerId);
      // 目を変えるだけのタップは、タップした直後ではなく「変えたダイスで一番良い置き方をした後」の点で比べる
      // (2026-11-24, per user のナビのバグ報告「ダイス2個で水道橋取れるのに3個で取るのを推奨してくる」-- 幾何学LV2(+4)で
      // 5を9にすれば2個で水道橋が取れるのに、タップ直後は何も建っていないので点が低く、先読みの候補(上位3つ)に入らなかった)。
      // 目を変えたダイスは必ず置く(MoveGeneratorのmustUseChangedDie)ので、タップと置く手はひとまとまり。
      if (!placedNow && move.type === 'BARE_TAP') score = Math.max(score, this.#bestPlacementAfterDieTap(state, resultState, playerId, move));
      scored.push({ move, resultState, score });
    }
    if (scored.length === 0) return null;
    removeDominatedPlacements(scored, state, playerId);
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
    // 2026-11-23から: 点が同じ手に加えて、「同じ考えの手」(同じカードを取る置き方違い・同じエリアに置くダイス違い・同じ
    // カードのタップの対象違い)も、一番点の良いものだけを残す (per user のバグ報告「測量術を使って元老院を取って元老院に
    // 行って皇女をとる手が見えていない」-- 先まで読む3つの枠が全部「黄金宮殿」の置き方違いで埋まり、別の考えの手が読まれな
    // かった + 「微妙な手を読まなくすることで時間を浮かせて先読みできるようにできない？」)。
    const deduped = [];
    let lastScore = null;
    const seenIdeas = new Set();
    for (const candidate of scored) {
      if (candidate.score === lastScore) continue;
      const idea = moveIdeaKey(candidate.move);
      if (seenIdeas.has(idea)) continue;
      seenIdeas.add(idea);
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
        // 使用料をすぐ取るきまり(2026-11-23、move-generator.jsのgenerateMoves参照)で、回収の手だけが返ってくることが
        // ある -- その時は先に回収する(そうしないと置く手が無くて、ここで止まってしまう)。
        const feeMoves = moves.filter((m) => m.type === 'COLLECT_FEE');
        const diceMoves = rng.shuffle(state.rng, moves.filter((m) => DICE_MOVE_TYPES.has(m.type)));
        const endTurnMove = moves.find((m) => m.type === 'END_TURN');
        candidateMoves = feeMoves.length > 0 && diceMoves.length === 0 && !endTurnMove ? feeMoves
          : (endTurnMove ? [...diceMoves, endTurnMove] : diceMoves);
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
      state = this.#resolveUntapChoiceQuick(state, playerId, hasPlacedDieThisTurn);
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
            // ラウンドが変わるとゲームの決まりが「ターン開始に戻す」用の控えを作り直すので、また外して軽くする(selectMove参照)。
            state = lightState(crossedState);
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
  #plannedUntap = null;

  /** 読み切りで決めておいたアンタップの選び方(次のchooseUntapChoiceで使う)。main.jsの裏で考える仕組み(ai-worker.js)が、
   * Worker側で決めた選び方を画面側のAIに渡すために使う。 */
  peekPlannedUntap() { return this.#plannedUntap; }
  setPlannedUntap(untap) { this.#plannedUntap = untap || null; }

  /** 終盤の読み切り (endgameSearchMs参照)。最初の手の候補(1手の点の高い順に8つ)ごとに残り時間を均等に分け、それぞれ
   * 良さそうな手から順に深く調べる(同じ盤面は一度だけ)。ゲーム終了時のP1の点が一番高かった最初の手と、その手で
   * アンタップを選ぶ時の選び方を返す。何も見つからなければnull(いつもの考え方に戻る)。 */
  /** playerId -> 読み切りで見つけた一番良い手順 {steps: [{key(その手を打つ前の盤面の目印), m, untap}], v(その手順の点), exact(時間切れなしで読み切れたか)} */
  #endgamePlans = new Map();

  /** 読み切り用の盤面(軽いコピー、相手のまだ置いていないダイスはパス扱い)。 */
  static #endgameRoot(state0, playerId) {
    const root = cloneState(lightState(state0));
    for (const p of root.players) if (p.id !== playerId) for (const d of p.dice) if (d.placedMapId === null) d.passed = true;
    return root;
  }

  /** 盤面の目印(同じ目印 = 同じ盤面)。cached=true は読み切り②(深く読む)の中だけ: カードは、写さずに共有している物
   * (cloneStateCow)が多いので、カード1枚ごとの文字をそのカードの物に覚えておき使い回す(2026-11-25, per user「まだ スピード
   * アップ の案ある？」→「ぜんぶおねがい」-- 目印作りが読みの時間の約9%で、その半分がカード)。②の盤面は目印を作った後に
   * 書き換えないので覚えた文字は古くならない。その場で打ち進める①(#endgameRollout)と、覚えた手順の照合ではcached=false。
   * どちらも同じ形の文字になる。 */
  static #endgameKey(s, placed, cached = false) {
    let cards = '';
    for (const id in s.cards) {
      const c = s.cards[id];
      let t = cached && c ? endgameCardKeys.get(c) : undefined;
      if (t === undefined) {
        t = JSON.stringify(c);
        if (cached && c) endgameCardKeys.set(c, t);
      }
      cards += `${id}:${t},`;
    }
    return JSON.stringify([placed, s.players, s.maps, s.shops, s.phase, s.round, s.pendingChoices]) + cards;
  }

  /** 手分けして読んだ時、一番良かった手順をこのAIにも覚えさせる(main.jsから)。 */
  adoptEndgamePlan(playerId, plan) {
    if (plan && Array.isArray(plan.steps)) this.#endgamePlans.set(playerId, plan);
    else this.#endgamePlans.delete(playerId);
  }

  /** 今の盤面が、覚えている手順のどこかの「手を打つ前」と同じなら、その手を返す。違えば手順を捨ててnull。 */
  #nextPlannedEndgameStep(state, playerId, placed) {
    const plan = this.#endgamePlans.get(playerId);
    if (!plan) return null;
    const key = AIPlayer.#endgameKey(AIPlayer.#endgameRoot(state, playerId), placed);
    const step = plan.steps.find((st) => st.key === key);
    if (!step) { this.#endgamePlans.delete(playerId); return null; }
    return { step, plan };
  }

  #endgameSearch(state0, playerId, placed0, limitMs, shard = null) {
    const mine = (i) => !shard || shard.count <= 1 || i % shard.count === shard.index; // 手分けの受け持ち
    const t0 = Date.now();
    const root = AIPlayer.#endgameRoot(state0, playerId);
    const keyOf = AIPlayer.#endgameKey;
    const keyOfCached = (s, placed) => AIPlayer.#endgameKey(s, placed, true);
    const children = (s, placed) => {
      let moves;
      try { moves = this.moveGenerator.generateMoves(s, this.index, playerId, { hasPlacedDieThisTurn: placed }); } catch (e) { return []; }
      const out = [];
      const seen = new Set();
      for (const m of moves) {
        // 手の候補を作る時にダイスを置いてみた盤面を使い回す(Simulator.apply、2026-11-25 上の#endgameKeyと同じ依頼 --
        // 写して置き直すのが読みの時間の約25%だった)。
        let c;
        let r;
        try { ({ state: c, result: r } = this.simulator.apply(s, this.index, m)); } catch (e) { continue; }
        if (!r.success || r.pendingBuild) continue;
        const np = m.type === 'END_TURN' ? false : (placed || DICE_MOVE_TYPES.has(m.type));
        const uc = (c.pendingChoices || []).find((x) => x.playerId === playerId && x.kind === 'UNTAP_CHOICE');
        const variants = uc
          ? AIPlayer.untapSubsets(uc).map((sub) => { const c2 = cloneState(c); executor.resolveUntapChoice(c2, playerId, sub); return { c: c2, untap: sub }; })
          : [{ c, untap: null }];
        for (const v of variants) {
          const k = keyOfCached(v.c, np);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ m, untap: v.untap, c: v.c, np, k, h: this.evaluator.score(v.c, playerId) });
        }
      }
      out.sort((a, b) => b.h - a.h);
      return out;
    };
    const memo = new Map(); // 調べ終わった盤面の目印 -> その先の一番良い点
    const bestNext = new Map(); // 調べ終わった盤面の目印 -> その点になる次の手 {key, m, untap, childKey}
    // 盤面の目印から、調べ終わった一番良い手順をたどる
    const chainFrom = (k) => {
      const out = [];
      while (bestNext.has(k) && out.length < 200) { const n = bestNext.get(k); out.push({ key: k, m: n.m, untap: n.untap }); k = n.childKey; }
      return out;
    };
    const rootKey = keyOfCached(root, placed0);
    const allRoot = children(root, placed0);
    const rootChildren = allRoot.slice(0, 8).filter((c, i) => mine(i));
    if (allRoot.length === 0) return null;
    let best = null;
    let anyTimedOut = false;
    // ① 最初の手を「やること」(どのエリアに置いて何を取るか・どのカードをタップするか、とダイスの目)ごとにまとめ、まとまりの
    // 代表の手から、いつものAIの手(1手先だけ見る手)で最後まで打って点を数える(2026-11-24, per user「バグ報告 最終62VPとって
    // 20位」-- 元老院に1を置いて孤児院をLV2に上げる手は、その場では点が増えないので、点の見積もり順に深く読む②だけでは
    // 3秒で届かなかった。最後まで打ってみると一番良い手だった)。今ゲームが終わったら何点か、の高い順に打ってみる。
    // 時間の6割まで。残りの時間で②(深く読む)をして、点の高い方を選ぶ。
    const finNow = (st) => {
      const f = scoring.computeFinalScore(st, this.index, playerId);
      return (typeof f === 'number' ? f : f.total) + executor.collectFinalOnlyVpModifiers(st, this.index, playerId, true);
    };
    const groups = new Map();
    const me0 = root.players.find((p) => p.id === playerId);
    for (const c of allRoot) {
      const d = c.m.dieId ? me0.dice.find((x) => x.id === c.m.dieId) : null;
      const g = moveIdeaKey(c.m) + (d ? `|${d.value}` : '');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const reps = [...groups.values()].map((arr) => arr[0]); // allRootは点の見積もり順なので、先頭がまとまりの代表
    for (const c of reps) c.f0 = finNow(c.c);
    reps.sort((a, b) => b.f0 - a.f0 || b.h - a.h);
    const myReps = reps.filter((c, i) => mine(i));
    const rolloutDeadline = t0 + limitMs * 0.6;
    for (const c of myReps) {
      if (Date.now() > rolloutDeadline) { anyTimedOut = true; break; }
      const r = this.#endgameRollout(c, playerId, keyOf);
      if (r && (!best || r.v > best.v)) {
        best = { v: r.v, move: c.m, untap: c.untap, plan: [{ key: rootKey, m: c.m, untap: c.untap }].concat(r.steps), fromRollout: true };
      }
    }
    for (let i = 0; i < rootChildren.length; i++) {
      const ch = rootChildren[i];
      const share = (limitMs - (Date.now() - t0)) / (rootChildren.length - i);
      const lt0 = Date.now();
      let timedOut = false;
      let found = -1;
      let foundPath = [];
      const stack = []; // 今たどっている手順(この最初の手の後から)
      const dfs = (s, placed, k) => {
        if (Date.now() - lt0 > share) { timedOut = true; return -1; }
        if (s.phase === 'GAME_END') {
          const f = scoring.computeFinalScore(s, this.index, playerId);
          const v = typeof f === 'number' ? f : f.total;
          if (v > found) { found = v; foundPath = stack.slice(); }
          return v;
        }
        if (memo.has(k)) {
          const v = memo.get(k);
          if (v > found) { found = v; foundPath = stack.concat(chainFrom(k)); }
          return v;
        }
        let b = -1;
        let bChild = null;
        for (const c of children(s, placed)) {
          stack.push({ key: k, m: c.m, untap: c.untap });
          const v = dfs(c.c, c.np, c.k);
          stack.pop();
          if (v > b) { b = v; bChild = c; }
          if (timedOut) break;
        }
        if (!timedOut) {
          memo.set(k, b);
          if (bChild) bestNext.set(k, { m: bChild.m, untap: bChild.untap, childKey: bChild.k });
        }
        return b;
      };
      const v = Math.max(dfs(ch.c, ch.np, ch.k), found);
      if (timedOut) anyTimedOut = true;
      if (v >= 0 && (!best || v > best.v)) {
        best = { v, move: ch.m, untap: ch.untap, plan: [{ key: rootKey, m: ch.m, untap: ch.untap }].concat(foundPath) };
      }
    }
    if (best) best.exact = !anyTimedOut && !best.fromRollout;
    return best;
  }

  /** 読み切り①: 子の盤面cから、いつものAIの手(#greedyMove)で自分の手を最後まで打ち、ゲーム終了時の点と、その手順
   * (手を打つ前の盤面の目印つき、覚えておく手順用)を返す。最後まで行けなければnull。 */
  #endgameRollout(c, playerId, keyOf) {
    let st = cloneState(c.c);
    let placed = c.np;
    const steps = [];
    for (let i = 0; i < 80 && st.phase !== 'GAME_END'; i++) {
      const key = keyOf(st, placed);
      const m = this.#greedyMove(st, playerId, placed);
      if (!m) return null;
      let r;
      try { r = applyInPlace(st, this.index, m); } catch (e) { return null; }
      if (!r.success || r.pendingBuild) return null;
      let untap = null;
      const uc = (st.pendingChoices || []).find((x) => x.playerId === playerId && x.kind === 'UNTAP_CHOICE');
      if (uc) {
        // アンタップは選び方ごとに次の一番良い手の点で比べる(軽い版、#resolveUntapChoiceQuickと同じ考え)
        let bestScore = -Infinity;
        for (const sub of AIPlayer.untapSubsets(uc)) {
          const t = cloneState(st);
          executor.resolveUntapChoice(t, playerId, sub);
          const sc = this.evaluator.score(t, playerId);
          if (sc > bestScore) { bestScore = sc; untap = sub; }
        }
        executor.resolveUntapChoice(st, playerId, untap);
      }
      steps.push({ key, m, untap });
      placed = m.type === 'END_TURN' ? false : (placed || DICE_MOVE_TYPES.has(m.type));
    }
    if (st.phase !== 'GAME_END') return null;
    const f = scoring.computeFinalScore(st, this.index, playerId); // 終わった盤面なので、晩餐会などの終了時の点も入っている
    return { v: typeof f === 'number' ? f : f.total, steps };
  }

  /** アンタップするカードの選び方(重さの合計が上限以内で、これ以上足せない組)を全部挙げる。 */
  static untapSubsets(choice) {
    const { candidates, weights, count } = choice.context;
    const subsets = [];
    (function rec(i, cur, w) {
      if (i === candidates.length) {
        if (candidates.every((id) => cur.includes(id) || w + weights[id] > count)) subsets.push(cur.slice());
        return;
      }
      if (w + weights[candidates[i]] <= count) { cur.push(candidates[i]); rec(i + 1, cur, w + weights[candidates[i]]); cur.pop(); }
      rec(i + 1, cur, w);
    })(0, [], 0);
    return subsets.length > 0 ? subsets : [[]];
  }

  /** 先読みの中で、アンタップするカードを選ぶ(2026-11-23、per user「このリプレイからAIを強くする方法」-- 前はくじ引き、
   * 先読みの中では選ばれずに止まっていた)。選び方ごとに、次に打てる一番良い手の点で比べる(軽い版)。 */
  #resolveUntapChoiceQuick(state, playerId, hasPlacedDieThisTurn) {
    const choice = (state.pendingChoices || []).find((c) => c.playerId === playerId && c.kind === 'UNTAP_CHOICE');
    if (!choice) return state;
    let best = null;
    let bestScore = -Infinity;
    for (const subset of AIPlayer.untapSubsets(choice)) {
      const clone = { ...cloneState(state) };
      executor.resolveUntapChoice(clone, playerId, subset);
      let score = this.evaluator.score(clone, playerId);
      const next = this.#greedyMove(clone, playerId, hasPlacedDieThisTurn);
      if (next) {
        const r = this.simulator.apply(clone, this.index, next);
        if (r.result.success) score = Math.max(score, this.evaluator.score(r.state, playerId));
      }
      if (score > bestScore) { bestScore = score; best = clone; }
    }
    return best || state;
  }

  /** 本番の手番でアンタップするカードを選ぶ(main.js・game-runner.jsから)。選び方ごとに、その手番の残りを打ってみて、
   * 一番良くなる組を返す(2026-11-23、per user のリプレイ「軍団長LV2で測量術をアンタップしてもう一度使う」)。 */
  chooseUntapChoice(state, playerId, hasPlacedDieThisTurn) {
    const choice = (state.pendingChoices || []).find((c) => c.playerId === playerId && c.kind === 'UNTAP_CHOICE');
    if (!choice) return [];
    // 終盤の読み切りで決めておいた選び方があれば、それを使う。
    const planned = this.#plannedUntap;
    this.#plannedUntap = null;
    if (planned && planned.every((id) => choice.context.candidates.includes(id))) return planned;
    const light = lightState(state);
    let best = null;
    let bestScore = -Infinity;
    for (const subset of AIPlayer.untapSubsets(choice)) {
      const clone = cloneState(light);
      executor.resolveUntapChoice(clone, playerId, subset);
      const end = this.#finishTurnGreedy(clone, playerId, !!hasPlacedDieThisTurn, 60);
      const score = this.evaluator.score(end, playerId);
      if (score > bestScore) { bestScore = score; best = subset; }
    }
    return best || [];
  }

  #finishTurnGreedy(state, playerId, hasPlacedDieThisTurn, maxRolloutMoves) {
    let steps = 0;
    while (steps < maxRolloutMoves) {
      steps++;
      state = this.#resolveUntapChoiceQuick(state, playerId, hasPlacedDieThisTurn);
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

/** 手の「考え」(#selectMoveInnerの読む枠を、考えの違う手で埋めるため): 建築を伴う置き方は取るカード、伴わない置き方は
 * エリア、カードのタップはそのカード(+建築するカード)。どのダイスを・どのマスに、の違いは同じ考えとみなす。 */
function moveIdeaKey(move) {
  if ((move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP') && move.mapId) {
    return move.buildCandidateKey ? `build:${move.buildCandidateKey}` : `area:${move.mapId}`;
  }
  if (move.type === 'BARE_TAP' && move.physicalId) return `tap:${move.physicalId}:${move.buildCandidateIndex !== undefined ? move.buildCandidateIndex : ''}`;
  return JSON.stringify(move);
}

/** 明らかに損な置き方を候補から外す (2026-11-23, per user のバグ報告「ナビ 農園LV2を所有しているにも関わらず 下位互換の
 * 他人の小麦畑に行こうとする」「1手で9Kと5K」「自分の元老院に置けるのに皇帝宮殿にダイスを置こうとする」)。
 * 同じダイスを別のエリアに置く手どうしで、置いた後に持っているカードが同じ(=同じカードを取る、または何も取らない)なら、
 * もらえる資源(使用料を引いた後)がどれも同じか多い方があれば、少ない方を外す。scoredをその場で減らす。 */
function removeDominatedPlacements(scored, state, playerId) {
  const before = Array.isArray(state.players) ? state.players.find((p) => p.id === playerId) : null;
  if (!before) return; // テスト用の仮の盤面など
  const info = [];
  for (const entry of scored) {
    const m = entry.move;
    if ((m.type !== 'PLACE_DIE' && m.type !== 'PLACE_WILDCARD_DIE') || !m.mapId || !entry.resultState || !Array.isArray(entry.resultState.players)) continue;
    const after = entry.resultState.players.find((p) => p.id === playerId);
    if (!after) continue;
    const cards = after.ownedCardPhysicalIds.map((id) => entry.resultState.cards[id].currentFaceId).sort().join(',');
    const gain = {};
    for (const r of new Set([...Object.keys(before.resources), ...Object.keys(after.resources)])) gain[r] = (after.resources[r] || 0) - (before.resources[r] || 0);
    const fee = after.pendingFee && (!before.pendingFee || before.pendingFee.mapId !== after.pendingFee.mapId) ? after.pendingFee : null;
    if (fee) gain[fee.resource || 'K'] = (gain[fee.resource || 'K'] || 0) - fee.amount;
    info.push({ entry, group: `${m.dieId}|${cards}|${after.dice.length}`, mapId: m.mapId, gain });
  }
  const dominated = new Set();
  for (const a of info) {
    for (const b of info) {
      if (a === b || a.group !== b.group || a.mapId === b.mapId) continue;
      let allGe = true;
      let someGt = false;
      for (const k of new Set([...Object.keys(a.gain), ...Object.keys(b.gain)])) {
        const x = b.gain[k] || 0;
        const y = a.gain[k] || 0;
        if (x < y) { allGe = false; break; }
        if (x > y) someGt = true;
      }
      if (allGe && someGt) { dominated.add(a.entry); break; }
    }
  }
  if (dominated.size === 0 || dominated.size === scored.length) return;
  for (let i = scored.length - 1; i >= 0; i--) if (dominated.has(scored[i])) scored.splice(i, 1);
}

module.exports = { AIPlayer };

})();
