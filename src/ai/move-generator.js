(function () {
'use strict';

/**
 * MoveGenerator: enumerates every legal Move for playerId in the *current* state. Never mutates state
 * -- candidate placements/bare-TAP choices are legality-checked via throwaway clones (cloneState),
 * exactly the same "engine is the single source of truth for legality" principle main.js's UI follows
 * (nothing here re-implements board.placeDice's own rules).
 *
 * Move shapes (a plain discriminated union, matching what simulator.js's applyInPlace expects):
 *   { type:'PLACE_DIE', playerId, dieId, mapId, slotIndex, buildCandidateIndex? }
 *   { type:'PLACE_WILDCARD_DIE', playerId, dieId, mapId, slotIndex?, buildCandidateIndex? }
 *   { type:'PLACE_DICE_GROUP', playerId, dieIds:[id,id], mapId, buildCandidateIndex? }
 *   { type:'PASS_DIE', playerId, dieId }
 *   { type:'BARE_TAP', playerId, physicalId, chosenDieId?, chosenValue?, chosenDelta?, buildCandidateIndex? }
 *   { type:'FREE_ACTION', playerId, freeActionId }
 *   { type:'COLLECT_FEE', playerId, mapId }
 *   { type:'TAP_REACTION', playerId, choiceId, use }
 *   { type:'END_TURN', playerId }
 *
 * (2026-08-09: CLAIM_QUEST removed -- QST no longer has any player-facing action at all, see
 * src/qst.js's own doc. Rewards are granted automatically at GAME_END based on final ranking.)
 *
 * context.hasPlacedDieThisTurn (supplied by AIPlayer, which tracks it the same way main.js's UI-only
 * turnActionTaken flag does -- GameState has no such field, since a "turn" isn't its own state, just
 * turn-flow.getNextTurn's rotation) gates which categories apply: PLACE_DIE/PASS_DIE only appear while
 * false (fulfilling the mandatory once-per-turn placement-or-pass decision, see board.passDie's own
 * doc); END_TURN only appears once true (matches main.js's 2026-08-01 "建築後、ターンエンド前にTAPの
 * フリーアクションが可能です" fix -- ending a turn is a separate, explicit choice, not automatic).
 * Everything else (free actions/bare TAP/TAP reactions) is available either way, same as the real UI's
 * own gating.
 *
 * Simplification confirmed for this first pass (see simulator.js's matching note): PLACE_DIE/BARE_TAP
 * candidates never vary colorPreference/bzDiscount -- payment always resolves AUTO.
 *
 * PLACE_WILDCARD_DIE (2026-08-19, JOB003/hasWildcardDice): #placeDieMoves enumerates die x mapId only,
 * no slotIndex loop, for a wildcard-owning player -- board.placeWildcardDie auto-assigns the slot itself
 * (see its own doc), so there is nothing for MoveGenerator to search over per-slot the way PLACE_DIE
 * does. EXCEPTION (2026-08-28, see board.wildcardExAnyChoice's own doc): when the player's own empty EX
 * slot and an empty non-EX slot are both available at mapId, that IS a genuine choice with no single
 * "correct" auto-pick, so #wildcardPlaceDieMoves offers BOTH as separate Moves (each carrying its own
 * slotIndex) instead of the usual single slotIndex-less Move.
 *
 * PLACE_DICE_GROUP (2026-08-21, per user request "AIがダイスを２個使ってモニュメントを獲得できるように
 * してほしい"): #placeDiceGroupMoves enumerates 2-die pairs (never 3+) at 王宮/元老院 only -- the only 2
 * maps board.placeDiceGroup supports -- and only pairs summing to >6 (a single die already covers <=6 via
 * #placeDieMoves). No multi-turn "hold a die back hoping for a better pair" strategy -- this only offers
 * moves that are legal *right now*, same greedy-per-turn scope as every other Move here.
 */

const { getAreaRow, getCardRow } = require('../data-loader');
const { parse } = require('../dsl-parser');
const { lowerProgram } = require('../command-builder');
const { cloneState } = require('../game-state');
const board = require('../board');
const executor = require('../executor');
const { applyInPlace } = require('./simulator');

/** Mirrors main.js's bareTapKind (2026-07-31) -- duplicated rather than shared because main.js is a
 * browser-only classic script, not a requireable CommonJS module like the rest of src/. Keep the two
 * in sync if either changes. null = no TAP field, or purely ON(...)-wrapped (reactive-only, handled as
 * a TAP_REACTION choice instead, never generated as a BARE_TAP move here). BUILD is checked anywhere in
 * the field, not just commands[0] (2026-08-17, see main.js's own bareTapKind doc -- JOB010's
 * "PAY(2K);BUILD(U)" has a flat cost ahead of it; a no-op change for every other card). */
function bareTapKind(index, faceId) {
  let row;
  try { row = getCardRow(index, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = lowerProgram(parse(row.TAP));
  if (commands.every((c) => c.type === 'ON')) return null;
  const first = commands[0];
  if (first.type === 'SET_DICE_ANY') return { kind: 'SET_DICE_ANY' };
  if (first.type === 'SET_DIE_VALUE') return { kind: 'SET_DIE_VALUE', choices: first.choices };
  if (first.type === 'CHANGE_DIE_VALUE') return { kind: 'CHANGE_DIE_VALUE', choices: first.choices };
  // MONUMENT_CHANGE_DIE_VALUE(SELF+2) (2026-08-24, JOB007/宮廷人's revised TAP) -- same die-choice
  // requirement as CHANGE_DIE_VALUE, but the delta is a single fixed number baked in at DSL-lowering
  // time (cmd.delta), never a player-picked one of several choices, so no `choices` value here.
  // Searched ANYWHERE in the field, not just commands[0] (mirrors main.js's own bareTapKind, fixed
  // there 2026-08-25 per user report: "宮廷人を使おうとしてTAPしようとするとカードを使用できません
  // と出ます" -- JOB007's own TAP is "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(...)", so
  // first.type was 'ADD', this branch never matched there either. This copy was never brought in sync
  // with that fix -- see this function's own top-of-file doc on the two needing to stay in sync -- so
  // the AI could never actually use JOB007's TAP at all (2026-08-25, per user report: "宮廷人 AIの使用
  // 回数が0です"): #bareTapMoves/forcedBzConversionMove both called useBareTapAbility with no
  // chosenDieId, which the die-value-change command then had nothing to act on and always failed.
  // ADD(BZ) is an unconditional grant with no choice of its own, same "flat leading effect ahead of the
  // real interactive command" shape BUILD's own check just below already handles for JOB010.
  const monumentChangeDieValue = commands.find((c) => c.type === 'MONUMENT_CHANGE_DIE_VALUE');
  if (monumentChangeDieValue) return { kind: 'MONUMENT_CHANGE_DIE_VALUE' };
  if (commands.some((c) => c.type === 'BUILD')) return { kind: 'BUILD' };
  return { kind: 'IMMEDIATE' };
}

class MoveGenerator {
  /**
   * @param {{avoidMapIdFromRound?: {mapId: string, round: number}}} [policy] - optional strategy knob
   *   (2026-08-09, originally added for "AI LV3"). Default {} (no restriction at all) -- every AI level
   *   currently uses a MoveGenerator built with no policy, so behavior is byte-for-byte unchanged unless
   *   a level is explicitly given one of its own (construct a separate MoveGenerator instance with this
   *   set, as main.js's aiMoveGeneratorLv3 used to for LV3).
   *   avoidMapIdFromRound (2026-08-10, per user request: "AILV3について R3からAREA007にダイスを置かない
   *   ようにかえたい"; removed from LV3 2026-08-28 per user request "3Rから訓練場を避けるは削除してくださ
   *   い" -- the mechanism itself is kept here, unused by any level for now, since it's generic and may
   *   be reused later): once state.round reaches .round, #placeDieMoves stops offering ANY placement
   *   (any slot, any die) on .mapId at all -- not a preference the Evaluator weighs, an outright removal
   *   from the candidate list (a die left with no other legal slot still falls back to PASS_DIE, same
   *   escape hatch as always -- this can't deadlock the AI).
   *   (2026-08-10: this policy previously also had a monumentFocusFromRound field -- an AI that stopped
   *   buying new A/B/C cards from a given round on and banked toward monuments instead, meant to stop
   *   LV1/LV2 from routinely ending games with large unspent resource piles. Removed per user request
   *   once QST's rank-based rewards rework made the round 3/4 build restriction unnecessary.)
   *   preferCastleOverSenate (2026-08-28, "AI LV4", default false, per user spec: "王宮 元老院 どちらに
   *   も置けるときは 王宮優先", exception confirmed the same day: "開拓者を例外にして" -- "空いている方を
   *   優先"; scoped to rounds 1-2 only, per a same-day follow-up: "元老院と王宮どちらも置けるときに王宮に
   *   するというのは 1-2R限定の話です" -- from round 3 on this policy is a complete no-op and both areas
   *   stay full, independent candidates): 王宮(CASTLE_MAP_ID/MAP008) and 元老院(AREA009_MAP_ID/MAP009) are
   *   functionally identical (both ANY-slot BUILD() areas), so offering both as separate candidates every
   *   turn is pure redundant
   *   search for computation-reduction purposes (see this class's own die-priority.js sibling for the
   *   same motivation). When both currently have at least one legal placement move this call, all 元老院
   *   moves are dropped in favor of 王宮 -- UNLESS playerId holds 開拓者 (JOB009, board.hasPioneerAbility),
   *   whose bonus only fires on an AREA with zero dice placed on it yet (board.isMapEmptyOfDice): a
   *   開拓者 owner instead keeps only whichever of the two is CURRENTLY empty (dropping the other), since
   *   that is a genuine value difference between them for this player specifically; a tie (both empty or
   *   both already occupied, so neither/either equally triggers or fails to trigger the bonus) falls back
   *   to the plain 王宮 preference. Applied as a post-filter over the whole move list (mapId is absent on
   *   every non-placement move type, e.g. FREE_ACTION/END_TURN, so those are always left untouched).
   */
  constructor(policy) {
    this.policy = policy || {};
  }

  /** See preferCastleOverSenate's own constructor doc for the full rule. No-op (returns moves unchanged)
   * whenever the policy isn't set, state.round > 2, or 王宮/元老院 aren't BOTH currently offering a legal
   * move. */
  #applyCastleSenatePreference(state, index, playerId, moves) {
    if (!this.policy.preferCastleOverSenate || state.round > 2) return moves;
    const CASTLE = board.CASTLE_MAP_ID;
    const SENATE = board.AREA009_MAP_ID;
    if (!moves.some((m) => m.mapId === CASTLE) || !moves.some((m) => m.mapId === SENATE)) return moves;
    let dropMapId = SENATE;
    if (board.hasPioneerAbility(state, index, playerId)) {
      const castleEmpty = board.isMapEmptyOfDice(state.maps[CASTLE]);
      const senateEmpty = board.isMapEmptyOfDice(state.maps[SENATE]);
      if (senateEmpty && !castleEmpty) dropMapId = CASTLE;
      // else: castle-only-empty, or a tie (both/neither empty) -- dropMapId stays SENATE (plain
      // preference, see this method's own doc).
    }
    return moves.filter((m) => m.mapId !== dropMapId);
  }

  /** True once state.round has reached the policy's avoidMapIdFromRound.round threshold for this exact
   * mapId -- no-op (always false) when the policy isn't set. */
  #isMapIdAvoided(state, mapId) {
    const avoid = this.policy.avoidMapIdFromRound;
    return !!avoid && mapId === avoid.mapId && state.round >= avoid.round;
  }

  /** @returns {Object[]} every legal Move for playerId right now. */
  generateMoves(state, index, playerId, context) {
    let moves = [];
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return moves;

    if (!context.hasPlacedDieThisTurn) {
      moves.push(...this.#placeDieMoves(state, index, playerId, player));
      moves.push(...this.#placeDiceGroupMoves(state, index, playerId, player));
      moves = this.#applyCastleSenatePreference(state, index, playerId, moves);
    }
    // Only offered while actually needed to unblock a RESOURCE_TOTAL_LIMIT-blocked turn end (2026-08-03,
    // per user feedback: "AIが無駄にA→K B→K C→K Z→K wD→2Kをやっています この行動には意味がないため
    // AIは上記のフリーアクションを基本的にはやらないようにしてください"). A simple linear-weighted
    // Evaluator has no notion of "do I actually need K right now" -- any conversion whose target weighs
    // even marginally more than its source (e.g. round-independent K=3 vs A=5 usually loses) reads as
    // "an improvement" and gets taken, even though it just trades a typed resource for K with no real
    // plan for it. Restricting generation to the one case where it's genuinely necessary (not "usually
    // good") keeps the resource-limit-unblock behavior that was specifically fixed earlier (CON005B
    // could otherwise deadlock the AI) without the otherwise-constant pointless conversions. (2026-08-07:
    // wD->2K, one of the free actions this comment originally listed, was abolished per user request --
    // see game-state.js's FREE_ACTION_IDS.)
    if (executor.canEndTurn(state, index, playerId).violations.length > 0) {
      moves.push(...this.#freeActionMoves(state, index, playerId, player));
    }
    moves.push(...this.#feeCollectionMoves(state, playerId));
    moves.push(...this.#bareTapMoves(state, index, playerId, player, context));
    moves.push(...this.#tapReactionMoves(state, playerId));
    if (context.hasPlacedDieThisTurn && executor.canEndTurn(state, index, playerId).ok) {
      moves.push({ type: 'END_TURN', playerId });
    }
    return moves;
  }

  #placeDieMoves(state, index, playerId, player) {
    const moves = [];
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    const diceWithAPlacement = new Set();
    // JOB003/道化 (2026-08-19): a wildcard-owning player never uses placeDice's own slotIndex-based path
    // -- see #wildcardPlaceDieMoves' own doc.
    const dieIsWildcard = board.hasWildcardDice(state, index, playerId);
    for (const die of unplacedDice) {
      for (const mapId of Object.keys(state.maps)) {
        if (this.#isMapIdAvoided(state, mapId)) continue;
        if (dieIsWildcard) {
          if (this.#wildcardPlaceDieMoves(state, index, playerId, die, mapId, moves)) diceWithAPlacement.add(die.id);
          continue;
        }
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const slotCount = board.getSlotRequirements(areaRow).length;
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const clone = cloneState(state);
          const result = board.placeDice(clone, index, { playerId }, die.id, mapId, slotIndex);
          if (!result.success) continue;
          diceWithAPlacement.add(die.id);
          if (result.actionResult && result.actionResult.pendingBuild) {
            const candidates = result.actionResult.pendingBuild.candidates;
            for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
              moves.push({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex, buildCandidateIndex });
            }
            // Always also offer "place the die, leave the build unresolved" -- getBuildCandidates only
            // checks dice/category eligibility, not affordability, so every candidate above can turn out
            // unaffordable once Simulator actually tries to pay for it. Without this fallback, a player
            // with no affordable candidate would have zero legal moves for this slot at all (found via
            // the 2026-07-31 stuck-AI debugging: P4 had 25 candidate moves from MoveGenerator but 0 that
            // Simulator accepted, because none were affordable).
            moves.push({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex });
            // A BUILD trigger with 0 candidates (NO_BUILDABLE_CARD) still placed the die legally --
            // that's just placeDice's success:true/actionResult.success:false case below, already
            // covered since result.actionResult.pendingBuild would be absent then.
          } else {
            moves.push({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex });
          }
        }
      }
    }
    // PASS_DIE only offered for a die with ZERO legal placements anywhere (2026-08-03, per user
    // feedback: "AIは基本的にパスをしないように出来ませんか" -- same "only when actually necessary"
    // pattern already applied to free actions). Passing is meant as a deadlock escape hatch (a die with
    // no legal slot would otherwise force the AI to face the same still-unplaceable die every cycle,
    // matching the human-facing pass button's own purpose), not a normal candidate the Evaluator gets to
    // weigh against a real placement -- doing that unconditionally is exactly what caused the AI to
    // default to passing almost every turn (found 2026-08-03: 13 passes vs 1 placement in one round,
    // even after correcting a passed die's score -- see evaluator.js's own comment on that fix).
    for (const die of unplacedDice) {
      if (!diceWithAPlacement.has(die.id)) moves.push({ type: 'PASS_DIE', playerId, dieId: die.id });
    }
    return moves;
  }

  /** #placeDieMoves' wildcard branch (JOB003/道化, 2026-08-19): board.placeWildcardDie auto-assigns the
   * slot itself, so this only tries die x mapId, never a slotIndex loop -- mirrors the non-wildcard
   * PLACE_DIE branch's pendingBuild/candidate handling exactly, just emitting PLACE_WILDCARD_DIE instead
   * (no slotIndex field at all, since the caller never chose one).
   * EX-vs-ANY choice (2026-08-28, see board.wildcardExAnyChoice's own doc and this file's own top-of-file
   * doc): when that returns non-null, tries BOTH slot indices (each dry-run via a fresh clone, same as
   * every other candidate here) and offers whichever succeed as separate Moves, each carrying its own
   * slotIndex -- letting the Evaluator actually choose, rather than silently defaulting to whichever slot
   * the AREA's own SLOT1-6 order happens to list first. Returns true iff this mapId yielded at least one
   * legal placement, so the caller can track diceWithAPlacement for the PASS_DIE fallback the same way. */
  #wildcardPlaceDieMoves(state, index, playerId, die, mapId, moves) {
    const exAnyChoice = board.wildcardExAnyChoice(state, index, { playerId }, mapId);
    const slotOptions = exAnyChoice ? [exAnyChoice.exSlotIndex, exAnyChoice.otherSlotIndex] : [undefined];
    let placedAny = false;
    for (const slotIndex of slotOptions) {
      const clone = cloneState(state);
      const result = board.placeWildcardDie(clone, index, { playerId }, die.id, mapId, slotIndex);
      if (!result.success) continue;
      placedAny = true;
      const moveBase = { type: 'PLACE_WILDCARD_DIE', playerId, dieId: die.id, mapId, ...(slotIndex !== undefined ? { slotIndex } : {}) };
      if (result.actionResult && result.actionResult.pendingBuild) {
        const candidates = result.actionResult.pendingBuild.candidates;
        for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
          moves.push({ ...moveBase, buildCandidateIndex });
        }
        moves.push({ ...moveBase });
      } else {
        moves.push({ ...moveBase });
      }
    }
    return placedAny;
  }

  /** PLACE_DICE_GROUP (2026-08-21, per user request -- see board.placeDiceGroup's own doc): AI-side
   * enumeration of 2-die monument-building placements at 王宮(CASTLE_MAP_ID)/元老院(AREA009_MAP_ID),
   * the only 2 maps board.placeDiceGroup supports. Deliberately pairs-only (never 3+ dice, per user
   * decision) and skips any pair whose combined value is <=6 (a single die could already reach that on
   * its own via #placeDieMoves, so there is no reason to ever spend 2 dice on it) -- this is a
   * MoveGenerator-side filter distinct from board.placeDiceGroup's own excludeOverfundedMonuments (which
   * only filters which monuments are offered for a pair that DOES get dry-run, not whether the pair is
   * tried at all). A 道化 (JOB003, hasWildcardDice) player can never use this path at all (see
   * board.placeDiceGroup's own WILDCARD_GROUP_NOT_ALLOWED refusal), so this returns early for them
   * rather than wasting dry-run clones that would always fail. Mirrors #placeDieMoves' own
   * pendingBuild/buildCandidateIndex handling exactly, just for a die *pair* instead of a single die. */
  #placeDiceGroupMoves(state, index, playerId, player) {
    const moves = [];
    if (board.hasWildcardDice(state, index, playerId)) return moves;
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    for (let i = 0; i < unplacedDice.length; i++) {
      for (let j = i + 1; j < unplacedDice.length; j++) {
        const dieA = unplacedDice[i];
        const dieB = unplacedDice[j];
        if (dieA.value + dieB.value <= 6) continue;
        for (const mapId of [board.CASTLE_MAP_ID, board.AREA009_MAP_ID]) {
          const clone = cloneState(state);
          const result = board.placeDiceGroup(clone, index, { playerId }, [dieA.id, dieB.id], mapId);
          if (!result.success) continue;
          const dieIds = [dieA.id, dieB.id];
          if (result.actionResult && result.actionResult.pendingBuild) {
            const candidates = result.actionResult.pendingBuild.candidates;
            for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
              moves.push({ type: 'PLACE_DICE_GROUP', playerId, dieIds, mapId, buildCandidateIndex });
            }
            // Same "also offer the build left unresolved" fallback as #placeDieMoves -- see its own
            // comment for why (candidates aren't affordability-filtered here, only category/dice-value
            // eligible).
            moves.push({ type: 'PLACE_DICE_GROUP', playerId, dieIds, mapId });
          } else {
            moves.push({ type: 'PLACE_DICE_GROUP', playerId, dieIds, mapId });
          }
        }
      }
    }
    return moves;
  }

  #freeActionMoves(state, index, playerId, player) {
    const moves = [];
    for (const freeActionId of ['A_K', 'B_K', 'C_K', 'Z_K']) {
      if (player.freeActionTaps[freeActionId]) continue;
      const clone = cloneState(state);
      const result = executor.tryFreeAction(clone, index, playerId, freeActionId);
      if (result.success) moves.push({ type: 'FREE_ACTION', playerId, freeActionId });
    }
    return moves;
  }

  #feeCollectionMoves(state, playerId) {
    const moves = [];
    for (const [mapId, mapState] of Object.entries(state.maps)) {
      if (mapState.feeOwnerId === playerId && mapState.accumulatedFee > 0) {
        moves.push({ type: 'COLLECT_FEE', playerId, mapId });
      }
    }
    return moves;
  }

  #bareTapMoves(state, index, playerId, player, context) {
    const moves = [];
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      const bareTap = bareTapKind(index, cardState.currentFaceId);
      if (!bareTap) continue;
      const unplacedDice = player.dice.filter((d) => d.placedMapId === null);
      if (bareTap.kind === 'IMMEDIATE') {
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
        if (!result.success) continue;
        // Skip a genuine no-op (2026-08-31, per user report: watching a replay, an AI player tapped
        // C003A/商人LV1's CHANGE(K,C,3) at 0K -- board.useBareTapAbility still returns success:true for a
        // 0-times CHANGE (see executor.runChange's own "times <= 0" doc), so without this check
        // MoveGenerator would keep offering a completely inert tap that ties the Evaluator's score with
        // "do nothing" and can win that tie purely by generation order. Compares the WHOLE player object
        // (not just the CHANGE's own resources) so a tap with a genuine non-resource side effect --
        // GRANT_PLACE_ANYWHERE, a die-value set, etc. -- is never mistaken for a no-op.
        const beforePlayer = state.players.find((p) => p.id === playerId);
        const afterPlayer = clone.players.find((p) => p.id === playerId);
        if (JSON.stringify(beforePlayer) === JSON.stringify(afterPlayer)) continue;
        // A BZ-conversion tap (e.g. JOB004A's "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)") is never
        // offered as a normal scored candidate unless a build outlet actually exists for the BZ it
        // would generate (2026-08-06, per user feedback: "AIは建築しないときはJOB004をTAPしない
        // （できない）"). forcedBzConversionMove already *forces* this exact tap whenever an outlet
        // DOES exist (see its own doc) -- that short-circuits AIPlayer.selectMove before
        // generateMoves is even reached for that top-level decision, so this branch only matters
        // when no outlet exists there *or* when generateMoves is called directly for a simulated
        // lookahead node (Simulator's deeper search isn't gated by the top-level short-circuit).
        // Either way: closes the loophole where the Evaluator could still pick this tap as a normal
        // candidate purely because its flat per-unit BZ weight doesn't know BZ evaporates unused at
        // TURNEND (see evaluator.js's own resource-weight loop) -- confirmed via
        // tools/ai_batch_run.js that this was dragging down JOB004's measured average score.
        if (bzConversionTap(index, cardState.currentFaceId) && !this.#hasAffordableBuildOutlet(clone, index, playerId, context)) continue;
        moves.push({ type: 'BARE_TAP', playerId, physicalId });
      } else if (bareTap.kind === 'BUILD') {
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
        if (result.success && result.pendingBuild) {
          // Unlike #placeDieMoves, no "leave the build unresolved" fallback here: board.useBareTapAbility
          // returns pendingBuild *before* paying anything or tapping the card (see its own doc), so
          // declining every candidate would be a true no-op -- same state in, same state out. Offering
          // it as a Move let AIPlayer's first-max-wins tie-break pick it forever (found 2026-08-02:
          // ai-batch-5 looped on B006A's BUILD-kind TAP indefinitely, since a no-op move ties every
          // other move's score and this one sorted before END_TURN).
          for (let buildCandidateIndex = 0; buildCandidateIndex < result.pendingBuild.candidates.length; buildCandidateIndex++) {
            moves.push({ type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex });
          }
        }
      } else if (bareTap.kind === 'MONUMENT_CHANGE_DIE_VALUE') {
        // Needs a die but no value/delta (the delta is a single fixed number baked in at DSL-lowering
        // time -- see bareTapKind's own doc). Same bzConversionTap gating as the IMMEDIATE branch above
        // (JOB007's own TAP grants BZ, same shape) -- forcedBzConversionMove already forces this whenever
        // a build outlet exists; this branch only matters when one doesn't (or for a simulated lookahead
        // node the top-level short-circuit doesn't gate).
        const isBz = bzConversionTap(index, cardState.currentFaceId);
        for (const die of unplacedDice) {
          const tapContext = { playerId, chosenDieId: die.id };
          const clone = cloneState(state);
          const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
          if (!result.success) continue;
          if (isBz && !this.#hasAffordableBuildOutlet(clone, index, playerId, context)) continue;
          moves.push({ type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id });
        }
      } else if (board.hasWildcardDice(state, index, playerId)) {
        // 道化(JOB003)'s own ☆ dice ignore VALUE_MISMATCH entirely and their buildValue is category-fixed
        // (1 for A/B/C, 6 for monument -- see board.placeWildcardDie's own doc), never dependent on the
        // die's own .value at all -- so a SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE tap can NEVER change
        // what a ☆-owning player can reach with any die, for any value. #dieReachableOutcomes below
        // assumes board.placeDice (the non-wildcard path), which doesn't reflect ☆'s real placement rules
        // -- rather than adapting it for a case that's provably always a no-op anyway, this player is
        // simply never offered these taps at all (2026-08-28, part of the same gating this whole branch
        // exists for -- see the other branch's own doc).
      } else {
        // SET_DICE_ANY / SET_DIE_VALUE / CHANGE_DIE_VALUE -- needs a die + a value/delta up front
        // (the whole TAP field runs as one atomic program, see board.useBareTapAbility's own doc).
        // Only offered once it lets THIS SPECIFIC die reach a genuinely NEW outcome (mapId/slotIndex/
        // resulting card) it couldn't already reach at its original value (2026-08-28, per user spec:
        // "置かないダイスにダイス変換を使わない 結果がだいたい同じときは（同じSLOTにおけて同じカードが
        // 獲得できるとき、残すダイスが違ってもOK）ダイス変換を使わない" -- refining the earlier
        // #hasAffordableBuildOutlet gate, which only checked "is there an outlet ANYWHERE on the board",
        // not whether THIS die specifically ends up used for it, or whether the outlet was reachable
        // without converting at all. A die whose value changes this turn but never gets PLACED that same
        // turn silently reverts at TURNEND (see executor.js's own valueChangedThisTurn revert), so either
        // gap left the once-per-round tap burnable for nothing.
        const values = bareTap.kind === 'SET_DICE_ANY' ? [1, 2, 3, 4, 5, 6] : bareTap.choices;
        for (const die of unplacedDice) {
          const outcomesBefore = this.#dieReachableOutcomes(state, index, playerId, die.id);
          for (const value of values) {
            const tapContext = { playerId, chosenDieId: die.id };
            if (bareTap.kind === 'CHANGE_DIE_VALUE') tapContext.chosenDelta = value;
            else tapContext.chosenValue = value;
            const clone = cloneState(state);
            const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
            if (!result.success) continue;
            const outcomesAfter = this.#dieReachableOutcomes(clone, index, playerId, die.id);
            const hasNewOutcome = [...outcomesAfter].some((o) => !outcomesBefore.has(o));
            if (!hasNewOutcome) continue;
            moves.push({
              type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id,
              ...(bareTap.kind === 'CHANGE_DIE_VALUE' ? { chosenDelta: value } : { chosenValue: value }),
            });
          }
        }
      }
    }
    return moves;
  }

  #tapReactionMoves(state, playerId) {
    const moves = [];
    for (const choice of state.pendingChoices) {
      if (choice.playerId !== playerId || choice.kind !== 'TAP_REACTION_AVAILABLE') continue;
      moves.push({ type: 'TAP_REACTION', playerId, choiceId: choice.id, use: true });
      moves.push({ type: 'TAP_REACTION', playerId, choiceId: choice.id, use: false });
    }
    return moves;
  }

  /** Finds playerId's forced BZ-conversion bare TAP (e.g. JOB004A's "CHANGE(3K,2BZ)"), if one is
   * currently legal AND would actually get spent on a build before this turn ends, and returns it as a
   * ready-to-apply Move -- or null if none applies. Unlike every other move category above, this is NOT
   * offered as a candidate for AIPlayer to weigh against alternatives: AIPlayer.selectMove calls this
   * FIRST and short-circuits straight to it when non-null, skipping generateMoves/Evaluator entirely for
   * that decision (2026-08-04, per user feedback: "JOB004の効果は使えるときは必ず使う"). Two reasons this
   * needed to be unconditional (within its now-gated scope) rather than left as a normal scored
   * candidate: (1) a simple 1-ply Evaluator can't see that converting K into BZ pays off later via an
   * otherwise-unaffordable build (that's the whole point of BZ), so leaving it to compete on score alone
   * was undervaluing it; (2) making it a forced pre-step (not a MoveGenerator candidate) costs nothing
   * extra in the search -- if anything it *shrinks* the branching factor by one move whenever it applies,
   * rather than growing it.
   *
   * `context` (2026-08-0X, per user feedback: "BZはターン終了時に無くなります...AIもBZを作る→無くなる
   * ということをしないようにしてください"): BZ used to be safe to bank ahead of time since it never
   * expired, but now it's lost the moment this turn ends (see executor.applyTurnEnd), so blindly forcing
   * this conversion whenever legal -- regardless of whether anything this turn could actually spend it --
   * would just as often waste it as use it (e.g. a turn where the die already went on a non-BUILD AREA
   * and no BUILD-kind bare TAP is available). Gated on there being at least one build-resolving move
   * (PLACE_DIE/BARE_TAP carrying a buildCandidateIndex) reachable in the state *after* this
   * conversion -- if none exists, this returns null and falls through to the normal scored candidates
   * instead (the plain CHANGE(3K,2BZ) is still offered there via #bareTapMoves' IMMEDIATE case; the
   * Evaluator's raw resource weights should reject it on their own when there's truly nothing to spend it
   * on, without needing another special case here). See bzConversionTap for the detection rule and
   * simulator.js's own doc for the unrelated "always use *already-held* BZ on a BUILD's payment" half of
   * this feature, which needed no change -- BZ still can't outlive the turn it's spent in either way.
   *
   * **Corrected 2026-08-04** (per user feedback: "JOB004のAIの平均点が低すぎます 3K→2BZ 使えていますか？"
   * -- investigation found this was firing far more than intended): "reachable" here used to mean only
   * "some buildCandidateIndex-carrying move exists", but #placeDieMoves/#bareTapMoves deliberately don't
   * affordability-filter their buildCandidateIndex candidates (see #placeDieMoves' own doc -- that's
   * left to Simulator, since getBuildCandidates only checks dice/category eligibility). That made this
   * force JOB004's conversion any time *any* build was dice-reachable at all, whether or not the
   * resulting build could actually be paid for -- confirmed via tests/ai-move-generator.smoke.js's own
   * existing case, which asserted a forced fire with a player holding 0 A/B/C resources (nothing to
   * build with regardless of BZ). Burning 3K and BLOCK_BUILD(M,THIS_TURN) for a build that then fails
   * outright is a pure loss with no offsetting upside -- exactly the kind of AI misplay that would drag
   * down JOB004's measured average score in tools/ai_data_report.js. Now actually simulates each
   * candidate via applyInPlace (the same payment pipeline, incl. maxBzDiscount, the real move commits
   * with later) and only forces the conversion if at least one of them would actually succeed.
   *
   * dieCandidates (2026-08-25, fixing the same bareTapKind gap described in that function's own doc --
   * JOB007's own "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(...)" is a bzConversionTap shape
   * that ALSO needs a chosenDieId; the single `{playerId}`-only attempt below always failed for it with
   * no die ever supplied, so this force could never fire (per user report: "宮廷人 AIの使用回数が0です")):
   * tries every unplaced die in turn for a MONUMENT_CHANGE_DIE_VALUE-shaped tap, `[null]` (a single
   * no-choice attempt, unchanged) for every other bzConversionTap shape. */
  forcedBzConversionMove(state, index, playerId, context) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      if (!bzConversionTap(index, cardState.currentFaceId)) continue;
      const needsDieChoice = bareTapKind(index, cardState.currentFaceId).kind === 'MONUMENT_CHANGE_DIE_VALUE';
      const dieCandidates = needsDieChoice ? player.dice.filter((d) => d.placedMapId === null) : [null];
      for (const die of dieCandidates) {
        const tapContext = die ? { playerId, chosenDieId: die.id } : { playerId };
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
        if (!result.success) continue;
        if (this.#hasAffordableBuildOutlet(clone, index, playerId, context)) {
          return { type: 'BARE_TAP', playerId, physicalId, ...(die ? { chosenDieId: die.id } : {}) };
        }
      }
    }
    return null;
  }

  /** 策士/JOB004 (2026-08-28, per user request/experiment: "策士は3K以上あれば基本的に毎ターン使うでどう
   * でしょうか これで逆に弱くなるようなら戻します" -- prompted by a report that AI LV4 passed up a
   * 策士→終わりの兆しLV2→鐘楼 combo because the immediate score of converting 3K->2Z alone doesn't reflect
   * the build it can enable 1-2 moves later, so a beam/rollout search can prune it before ever discovering
   * that value): forces CHANGE(3K,2Z) unconditionally whenever the player owns an untapped JOB004 with
   * >=3K, with NO build-outlet check -- deliberately simpler than forcedBzConversionMove's own gating.
   * JOB004's TAP no longer grants BZ at all (a 2026-08-24 data edit changed it to grant plain Z instead),
   * so bzConversionTap/forcedBzConversionMove don't recognize this card's current shape any more -- this
   * is a separate, JOB004-specific mechanism rather than broadening that BZ-specific one, since the
   * intended policy genuinely differs (always force here, vs. only-when-useful there). JOB004's own
   * TURNEND=UNTAP() means this can fire again every single turn, not just once per round -- revert this
   * (per the user's own framing) if it turns out to make JOB004 weaker in practice.
   *
   * Usage-fee guard (2026-08-30, per user bug report: a live game froze after leveling up 元老院LV2 with
   * 4K, this firing and spending 3K down to 1K, leaving the AREA009 usage fee unpayable -- "3Kあったら
   * 必ず使う→手数料をひいて3K余るなら使う"): now also requires that 3K would still be left over AFTER
   * paying whatever K this player currently has reserved -- player.lockedK (the AREA009-specific floor
   * tryPay/resolvePayment already refuse to dip below, see its own doc) and/or player.pendingFee.amount
   * (a non-AREA009 B/C-tier fee, which doesn't reserve lockedK but still needs paying at TURNEND) --
   * without this, forcing the conversion anyway could leave the fee unpayable with no K left to fix it,
   * which (depending on what resources remain) can leave the player's turn genuinely stuck. */
  forcedJob004ConversionMove(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || (player.resources.K || 0) < 3) return null;
    const reservedK = Math.max(player.lockedK || 0, player.pendingFee ? player.pendingFee.amount : 0);
    if ((player.resources.K || 0) - 3 < reservedK) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped || cardState.currentFaceId !== 'JOB004') continue;
      return { type: 'BARE_TAP', playerId, physicalId };
    }
    return null;
  }

  /** 終わりの兆しLV2/B202B (2026-08-28, per user request: "終わりの兆しLV2は獲得できるカードがあれば
   * すぐ使うようにしてください 使用対象が複数の時はダイス目高いほうを優先で" -- "ダイス目" here means the
   * MONUMENT's own DICE threshold (e.g. ">=12" vs ">=11"), not a real placed die -- B202B's own
   * TAP="BUILD(M,12)" has a fixed buildValue, no die involved at all): forces the tap unconditionally
   * whenever at least one monument candidate is genuinely affordable, picking whichever affordable
   * candidate has the HIGHEST DICE threshold when more than one qualifies -- a higher-threshold monument
   * is harder to reach via an ordinary die (solo max 6, PLACE_DICE_GROUP max 12) or other cards, so this
   * spends B202B's fixed-12 reach on whichever one benefits most from it, not just the first one found.
   * Unlike #bareTapMoves' own BUILD branch (which offers every reachable candidate as a separate scored
   * Move, dice/category-eligible but not affordability-filtered -- see getBuildCandidates' own doc), this
   * actually simulates each one via applyInPlace to find which are real options, same as
   * #hasAffordableBuildOutlet's own approach.
   *
   * Usage-fee guard (2026-08-30, per user request, extending the same class of guard already added to
   * forcedJob004ConversionMove/forcedTrainingGroundMove): a candidate that would leave an already-pending
   * usage fee unaffordable is skipped, same as those two. Unlike those two (a flat K cost), a monument's
   * COST can be any mix of A/B/C/K, so this checks the *resulting* player's post-build resources against
   * board.canAffordFee (K + every free-action-convertible resource) rather than a precomputed K amount --
   * player.lockedK (the AREA009-specific reserved floor) doesn't need its own separate check here since
   * board.js's own payment logic already refuses to dip below it, so a candidate that would violate it
   * already fails the applyInPlace call above and never reaches this point. */
  forcedEndSignLv2Move(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped || cardState.currentFaceId !== 'B202B') continue;
      const clone = cloneState(state);
      const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
      if (!result.success || !result.pendingBuild) continue;
      let bestIndex = null;
      let bestThreshold = -Infinity;
      for (let i = 0; i < result.pendingBuild.candidates.length; i++) {
        const move = { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex: i };
        const tryClone = cloneState(state);
        if (!applyInPlace(tryClone, index, move).success) continue;
        const afterPlayer = tryClone.players.find((p) => p.id === playerId);
        if (afterPlayer.pendingFee && !board.canAffordFee(afterPlayer, afterPlayer.pendingFee.amount)) continue;
        const candidate = result.pendingBuild.candidates[i];
        const faceId = candidate.faceId || candidate.toFaceId;
        const match = /^>=(\d+)$/.exec(getCardRow(index, faceId).DICE || '');
        const threshold = match ? Number(match[1]) : -Infinity;
        if (threshold > bestThreshold) {
          bestThreshold = threshold;
          bestIndex = i;
        }
      }
      if (bestIndex !== null) return { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex: bestIndex };
    }
    return null;
  }

  /** How much K MAP007's own current face spends per die placed there, via its CHANGE(nK,D) ACTION --
   * 0 for AREA007A/C (CHANGE((A,B,C),D)/ADD(D), no K involved). Shared by forcedTrainingGroundMove's own
   * pendingFee/lockedK guard and forcedTrainingGroundKPrepMove's "do I even have enough yet" check --
   * factored out (2026-08-30) so both stay correct together as this amount keeps changing (2026-08-25
   * "訓練場LV1　能力変えました" added CHANGE(K,D); 2026-08-30 "訓練場すこしかえました" raised it to
   * CHANGE(2K,D)). */
  #trainingGroundKCost(index, state) {
    const areaRow = getAreaRow(index, state.maps.MAP007.currentAreaId);
    const match = /^CHANGE\((\d*)K,D\)$/.exec(areaRow.ACTION || '');
    return match ? Number(match[1] || 1) : 0;
  }

  /** 訓練場の支配/A202A・A202B (2026-08-28, per user request: "訓練場の支配も獲得したら必ずすぐに訓練場に
   * ダイスを置いて追加色ダイスを獲得するようにしてほしい"; scoped to "新しい色ダイスが得られる時だけ強制"
   * per follow-up confirmation): forces a PLACE_DIE at 訓練場(MAP007) whenever the player owns either
   * face AND some unplaced die's placement there would genuinely raise their own COLOR-dice count (not
   * just "the placement succeeds" -- a placement that succeeds without a net gain, e.g. once already at
   * whatever cap applies, is left alone so the player's own turn choice/normal search still picks whatever
   * else looks best). Mirrors board.js's own AREA007-tier CHANGE((A,B,C),D)/CHANGE(K,D)/ADD(D) shapes by
   * just diffing color-dice count before/after a real dry-run placement, rather than re-deriving each
   * tier's own resource math here. Only offered while this player hasn't already placed a die this turn
   * (context.hasPlacedDieThisTurn), same PLACE_DIE-family gating as everywhere else. Skipped entirely for
   * a wildcard-owning (道化/JOB003) player -- their dice all need board.placeWildcardDie instead of
   * board.placeDice below (see #placeDieMoves' own dieIsWildcard branch); this rare combination (owning
   * BOTH JOB003 and A202A/B) is left to the normal search rather than adding a second placement path here.
   *
   * Usage-fee guard (2026-08-30, per user request: "使用料を認識して払えるように", same class of bug as
   * forcedJob004ConversionMove's own matching guard): building/owning 訓練場 makes this player its own
   * feeOwnerId (see executor.runSetCurrentArea), so placing on their own copy never incurs a NEW fee here
   * -- but if some OTHER fee is already pending from earlier this same turn, spending this AREA's own K
   * cost on top of it could leave that fee unpayable. board.placeDice's own payment logic already refuses
   * to dip below player.lockedK (the AREA009-specific reserved floor) on its own, but a non-AREA009
   * pendingFee.amount isn't reserved that way -- checked explicitly here too, so both cases are covered
   * consistently regardless of which one actually applies. */
  forcedTrainingGroundMove(state, index, playerId, context) {
    if (context.hasPlacedDieThisTurn) return null;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || board.hasWildcardDice(state, index, playerId)) return null;
    const ownsControl = player.ownedCardPhysicalIds.some((physicalId) => {
      const cardState = state.cards[physicalId];
      return cardState && (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B');
    });
    if (!ownsControl) return null;
    const kCost = this.#trainingGroundKCost(index, state);
    const reservedK = Math.max(player.lockedK || 0, player.pendingFee ? player.pendingFee.amount : 0);
    if (kCost > 0 && (player.resources.K || 0) - kCost < reservedK) return null;
    const beforeColorCount = player.dice.filter((d) => d.kind === 'COLOR').length;
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    const areaRow = getAreaRow(index, state.maps.MAP007.currentAreaId);
    const slotCount = board.getSlotRequirements(areaRow).length;
    for (const die of unplacedDice) {
      for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        const clone = cloneState(state);
        const result = board.placeDice(clone, index, { playerId }, die.id, 'MAP007', slotIndex);
        if (!result.success) continue;
        const afterPlayer = clone.players.find((p) => p.id === playerId);
        const afterColorCount = afterPlayer.dice.filter((d) => d.kind === 'COLOR').length;
        if (afterColorCount > beforeColorCount) {
          return { type: 'PLACE_DIE', playerId, dieId: die.id, mapId: 'MAP007', slotIndex };
        }
      }
    }
    return null;
  }

  /** 訓練場の支配/A202Aを先取りする (2026-08-30, per user request, following a replay report where the AI
   * collected 小麦畑's 3K then only afterward built 訓練場の支配 -- with just 2 dice left that order wastes
   * the round's only chance to also spend a die on 訓練場's own CHANGE(K,D)/ADD(D): forces building A202A
   * BEFORE any other move whenever (a) round>=2 (per user confirmation -- round 1 dice are too scarce/
   * onboarding-heavy for this to reliably pay off), (b) the player doesn't already own it, (c) total color
   * dice count is exactly 3 (same trigger evaluator.js's own TRAINING_GROUND_DOMINATION_BONUS uses -- this
   * is the "stuck right at CON005A's 3-die cap" sweet spot), and (d) at least one MORE unplaced die would
   * be left over after spending one on this build, so forcedTrainingGroundMove above has something left
   * to actually use afterward -- building on the round's last die would strand the upgrade unused this
   * round, which the user explicitly confirmed should NOT be forced ("ダイスが残っていなくて次のラウンド
   * になってしまうようであれば逆に獲得しない"). Mirrors #placeDieMoves' own dice x map x slot x
   * buildCandidateIndex enumeration (build candidates for an AREA upgrade can appear at any hammer-icon
   * area, not just AREA007 itself) rather than forcedEndSignLv2Move's bare-TAP path -- A202A has no TAP
   * field of its own, so it's only ever reachable via a normal PLACE_DIE build candidate.
   *
   * hasPlacedDieThisTurn gate (2026-08-30, found during a forced-move consistency audit): this returns a
   * PLACE_DIE move, the once-per-turn placement -- without checking context.hasPlacedDieThisTurn (unlike
   * forcedTrainingGroundMove's own matching gate), a selectMove call made *after* this player already
   * placed their one die this turn some other way (e.g. a normal scored move, before ownsControl became
   * true) would still force a SECOND placement here, since nothing else in this function's own conditions
   * depends on whether a die was placed yet. Confirmed reproducible via a direct unit check: with one die
   * already sitting at placedMapId!==null and the rest of the trigger conditions intact, this returned a
   * real move to place a second die.
   *
   * TAP-based build preferred first (2026-08-31, per user report: watching a replay, the AI forced a
   * die-based build of A202A here even though B006A/移ろいの兆しLV1's own BUILD-kind bare TAP
   * (TAP=BUILD((A,B,C,M),4)) could build the exact same A202A for free, no die spent -- confirmed by
   * re-scoring the real state, where the TAP move scored higher (1459) than the die move this function
   * actually forced (1409). "A202A has no TAP field of its own" (see this function's own doc above) is
   * true but incomplete -- a DIFFERENT owned card's generic BUILD tap can still reach it as one of its
   * candidates. #trainingGroundTapBuildMove is checked before the die-based search below (and before the
   * die-count/dice-remaining gates that search relies on, since those exist purely to reason about a die
   * trade-off this free path doesn't have) -- whenever it finds one, it's strictly better (same
   * acquisition, no die spent) and wins outright. */
  forcedTrainingGroundBuildMove(state, index, playerId, context) {
    if (state.round < 2 || context.hasPlacedDieThisTurn) return null;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || board.hasWildcardDice(state, index, playerId)) return null;
    const ownsControl = player.ownedCardPhysicalIds.some((physicalId) => {
      const cardState = state.cards[physicalId];
      return cardState && (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B');
    });
    if (ownsControl) return null;
    const tapBuild = this.#trainingGroundTapBuildMove(state, index, playerId, player);
    if (tapBuild) return tapBuild;
    const totalColorDiceCount = player.dice.filter((d) => d.kind === 'COLOR').length;
    if (totalColorDiceCount !== 3) return null;
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    if (unplacedDice.length < 2) return null;
    for (const die of unplacedDice) {
      for (const mapId of Object.keys(state.maps)) {
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const slotCount = board.getSlotRequirements(areaRow).length;
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const clone = cloneState(state);
          const result = board.placeDice(clone, index, { playerId }, die.id, mapId, slotIndex);
          if (!result.success || !result.actionResult || !result.actionResult.pendingBuild) continue;
          const candidates = result.actionResult.pendingBuild.candidates;
          for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
            const candidate = candidates[buildCandidateIndex];
            if ((candidate.faceId || candidate.toFaceId) !== 'A202A') continue;
            const move = { type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex, buildCandidateIndex };
            if (applyInPlace(cloneState(state), index, move).success) return move;
          }
        }
      }
    }
    return null;
  }

  /** A currently-untapped owned card whose BUILD-kind bare TAP (e.g. B006A/移ろいの兆しLV1's
   * TAP=BUILD((A,B,C,M),4)) can build A202A right now, if any -- see forcedTrainingGroundBuildMove's own
   * doc on why this is checked first. Same per-card dry-run pattern #bareTapMoves' own 'BUILD' branch
   * uses, just filtered down to the one target face this caller cares about. */
  #trainingGroundTapBuildMove(state, index, playerId, player) {
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      const bareTap = bareTapKind(index, cardState.currentFaceId);
      if (!bareTap || bareTap.kind !== 'BUILD') continue;
      const clone = cloneState(state);
      const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
      if (!result.success || !result.pendingBuild) continue;
      const candidates = result.pendingBuild.candidates;
      for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
        const candidate = candidates[buildCandidateIndex];
        if ((candidate.faceId || candidate.toFaceId) !== 'A202A') continue;
        const move = { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex };
        if (applyInPlace(cloneState(state), index, move).success) return move;
      }
    }
    return null;
  }

  /** 訓練場の支配所有時、Kが無ければ先にKを用意する (2026-08-30, per user request: "ただしKがなくてダイス
   * が２個以上残っているなら小麦畑か農園のKが多く獲得できる方にいってその次に訓練場　ダイスが最後の一こ
   * なら　ABCのいずれかをKに変えて訓練場に行く"): forcedTrainingGroundMove above only ever succeeds once
   * the player actually has enough K on hand to spend on 訓練場's own CHANGE(nK,D) -- with too little K it
   * dry-run-fails every slot and returns null, silently falling through to whatever the normal search
   * picks instead. This fills that gap: with 2+ dice left, force a placement at whichever of 小麦畑
   * (MAP001)/農園(MAP002) currently yields more K (comparing their own live ACTION field, not a hardcoded
   * LEVEL, since either could be independently upgraded); with exactly 1 die left, spend a free action
   * converting whichever of A/B/C the player holds the most of into K (2026-08-30, per user confirmation
   * on ties/multiple) -- free actions don't consume the die or set hasPlacedDieThisTurn, so the very next
   * selectMove/#greedyMove call this same turn re-checks forcedTrainingGroundMove, which will now succeed
   * and place the last die at 訓練場. K-needed comes from #trainingGroundKCost (0 for AREA007C's ADD(D),
   * which needs no K at all) rather than being hardcoded here, since the exact amount has already changed
   * twice (2026-08-25 "訓練場LV1　能力変えました" added CHANGE(K,D); 2026-08-30 "訓練場すこしかえました"
   * raised it to CHANGE(2K,D)) and could again. */
  forcedTrainingGroundKPrepMove(state, index, playerId, context) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || board.hasWildcardDice(state, index, playerId)) return null;
    const ownsControl = player.ownedCardPhysicalIds.some((physicalId) => {
      const cardState = state.cards[physicalId];
      return cardState && (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B');
    });
    if (!ownsControl) return null;
    const kNeeded = this.#trainingGroundKCost(index, state);
    if (kNeeded === 0 || (player.resources.K || 0) >= kNeeded) return null;
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    if (unplacedDice.length === 0) return null;
    if (unplacedDice.length >= 2) {
      if (context.hasPlacedDieThisTurn) return null;
      let best = null;
      for (const mapId of ['MAP001', 'MAP002']) {
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const match = /^ADD\((\d+)K\)$/.exec(areaRow.ACTION || '');
        if (!match) continue;
        const yieldK = Number(match[1]);
        if (!best || yieldK > best.yieldK) best = { mapId, yieldK };
      }
      if (!best) return null;
      const areaRow = getAreaRow(index, state.maps[best.mapId].currentAreaId);
      const slotCount = board.getSlotRequirements(areaRow).length;
      for (const die of unplacedDice) {
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const clone = cloneState(state);
          if (board.placeDice(clone, index, { playerId }, die.id, best.mapId, slotIndex).success) {
            return { type: 'PLACE_DIE', playerId, dieId: die.id, mapId: best.mapId, slotIndex };
          }
        }
      }
      return null;
    }
    const candidates = ['A', 'B', 'C'].filter((r) => (player.resources[r] || 0) > 0);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => player.resources[b] - player.resources[a]);
    return { type: 'FREE_ACTION', playerId, freeActionId: `${candidates[0]}_K` };
  }

  /** Whether some build-resolving move (PLACE_DIE/BARE_TAP carrying a buildCandidateIndex)
   * in clone would actually succeed if applied right now -- shared by forcedBzConversionMove (deciding
   * whether to force a BZ-conversion tap) and #bareTapMoves' IMMEDIATE branch (deciding whether to even
   * offer one as a normal candidate when it isn't forced -- see that branch's own comment). */
  #hasAffordableBuildOutlet(clone, index, playerId, context) {
    const buildMoves = this.generateMoves(clone, index, playerId, context)
      .filter((m) => m.buildCandidateIndex !== undefined);
    return buildMoves.some((m) => applyInPlace(cloneState(clone), index, m).success);
  }

  /** Every (mapId, slotIndex, outcome) dieId could legally, effectively reach right now in `state` --
   * outcome is the built/upgraded faceId for a BUILD-resolving placement, or 'NONE' for a plain
   * AREA-effect resolution. Used by #bareTapMoves' die-value-change gating (2026-08-28, per user spec:
   * "置かないダイスにダイス変換を使わない 結果がだいたい同じときは...ダイス変換を使わない") to compare
   * one die's reach before vs after a value-change TAP -- keyed by the actual resulting card rather than
   * a candidate array INDEX, since indices from two different dry-run calls aren't comparable (the whole
   * point here is diffing this die's reach across two different states). Mirrors #placeDieMoves' own
   * per-slot dry-run loop, scoped to one die. Never called for a wildcard-owning player (see the call
   * site's own comment on why that case is skipped entirely instead). */
  #dieReachableOutcomes(state, index, playerId, dieId) {
    const outcomes = new Set();
    for (const mapId of Object.keys(state.maps)) {
      if (this.#isMapIdAvoided(state, mapId)) continue;
      const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
      const slotCount = board.getSlotRequirements(areaRow).length;
      for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        const clone = cloneState(state);
        const result = board.placeDice(clone, index, { playerId }, dieId, mapId, slotIndex);
        if (!result.success) continue;
        if (result.actionResult && result.actionResult.pendingBuild) {
          for (const candidate of result.actionResult.pendingBuild.candidates) {
            outcomes.add(`${mapId}|${slotIndex}|${candidate.faceId || candidate.toFaceId}`);
          }
        } else {
          outcomes.add(`${mapId}|${slotIndex}|NONE`);
        }
      }
    }
    return outcomes;
  }
}

