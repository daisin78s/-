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
 *   { type:'PASS_DIE', playerId, dieId }
 *   { type:'BARE_TAP', playerId, physicalId, chosenDieId?, chosenValue?, chosenDelta?, buildCandidateIndex? }
 *   { type:'FREE_ACTION', playerId, freeActionId }
 *   { type:'COLLECT_FEE', playerId, mapId }
 *   { type:'TAP_REACTION', playerId, choiceId, use }
 *   { type:'CLAIM_QUEST', playerId, questFaceId, buildCandidateIndex? }
 *   { type:'END_TURN', playerId }
 *
 * context.hasPlacedDieThisTurn (supplied by AIPlayer, which tracks it the same way main.js's UI-only
 * turnActionTaken flag does -- GameState has no such field, since a "turn" isn't its own state, just
 * turn-flow.getNextTurn's rotation) gates which categories apply: PLACE_DIE/PASS_DIE only appear while
 * false (fulfilling the mandatory once-per-turn placement-or-pass decision, see board.passDie's own
 * doc); END_TURN only appears once true (matches main.js's 2026-08-01 "建築後、ターンエンド前にTAPの
 * フリーアクションが可能です" fix -- ending a turn is a separate, explicit choice, not automatic).
 * Everything else (free actions/bare TAP/TAP reactions/QST) is available either way, same as the real
 * UI's own gating.
 *
 * Simplification confirmed for this first pass (see simulator.js's matching note): PLACE_DIE/BARE_TAP/
 * CLAIM_QUEST candidates never vary colorPreference/bzDiscount -- payment always resolves AUTO.
 */

const { getAreaRow, getCardRow } = require('../data-loader');
const { parse } = require('../dsl-parser');
const { lowerProgram } = require('../command-builder');
const { cloneState } = require('../game-state');
const board = require('../board');
const executor = require('../executor');
const qst = require('../qst');
const { applyInPlace } = require('./simulator');

/** Mirrors main.js's bareTapKind (2026-07-31) -- duplicated rather than shared because main.js is a
 * browser-only classic script, not a requireable CommonJS module like the rest of src/. Keep the two
 * in sync if either changes. null = no TAP field, or purely ON(...)-wrapped (reactive-only, handled as
 * a TAP_REACTION choice instead, never generated as a BARE_TAP move here). */
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
  if (first.type === 'BUILD') return { kind: 'BUILD' };
  return { kind: 'IMMEDIATE' };
}

class MoveGenerator {
  /** @returns {Object[]} every legal Move for playerId right now. */
  generateMoves(state, index, playerId, context) {
    const moves = [];
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return moves;

    if (!context.hasPlacedDieThisTurn) {
      moves.push(...this.#placeDieMoves(state, index, playerId, player));
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
    moves.push(...this.#questMoves(state, index, playerId));
    if (context.hasPlacedDieThisTurn && executor.canEndTurn(state, index, playerId).ok) {
      moves.push({ type: 'END_TURN', playerId });
    }
    return moves;
  }

  #placeDieMoves(state, index, playerId, player) {
    const moves = [];
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    const diceWithAPlacement = new Set();
    for (const die of unplacedDice) {
      for (const mapId of Object.keys(state.maps)) {
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const slotCount = board.getSlotRequirements(areaRow).length;
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const clone = cloneState(state);
          const result = board.placeDice(clone, index, { playerId }, die.id, mapId, slotIndex);
          if (!result.success) continue;
          diceWithAPlacement.add(die.id);
          if (result.actionResult && result.actionResult.pendingBuild) {
            result.actionResult.pendingBuild.candidates.forEach((candidate, buildCandidateIndex) => {
              moves.push({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex, buildCandidateIndex });
            });
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
          result.pendingBuild.candidates.forEach((candidate, buildCandidateIndex) => {
            moves.push({ type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex });
          });
        }
      } else {
        // SET_DICE_ANY / SET_DIE_VALUE / CHANGE_DIE_VALUE -- needs a die + a value/delta up front
        // (the whole TAP field runs as one atomic program, see board.useBareTapAbility's own doc).
        const values = bareTap.kind === 'SET_DICE_ANY' ? [1, 2, 3, 4, 5, 6] : bareTap.choices;
        for (const die of unplacedDice) {
          for (const value of values) {
            const context = { playerId, chosenDieId: die.id };
            if (bareTap.kind === 'CHANGE_DIE_VALUE') context.chosenDelta = value;
            else context.chosenValue = value;
            const clone = cloneState(state);
            const result = board.useBareTapAbility(clone, index, context, physicalId);
            if (result.success) {
              moves.push({
                type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id,
                ...(bareTap.kind === 'CHANGE_DIE_VALUE' ? { chosenDelta: value } : { chosenValue: value }),
              });
            }
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

  #questMoves(state, index, playerId) {
    const moves = [];
    for (const questFaceId of Object.keys(state.quests)) {
      const check = qst.canClaim(state, index, playerId, questFaceId);
      if (!check.ok) continue;
      const clone = cloneState(state);
      const result = qst.claimQuestReward(clone, index, { playerId }, questFaceId);
      if (!result.success) continue;
      if (result.pendingBuild) {
        // No "leave unresolved" fallback here either -- same no-op reasoning as #bareTapMoves above:
        // qst.claimQuestReward only calls commitClaim() *after* the pendingBuild branch, so declining
        // every candidate wouldn't even mark the quest claimed. (Currently dormant in practice since
        // all QST REWARD fields are blank per the user's 2026-08-01 QST deferral, but kept consistent.)
        result.pendingBuild.candidates.forEach((candidate, buildCandidateIndex) => {
          moves.push({ type: 'CLAIM_QUEST', playerId, questFaceId, buildCandidateIndex });
        });
      } else {
        moves.push({ type: 'CLAIM_QUEST', playerId, questFaceId });
      }
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
   * (PLACE_DIE/BARE_TAP/CLAIM_QUEST carrying a buildCandidateIndex) reachable in the state *after* this
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
   * with later) and only forces the conversion if at least one of them would actually succeed. */
  forcedBzConversionMove(state, index, playerId, context) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      if (!bzConversionTap(index, cardState.currentFaceId)) continue;
      const clone = cloneState(state);
      const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
      if (!result.success) continue;
      if (this.#hasAffordableBuildOutlet(clone, index, playerId, context)) return { type: 'BARE_TAP', playerId, physicalId };
    }
    return null;
  }

  /** Whether some build-resolving move (PLACE_DIE/BARE_TAP/CLAIM_QUEST carrying a buildCandidateIndex)
   * in clone would actually succeed if applied right now -- shared by forcedBzConversionMove (deciding
   * whether to force a BZ-conversion tap) and #bareTapMoves' IMMEDIATE branch (deciding whether to even
   * offer one as a normal candidate when it isn't forced -- see that branch's own comment). */
  #hasAffordableBuildOutlet(clone, index, playerId, context) {
    const buildMoves = this.generateMoves(clone, index, playerId, context)
      .filter((m) => m.buildCandidateIndex !== undefined);
    return buildMoves.some((m) => applyInPlace(cloneState(clone), index, m).success);
  }
}

/** A bare (direct, non-ON-wrapped) TAP ability built from a CHANGE(...) or ADD(...) command that grants
 * BZ -- e.g. JOB004's "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)" or JOB007's "ADD(BZ);BLOCK_BUILD(A,
 * THIS_TURN);BLOCK_BUILD(B,THIS_TURN);BLOCK_BUILD(C,THIS_TURN)" (2026-08-07: generalized from CHANGE-only
 * to also cover ADD, since JOB007 grants BZ for free rather than converting another resource into it; the
 * BLOCK_BUILD half is a side-effect restriction, not a second thing this ability "does", so it doesn't
 * disqualify the shape). Returns the lowered CHANGE/ADD command, or null if faceId has no TAP field, no
 * BZ grant is there, or the field has some other statement besides CHANGE/ADD/BLOCK_BUILD. See
 * MoveGenerator#forcedBzConversionMove's own doc for why this is treated as forced rather than a normal
 * candidate. Deliberately not scoped to any one card: any future card with the same shape (a bare BZ
 * grant, optionally paired with BLOCK_BUILD) gets the same forced treatment automatically. */
function bzConversionTap(index, faceId) {
  let row;
  try { row = getCardRow(index, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = lowerProgram(parse(row.TAP));
  const bzCmd = commands.find((c) => (c.type === 'CHANGE' && c.gain.some((g) => g.resource === 'BZ'))
    || (c.type === 'ADD' && c.items.some((i) => i.resource === 'BZ')));
  if (!bzCmd) return null;
  const onlyBzGrantAndBlockBuild = commands.every((c) => c === bzCmd || c.type === 'BLOCK_BUILD');
  return onlyBzGrantAndBlockBuild ? bzCmd : null;
}

module.exports = { MoveGenerator, bareTapKind, bzConversionTap };

})();
