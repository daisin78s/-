(function () {
'use strict';

/**
 * Simulator: applies one Move (see move-generator.js's own doc for the exact shapes) to a *clone* of
 * GameState and returns the resulting state -- never mutates the state it's given. This is what lets
 * AIPlayer try many candidate moves against Evaluator before actually committing one for real.
 *
 * Deliberately dumb and stateless: it only knows how to dispatch a Move to the right engine call
 * (board.js/executor.js/turn-flow.js/qst.js -- the exact same functions main.js's UI calls). It has no
 * opinion about which move is *good* (that's Evaluator) or which moves exist (that's MoveGenerator),
 * so it can be reused unchanged if either of those gets swapped for a different algorithm later
 * (minimax, MCTS, etc. still need something that can "try a move and see what happens").
 *
 * Simplifications confirmed for this first pass (structure supports removing these later without
 * changing Simulator's own shape):
 *  - BUILD/UPGRADE payments never pass any payment preference of their own -- real resource first, Z
 *    only as a fallback, same default every player gets (2026-09-20: 色欲 owners now auto-prefer Z
 *    instead, unconditionally, so an AI-controlled 色欲 owner gets that behavior for free too -- see
 *    executor.resolvePayment's own doc; there is no longer a *choice* left to model here at all).
 *  - Ending a turn always answers any RESOURCE_LIMIT/FORCE_CONVERT WARNING "はい" (proceeds), matching
 *    the engine's pre-WARNING-UI default. An AI that specifically wants to preserve resources across a
 *    TURNEND by staying put isn't modeled yet -- see main.js's turnEndWarnings for the real rule set.
 *
 * BUILD and UPGRADE alike (2026-08-06, per user feedback -- board.resolveUpgrade now applies bzDiscount
 * exactly like resolveBuildNew) payments always use as much of the player's currently-held BZ as the
 * candidate's own COST can absorb (2026-08-04, per user feedback: "3K→2BZその2BZも必ず使う" -- see
 * maxBzDiscount). This *replaces* the earlier "no bzDiscount, ever" simplification rather than adding a
 * second candidate alongside it, so it costs nothing extra in AIPlayer's search -- every BUILD_NEW/
 * UPGRADE candidate simply pays with whatever BZ is on hand instead of always paying full price.
 */

const { getCardRow } = require('../data-loader');
const { lowerCostList, isChoiceCost, lowerChoiceCostOptions } = require('../command-builder');
const board = require('../board');
const executor = require('../executor');
const turnFlow = require('../turn-flow');
// AIの読みの中のコピーは、カードを変わった物だけ写す(game-state.jsのcloneStateCow参照)。
const { cloneStateCow: cloneState, writableCard } = require('../game-state');

/** Greedily spreads playerId's currently-held BZ across candidate's own COST items (BUILD_NEW's faceId,
 * or UPGRADE's fromFaceId -- the original tier's, per board.resolveUpgrade), up to what each item needs
 * and what's held -- e.g. holding 3 BZ against a "2A,4B" cost discounts 2A fully and 1 of the 4B. Returns
 * undefined (not an empty object) when there's no BZ to spend, so executor.applyBzDiscount's own
 * `if (!bzDiscount) return {items, bzUsed:0}` short-circuit applies cleanly the same as it always did
 * for a player with no BZ. */
function maxBzDiscount(state, index, playerId, candidate) {
  const player = state.players.find((p) => p.id === playerId);
  let remaining = (player && player.resources.BZ) || 0;
  if (remaining <= 0) return undefined;
  const costFaceId = candidate.type === 'UPGRADE' ? candidate.fromFaceId : candidate.faceId;
  const row = getCardRow(index, costFaceId);
  const discount = {};
  // Choice-COST (2026-10-15, "15A/15B/15C" -- see command-builder.isChoiceCost's own doc, M405/巨大石像):
  // pre-resolve to whichever single option board.resolveBuildNew's own pickChoiceCostResource would
  // actually pick, using the SAME helper (reused here rather than re-deriving it), so this discount
  // pre-computation never disagrees with the real resolution that follows it.
  const items = isChoiceCost(row.COST)
    ? (() => {
        const options = lowerChoiceCostOptions(row.COST);
        const resource = board.pickChoiceCostResource(state, index, playerId, options, remaining);
        return [options.find((opt) => opt.resource === resource)];
      })()
    : lowerCostList(row.COST);
  // 足りない資源の分から先にBZを使う(2026-11-24, per user のバグ報告「元老院でBZをもらって孤児院をLV2に」-- A2・BZ1で
  // 「A,B」を払う時、前は先頭のAにBZを使ってBが足りず、払えるのに払えない手になっていた)。残りは今までどおり先頭から。
  const held = (player && player.resources) || {};
  const used = {};
  const need = {};
  for (const item of items) need[item.resource] = (need[item.resource] || 0) + item.count;
  for (const res of Object.keys(need)) {
    if (remaining <= 0) break;
    const short = Math.max(0, need[res] - (held[res] || 0));
    const use = Math.min(short, remaining);
    if (use > 0) { used[res] = use; remaining -= use; }
  }
  for (const item of items) {
    if (remaining <= 0) break;
    const use = Math.min(item.count - (used[item.resource] || 0), remaining);
    if (use > 0) {
      used[item.resource] = (used[item.resource] || 0) + use;
      remaining -= use;
    }
  }
  for (const res of Object.keys(used)) discount[res] = used[res];
  return Object.keys(discount).length > 0 ? discount : undefined;
}

class SimulationError extends Error {}

/** Applies move to state in place (mutates -- callers use apply() below for the clone+apply pattern).
 * @returns {{success:boolean, reason?:string, [key:string]:*}} whatever the underlying engine call
 *   returned, for Evaluator/callers that want the detail; always has `success`.
 */
function applyInPlace(state, index, move) {
  // どの資源でも払える支払いの払い方(move.anyPayment、move-generator.jsの#withAnyPaymentVariants)を、払う直前に置く
  // (executor.resolveAnyPayment が読む。(2026-11-25, per user「どんな資源でも払えるように」「人間もAIも選べるように」))。
  // 変換してからタップする手(move.preConvert {A:n,...}、move-generator.jsの#withPreConvertedTaps): 先に〇へ変える。
  if (move.preConvert) {
    for (const [resource, count] of Object.entries(move.preConvert)) {
      for (let i = 0; i < count; i++) {
        const r = executor.tryFreeAction(state, index, move.playerId, `${resource}_K`);
        if (!r.success) return { success: false, reason: 'PRE_CONVERT_FAILED' };
      }
    }
  }
  // 目を変えるカードをタップしてから置く手(move.preTap {physicalId, chosenDieId, chosenValue?, chosenDelta?}、
  // move-generator.jsの#tapThenPlaceMoves) (2026-11-26 Ver.1.1747): 先にタップしてダイスの目を変える。
  if (move.preTap) {
    const tapContext = { playerId: move.playerId, chosenDieId: move.preTap.chosenDieId };
    if (move.preTap.chosenValue !== undefined) tapContext.chosenValue = move.preTap.chosenValue;
    if (move.preTap.chosenDelta !== undefined) tapContext.chosenDelta = move.preTap.chosenDelta;
    const r = board.useBareTapAbility(state, index, tapContext, move.preTap.physicalId);
    if (!r.success) return { success: false, reason: 'PRE_TAP_FAILED' };
  }
  if (move.anyPayment) {
    const payer = state.players.find((p) => p.id === move.playerId);
    if (payer) payer.anyPaymentChoice = { ...move.anyPayment };
  }
  switch (move.type) {
    case 'PLACE_DIE': {
      const result = board.placeDice(state, index, { playerId: move.playerId }, move.dieId, move.mapId, move.slotIndex);
      if (!result.success) return result;
      if (result.actionResult && result.actionResult.pendingBuild) {
        if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) {
          // A legal placement whose AREA needs a BUILD choice this Move didn't specify -- the die is
          // placed, but nothing further happens (matches leaving pendingBuild unresolved, same as
          // main.js before pass 3 -- MoveGenerator should always pair a build-triggering placement
          // with a candidate index, so this is a defensive fallback, not the expected path).
          return { success: true, pendingBuild: result.actionResult.pendingBuild };
        }
        const candidate = result.actionResult.pendingBuild.candidates[move.buildCandidateIndex];
        if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
        const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, result.actionResult.pendingBuild.remainingCommands);
        // candidate is folded into the return (2026-08-03) so callers can identify exactly what was
        // built/upgraded -- buildResult itself carries a faceId only for BUILD_NEW (board.resolveBuild's
        // own doc: UPGRADE's buildResult has no physicalId/faceId at all), but candidate always has
        // faceId (BUILD_NEW) or toFaceId (UPGRADE) regardless of outcome.
        return { ...buildResult, candidate };
      }
      return result;
    }
    // JOB003/道化 (2026-08-19, hasWildcardDice): mirrors PLACE_DIE exactly, just via board.placeWildcardDie
    // (usually no slotIndex -- the engine auto-picks one, same as board.placeDice's own doc -- except when
    // move.slotIndex is set, 2026-08-28, see move-generator.js's #wildcardPlaceDieMoves' own doc on the
    // EX-vs-ANY choice) instead of board.placeDice.
    case 'PLACE_WILDCARD_DIE': {
      const result = board.placeWildcardDie(state, index, { playerId: move.playerId }, move.dieId, move.mapId, move.slotIndex);
      if (!result.success) return result;
      if (result.actionResult && result.actionResult.pendingBuild) {
        if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) {
          return { success: true, pendingBuild: result.actionResult.pendingBuild };
        }
        const candidate = result.actionResult.pendingBuild.candidates[move.buildCandidateIndex];
        if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
        const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, result.actionResult.pendingBuild.remainingCommands);
        return { ...buildResult, candidate };
      }
      return result;
    }
    // PLACE_DICE_GROUP (2026-08-21, see move-generator.js's own doc): mirrors PLACE_DIE exactly, just
    // via board.placeDiceGroup (2 dice, no slotIndex -- board.placeDiceGroup assigns each die its own
    // slot itself) instead of board.placeDice.
    case 'PLACE_DICE_GROUP': {
      const result = board.placeDiceGroup(state, index, { playerId: move.playerId }, move.dieIds, move.mapId);
      if (!result.success) return result;
      if (result.actionResult && result.actionResult.pendingBuild) {
        if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) {
          return { success: true, pendingBuild: result.actionResult.pendingBuild };
        }
        const candidate = result.actionResult.pendingBuild.candidates[move.buildCandidateIndex];
        if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
        const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, result.actionResult.pendingBuild.remainingCommands);
        return { ...buildResult, candidate };
      }
      return result;
    }
    case 'PASS_DIE': {
      // allDice: ラウンドパス(画面のラウンドパスボタンと同じ、残りのダイスを全部パス) (2026-11-25, per user「AIラウンドパスはできないの」「ラウンドパスが AIもできるようになれば」「孤児院に置かなくても 解決」「ラウンドパスのほうが まし」)。
      if (move.allDice) {
        const player = state.players.find((p) => p.id === move.playerId);
        const dice = player ? player.dice.filter((d) => d.placedMapId === null && !d.passed) : [];
        if (dice.length === 0) return { success: false, reason: 'NO_DICE_TO_PASS' };
        for (const die of dice) {
          const r = board.passDie(state, index, { playerId: move.playerId }, die.id);
          if (!r.success) return r;
        }
        return { success: true };
      }
      return board.passDie(state, index, { playerId: move.playerId }, move.dieId);
    }
    case 'BARE_TAP': {
      const context = { playerId: move.playerId };
      if (move.chosenDieId !== undefined) context.chosenDieId = move.chosenDieId;
      if (move.chosenValue !== undefined) context.chosenValue = move.chosenValue;
      if (move.chosenDelta !== undefined) context.chosenDelta = move.chosenDelta;
      // skipDieChange (2026-09-06, JOB007/宮廷人's own MONUMENT_CHANGE_DIE_VALUE -- see
      // executor.runMonumentChangeDieValue's own doc): lets this bare TAP commit its non-die effects
      // (ADD(BZ), BLOCK_BUILD) with no die/card targeted at all.
      if (move.skipDieChange) context.skipDieChange = true;
      const result = board.useBareTapAbility(state, index, context, move.physicalId);
      if (!result.success) return result;
      if (result.pendingBuild) {
        if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) return result;
        const candidate = result.pendingBuild.candidates[move.buildCandidateIndex];
        if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
        const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
        // Tap BEFORE resolving the build, not after (2026-08-09 fix, mirrors main.js's matching fix --
        // see its own comment for the full story: a built card's own ONCE, e.g. C301A's (renamed from
        // C008A by the 2026-08-24 SHOP201-203 rework's card renumbering)
        // UNTAP_ALL(SELF), runs *inside* completeAreaBuild, so tapping this card only afterward meant
        // that effect could never actually reach it). resolveBuildNew/resolveUpgrade both check
        // affordability and fail atomically *before* any state mutation (see their own code), so it's
        // safe to speculatively tap first and simply revert on failure -- nothing else needs undoing.
        writableCard(state, move.physicalId).tapped = true;
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, result.pendingBuild.remainingCommands);
        if (buildResult.success) {
          executor.notifyActivation(state, move.playerId, move.physicalId, state.cards[move.physicalId].currentFaceId, 'TAP');
        } else {
          writableCard(state, move.physicalId).tapped = false; // build never actually happened -- the TAP wasn't spent
        }
        return { ...buildResult, candidate }; // see PLACE_DIE's own comment on why candidate is included
      }
      return result;
    }
    case 'FREE_ACTION':
      return executor.tryFreeAction(state, index, move.playerId, move.freeActionId);
    case 'COLLECT_FEE':
      return executor.collectUsageFee(state, index, { playerId: move.playerId }, move.mapId);
    case 'TAP_REACTION': {
      const choice = state.pendingChoices.find((c) => c.id === move.choiceId);
      if (!choice) return { success: false, reason: 'CHOICE_NOT_FOUND' };
      if (move.use) {
        const result = executor.resolveTapReaction(state, index, { playerId: move.playerId }, choice.context.physicalId, choice.context.effect);
        state.pendingChoices = state.pendingChoices.filter((c) => c.id !== move.choiceId);
        return result;
      }
      state.pendingChoices = state.pendingChoices.filter((c) => c.id !== move.choiceId);
      return { success: true, declined: true };
    }
    case 'END_TURN': {
      const result = turnFlow.endTurn(state, index, move.playerId);
      if (!result.success) return result; // RESOURCE_TOTAL_LIMIT block -- caller's problem to resolve first
      if (turnFlow.isRoundOver(state)) {
        turnFlow.endRound(state, index);
        if (state.phase !== 'GAME_END') turnFlow.startRound(state);
      }
      return result;
    }
    default:
      throw new SimulationError(`Unknown move type: ${move.type}`);
  }
}