/** A bare (direct, non-ON-wrapped) TAP ability built from a CHANGE(...) or ADD(...) command that grants
 * BZ -- e.g. JOB007's "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+2);BLOCK_BUILD(A,THIS_TURN);BLOCK_BUILD(B,
 * THIS_TURN);BLOCK_BUILD(C,THIS_TURN)" (2026-08-07: generalized from CHANGE-only to also cover ADD,
 * since JOB007 grants BZ for free rather than converting another resource into it -- JOB004 used to be
 * the CHANGE-based example, "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)", until its own TAP dropped BZ
 * entirely on 2026-08-24 in favor of CHANGE(3K,2Z); no card grants BZ via CHANGE any more today, but the
 * CHANGE branch below is kept since bzConversionTap is meant to recognize this *shape*, not one specific
 * card. The BLOCK_BUILD half is a side-effect restriction, not a second thing this ability "does", so it
 * doesn't disqualify the shape; MONUMENT_DICE_DISCOUNT was added to the same allowed-side-effects set
 * 2026-08-18 when JOB007's TAP grew that clause, and MONUMENT_CHANGE_DIE_VALUE joined it 2026-08-24 when
 * that same clause was replaced with a fixed dice-value change instead of a discount).
 * Returns the lowered CHANGE/ADD command, or null if faceId has no TAP field, no BZ grant is there, or
 * the field has some other statement besides CHANGE/ADD/BLOCK_BUILD/MONUMENT_DICE_DISCOUNT/
 * MONUMENT_CHANGE_DIE_VALUE. See MoveGenerator#forcedBzConversionMove's own doc for why this is treated
 * as forced rather than a normal candidate. Deliberately not scoped to any one card: any future card
 * with the same shape (a bare BZ grant, optionally paired with one of those side effects) gets the same
 * forced treatment automatically. */
function bzConversionTap(index, faceId) {
  let row;
  try { row = getCardRow(index, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = lowerProgram(parse(row.TAP));
  const bzCmd = commands.find((c) => (c.type === 'CHANGE' && c.gain.some((g) => g.resource === 'BZ'))
    || (c.type === 'ADD' && c.items.some((i) => i.resource === 'BZ')));
  if (!bzCmd) return null;
  const SIDE_EFFECT_TYPES = new Set(['BLOCK_BUILD', 'MONUMENT_DICE_DISCOUNT', 'MONUMENT_CHANGE_DIE_VALUE']);
  const onlyBzGrantAndSideEffects = commands.every((c) => c === bzCmd || SIDE_EFFECT_TYPES.has(c.type));
  return onlyBzGrantAndSideEffects ? bzCmd : null;
}

module.exports = { MoveGenerator, bareTapKind, bzConversionTap };

})();
