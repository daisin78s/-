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
 *  - BUILD/UPGRADE payments always use colorPreference: undefined (AUTO -- real resource first, Z only
 *    as a fallback). Optimizing *which color* to pay with is a separate, later concern from *whether/
 *    what* to build.
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
const { lowerCostList } = require('../command-builder');
const board = require('../board');
const executor = require('../executor');
const turnFlow = require('../turn-flow');
const { cloneState } = require('../game-state');

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
  for (const item of lowerCostList(row.COST)) {
    if (remaining <= 0) break;
    const use = Math.min(item.count, remaining);
    if (use > 0) {
      discount[item.resource] = use;
      remaining -= use;
    }
  }
  return Object.keys(discount).length > 0 ? discount : undefined;
}

class SimulationError extends Error {}

/** Applies move to state in place (mutates -- callers use apply() below for the clone+apply pattern).
 * @returns {{success:boolean, reason?:string, [key:string]:*}} whatever the underlying engine call
 *   returned, for Evaluator/callers that want the detail; always has `success`.
 */
function applyInPlace(state, index, move) {
  switch (move.type) {
    case 'PLACE_DIE': {
      const result = board.placeDice(state, index, { playerId: move.playerId, colorPreference: move.colorPreference }, move.dieId, move.mapId, move.slotIndex);
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
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, colorPreference: move.colorPreference, bzDiscount }, candidate, result.actionResult.pendingBuild.remainingCommands);
        // candidate is folded into the return (2026-08-03) so callers can identify exactly what was
        // built/upgraded -- buildResult itself carries a faceId only for BUILD_NEW (board.resolveBuild's
        // own doc: UPGRADE's buildResult has no physicalId/faceId at all), but candidate always has
        // faceId (BUILD_NEW) or toFaceId (UPGRADE) regardless of outcome.
        return { ...buildResult, candidate };
      }
      return result;
    }
    case 'PASS_DIE':
      return board.passDie(state, index, { playerId: move.playerId }, move.dieId);
    case 'BARE_TAP': {
      const context = { playerId: move.playerId };
      if (move.chosenDieId !== undefined) context.chosenDieId = move.chosenDieId;
      if (move.chosenValue !== undefined) context.chosenValue = move.chosenValue;
      if (move.chosenDelta !== undefined) context.chosenDelta = move.chosenDelta;
      const result = board.useBareTapAbility(state, index, context, move.physicalId);
      if (!result.success) return result;
      if (result.pendingBuild) {
        if (move.buildCandidateIndex === undefined || move.buildCandidateIndex === null) return result;
        const candidate = result.pendingBuild.candidates[move.buildCandidateIndex];
        if (!candidate) throw new SimulationError(`buildCandidateIndex ${move.buildCandidateIndex} out of range`);
        const bzDiscount = maxBzDiscount(state, index, move.playerId, candidate);
        // Tap BEFORE resolving the build, not after (2026-08-09 fix, mirrors main.js's matching fix --
        // see its own comment for the full story: a built card's own ONCE, e.g. C008A's
        // UNTAP_ALL(SELF), runs *inside* completeAreaBuild, so tapping this card only afterward meant
        // that effect could never actually reach it). resolveBuildNew/resolveUpgrade both check
        // affordability and fail atomically *before* any state mutation (see their own code), so it's
        // safe to speculatively tap first and simply revert on failure -- nothing else needs undoing.
        state.cards[move.physicalId].tapped = true;
        const buildResult = board.completeAreaBuild(state, index, { playerId: move.playerId, bzDiscount }, candidate, result.pendingBuild.remainingCommands);
        if (buildResult.success) {
          executor.notifyActivation(state, move.playerId, move.physicalId, state.cards[move.physicalId].currentFaceId, 'TAP');
        } else {
          state.cards[move.physicalId].tapped = false; // build never actually happened -- the TAP wasn't spent
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

class Simulator {
  /** Applies move to a clone of state; the original is never touched.
   * @returns {{state: GameState, result: Object}}
   */
  apply(state, index, move) {
    const clone = cloneState(state);
    const result = applyInPlace(clone, index, move);
    return { state: clone, result };
  }
}

module.exports = { Simulator, SimulationError, applyInPlace };

})();