// 手の候補を作る時に試しに打った盤面を、点数をつける時に使い回す (2026-11-24, per user「(AIを早くする案)すべて」)。MoveGeneratorの#placeDieMovesが、
// 置けるか確かめるためにダイスを置いた盤面(コピー)を、手ごとにここへ預ける(move -> {base, state, result})。
// apply(base, index, move) が同じ盤面(base)・同じ手で呼ばれたら、置くところを打ち直さずにその盤面を使う(1回使ったら捨てる。
// 同じ盤面を2つの手が書き換えないように、建てる手は置いた後の盤面をコピーしてから建てる)。
const placedDryRuns = new WeakMap();
function rememberPlacedDryRun(move, base, placedState, placeResult, shared) {
  placedDryRuns.set(move, { base, state: placedState, result: placeResult, shared });
}

class Simulator {
  /** Applies move to a clone of state; the original is never touched.
   * @returns {{state: GameState, result: Object}}
   */
  apply(state, index, move) {
    const dry = placedDryRuns.get(move);
    if (dry) {
      placedDryRuns.delete(move);
      if (dry.base === state) {
        const reused = applyFromPlaced(dry, index, move);
        if (reused) return reused;
      }
    }
    const clone = cloneState(state);
    const result = applyInPlace(clone, index, move);
    return { state: clone, result };
  }
}

/** apply の使い回し: dry = ダイスを置いた直後の盤面。PLACE_DIEの残り(建てる)だけをapplyInPlaceと同じ順でする。 */
function applyFromPlaced(dry, index, move) {
  if (move.type !== 'PLACE_DIE') return null;
  const result = dry.result;
  const pendingBuild = result.actionResult && result.actionResult.pendingBuild;
  if (!pendingBuild) return dry.shared ? null : { state: dry.state, result };
  if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) {
    return { state: cloneState(dry.state), result: { success: true, pendingBuild } };
  }
  const state = cloneState(dry.state);
  const candidate = pendingBuild.candidates[move.buildCandidateIndex];
  if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
  const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
  // pendingBuild(候補・残りの命令)は置いた直後の盤面の物。コピーした盤面の中の物ではないが、applyInPlaceと同じく
  // 読むだけなので同じ結果になる。
  const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, pendingBuild.remainingCommands);
  return { state, result: { ...buildResult, candidate } };
}

module.exports = { Simulator, SimulationError, applyInPlace, maxBzDiscount, rememberPlacedDryRun };

})();
