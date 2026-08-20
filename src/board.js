(function () {
/**
 * Board actions: PLACE_DICE and BUILD/UPGRADE resolution. These need shop
 * and map state that plain Executor commands don't have access to, so they
 * live here rather than in executor.js (which only knows how to run an
 * already-fully-specified Command against GameState).
 *
 * Scope note (2026-07-29): BUILD is inherently a two-step, player-choice
 * action (candidate list, then the player picks one) -- it cannot complete
 * synchronously the way ADD/CHANGE do. getBuildCandidates()/resolveBuild()
 * are implemented and fully tested here, but *automatically* detecting a
 * BUILD() inside an AREA's ACTION field (e.g. AREA008/AREA009's "BUILD()"
 * or "BUILD();ADD(2K)") and pausing mid-resolution for that choice is left
 * for the future turn-flow controller, the same way round-1 onboarding
 * sequencing was deferred in setup.js. placeDice() below only resolves AREA
 * actions that don't require a mid-resolution pause (i.e. everything except
 * BUILD/UPGRADE); it throws executor.NotImplementedError if the AREA's
 * ACTION contains BUILD, same as running that command directly would.
 */

'use strict';

const {
  getAreaRow,
  getCardRow,
  getShopRow,
  findCardFace,
  splitCardId,
} = require('./data-loader');
const { parse } = require('./dsl-parser');
const { lowerProgram, lowerCostList } = require('./command-builder');
const { createCardInstance } = require('./game-state');
const executor = require('./executor');
// Only for BLOCK_UPGRADE_UNLESS_QST_RANK (CON004A, see isUpgradeBlockedByQstRank) -- qst.js sits above
// executor.js in the layering and never requires board.js, so this direction is safe.
const qst = require('./qst');

// ---------------------------------------------------------------------------
// PLACE_DICE
// ---------------------------------------------------------------------------

/** Non-"NONE" SLOT1..6 values for an AREA row, in order -- these are the requirements map.slots[i] must satisfy. */
function getSlotRequirements(areaRow) {
  return ['SLOT1', 'SLOT2', 'SLOT3', 'SLOT4', 'SLOT5', 'SLOT6']
    .map((key) => areaRow[key])
    .filter((v) => v !== 'NONE');
}

const CASTLE_MAP_ID = 'MAP008';
/** The one other map with its own same-value stacking exception, scoped to its EX slot(s) only
 * (2026-08-04, per user feedback -- see the EX handling in placeDice's own doc). */
const AREA009_MAP_ID = 'MAP009';
// (CONVERT_LIMIT_ELIGIBLE_MAP_IDS lived here until 2026-08-11 -- it restricted CONVERT_LIMIT(ALL,n) to
// AREA003/004/005's own CHANGEs. That scope was written when those AREAs held the only ALL-based CHANGEs
// in the data; C001B/C002B/C003B's TAPs became ALL-based later and were left uncapped, which contradicted
// the rule's actual intent. The cap now applies to every ALL-based CHANGE, so board.js no longer has to
// tell executor.js which AREA fired one -- see executor.js's runChange.)

/** Usage fee owed by a non-owner who uses a tier-B/C AREA (confirmed: "tier Bは一律1K...tier Cは一律2K",
 * a flat system rule, not per-AREA data). Tier A has no fee. */
const USAGE_FEE_BY_TIER = { B: 1, C: 2 };

/** Pure: the usage fee placing on map would incur for playerId right now, or null if none applies (the
 * map's own owner, a tier-A map with no feeOwnerId, or an AREA with no tier suffix at all -- castle/
 * AREA007, confirmed to have no tier concept). Factored out of chargeUsageFeeIfOwed (2026-08-05) so
 * wouldOweUnaffordableFee below can ask "how much, if any" without mutating anything. */
function wouldOweFee(map, playerId) {
  if (!map.feeOwnerId || map.feeOwnerId === playerId) return null;
  const { tier } = splitCardId(map.currentAreaId);
  const amount = USAGE_FEE_BY_TIER[tier];
  return amount ? { mapId: map.mapId, amount } : null;
}

/** Sets player.pendingFee (see its own doc in game-state.js) if placing on mapId right now means using
 * someone else's tiered-up AREA -- a no-op (leaves pendingFee untouched) for the map's own owner, a
 * tier-A map (feeOwnerId null), or an AREA with no tier suffix at all (castle/AREA007, confirmed to have
 * no tier concept). Called once per placement action (placeDice, or once for the whole group in
 * placeDiceGroup) -- "using the area" is what's billed, not per-die, matching how this is always exactly
 * one turn's worth of action even when placeDiceGroup lets multiple dice land in it. */
function chargeUsageFeeIfOwed(state, map, playerId) {
  const fee = wouldOweFee(map, playerId);
  if (!fee) return;
  const player = state.players.find((p) => p.id === playerId);
  player.pendingFee = fee;
  // Reserve this much K for the fee itself, AREA009 only (2026-08-11, per user decision -- see
  // PlayerState.lockedK's own doc in game-state.js for the deadlock this closes). Other tier B/C AREAs
  // deliberately keep the older, unreserved behavior.
  if (map.mapId === AREA009_MAP_ID) player.lockedK = fee.amount;
}

/** Pure: could playerId ever actually pay a fee of `amount` K, counting not just K on hand but every
 * resource a free action could turn into K (2026-08-05, per user diagnosis of the residual usage-fee
 * softlock after the BARE_TAP block above: "AREA010を使うときはAIが使用料が払えることを確認してから
 * ダイスを置く用に直せますか" -- AREA010's own AREA action never grants K to a non-owner (it either
 * costs K outright via CHANGE(2K,...) or grants only VP via ADD(VP)/ADD(2VP)), so a non-owner placing
 * there gets nothing back that could help pay the fee they just incurred). A/B/C/Z->K free actions have
 * no usage cap at all ("回数制限ありません", confirmed [[project-dice-wp-dsl-spec]]), so every unit of
 * those four resources genuinely converts 1:1. Deliberately ignores whatever the AREA action about to
 * resolve might itself grant -- checking affordability with *current* resources alone is conservative (a
 * placement that would only become affordable *after* its own ADD/CHANGE effect stays blocked), but never
 * risks the reverse (never allows an actually-impossible placement through) -- matching the same
 * "affordability gates legality" precedent AREA008/009's own isCandidateAffordable already established.
 * (2026-08-07: used to also count an unplaced wD as +2, since wD->2K was a free action too -- removed
 * along with that free action, see FREE_ACTION_IDS' own doc; wD no longer converts to K on demand at
 * all.) */
function canAffordFee(player, amount) {
  const convertible = (player.resources.A || 0) + (player.resources.B || 0) + (player.resources.C || 0) + (player.resources.Z || 0);
  return (player.resources.K || 0) + convertible >= amount;
}

/**
 * Places one of the player's own, not-yet-placed dice onto AREA slot
 * `slotIndex` of `mapId`, then resolves that AREA's ACTION. Enforces the
 * slot's value requirement (specific number, "ANY", or "EX" -- see below)
 * always, plus one of:
 *
 *  - Normal case (die.placeAnywhereThisTurn is false): the slot must be
 *    empty, AND this die's value must not already sit in some *other* slot
 *    of the same AREA (confirmed "no duplicate value per AREA" rule). This
 *    now applies uniformly everywhere, including the castle (MAP008) and
 *    AREA009's own EX slot (2026-08-06, per user feedback: "ゾロ目は上にお
 *    けるルールは廃止します" -- abolishes the previous exception where a
 *    slot already holding the same value was fine to join there without
 *    GRANT_PLACE_ANYWHERE; see slotAcceptsValue's own doc for the matching
 *    change on placeDiceGroup's side).
 *  - GRANT_PLACE_ANYWHERE case (die.placeAnywhereThisTurn is true): the
 *    above is waived -- this die may join *any* already-occupied slot,
 *    matching value or not (confirmed 2026-07-29), anywhere on the board.
 *    Whether this waiver was actually needed for this particular placement
 *    is recorded as countsForTurnOrder=false on the resulting SlotDie --
 *    confirmed such placements don't count when the castle's dice determine
 *    next round's turn order (see turn-flow.js's computeNextRoundTurnOrder).
 *
 * "EX" slots (2026-08-04, per user feedback: new SLOT1-6 value alongside a specific number/"ANY"/
 * "NONE") add an ownership gate on top of everything above: only the player who currently holds
 * map.feeOwnerId (the same "who tiered this AREA up" concept collectUsageFee already uses -- confirmed
 * by the user via example, e.g. building A001A makes MAP003 "belong" to that player the same way it
 * makes them the usage-fee owner) may place there at all -- not even GRANT_PLACE_ANYWHERE lets a
 * non-owner in. For the owner: any die (color or white), any value is accepted (no VALUE_MISMATCH,
 * ever), and placing INTO an empty EX slot is never blocked by a duplicate value sitting elsewhere in
 * the AREA -- but that exemption only runs one way: once a die does sit in an EX slot, it still blocks
 * *other* (non-EX) slots' own duplicate-value check the normal way. Once an EX slot already has
 * an occupant, a second die from the owner can only join via GRANT_PLACE_ANYWHERE
 * (die.placeAnywhereThisTurn), which -- same as anywhere else in this function -- waives the value
 * match and lets the owner join regardless (confirmed: "GRANT_PLACE_ANYWHEREはこのターンすでにダイスが
 * おいてあるSLOTにも置けるなので"). A non-owner is rejected before any of this even runs.
 *
 * Emits a PLACE(mapId) event (e.g. for JOB002A) before resolving ACTION.
 */
/**
 * Whether slotIndex is the slot a `value`-die is allowed to land on, among slots that would otherwise
 * (base value-match + occupancy) accept it (2026-08-06, per user feedback: "SLOTが6とANYの時 ダイス6は
 * ANYではなく6に置かなければならない...ANY ANY ANYの時は1番左のANYしか選択できない"). Two priority
 * rules, checked only when `requirements[slotIndex]` is "ANY" (a die on its own exact-numbered slot, or
 * an EX slot, is never subject to either):
 *  1. If some *other*, currently-unoccupied slot in this same area has a specific numbered requirement
 *     equal to `value`, that slot is mandatory -- `value` may not use an "ANY" slot instead, even though
 *     "ANY" would otherwise accept it.
 *  2. Otherwise (no numbered slot claims this value), only the leftmost (lowest-index) currently-
 *     unoccupied "ANY" slot is selectable -- several interchangeable empty "ANY" slots aren't a
 *     meaningful choice.
 * "EX" slots are invisible to both rules (never counted as the "numbered slot" in rule 1 -- their
 * requirement string is "EX", never a number -- and never counted as an "ANY" slot in rule 2); they
 * keep their own separate, pre-existing acceptance logic entirely. Pure -- does not mutate slots.
 *
 * dieIsWildcard (2026-08-19, JOB003/hasWildcardDice): a ☆ die ignores this priority logic entirely --
 * it has no numbered identity to prefer a matching slot over an ANY one, so every otherwise-eligible
 * slot is equally allowed.
 */
function isAllowedSlotForValue(requirements, slots, slotIndex, value, dieIsWildcard = false) {
  if (dieIsWildcard) return true;
  if (requirements[slotIndex] !== 'ANY') return true; // caller's own base checks handle non-ANY slots
  const numberedSlotAvailable = requirements.some((r, i) => r === value && slots[i].length === 0);
  if (numberedSlotAvailable) return false;
  const leftmostAnyIndex = requirements.findIndex((r, i) => r === 'ANY' && slots[i].length === 0);
  return slotIndex === leftmostAnyIndex;
}

// 王宮 (CASTLE_MAP_ID) and 元老院 (AREA009_MAP_ID) -- the only 2 maps that support multi-die/stacked
// buildValue at all (see placeDiceGroup's own doc), and so the only 2 where this exploit is reachable.
const CHANGED_DIE_SELF_STACK_BLOCKED_MAPS = new Set([CASTLE_MAP_ID, AREA009_MAP_ID]);

/** True if `die` may NOT join targetOccupants here -- 2026-08-18, per user report: 道化/JOB003's "ダイス
 * 目を変える" (SET_DICE_ANY, also usable via SET_DIE_VALUE/CHANGE_DIE_VALUE on other cards) combined with
 * its own GRANT_PLACE_ANYWHERE let a player set a die to whatever value exactly completes a stack with
 * their OWN already-placed die at 王宮/元老院, summing buildValue as if 2 genuinely-earned dice were
 * involved when really only 1 fresh, naturally-rolled placement happened -- e.g. a real 3 already on the
 * castle, then a JOB003-set 4 stacked onto it, reaching a DICE>=7 monument for what's really a single
 * die's worth of investment. Especially severe once JOB003 became unlimited-use/no-tap (see
 * board.useBareTapAbility's own doc) -- previously rate-limited by the tap itself.
 *
 * Deliberately narrow, confirmed with the user: only blocks a die whose value was JUST changed this same
 * turn (die.valueChangedThisTurn) from joining a slot that already holds this SAME player's own die, and
 * only at these 2 maps -- the legitimate multi-turn castle-investment pattern (a naturally-rolled die
 * matching/joining an earlier one, via any GRANT_PLACE_ANYWHERE-granting card) is untouched, as is a
 * value-changed die joining another PLAYER's slot, or an empty slot, or any placement anywhere else on
 * the board. Applies to WHITE dice too, not just COLOR (confirmed with the user: "wDも含む") -- die.kind
 * is never checked here on purpose. */
function isChangedDieSelfStackBlocked(mapId, playerId, valueChanged, targetOccupants) {
  if (!valueChanged) return false;
  if (!CHANGED_DIE_SELF_STACK_BLOCKED_MAPS.has(mapId)) return false;
  return targetOccupants.some((o) => o.playerId === playerId);
}

function placeDice(state, index, context, dieId, mapId, slotIndex) {
  const player = state.players.find((p) => p.id === context.playerId);
  const die = player.dice.find((d) => d.id === dieId && d.placedMapId === null && !d.passed);
  if (!die) return { success: false, reason: 'DIE_NOT_AVAILABLE' };

  const map = state.maps[mapId];
  if (!map) throw new executor.ExecutionError(`Unknown map: ${mapId}`);
  // 開拓者 (2026-08-17): must be read before anything below touches map.slots -- see
  // isMapEmptyOfDice/grantPioneerBonusIfEarned's own doc.
  const mapWasEmptyOfDice = isMapEmptyOfDice(map);
  // 地主 (2026-08-17): same "read before mutation" requirement -- see grantLandlordBonusIfEarned's own doc.
  const hadOwnColorDieThereAlready = playerHasOwnColorDieInMapSlots(state, map, context.playerId);
  const areaRow = getAreaRow(index, map.currentAreaId);
  const requirements = getSlotRequirements(areaRow);

  if (slotIndex < 0 || slotIndex >= requirements.length) {
    return { success: false, reason: 'INVALID_SLOT' };
  }
  const requirement = requirements[slotIndex];
  const isExSlot = requirement === 'EX';
  const bypass = die.placeAnywhereThisTurn;
  if (isExSlot) {
    if (map.feeOwnerId !== context.playerId) return { success: false, reason: 'EX_NOT_OWNER' };
    // Any die, any value -- no VALUE_MISMATCH check for EX.
  } else if (requirement !== 'ANY' && requirement !== die.value) {
    return { success: false, reason: 'VALUE_MISMATCH', requirement, dieValue: die.value };
  } else if (!bypass && !isAllowedSlotForValue(requirements, map.slots, slotIndex, die.value)) {
    // 2026-08-06, per user feedback: "SLOTが6とANYの時 ダイス6はANYではなく6に置かなければならない...
    // ANY ANY ANYの時は1番左のANYしか選択できない" -- see isAllowedSlotForValue's own doc. GRANT_PLACE_
    // ANYWHERE waives this the same way it waives everything else in this function.
    return { success: false, reason: 'SLOT_NOT_PREFERRED' };
  }

  const targetOccupants = map.slots[slotIndex];
  if (targetOccupants.length > 0) {
    // Occupied: blocked without GRANT_PLACE_ANYWHERE (2026-08-06) -- but bypass DOES waive this,
    // value-independent ("値の一致は不問"), letting the die join whichever occupied slot the player
    // targets. See this function's own doc.
    if (!bypass) return { success: false, reason: 'SLOT_OCCUPIED' };
    // 2026-08-18: even with bypass, a die whose value was just conjured this same turn still can't stack
    // onto this same player's own die at 王宮/元老院 -- see isChangedDieSelfStackBlocked's own doc.
    if (isChangedDieSelfStackBlocked(mapId, context.playerId, die.valueChangedThisTurn, targetOccupants)) {
      return { success: false, reason: 'CHANGED_DIE_CANNOT_SELF_STACK' };
    }
  } else if (!isExSlot) {
    // Empty target slot: blocked if this die's value duplicates one already sitting elsewhere in the
    // AREA -- and, unlike the occupied-slot branch above, NEVER waived by GRANT_PLACE_ANYWHERE
    // (2026-08-07, per user feedback: using JOB003 to set a die to a value already on the board, then
    // placing it via GRANT_PLACE_ANYWHERE into a *different*, empty slot instead of stacking onto the
    // matching one, produced two independent same-value occupants in one AREA -- not what the ability is
    // for. GRANT_PLACE_ANYWHERE exists so a die can join the slot a conflicting value already occupies,
    // not to spawn a second one elsewhere; a duplicate value's only legal home is the slot(s) that
    // already hold it). previously this shared the same bypass flag as the occupied-slot branch, which
    // is exactly what let this slip through.
    const duplicateElsewhere = map.slots.some((occ, i) => i !== slotIndex && occ.some((o) => o.value === die.value));
    if (duplicateElsewhere) return { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' };
  }

  // CON006A (2026-08-15): a die can't join a map this player already has one of their own COLOR dice
  // on, from an *earlier* placement action -- see isColorDieReuseBlocked's own doc. Checked against live
  // state, so a die placed earlier THIS SAME action (placeDiceGroup) never trips this; only prior,
  // already-committed placements do. Waived by GRANT_PLACE_ANYWHERE (bypass), unlike DUPLICATE_VALUE_IN_
  // AREA above -- confirmed distinct on purpose.
  // TEST CHANGE (2026-08-16, per user: "自分のカラーダイスがおかれているAREAにカラーダイスもｗDも置け
  // なくなります", explicitly flagged as trial/revertible): widened from COLOR-only to every die kind --
  // wD (WHITE) used to be exempt (`die.kind === 'COLOR' &&` guarded this whole block). To revert to
  // COLOR-only, restore that guard on the line below.
  if (!bypass && isColorDieReuseBlocked(state, index, context.playerId)) {
    if (playerHasOwnColorDieInMapSlots(state, map, context.playerId)) {
      return { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' };
    }
  }
  // (isExSlot && targetOccupants.length === 0): never blocked by a duplicate value sitting elsewhere in
  // the AREA (confirmed: "EXはどんなダイスでも置けます すでに同AREA別SLOTに置かれているダイスと同じ目
  // でも"). The reverse direction (an EX occupant blocking some *other* slot) still goes through the
  // normal map.slots.some(...) check above whenever that OTHER slot is the one being placed into, so
  // this asymmetry is deliberate.

  // Stacking (now GRANT_PLACE_ANYWHERE-only, see this function's own doc) sums to a combined buildValue
  // -- a lone die only ever rolls 1-6, but M001-M006's DICE threshold goes up to 12, so reaching those
  // requires stacking 2+ dice on one slot. Computed here, *before* committing anything, so the NO_EFFECT
  // guard right below can use it (see predictedBuildValueForPlacement's own doc for why this must stay
  // in lockstep with the post-commit math it replaced).
  const buildValue = predictedBuildValueForPlacement(mapId, isExSlot, targetOccupants, die.value);

  const actionContext = context;

  // 地主/開拓者 (2026-08-18/2026-08-20, see grantLandlordBonusIfEarned/grantPioneerBonusIfEarned's own
  // docs): granted speculatively *before* the NO_EFFECT prediction and the usage-fee check below, so
  // the resource is already in the player's resources by the time either one reads them -- e.g.
  // affording 孤児院LV2's own CHANGE(2K,VP), an otherwise-unaffordable usage fee on another player's
  // map, or (開拓者) making a previously-unaffordable AREA action like AREA007's CHANGE((A,B,C),D)
  // viable. Only snapshotted (real cloning cost) when this player actually has one of these two JOBs AND
  // qualifies -- cheap to check first, so a normal placement by any other player never pays for a clone
  // it doesn't need. A player can only ever hold one JOB, so landlordEligible/pioneerEligible are never
  // both true at once -- one shared snapshot variable covers either case. If the placement still turns
  // out illegal for some unrelated reason (prediction.ok===false below), this speculative grant is
  // rolled back along with everything else -- it must never survive a refused placement.
  const landlordEligible = hasLandlordAbility(state, index, context.playerId) && isLandlordEligibleArea(map.currentAreaId);
  const pioneerEligible = hasPioneerAbility(state, index, context.playerId) && mapWasEmptyOfDice && die.kind === 'COLOR';
  const preJobBonusSnapshot = (landlordEligible || pioneerEligible) ? structuredClone(state) : null;
  if (landlordEligible) grantLandlordBonusIfEarned(state, index, actionContext, mapId, hadOwnColorDieThereAlready);
  if (pioneerEligible) {
    grantPioneerBonusIfEarned(state, index, actionContext, mapWasEmptyOfDice, [die.value],
      (candidateState) => wouldAreaActionHaveEffect(candidateState, index, actionContext, areaRow, buildValue));
  }

  // Refuse the placement outright if it wouldn't actually do anything (2026-08-0X, per user feedback:
  // "効果を得られない時ダイスの配置不可にして" -- e.g. AREA003A's CHANGE(K,A,ALL) with 0 K on hand, or
  // AREA007's CHANGE((A,B,C),D) when A/B/C can't be paid, or AREA008/009's BUILD() with no buildable
  // candidate at all) -- see wouldAreaActionHaveEffect's own doc for exactly what "no effect" means.
  // Deliberately checked *before* any mutation below so a doomed placement never burns the die.
  const prediction = wouldAreaActionHaveEffect(state, index, actionContext, areaRow, buildValue);
  if (!prediction.ok) {
    if (preJobBonusSnapshot) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preJobBonusSnapshot);
    }
    return { success: false, reason: prediction.reason };
  }

  // Would this placement owe a usage fee at all? If so, snapshot state now so the whole placement can be
  // rolled back if it turns out unpayable (2026-08-05, per user diagnosis: "AREA010を使うときはAIが使用
  // 料が払えることを確認してからダイスを置く用に直せますか"). Checked *after* the area's own ACTION
  // resolves below, not before -- e.g. AREA001B's ACTION is ADD(5K), which trivially covers its own 1K
  // fee, so checking with only pre-resolution resources would incorrectly block that common, perfectly
  // safe case (confirmed via a failing test this exact change caught: freshly-placed non-owners with 0
  // K starting resources routinely gain plenty from the AREA itself). AREA010's own actions never grant
  // K to a non-owner (CHANGE(2K,...) costs K outright, ADD(n)VP grants none at all) -- that's the actual
  // gap this closes, without over-restricting AREAs whose own effect already covers their fee. See
  // canAffordFee's own doc for what "payable" means (current K + every free-action-convertible
  // resource, not just raw K).
  const owedFee = wouldOweFee(map, context.playerId);
  // Reuses preJobBonusSnapshot (already taken *before* the landlord/pioneer grant, i.e. before this
  // whole placement's own effects began) when one exists, rather than taking a fresh structuredClone
  // here -- a fresh one at this point would already include that bonus, so rolling back to it below
  // would incorrectly leave it in place even though the point of this rollback is to undo the *entire*
  // placement, job bonus included.
  const preFeeSnapshot = owedFee ? (preJobBonusSnapshot || structuredClone(state)) : null;

  state.placementSeq += 1;
  die.placedMapId = mapId;
  targetOccupants.push({
    playerId: context.playerId,
    dieId,
    value: die.value,
    seq: state.placementSeq,
    // False only when this placement actually needed GRANT_PLACE_ANYWHERE to join an occupied slot
    // (confirmed: dice placed that way don't count toward next round's turn order). By this point an
    // empty target slot can no longer have needed the bypass at all -- the one thing bypass used to also
    // waive for empty slots (a duplicate value elsewhere in the AREA) is now blocked outright above,
    // never reaching here (2026-08-07) -- so occupancy is the only remaining bypass-relevant case.
    countsForTurnOrder: !(bypass && targetOccupants.length > 0),
  });
  chargeUsageFeeIfOwed(state, map, context.playerId);

  executor.emitAndResolve(state, index, actionContext, 'PLACE', mapId);
  const actionResult = resolveAreaAction(state, index, actionContext, areaRow, buildValue);

  if (preFeeSnapshot) {
    const updatedPlayer = state.players.find((p) => p.id === context.playerId);
    if (!canAffordFee(updatedPlayer, owedFee.amount)) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preFeeSnapshot);
      return { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: owedFee.amount };
    }
  }

  // 地主/開拓者's own bonus already landed earlier (see preJobBonusSnapshot above) -- not called again here.

  return { success: true, actionResult };
}

/** Pure: what buildValue would result if a die of `dieValue` became the next occupant of a slot
 * currently holding `occupants` -- sums the castle/AREA009 EX slot's existing occupancy plus the new
 * die (see placeDice's own doc for the stacking rule itself), otherwise just dieValue alone. Occupants
 * only ever accumulate at these two spots (a normal placement can never join an occupied slot anywhere
 * -- see placeDice's own wouldBeBlocked -- so `occupants.length>0` here always means every prior
 * occupant got there via GRANT_PLACE_ANYWHERE); the new die's value is added regardless of whether it
 * matches an existing occupant's (2026-08-06, per user feedback: the combined buildValue counts every
 * stacked die's face, matching value or not, even though only the *display* stays pinned to the
 * original die at 王宮 -- see main.js's renderBoard). Factored out (2026-08-0X) so placeDice's own
 * pre-commit NO_EFFECT check and the UI's slot-highlight preview can't drift from each other. */
function predictedBuildValueForPlacement(mapId, isExSlot, occupants, dieValue) {
  const wouldStack = (mapId === CASTLE_MAP_ID || (isExSlot && mapId === AREA009_MAP_ID)) && occupants.length > 0;
  return wouldStack ? occupants.reduce((sum, o) => sum + o.value, 0) + dieValue : dieValue;
}

/** Whether playerId can currently pay candidate's COST -- both BUILD_NEW and UPGRADE auto-max any BZ
 * they hold (2026-08-06, per user feedback: BZ discounts an UPGRADE's COST exactly like a BUILD_NEW's --
 * see executor.enumerateBzOutcomes' own doc and resolveUpgrade below). UPGRADE pays against fromFaceId's
 * COST (the original tier's, confirmed identical to the tier-B row's). Used by wouldAreaActionHaveEffect's
 * BUILD branch. Mirrors main.js's own candidateAffordable (UI-side) -- can't be shared, that file is a
 * browser-only classic script, not a requireable module (same reasoning as move-generator.js's bareTapKind). */
function isCandidateAffordable(state, index, playerId, candidate) {
  const costFaceId = candidate.type === 'UPGRADE' ? candidate.fromFaceId : candidate.faceId;
  const row = getCardRow(index, costFaceId);
  const player = state.players.find((p) => p.id === playerId);
  const bzAvailable = (player && player.resources.BZ) || 0;
  return executor.enumerateBzOutcomes(state, playerId, lowerCostList(row.COST), bzAvailable).length > 0;
}

/** If commands (whose [0] is already known to be a BUILD) is followed by nothing but ADD statements --
 * e.g. AREA009B/C's "BUILD();ADD(2K)"/"BUILD();ADD(2K,BZ)" or B005B/B007B's "BUILD(...);ADD(BZ)" -- returns
 * that trailing array, else null. Shared by wouldAreaActionHaveEffect (preview) and resolveProgramOrBuild
 * (real resolution) so a BUILD();ADD(...) field's ADD half is always resolved *before* build-candidate
 * affordability is judged in both places (2026-08-07, per user feedback on 元老院LV2: "BZをもらえるので
 * 本来建築できるものが表示されません まずBZと2Kを得るその後建築候補が表示される" -- getBuildCandidates
 * itself doesn't filter by affordability at all, but both callers of it here do (isCandidateAffordable /
 * main.js's candidateAffordable filtering the build-choice modal), always against the player's resources
 * *before* this grant under the old order, since the ADD was deferred to remainingCommands and only ran
 * *after* a candidate got committed -- too late to ever help pay for the very build it was attached to,
 * and too late for the affordability-filtered modal to ever show it as an option). Confirmed the same fix
 * should apply to all 4 existing cards with this shape, not just 元老院. Safe to run for real (not just
 * preview) ahead of the candidates.length===0 check in resolveProgramOrBuild: getBuildCandidates' own
 * output depends only on category/buildValue/shop contents/block-list/ownership, never on resources, so
 * running the ADD earlier can't change whether a NO_BUILDABLE_CARD failure happens -- nothing new to roll
 * back. */
/** buildIndex is the position of the BUILD command itself within `commands` -- always 0 for AREA
 * fields (BUILD is always their first statement), but can be >0 for a card TAP field with a leading
 * non-BUILD cost run first (e.g. JOB010's "PAY(2K);BUILD(U)", buildIndex=1) -- see
 * resolveProgramOrBuild's own doc. */
function buildTrailingAdds(commands, buildIndex) {
  const trailing = commands.slice(buildIndex + 1);
  return trailing.length > 0 && trailing.every((c) => c.type === 'ADD') ? trailing : null;
}

/** Pure (no mutation) prediction of whether resolving areaRow's ACTION would actually produce any
 * benefit for the player, given `buildValue` as the die value that's about to be placed. Mirrors
 * resolveAreaAction/resolveProgramOrBuild's own dispatch (BUILD-first fields vs. everything else) so
 * the two can never quietly diverge:
 *
 *  - BUILD-first fields (AREA008/009's bare "BUILD()"/"BUILD();ADD(...)"): "effect" means "at least one
 *    AFFORDABLE buildable candidate exists" (corrected 2026-08-04, per user feedback: "AREA008 009は
 *    建築完了出来ないときはダイスが置けません" -- reverses the 2026-08-0X policy this replaced, which
 *    deliberately only checked getBuildCandidates() dice/category eligibility and left affordability to
 *    the build-choice modal one step later; the user now wants placement itself blocked unless a build
 *    can actually be completed, not just attempted). Uses isCandidateAffordable, same auto-max-BZ
 *    affordability rule the build-choice modal itself uses. Any trailing ADD statements (see
 *    buildTrailingAdds) are applied to a throwaway clone first, so a grant like AREA009C's "ADD(2K,BZ)"
 *    is reflected in the affordability check that decides placement legality (2026-08-07).
 *  - Everything else (ADD/CHANGE fields): runs the field on a throwaway clone (never mutates the real
 *    state) and compares the acting player's resources/dice before vs. after. A field can technically
 *    "succeed" while changing nothing at all -- e.g. CHANGE(K,A,ALL) with 0 K on hand runs 0 times and
 *    returns success -- so success alone isn't enough; only an observed change counts as "an effect".
 *    This diffing approach is deliberately DSL-type-agnostic (no per-command-type special-casing) so it
 *    keeps working if AREA ACTION ever grows a new command shape.
 *
 * A third, earlier check (2026-08-15, per user request: "色Dの上限を超えるときは訓練場にダイス候補が出
 * ないようにしてほしい") blocks outright, before either branch above even runs, whenever the ACTION would
 * grant a plain color die (resource 'D') while the player is already at their color-die cap -- currently
 * only AREA007 (訓練場)'s CHANGE((A,B,C),D), but written against the lowered command shape generically
 * (see grantsColorDie) rather than hardcoded to that one mapId, so it keeps working if a future AREA ever
 * grants D the same way. Without this, the diffing check above would still say "changed" (grantOneDie's
 * own overflow-conversion chain still silently turns the D into a wD, a real, detectable dice.length
 * change) and let the placement through -- exactly the "spend A/B/C, get a wD instead of the D you came
 * here for" outcome the user wants hidden from the candidate list entirely, not just left to happen
 * silently. The overflow-conversion chain itself (D->wD->2K) is untouched everywhere else (ADD(D)-style
 * grants, e.g. CON001B's ONCE, aren't a placement candidate at all, so they're unaffected).
 *
 * Counts the player's TOTAL color dice (in hand AND currently placed on any map -- including the very
 * die about to be placed here), not just in-hand ones (2026-08-17 fix, per user report: "憤怒　6個目の
 * カラーDを得ることができます"). Placing this die relocates it, it doesn't remove it from the player's
 * ownership, so excluding it (the old behavior) let a player with exactly 5 total color dice -- some
 * merely parked on other maps -- "free up a slot" by placing one of them here and walk away with 6:
 * round 1 they'd place 1 of their 4 starting dice (3 initial + CON006A's ONCE=ADD(D)) here, ending the
 * round with 5 in hand once everything returns (endRound() returns every placed COLOR die unconditionally,
 * with no cap re-check of its own); round 2 they'd do it again -- 5 total, excluding the one being placed
 * left only 4 "counted", still under the cap of 5, so a 6th was granted. Counting the placing die too
 * closes this: a player already holding 5 total (regardless of where any of them currently sit) can never
 * gain a 6th through this AREA, confirmed via this fix's own regression test (a full round-by-round replay
 * of the exact exploit above).
 *
 * A second, unconditional form of this same block (2026-08-15, per user follow-up: "CONで上限3個を持つ
 * プレイヤーはダイスを3個持つ限り訓練場にダイス候補が出ないように...現状絶対置けないはずです"): CON002A
 * (怠惰)'s PASSIVE=REPLACE_ADD(D,wD) forces every gained D into a wD instead, unconditionally -- not a
 * literal colorDiceCap change (that field stays 5 for everyone; CON002A's own INST text "色ダイスの上限
 * ３個" is just flavor text for this substitution's practical effect, never spending past their starting
 * 3-die hand since they can never gain a real 4th). A CON002A owner can NEVER get a genuine D from this
 * AREA, at any dice count, so this is checked independently of (and before) the cap count above.
 */
function grantsColorDie(commands) {
  return commands.some((cmd) => {
    if (cmd.type === 'CHANGE') return cmd.gain.some((item) => item.resource === 'D');
    if (cmd.type === 'ADD') return cmd.items.some((item) => item.resource === 'D');
    return false;
  });
}

// monumentBuildValue (2026-08-19, JOB003/hasWildcardDice): defaults to buildValue, so every pre-existing
// caller (never involving a ☆ die) is unaffected -- only placeWildcardDie ever passes a distinct value,
// since a ☆ die's contribution is 1 for an A/B/C candidate's range check but 6 for a monument's
// threshold check (see occupantBuildContribution's own doc) -- the same placement's buildValue can't be
// a single shared number when both category families are evaluated together, which is exactly what
// happens at 王宮/元老院's bare BUILD() (defaults to every category at once).
function wouldAreaActionHaveEffect(state, index, context, areaRow, buildValue, monumentBuildValue = buildValue) {
  const commands = lowerProgram(parse(areaRow.ACTION));
  if (grantsColorDie(commands)) {
    const replaceAddRules = executor.getPassiveRules(state, index, context.playerId, 'REPLACE_ADD');
    if (replaceAddRules.some((r) => r.from === 'D')) return { ok: false, reason: 'COLOR_DIE_REPLACED' };
    const player = state.players.find((p) => p.id === context.playerId);
    const totalColorDiceCount = player.dice.filter((d) => d.kind === 'COLOR').length;
    if (totalColorDiceCount >= player.colorDiceCap) return { ok: false, reason: 'COLOR_DICE_CAP' };
  }
  if (commands.length > 0 && commands[0].type === 'BUILD') {
    const buildCmd = commands[0];
    const trailingAdds = buildTrailingAdds(commands, 0);
    let evalState = state;
    if (trailingAdds) {
      evalState = structuredClone(state);
      for (const cmd of trailingAdds) executor.runCommand(evalState, index, context, cmd);
    }
    const resolvedBuildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : buildValue;
    const resolvedMonumentBuildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : monumentBuildValue;
    const candidates = getBuildCandidates(evalState, index, context.playerId, buildCmd.categories, resolvedBuildValue, resolvedMonumentBuildValue);
    const affordable = candidates.some((c) => isCandidateAffordable(evalState, index, context.playerId, c));
    return affordable ? { ok: true } : { ok: false, reason: 'NO_BUILDABLE_CARD' };
  }
  const clone = structuredClone(state);
  const result = executor.runProgram(clone, index, context, areaRow.ACTION);
  if (!result.success) return { ok: false, reason: 'NO_EFFECT' };
  const before = state.players.find((p) => p.id === context.playerId);
  const after = clone.players.find((p) => p.id === context.playerId);
  const changed = !resourcesEqual(before.resources, after.resources) || before.dice.length !== after.dice.length;
  return changed ? { ok: true } : { ok: false, reason: 'NO_EFFECT' };
}

/** Pure: are `a`/`b` (PlayerState.resources-shaped objects) the same, treating a missing key as 0. */
function resourcesEqual(a, b) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[key] || 0) !== (b[key] || 0)) return false;
  }
  return true;
}

/** Non-mutating preview of placeDice: runs the real placeDice against a throwaway clone and reports
 * whether it would fully succeed (not just "the die can legally sit here" but "and the AREA's own
 * ACTION would actually do something") -- used by the UI to decide which SLOTs to light up for the
 * currently selected die (2026-08-0X, per user feedback: "配置可能SLOTが光るようにして欲しい") without
 * re-deriving any of placeDice's own rules a second time. Never touches the real state. */
function previewPlaceDice(state, index, context, dieId, mapId, slotIndex) {
  const clone = structuredClone(state);
  const result = placeDice(clone, index, context, dieId, mapId, slotIndex);
  if (!result.success) return false;
  if (result.actionResult && result.actionResult.success === false) return false;
  return true;
}

/** Pure (no mutation) check: could `value` legally land on this slot right now, given mapId/playerId
 * and the slot's current requirement/occupants -- the same rules placeDice() enforces above, factored
 * out so placeDiceGroup's dry-run pass (below) can't drift from them. `bypass` (GRANT_PLACE_ANYWHERE,
 * default false) waives the occupied-slot check exactly like placeDice's own `bypass` local does -- still
 * NOT the slot's base value/EX-ownership requirement, which always applies regardless (added 2026-08-0X
 * so the UI's slot-highlight preview can reuse this instead of re-deriving the rule a third time). An
 * occupied slot is always blocked without bypass now (2026-08-06, per user feedback -- the castle/
 * AREA009's old same-value auto-stack exception is abolished, matching placeDice's own removal above);
 * placeDiceGroup passes bypass=true for a value-bucket only when *every* die in it individually carries
 * placeAnywhereThisTurn (confirmed: one die in a pair having the ability isn't enough for the pair to
 * join together -- the other die still can't get in). An EMPTY slot's duplicate-value-elsewhere check is
 * NEVER waived by bypass, even though it used to be (2026-08-07, per user feedback: using GRANT_PLACE_
 * ANYWHERE to place a value already on the board into some *other*, empty slot instead of stacking onto
 * the matching one produced two independent same-value occupants in one AREA -- see placeDice's own doc
 * on this exact split for the full reasoning). A duplicate value's only legal home is the slot(s) that
 * already hold it.
 *
 * dieIsWildcard (2026-08-19, JOB003/hasWildcardDice): a ☆ die ignores the numbered/ANY value-match
 * requirement (EX ownership gating still applies unchanged -- confirmed with the user ☆ can't use
 * another player's EX) and is never blocked by DUPLICATE_VALUE_IN_AREA (a valueless die can't duplicate
 * a number). Occupied-slot joining still needs `bypass` even when dieIsWildcard -- placeDiceGroup forces
 * bypass=true for a wildcard-owner's whole group (see its own doc), matching how a ☆ die "placeable
 * anywhere" resolves to a deliberate simultaneous multi-die action here, never an implicit one. */
function slotAcceptsValue(map, mapId, playerId, requirement, occupants, value, bypass = false, dieIsWildcard = false) {
  const isExSlot = requirement === 'EX';
  if (isExSlot) {
    if (map.feeOwnerId !== playerId) return false;
  } else if (!dieIsWildcard && requirement !== 'ANY' && requirement !== value) {
    return false;
  }
  if (occupants.length > 0) return bypass;
  if (isExSlot) return true; // empty EX slot: never blocked by a duplicate value elsewhere (see placeDice's doc)
  if (dieIsWildcard) return true;
  return !map.slots.some((occ) => occ.some((o) => o.value === value));
}

/** How much a single stacked-slot occupant contributes toward buildValue -- `wildcardValue` is the
 * caller-supplied substitution for a ☆ occupant (isWildcard, see hasWildcardDice's own doc): 1 when the
 * caller is evaluating an A/B/C candidate's DICE_MIN/MAX range, 6 when evaluating a monument's
 * DICE>=threshold (2026-08-19, per user spec: "ABCカード獲得時☆はダイス目1として扱う...モニュメント
 * 獲得時☆はダイス目6として扱う").
 *
 * Deliberately does NOT look at excludedFromBuildValue -- that flag only ever suppresses a die's OWN
 * contribution to the SAME placement action that just forced it into a full row (see placeWildcardDie's
 * own ternary, applied separately at each call site below, never inside this function). Once an occupant
 * is actually sitting in a slot, it contributes normally to every LATER placement's own buildValue
 * computation, excluded-at-birth or not (2026-08-20 fix, per user bug report: without this, a slot that
 * ever received one forced-fallback occupant became permanently stuck contributing 0 to every category
 * for the rest of the round -- e.g. two separate solo ☆ placements, both forced onto the same already-
 * full row because 元老院 was still full both times, left BOTH occupants excluded and buildValue at 0
 * even though a real, non-excluded die was sitting right there the whole time -- ABC AND every monument
 * both became unreachable, only UPGRADE (buildValue-independent) still showed). This matches how a REAL
 * die's own multi-turn castle-investment pattern already works (placeDice's predictedBuildValueForPlacement
 * always sums the FULL existing occupancy, not just this turn's increment) -- a repeatedly-forced ☆ die
 * accumulating value the same way, across several separate placements, is the wildcard equivalent of that
 * same legitimate pattern, not a new exploit; only ONE single placement's own forced landing is ever
 * zeroed for ITS OWN check. */
function occupantBuildContribution(occupant, wildcardValue) {
  return occupant.isWildcard ? wildcardValue : occupant.value;
}

/** True if some subset of newValues (possibly empty, but never the *whole* set) combined with baseSum
 * already reaches threshold -- i.e. at least one of newValues is unnecessary for reaching threshold
 * specifically (2026-08-06, per user feedback: "他のプレイヤーの邪魔をするだけの行動はできない" -- a
 * group placement that spends more dice on a monument than that monument actually needed is exactly
 * this, e.g. M012 needs only >=1, so placing 2 dice (6+6=12) to "build" it wastes one die for no reason
 * a real player would ever have -- confirmed: "ダイスを減らしても建築できるモニュメントは表示しないでく
 * ださい"). Brute-forces every subset via bitmask (newValues.length is always small -- a monument group
 * placement never involves more than a handful of dice). */
function hasSufficientProperSubset(newValues, threshold, baseSum) {
  const n = newValues.length;
  for (let mask = 0; mask < (1 << n) - 1; mask++) {
    let sum = baseSum;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += newValues[i];
    if (sum >= threshold) return true;
  }
  return false;
}

/** Filters a monument BUILD_NEW candidate list down to only those that genuinely need every one of
 * newValues (this group's own dice) -- on top of baseSum (the touched slots' pre-existing occupancy,
 * fixed and un-reducible) -- to reach their own DICE threshold. See hasSufficientProperSubset. A solo
 * die never has a "redundant" partner (there's only ever the one), so this is a no-op below 2 dice.
 * discount (2026-08-18, JOB007/密使's MONUMENT_DICE_DISCOUNT) -- same floor-at-0 subtraction from each
 * monument's own threshold that getBuildCandidates itself already applies, kept in sync here too since
 * this re-derives the threshold independently rather than reading it back off the already-filtered
 * candidates (both callers already have the placing player's own discount on hand). */
function excludeOverfundedMonuments(index, candidates, newValues, baseSum, discount) {
  if (newValues.length <= 1) return candidates;
  return candidates.filter((c) => !hasSufficientProperSubset(newValues, Math.max(0, parseMonumentThreshold(getCardRow(index, c.faceId).DICE) - discount), baseSum));
}

/**
 * Places several of the player's own dice at once onto mapId -- possibly *different* values, not just
 * doubles -- then resolves ONLY a monument ("M") BUILD candidate list against the combined buildValue
 * (sum of every die's face value). Added 2026-08-02 per user feedback: reaching a high monument
 * threshold (e.g. 12) by combining several different-valued dice, via a dedicated multi-select UI (see
 * main.js's selectedDieIds), not just doubles-stacking one slot the way the pre-existing "追加のダイス
 * を置く" in-modal widget requires. Scoped to the castle and AREA009 -- the only two AREAs whose ACTION
 * is a bare BUILD() and where combining dice to reach a monument threshold is ever relevant; callers
 * shouldn't invoke this for any other mapId.
 *
 * Same-valued dice among dieIds share a single slot; different-valued dice each claim their own slot.
 * Fully atomic via a two-pass design: first a pure dry-run (slotAcceptsValue) that finds a legal slot
 * for every die without mutating anything; only if the *entire* group has somewhere to go does it
 * actually commit each die (confirmed 2026-08-02: "選べるだけ選ばせて、配置時に失敗メッセージ" -- let
 * the player select freely, only reject at commit time) -- a partial placement (some dice down, others
 * stranded) would have no clean way to undo just the failed ones, so this never happens; returns
 * NO_LEGAL_SLOT_FOR_GROUP instead, touching nothing.
 *
 * A value-bucket that targets an already-occupied slot (2026-08-06, per user feedback -- the castle/
 * AREA009's old same-value auto-stack is abolished, see slotAcceptsValue's own doc) can only join if
 * *every* die in that bucket individually carries placeAnywhereThisTurn (confirmed: one bypass-holding
 * die in a pair of same-valued dice isn't enough for the pair to join together -- the other die still
 * can't get in, so the whole bucket -- and thus this atomic group placement -- fails). Dice that join
 * this way get countsForTurnOrder=false on their SlotDie, same meaning as placeDice's own bypass path.
 *
 * Deliberately always forces categories to ["M"] rather than parsing the AREA's own ACTION categories
 * the way a normal single-die placement does (confirmed 2026-08-02: "ダイスを複数置いたときはモニュメ
 * ントのみ建築候補に表示です") -- multi-die is monument-only here regardless of what BUILD(...) in the
 * data would otherwise allow for a single die.
 *
 * Monument candidates this group's own dice didn't actually need are excluded from the result
 * (2026-08-06, per user feedback: "他のプレイヤーの邪魔をするだけの行動はできない...ダイスを減らしても
 * 建築できるモニュメントは表示しないでください" -- e.g. M012 needs only >=1, so a 6+6 group placement
 * that reaches 12 must not offer M012 back, since either die alone already covered it). See
 * excludeOverfundedMonuments.
 *
 * Emits a PLACE(mapId) event per die (not once for the whole group) -- matching what placing them one
 * at a time across separate turns would have triggered (e.g. JOB002A's "get 1K per castle placement").
 *
 * @returns {{success:true, actionResult:{success:true,pendingBuild:object}|{success:false,reason:'NO_BUILDABLE_CARD',categories:['M'],buildValue:number}}|{success:false,reason:'DIE_NOT_AVAILABLE'|'NO_LEGAL_SLOT_FOR_GROUP'}}
 */
/** placeDiceGroup's own "would this group placement actually be able to build something" predicate --
 * factored out (2026-08-20) so 開拓者's speculative grant (see placeDiceGroup's own doc on why it needs
 * to land before this check, unlike 地主) can reuse the EXACT same logic as the real gate, rather than
 * re-deriving it and risking drift (same "can't diverge" motivation wouldAreaActionHaveEffect's own doc
 * cites). Pure with respect to `candidateState` (only mutates the clone it takes internally when
 * areaTrailingAdds exist) -- callers pass either the real `state` (for the real gate) or a throwaway
 * clone (for a speculative "what if" check). */
function groupBuildWouldBeAffordable(candidateState, index, context, playerId, areaTrailingAdds, predictedBuildValue, newValues, existingSumTotal, monumentDiscount) {
  let checkState = candidateState;
  if (areaTrailingAdds) {
    checkState = structuredClone(candidateState);
    for (const cmd of areaTrailingAdds) executor.runCommand(checkState, index, context, cmd);
  }
  const candidates = excludeOverfundedMonuments(index, getBuildCandidates(checkState, index, playerId, ['M'], predictedBuildValue), newValues, existingSumTotal, monumentDiscount);
  return { ok: candidates.some((c) => isCandidateAffordable(checkState, index, playerId, c)) };
}

function placeDiceGroup(state, index, context, dieIds, mapId) {
  const { playerId } = context;
  const player = state.players.find((p) => p.id === playerId);
  const dice = dieIds.map((id) => player.dice.find((d) => d.id === id && d.placedMapId === null && !d.passed));
  if (dice.some((d) => !d)) return { success: false, reason: 'DIE_NOT_AVAILABLE' };

  const map = state.maps[mapId];
  if (!map) throw new executor.ExecutionError(`Unknown map: ${mapId}`);
  // 開拓者 (2026-08-17): must be read before anything below touches map.slots -- see
  // isMapEmptyOfDice/grantPioneerBonusIfEarned's own doc.
  const mapWasEmptyOfDice = isMapEmptyOfDice(map);
  // 地主 (2026-08-17): same "read before mutation" requirement -- see grantLandlordBonusIfEarned's own doc.
  const hadOwnColorDieThereAlready = playerHasOwnColorDieInMapSlots(state, map, playerId);
  const areaRow = getAreaRow(index, map.currentAreaId);
  const requirements = getSlotRequirements(areaRow);
  // JOB003/道化 (2026-08-19): every die in this group is this player's own, so wildcard-ness is a single
  // owner-level flag, not per-die -- see hasWildcardDice's own doc.
  const dieIsWildcard = hasWildcardDice(state, index, playerId);
  // Moved up from the commit section further down (2026-08-20) -- 開拓者's speculative grant below needs
  // this in scope earlier than the commit phase did.
  const actionContext = context;

  // CON006A (2026-08-15): same rule as placeDice's own (see isColorDieReuseBlocked's doc), but checked
  // ONCE for the whole group against pre-existing map.slots occupancy (i.e. only earlier, already-
  // committed placements -- confirmed with the user this rule should NOT block a single group action
  // from placing 2+ of this player's own COLOR dice together, e.g. stacking at 王宮/AREA009 to sum
  // values: "スタッキングは許可"). A die in this group carrying GRANT_PLACE_ANYWHERE still waives it,
  // same as placeDice. Also waived unconditionally for a wildcard-owning player (2026-08-19, per user
  // spec: 憤怒/CON005B's same-AREA block is specifically negated by 道化's ☆ -- "憤怒の効果を道化で
  // 打ち消す" -- other restrictions, e.g. another player's EX slot, are untouched).
  // TEST CHANGE (2026-08-16, see placeDice's matching comment -- revertible by restoring `d.kind ===
  // 'COLOR' &&` below): widened from COLOR-only to every die kind, so a wD in the group trips this too.
  if (!dieIsWildcard && isColorDieReuseBlocked(state, index, playerId) && playerHasOwnColorDieInMapSlots(state, map, playerId)) {
    if (dice.some((d) => !d.placeAnywhereThisTurn)) {
      return { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' };
    }
  }

  const dieIdsByValue = new Map();
  for (const die of dice) {
    if (!dieIdsByValue.has(die.value)) dieIdsByValue.set(die.value, []);
    dieIdsByValue.get(die.value).push(die.id);
  }

  // Dry-run pass: find one legal, not-yet-claimed-by-this-batch slot per distinct value. bypass
  // requires every die in the bucket to individually carry placeAnywhereThisTurn (see this function's
  // own doc) -- slotJoinedOccupied records, per targetSlot, whether that slot already had an occupant
  // before this action (i.e. bypass was actually needed to join it), so the commit pass below can set
  // each die's countsForTurnOrder correctly without re-deriving this. existingSumBySlot records that
  // same pre-existing occupancy's *value* (not just whether it existed), fixed/un-reducible input to
  // excludeOverfundedMonuments below.
  const usedSlots = new Set();
  const slotForDie = new Map();
  const slotOfValue = new Map(); // value -> targetSlot, kept for the buildValue prediction below
  const slotJoinedOccupied = new Map(); // targetSlot -> boolean
  const existingSumBySlot = new Map(); // targetSlot -> sum of pre-existing occupants' values
  for (const [value, ids] of dieIdsByValue) {
    // dieIsWildcard forces bypass unconditionally (2026-08-19) -- a ☆ die can always join an occupied
    // slot as part of a deliberate group placement, same as if it always carried GRANT_PLACE_ANYWHERE
    // (see slotAcceptsValue's own doc on why occupied-slot joining still goes through `bypass` even for
    // wildcard dice, rather than being a separate unconditional branch).
    const bypass = dieIsWildcard || ids.every((id) => dice.find((d) => d.id === id).placeAnywhereThisTurn);
    // isAllowedSlotForValue reads real occupancy (map.slots[i].length) to find "the leftmost still-
    // available slot" -- but during this dry run, a slot claimed by an *earlier* value-bucket in this
    // same group action (usedSlots) hasn't actually been pushed to map.slots yet, so it would still look
    // "available" and wrongly win that comparison. This virtual view marks usedSlots members occupied
    // for that check only, without touching the real (not-yet-committed) map.slots array itself.
    const slotsForAllowedCheck = map.slots.map((occ, i) => (usedSlots.has(i) ? [{ virtual: true }] : occ));
    // 2026-08-18: same "conjured value can't stack onto this player's own die at 王宮/元老院" restriction
    // placeDice enforces -- see isChangedDieSelfStackBlocked's own doc. Any die in this value-bucket
    // having been value-changed this turn is enough to block the whole bucket from joining an occupied
    // slot that already holds this player's own die (they all share one target slot). Never trips for a
    // wildcard-owning player -- ☆ dice never run SET_DICE_ANY/valueChangedThisTurn at all.
    const bucketValueChanged = ids.some((id) => dice.find((d) => d.id === id).valueChangedThisTurn);
    let targetSlot = null;
    for (let i = 0; i < requirements.length; i++) {
      if (usedSlots.has(i)) continue;
      if (!bypass && !isAllowedSlotForValue(requirements, slotsForAllowedCheck, i, value, dieIsWildcard)) continue;
      if (!slotAcceptsValue(map, mapId, playerId, requirements[i], map.slots[i], value, bypass, dieIsWildcard)) continue;
      if (isChangedDieSelfStackBlocked(mapId, playerId, bucketValueChanged, map.slots[i])) continue;
      targetSlot = i;
      break;
    }
    if (targetSlot === null) return { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' };
    usedSlots.add(targetSlot);
    slotOfValue.set(value, targetSlot);
    slotJoinedOccupied.set(targetSlot, map.slots[targetSlot].length > 0);
    // A group placement is monument-only (categories forced to ['M'] below), so 6 is always the right
    // wildcard substitution here -- see occupantBuildContribution's own doc.
    existingSumBySlot.set(targetSlot, map.slots[targetSlot].reduce((sum, o) => sum + occupantBuildContribution(o, 6), 0));
    for (const id of ids) slotForDie.set(id, targetSlot);
  }
  const newValues = dice.map((d) => (dieIsWildcard ? 6 : d.value));
  const existingSumTotal = [...existingSumBySlot.values()].reduce((sum, v) => sum + v, 0);

  // AREA009C/B's own ACTION grants a trailing bonus after BUILD() (e.g. "BUILD();ADD(2K,BZ)" at LV2) --
  // same shape resolveProgramOrBuild/wouldAreaActionHaveEffect already special-case for the single-die
  // path (2026-08-07, per user feedback on 元老院LV2: "BZをもらえるので本来建築できるものが表示されません
  // まずBZと2Kを得るその後建築候補が表示される"). placeDiceGroup never ran areaRow.ACTION at all until now
  // (2026-08-12, same bug reported again but for a multi-die group placement reaching a monument threshold
  // >6 -- unreachable by a single die, so only this path could have shown it): the LV2 BZ bonus never
  // landed before affordability was judged, silently hiding an otherwise-affordable monument. Mirrors the
  // single-die split exactly -- applied to a throwaway clone for the predicted-affordability gate below
  // (never mutates real state on a placement that might still be refused), then for real, once, right
  // before the final post-commit candidate list further down.
  const areaTrailingAdds = buildTrailingAdds(lowerProgram(parse(areaRow.ACTION)), 0);

  // Predict the resulting buildValue *before* touching anything (same "sum each touched slot's full
  // occupancy" math as the post-commit version below, just computed off map.slots as it stands right
  // now instead of after pushing) -- lets this whole group placement be refused outright if it couldn't
  // possibly reach any monument (2026-08-0X, per user feedback: "建築するのはマストなので建築候補が無い
  // 場合置けません", same principle placeDice's own wouldAreaActionHaveEffect applies to a single die).
  // Affordability-checked too (corrected 2026-08-04, same policy change as wouldAreaActionHaveEffect's
  // BUILD branch -- see isCandidateAffordable's own doc). Overfunded-monument-excluded too (2026-08-06,
  // per user feedback -- see excludeOverfundedMonuments' own doc): if the only "affordable" candidates
  // are ones this group's dice overpay for, the whole placement is refused just like having none at all
  // -- a smaller selection would need to be tried instead.
  let predictedBuildValue = 0;
  for (const [value, slotIndex] of slotOfValue) {
    const existing = map.slots[slotIndex].reduce((sum, o) => sum + occupantBuildContribution(o, 6), 0);
    const perDieValue = dieIsWildcard ? 6 : value;
    predictedBuildValue += existing + perDieValue * dieIdsByValue.get(value).length;
  }

  // 開拓者 (2026-08-20): granted speculatively here, before this function's own build-affordability gate
  // just below -- unlike 地主 (deliberately kept post-commit further down, see its own comment there),
  // 開拓者's grant genuinely needs to land early: placeDiceGroup has no separate wouldAreaActionHaveEffect
  // call the way placeDice/placeWildcardDie do, so groupBuildWouldBeAffordable (below) IS the only gate a
  // group placement goes through, and a grant landing after it could never actually help. Every COLOR die
  // in the group grants its own resource separately (confirmed with the user: a 4 and a 5 placed together
  // grant both 1C and 1Z) -- still only one tap/untap transition for the whole action, since
  // grantPioneerBonusIfEarned's own loop runs every value inside a single grant-branch pass.
  const pioneerEligible = hasPioneerAbility(state, index, playerId) && mapWasEmptyOfDice && dice.some((d) => d.kind === 'COLOR');
  const preJobBonusSnapshot = pioneerEligible ? structuredClone(state) : null;
  if (pioneerEligible) {
    const colorDieValues = dice.filter((d) => d.kind === 'COLOR').map((d) => d.value);
    grantPioneerBonusIfEarned(state, index, actionContext, mapWasEmptyOfDice, colorDieValues,
      (candidateState) => groupBuildWouldBeAffordable(candidateState, index, actionContext, playerId, areaTrailingAdds, predictedBuildValue, newValues, existingSumTotal, player.monumentDiceDiscountThisTurn));
  }

  const affordability = groupBuildWouldBeAffordable(state, index, actionContext, playerId, areaTrailingAdds, predictedBuildValue, newValues, existingSumTotal, player.monumentDiceDiscountThisTurn);
  if (!affordability.ok) {
    if (preJobBonusSnapshot) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preJobBonusSnapshot);
    }
    return { success: false, reason: 'NO_BUILDABLE_CARD' };
  }
  // Same usage-fee affordability gate as placeDice's own (2026-08-05) -- AREA009 can carry a tier (A008A
  // tiers it up), so a group placement here can owe a fee too, not just the single-die path.
  const owedFee = wouldOweFee(map, playerId);
  if (owedFee && !canAffordFee(player, owedFee.amount)) {
    if (preJobBonusSnapshot) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preJobBonusSnapshot);
    }
    return { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: owedFee.amount };
  }

  // Everything fits and can lead somewhere -- commit for real.
  const touchedSlots = new Set();
  for (const die of dice) {
    const slotIndex = slotForDie.get(die.id);
    state.placementSeq += 1;
    die.placedMapId = mapId;
    map.slots[slotIndex].push({
      playerId,
      dieId: die.id,
      value: die.value,
      isWildcard: dieIsWildcard,
      seq: state.placementSeq,
      countsForTurnOrder: !slotJoinedOccupied.get(slotIndex),
    });
    touchedSlots.add(slotIndex);
    executor.emitAndResolve(state, index, actionContext, 'PLACE', mapId);
  }
  chargeUsageFeeIfOwed(state, map, playerId);
  // 開拓者's own bonus already landed earlier (see preJobBonusSnapshot above) -- not called again here;
  // it needed to be pre-commit (unlike 地主 just below) specifically because it must feed this function's
  // own build-affordability gate, which 地主's bonus never needs to.
  // 地主 deliberately stays post-commit and un-snapshotted here (2026-08-18) -- placeDiceGroup only ever
  // succeeds for a monument/BUILD-category placement (confirmed empirically: getBuildCandidates(
  // ['M'],...) gates it), and the only 2 maps that support a group placement at all are the castle
  // (MAP008/AREA008, which has no LVUP tier at all -- isLandlordEligibleArea always excludes it) and
  // 元老院 (MAP009/AREA009, excluded by name outright) -- so 地主's bonus never actually fires via this
  // path today, and the extra pre-grant/rollback complexity placeDice needed isn't worth adding here for
  // a currently-unreachable case. Revisit if a future group-placement target is ever added elsewhere.
  grantLandlordBonusIfEarned(state, index, actionContext, mapId, hadOwnColorDieThereAlready);
  // Real grant now (see areaTrailingAdds' own doc above) -- must land before the final candidates list
  // below is computed, same ordering resolveProgramOrBuild uses for the single-die path.
  if (areaTrailingAdds) {
    for (const cmd of areaTrailingAdds) executor.runCommand(state, index, context, cmd);
  }

  // Sum each touched slot's *full* occupancy (2026-08-02 fix, caught in headless verification) -- not
  // just this group's own dice. A slot this group joined via GRANT_PLACE_ANYWHERE bypass (see
  // slotAcceptsValue) may already have held a die from an earlier, unrelated placement -- ignoring
  // that pre-existing occupant would silently undercount buildValue. (Recomputed post-commit rather than
  // reusing predictedBuildValue above on the theory that PLACE event reactions fired mid-loop could in
  // principle add dice to these same slots -- no current data does that, but this stays exact either way.)
  let buildValue = 0;
  for (const slotIndex of touchedSlots) {
    buildValue += map.slots[slotIndex].reduce((sum, o) => sum + occupantBuildContribution(o, 6), 0);
  }

  const candidates = excludeOverfundedMonuments(index, getBuildCandidates(state, index, playerId, ['M'], buildValue), newValues, existingSumTotal, player.monumentDiceDiscountThisTurn);
  if (candidates.length === 0) {
    return { success: true, actionResult: { success: false, reason: 'NO_BUILDABLE_CARD', categories: ['M'], buildValue } };
  }
  return { success: true, actionResult: { success: true, pendingBuild: { categories: ['M'], buildValue, candidates, remainingCommands: [] } } };
}

/** Non-mutating preview of placeDiceGroup (2026-08-0X, same purpose as previewPlaceDice above): runs
 * the real placeDiceGroup against a throwaway clone and, if it would succeed, reports exactly which
 * slot indices the dice would land on (read back off the clone by dieId membership, not re-derived) --
 * the caller doesn't get to pick a slot for a group placement (board.placeDiceGroup auto-assigns), so
 * the UI needs this to know which slots to light up. Never touches the real state. */
function previewPlaceDiceGroup(state, index, context, dieIds, mapId) {
  const clone = structuredClone(state);
  const result = placeDiceGroup(clone, index, context, dieIds, mapId);
  if (!result.success) return { ok: false, touchedSlots: [] };
  if (result.actionResult && result.actionResult.success === false) return { ok: false, touchedSlots: [] };
  const dieIdSet = new Set(dieIds);
  const touchedSlots = [];
  clone.maps[mapId].slots.forEach((occupants, i) => {
    if (occupants.some((o) => dieIdSet.has(o.dieId))) touchedSlots.push(i);
  });
  return { ok: true, touchedSlots };
}

/**
 * Auto-placement entrypoint for a single ☆ wildcard die (JOB003/hasWildcardDice, 2026-08-19) -- unlike
 * placeDice, the caller never supplies a slotIndex: the engine picks it, per the user's own spec:
 * "☆ダイスはSLOTが空いている限り左詰めで置く(左 SLOT1 2 3 4 5 6 右)。EX以外のSLOTがすべて埋まって
 * いたら一番左のSLOTの下に重ねる。" Scans requirements left to right, skipping any EX slot that isn't
 * this player's own (confirmed with the user: another player's EX is never a target, this player's own
 * EX is fine -- same ownership gate slotAcceptsValue already enforces). The first empty eligible slot
 * wins outright; if every eligible slot is already occupied, this instead force-stacks under the
 * leftmost eligible slot (2026-08-19, confirmed with the user this fallback applies to every AREA, not
 * just 王宮/元老院 -- "全AREA共通" -- even though it only ever has a buildValue consequence at those two,
 * since no other AREA's ACTION ever contains BUILD).
 *
 * The forced-fallback occupant is flagged excludedFromBuildValue so it never silently inflates a
 * monument threshold by combining with whatever die already happened to occupy that slot -- only a
 * deliberate simultaneous placeDiceGroup of 2+ ☆ dice actually sums together (2026-08-19, per user spec,
 * closing a possible new exploit: an automatic single-die fallback stack combining unpredictably with an
 * unrelated pre-existing die to reach a high monument threshold without the player genuinely investing 2
 * dice at once). See occupantBuildContribution's own doc.
 *
 * ☆ dice ignore VALUE_MISMATCH/SLOT_NOT_PREFERRED/DUPLICATE_VALUE_IN_AREA entirely, and are exempt from
 * BLOCK_COLOR_DIE_REUSE (憤怒/CON005B's same-AREA restriction, confirmed with the user: "憤怒の効果を
 * 道化で打ち消す") -- none of placeDice's matching checks are reproduced here on purpose; this is a
 * wholly separate entrypoint, not a variant of placeDice.
 */
function placeWildcardDie(state, index, context, dieId, mapId) {
  const player = state.players.find((p) => p.id === context.playerId);
  const die = player.dice.find((d) => d.id === dieId && d.placedMapId === null && !d.passed);
  if (!die) return { success: false, reason: 'DIE_NOT_AVAILABLE' };

  const map = state.maps[mapId];
  if (!map) throw new executor.ExecutionError(`Unknown map: ${mapId}`);
  // 開拓者 (2026-08-17): must be read before anything below touches map.slots -- see
  // isMapEmptyOfDice/grantPioneerBonusIfEarned's own doc.
  const mapWasEmptyOfDice = isMapEmptyOfDice(map);
  // 地主 (2026-08-17): same "read before mutation" requirement -- see grantLandlordBonusIfEarned's own doc.
  const hadOwnColorDieThereAlready = playerHasOwnColorDieInMapSlots(state, map, context.playerId);
  const areaRow = getAreaRow(index, map.currentAreaId);
  const requirements = getSlotRequirements(areaRow);

  const eligibleIndexes = [];
  for (let i = 0; i < requirements.length; i++) {
    if (requirements[i] === 'EX' && map.feeOwnerId !== context.playerId) continue; // 他人のEXには置けない
    eligibleIndexes.push(i);
  }
  if (eligibleIndexes.length === 0) return { success: false, reason: 'NO_LEGAL_SLOT' };

  let slotIndex = eligibleIndexes.find((i) => map.slots[i].length === 0);
  let excludedFromBuildValue = false;
  if (slotIndex === undefined) {
    slotIndex = eligibleIndexes[0]; // leftmost eligible slot -- forced fallback stack
    excludedFromBuildValue = true;
  }
  const targetOccupants = map.slots[slotIndex];

  // Two separate sums, since a ☆ occupant's contribution differs by category (1 for A/B/C, 6 for
  // monument -- see occupantBuildContribution's own doc); this placement's own contribution is 0 when
  // excludedFromBuildValue, else the same 1-or-6 substitution.
  const existingAbcSum = targetOccupants.reduce((sum, o) => sum + occupantBuildContribution(o, 1), 0);
  const existingMonumentSum = targetOccupants.reduce((sum, o) => sum + occupantBuildContribution(o, 6), 0);
  const abcBuildValue = existingAbcSum + (excludedFromBuildValue ? 0 : 1);
  const monumentBuildValue = existingMonumentSum + (excludedFromBuildValue ? 0 : 6);

  const actionContext = context;

  // 地主/開拓者 (2026-08-18/2026-08-20, see placeDice's matching comment/grantLandlordBonusIfEarned/
  // grantPioneerBonusIfEarned's own docs): granted speculatively before the NO_EFFECT prediction/usage-
  // fee check, rolled back below if the placement turns out illegal for some unrelated reason. Never
  // both eligible at once (a player holds only one JOB), so one shared snapshot variable covers either.
  const landlordEligible = hasLandlordAbility(state, index, context.playerId) && isLandlordEligibleArea(map.currentAreaId);
  const pioneerEligible = hasPioneerAbility(state, index, context.playerId) && mapWasEmptyOfDice && die.kind === 'COLOR';
  const preJobBonusSnapshot = (landlordEligible || pioneerEligible) ? structuredClone(state) : null;
  if (landlordEligible) grantLandlordBonusIfEarned(state, index, actionContext, mapId, hadOwnColorDieThereAlready);
  if (pioneerEligible) {
    grantPioneerBonusIfEarned(state, index, actionContext, mapWasEmptyOfDice, [die.value],
      (candidateState) => wouldAreaActionHaveEffect(candidateState, index, actionContext, areaRow, abcBuildValue, monumentBuildValue));
  }

  const prediction = wouldAreaActionHaveEffect(state, index, actionContext, areaRow, abcBuildValue, monumentBuildValue);
  if (!prediction.ok) {
    if (preJobBonusSnapshot) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preJobBonusSnapshot);
    }
    return { success: false, reason: prediction.reason };
  }

  const owedFee = wouldOweFee(map, context.playerId);
  const preFeeSnapshot = owedFee ? (preJobBonusSnapshot || structuredClone(state)) : null;

  state.placementSeq += 1;
  die.placedMapId = mapId;
  targetOccupants.push({
    playerId: context.playerId,
    dieId,
    value: die.value,
    isWildcard: true,
    excludedFromBuildValue,
    seq: state.placementSeq,
    // Same convention as placeDice's own countsForTurnOrder -- false only when this placement had to
    // force its way onto an already-occupied slot rather than a genuinely free empty one, which for a ☆
    // die is exactly the excludedFromBuildValue case.
    countsForTurnOrder: !excludedFromBuildValue,
  });
  chargeUsageFeeIfOwed(state, map, context.playerId);

  executor.emitAndResolve(state, index, actionContext, 'PLACE', mapId);
  const actionResult = resolveAreaAction(state, index, actionContext, areaRow, abcBuildValue, monumentBuildValue);

  if (preFeeSnapshot) {
    const updatedPlayer = state.players.find((p) => p.id === context.playerId);
    if (!canAffordFee(updatedPlayer, owedFee.amount)) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, preFeeSnapshot);
      return { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: owedFee.amount };
    }
  }

  return { success: true, actionResult };
}

/** Non-mutating preview of placeWildcardDie (same purpose as previewPlaceDice/previewPlaceDiceGroup
 * above): runs the real placeWildcardDie against a throwaway clone and, if it would succeed, reports
 * which slot index it landed on (the caller doesn't get to pick one -- the engine auto-assigns, see
 * placeWildcardDie's own doc -- so the UI needs this to know which slot to light up). Never touches the
 * real state. */
function previewPlaceWildcardDie(state, index, context, dieId, mapId) {
  const clone = structuredClone(state);
  const result = placeWildcardDie(clone, index, context, dieId, mapId);
  if (!result.success) return { ok: false, slotIndex: null };
  if (result.actionResult && result.actionResult.success === false) return { ok: false, slotIndex: null };
  const slotIndex = clone.maps[mapId].slots.findIndex((occupants) => occupants.some((o) => o.dieId === dieId));
  return { ok: true, slotIndex };
}

/**
 * Declines to place dieId at all this round (2026-08-03, per user feedback: "色ダイスを置けない時、
 * または起きたくない時ラウンドをパスする手段がありません") -- without this, a die with no legal slot
 * anywhere (or one the player simply doesn't want to use) would force turn-flow.getNextTurn to keep
 * cycling back to the same player forever, since nothing else ever sets its placedMapId. Sets `passed`
 * instead of placedMapId -- turn-flow.isRoundOver/getNextTurn treat a passed die as resolved the same
 * way a placed one is, but endRound's "unused color die -> 3K" rule still applies to it (placedMapId
 * stays null), and it can't be placed after passing (see placeDice's own die lookup). Untapped again
 * (passed:false) at the next endRound, same lifetime as placedMapId.
 */
function passDie(state, index, context, dieId) {
  const player = state.players.find((p) => p.id === context.playerId);
  const die = player.dice.find((d) => d.id === dieId && d.placedMapId === null && !d.passed);
  if (!die) return { success: false, reason: 'DIE_NOT_AVAILABLE' };
  die.passed = true;
  return { success: true };
}

/**
 * Runs dslText normally, UNLESS it contains a BUILD(...) statement (AREA008/009's
 * "BUILD()"/"BUILD();ADD(...)", a QST reward's "BUILD((A,B,C),1);ADD(2BZ)", a card's own bare TAP field
 * like B005A's "BUILD((A,B,C,M),1)", or JOB010's "PAY(2K);BUILD(U)") -- that can't complete
 * synchronously, so instead of throwing executor.NotImplementedError this returns the build candidates
 * for the caller to choose from via completeAreaBuild(). Any commands *before* the BUILD (e.g. JOB010's
 * leading PAY) are run immediately, right here -- real data never has more than a flat PAY/ADD there,
 * nothing that itself needs a player choice, so running them synchronously is safe; if one of them fails
 * (e.g. PAY's affordability check) that failure is returned immediately and the BUILD is never reached.
 * Commands *after* the BUILD in the same field are deferred until the build is completed (see
 * remainingCommands) -- EXCEPT a trailing run of pure ADD statements (see buildTrailingAdds), which is
 * run right here too, *before* candidates are even computed (2026-08-07: see buildTrailingAdds' own doc
 * for why -- a grant like AREA009C's "ADD(2K,BZ)" needs to already be in the player's resources by the
 * time the build-choice modal filters candidates by affordability, not applied only after a candidate is
 * already committed). remainingCommands is empty in that case since there's nothing left to defer.
 * dieValueForBuild is only used when the BUILD command itself omits an explicit buildValue -- an
 * AREA-triggered BUILD falls back to the placed die's value; a QST/TAP-triggered one has no die to fall
 * back on, so its caller passes Infinity ("unconditional", confirmed 2026-07-30 for QST -- no current
 * data omits buildValue outside AREA anyway). monumentBuildValueForBuild mirrors
 * wouldAreaActionHaveEffect's own monumentBuildValue -- defaults to dieValueForBuild, only ever distinct
 * when placeWildcardDie is the caller (see that function's own doc).
 */
function resolveProgramOrBuild(state, index, context, dslText, dieValueForBuild, monumentBuildValueForBuild = dieValueForBuild) {
  const commands = lowerProgram(parse(dslText));
  const buildIndex = commands.findIndex((c) => c.type === 'BUILD');
  if (buildIndex !== -1) {
    const buildCmd = commands[buildIndex];
    const buildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : dieValueForBuild;
    const monumentBuildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : monumentBuildValueForBuild;
    // Candidate existence is checked *before* running any leading command (e.g. JOB010's PAY(2K)) --
    // 'U'/BUILD_NEW eligibility never depends on resources (it's about which cards/shop slots exist),
    // so this ordering can't hide a candidate a later payment would have unlocked, and it avoids
    // charging a flat leading cost for an ability that was never going to have anything to spend it on
    // (2026-08-17 fix: a naive "pay first, then check" order would silently take JOB010's 2K even when
    // the player has no upgradeable card at all).
    const candidates = getBuildCandidates(state, index, context.playerId, buildCmd.categories, buildValue, monumentBuildValue);
    if (candidates.length === 0) {
      return { success: false, reason: 'NO_BUILDABLE_CARD', categories: buildCmd.categories, buildValue };
    }
    for (const cmd of commands.slice(0, buildIndex)) {
      const result = executor.runCommand(state, index, context, cmd);
      if (!result.success) return result;
    }
    const trailingAdds = buildTrailingAdds(commands, buildIndex);
    let remainingCommands = commands.slice(buildIndex + 1);
    if (trailingAdds) {
      for (const cmd of trailingAdds) executor.runCommand(state, index, context, cmd);
      remainingCommands = [];
    }
    return { success: true, pendingBuild: { categories: buildCmd.categories, buildValue, candidates, remainingCommands } };
  }
  return executor.runProgram(state, index, context, dslText);
}

/** Resolves an AREA's ACTION field -- see resolveProgramOrBuild. */
function resolveAreaAction(state, index, context, areaRow, dieValue, monumentBuildValue = dieValue) {
  return resolveProgramOrBuild(state, index, context, areaRow.ACTION, dieValue, monumentBuildValue);
}

/** Completes a pendingBuild from resolveAreaAction()/resolveProgramOrBuild(): commits the chosen
 * candidate, then runs any commands that followed BUILD() in that field. */
function completeAreaBuild(state, index, context, candidate, remainingCommands) {
  const buildResult = resolveBuild(state, index, context, candidate);
  if (!buildResult.success) return buildResult;
  for (const cmd of remainingCommands || []) {
    executor.runCommand(state, index, context, cmd);
  }
  return { success: true, buildResult };
}

/**
 * A card's own *direct* (non-ON-wrapped) TAP ability -- e.g. B001A's
 * "SET_DIE_VALUE(SELF2|3);GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)", a C-tier CHANGE/ADD, or
 * B005-007's bare BUILD(...)/BUILD(U). Unlike executor.resolveTapReaction (an event-triggered
 * reaction offered to the player after a GET/PLACE/BUILD event fires), this is initiated directly by
 * the player at any point during their own turn -- same timing as a free action, and like a free
 * action it's the caller's job to only offer it then. context must already carry any
 * chosenDieId/chosenValue/chosenDelta a SET_DIE_VALUE/SET_DICE_ANY/CHANGE_DIE_VALUE statement in the
 * TAP field needs (see executor.runSetDieValue et al) -- the caller collects that from the player
 * *before* calling this, since the whole field runs as one atomic program.
 *
 * Self-untapping TAP fields (2026-08-18, 道化/JOB003, per user request: "TAPではなく何回でも使える能力に
 * したい", no per-use cost -- confirmed with the user) -- a bare UNTAP() anywhere in the TAP field means
 * this ability never actually ends up tapped from using it, so it stays usable indefinitely, reusing the
 * existing tap/untap machinery (and its ALREADY_TAPPED re-entrancy gate, still fully in effect) rather
 * than inventing a new "doesn't tap" DSL concept. Classified by DSL *shape*, not by re-reading
 * inst.tapped afterward -- that field is false both before and after a self-untapping run (nothing else
 * sets it true mid-program to tell the two cases apart), same "inspect the TAP text's own shape" pattern
 * main.js's bareTapKind already uses for a different classification.
 * @returns {{success:true}|{success:true,pendingBuild:{physicalId,...}}|{success:false,reason:string}}
 */
function useBareTapAbility(state, index, context, physicalId) {
  const inst = state.cards[physicalId];
  if (inst.tapped) return { success: false, reason: 'ALREADY_TAPPED' };
  // No longer blocked while a usage fee is owed (2026-08-10, per user request: "使用料の支払いが
  // ターン終了時にある時でもTAPアクションが使えるようにしたい" -- reverses the 2026-08-05 PENDING_FEE
  // gate this used to have here). That gate existed to stop a TAP ability from spending away the very
  // resources (or the A/B/C/Z a free action would've converted into K) needed to pay the fee at TURNEND,
  // which could permanently deadlock the AI. Since then, evaluator.js's LOCKOUT_PENALTY was generalized
  // to cover ANY executor.canEndTurn violation, not just RESOURCE_TOTAL_LIMIT -- a state left unable to
  // afford its pendingFee already scores -1000 there, so the AI now avoids digging that hole on its own
  // instead of being flatly forbidden from ever tapping in this window (matching the user's own spec:
  // "AIは使用料があるときはそれを把握しターン終了時に使用料分Kをあまらせるようにしたい"). A human player
  // remains free to overspend here same as anywhere else -- executor.canEndTurn still blocks TURNEND
  // itself until the fee is actually payable.
  const row = getCardRow(index, inst.currentFaceId);
  const tapContext = { ...context, sourcePhysicalId: physicalId };
  const result = resolveProgramOrBuild(state, index, tapContext, row.TAP, Infinity);
  if (result.pendingBuild) {
    // Not tapped yet -- and no activation notified yet either (see executor.notifyActivation's own
    // doc) -- a bare TAP=BUILD(...) ability (e.g. B005A) only actually commits once a candidate is
    // chosen and the build resolves; that happens later, in ai/simulator.js's BARE_TAP case (mirroring
    // main.js's own TAP-source commit), which fires the matching notifyActivation call itself.
    return { success: true, pendingBuild: { physicalId, ...result.pendingBuild } };
  }
  if (!result.success) return result;
  const selfUntaps = lowerProgram(parse(row.TAP)).some((cmd) => cmd.type === 'UNTAP');
  if (!selfUntaps) inst.tapped = true;
  executor.notifyActivation(state, context.playerId, physicalId, inst.currentFaceId, 'TAP');
  return { success: true };
}

// ---------------------------------------------------------------------------
// BUILD / UPGRADE candidates
// ---------------------------------------------------------------------------

function parseMonumentThreshold(diceString) {
  const match = /^>=(\d+)$/.exec(diceString);
  if (!match) throw new executor.ExecutionError(`Unrecognized monument DICE threshold: ${diceString}`);
  return Number(match[1]);
}

function nextTierLetter(tier) {
  return String.fromCharCode(tier.charCodeAt(0) + 1);
}

/** True if any of playerId's owned cards carries an active BLOCK_UPGRADE_UNLESS_QST_RANK PASSIVE rule
 * whose required rank isn't currently met (CON004A, 2026-08-13, per user spec: "QSTカードQ004Aで1位で
 * なければLVUPできない"). Deliberately evaluates questFaceId's GOAL via qst.rankPlayersForQuest
 * regardless of whether that exact face is one of this game's 3 actually-revealed QST cards (confirmed
 * with the user: "見えないところでQ004Aをチェックする" -- Q004A's ranking is checked as a hidden
 * yardstick either way, not gated on state.quests) -- rankPlayersForQuest only reads the QST sheet's
 * static GOAL text via getQstRow, never state.quests, so this already works unconditionally. */
function isUpgradeBlockedByQstRank(state, index, playerId) {
  const rules = executor.getPassiveRules(state, index, playerId, 'BLOCK_UPGRADE_UNLESS_QST_RANK');
  return rules.some((rule) => {
    const entry = qst.rankPlayersForQuest(state, index, rule.questFaceId).find((e) => e.playerId === playerId);
    return entry.rank !== rule.rank;
  });
}

/** Whether playerId owns at least one A/B/C card with a valid next-tier face -- the same tier-
 * eligibility check getBuildCandidates' own 'U' branch uses, but deliberately WITHOUT the
 * isUpgradeBlockedByQstRank gate (2026-08-18, per user request for CON004A/傲慢's own card-note: "自分
 * が最多AREAでない　かつ　LVアップするカードがある　場合のみ　警告文が出るようにして" -- the note
 * should stay hidden if the player has nothing that could ever be upgraded, even while the QST-rank
 * block is itself active, and getBuildCandidates(['U']) alone can't tell "blocked" apart from "nothing
 * to upgrade in the first place" -- it returns [] either way). */
function hasAnyUpgradeEligibleCard(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  return player.ownedCardPhysicalIds.some((physicalId) => {
    if (physicalId.startsWith('CON') || physicalId.startsWith('JOB')) return false;
    const inst = state.cards[physicalId];
    const { tier } = splitCardId(inst.currentFaceId);
    if (!tier) return false;
    return !!findCardFace(index, physicalId, nextTierLetter(tier));
  });
}

/** True if any of playerId's owned cards carries an active BLOCK_COLOR_DIE_REUSE PASSIVE rule (CON006A,
 * 2026-08-15, per user spec: "自分のカラーDが置かれているAREAには別のカラーDを配置できない"). Just an
 * on/off flag -- the actual "does this player already have a COLOR die on mapId" check is each caller's
 * own job (placeDice/placeDiceGroup), since it needs the specific mapId being targeted. */
function isColorDieReuseBlocked(state, index, playerId) {
  return executor.getPassiveRules(state, index, playerId, 'BLOCK_COLOR_DIE_REUSE').length > 0;
}

/** True if any of playerId's owned cards carries an active WILDCARD_DICE PASSIVE rule (JOB003/道化,
 * 2026-08-19, replacing its old SET_DICE_ANY TAP ability entirely). While true, ALL of this player's
 * dice -- COLOR and WHITE alike -- are "☆" wildcard dice, placed via placeWildcardDie (never placeDice's
 * player-chosen-slotIndex path) with their own separate value-matching/buildValue rules throughout this
 * file, and exempt from BLOCK_COLOR_DIE_REUSE (憤怒/CON005B) -- confirmed with the user this exemption is
 * specifically "憤怒's same-AREA restriction is negated", not "☆ can be placed anywhere unconditionally"
 * (another player's EX slot etc. still block it the normal way). Just an on/off flag, same pattern as
 * isColorDieReuseBlocked above. */
function hasWildcardDice(state, index, playerId) {
  return executor.getPassiveRules(state, index, playerId, 'WILDCARD_DICE').length > 0;
}

/** True if playerId currently has one of their own COLOR dice actually sitting in one of map's slots
 * (2026-08-16, bug fix per user report: "CON憤怒 現在AREAがLVUPしても前の情報が残りダイスが置けません" --
 * once the AREA LVUPs, the previously-placed die there should no longer block a new one). Deliberately
 * checks live map.slots occupancy rather than die.placedMapId===mapId (what both callers used to check
 * directly): runSetCurrentArea's own LVUP handling already resets map.slots to fresh empty arrays the
 * instant the area's tier changes (see executor.js's own doc on that), but leaves every die's own
 * placedMapId untouched on purpose -- it's still needed at round end (endRound's unused-color-die 3K
 * bonus checks placedMapId===null, and clearing it early would wrongly grant that bonus to a die that
 * WAS placed and used this round, just at an area that later leveled up). map.slots is therefore the
 * only signal that already distinguishes "still actually occupying this area" from "used earlier this
 * round, area since changed shape" without touching that round-end bookkeeping at all. */
function playerHasOwnColorDieInMapSlots(state, map, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const ownDieIdsInSlots = new Set();
  for (const occupants of map.slots) {
    for (const o of occupants) {
      if (o.playerId === playerId) ownDieIdsInSlots.add(o.dieId);
    }
  }
  return player.dice.some((d) => d.kind === 'COLOR' && ownDieIdsInSlots.has(d.id));
}

/** True if playerId's own JOB is 開拓者/JOB009. Bespoke, no DSL representation -- same class of exception
 * as isColorDieReuseBlocked above, or executor.js's PAYMENT_CHOICE_CON_FACE_ID. Matched by NAME rather
 * than physical id, since JOB ids could in principle get reorganized the same way CON's own physical
 * slots did (2026-08-17 CON-sheet reorg) -- see that incident's own memory. JOB has no A/B tier flip the
 * way CON does, so player.jobCardId is already the live faceId directly, no ownedCardPhysicalIds scan
 * needed. */
function hasPioneerAbility(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player.jobCardId) return false;
  return getCardRow(index, player.jobCardId).NAME === '開拓者';
}

// 開拓者/JOB009 (2026-08-20, replacing the old "random A/B/C" grant, per user spec): the placed die's
// own face value determines what's granted. K/VP have no matching free action (never converted); A/B/C/Z
// each convert 1:1 to K via the same free action a player could otherwise trigger manually (executor.js's
// FREE_ACTION_DEFS) -- see resolvePioneerGrantForDie's own doc for when that conversion actually fires.
const PIONEER_RESOURCE_BY_DIE_VALUE = { 1: 'K', 2: 'A', 3: 'B', 4: 'C', 5: 'Z', 6: 'VP' };
const PIONEER_FREE_ACTION_BY_RESOURCE = { A: 'A_K', B: 'B_K', C: 'C_K', Z: 'Z_K' };

/** Resolves one die's worth of 開拓者's bonus (2026-08-20) -- looks up dieValue's mapped resource
 * (PIONEER_RESOURCE_BY_DIE_VALUE) and decides whether to grant it raw or auto-convert it to K first,
 * so the bonus is "immediately usable" for THIS SAME placement (per user spec) rather than just sitting
 * unused: tries the raw resource first (speculatively, on a throwaway clone) against `wouldHelp` -- if
 * that alone would make the placement's own AREA action viable (e.g. AREA007's CHANGE((A,B,C),D) missing
 * exactly this color), grants it raw and stops, matching the user's own confirmed example (a die worth 4
 * grants C directly, no conversion). Only if the raw form does NOT help does it also try the SAME
 * resource converted to K via the matching free action (executor.tryFreeAction, the identical 1:1
 * pay/gain a player could otherwise trigger manually) -- if THAT would help (e.g. 歓楽街's CHANGE(2K,2Z)
 * needs K, not A), applies the conversion for real. Deliberately calls executor.tryFreeAction directly
 * rather than routing through any usage-count bookkeeping: confirmed with the user this auto-conversion
 * is unlimited and must never consume/interact with player.freeActionTaps (that flag, if anything reads
 * it, is a UI/AI-caller-side convenience only -- tryFreeAction itself has no built-in cap). If neither
 * form would help, the resource is still granted raw (the die's value always grants *something* per the
 * table) -- observable only when the overall placement still succeeds for an unrelated reason (a
 * different AREA whose own action doesn't need this resource at all), since if the WHOLE placement were
 * about to fail, the caller's own rollback undoes this speculative grant along with everything else. */
function resolvePioneerGrantForDie(state, index, context, dieValue, wouldHelp) {
  const rawResource = PIONEER_RESOURCE_BY_DIE_VALUE[dieValue];
  const freeActionId = PIONEER_FREE_ACTION_BY_RESOURCE[rawResource];
  if (!freeActionId) {
    executor.grantResourceAndEmitGet(state, index, context, rawResource, 1);
    return;
  }
  const rawClone = structuredClone(state);
  executor.grantResourceAndEmitGet(rawClone, index, context, rawResource, 1);
  if (wouldHelp(rawClone).ok) {
    executor.grantResourceAndEmitGet(state, index, context, rawResource, 1);
    return;
  }
  const convertedClone = structuredClone(state);
  executor.grantResourceAndEmitGet(convertedClone, index, context, rawResource, 1);
  executor.tryFreeAction(convertedClone, index, context.playerId, freeActionId);
  if (wouldHelp(convertedClone).ok) {
    executor.grantResourceAndEmitGet(state, index, context, rawResource, 1);
    executor.tryFreeAction(state, index, context.playerId, freeActionId);
    return;
  }
  executor.grantResourceAndEmitGet(state, index, context, rawResource, 1);
}

/** True if none of map's slots currently hold any occupant, from any player (2026-08-17, for 開拓者's own
 * "まだ１個もダイスが置かれていないAREA" trigger condition, confirmed with the user: whole-AREA/any-
 * player basis, not "this player's own first placement"; also confirmed to re-trigger after an AREA
 * LVUPs, which this naturally already does since runSetCurrentArea's own LVUP handling resets map.slots
 * to fresh empty arrays -- same live-state read playerHasOwnColorDieInMapSlots above relies on for the
 * same reason). Must be read BEFORE the current action's own die(s) get pushed into map.slots. */
function isMapEmptyOfDice(map) {
  return map.slots.every((occupants) => occupants.length === 0);
}

/** Grants 開拓者's bonus if earned by this placement (2026-08-17) -- 1 random A/B/C, via the same
 * grantResourceAndEmitGet every other resource grant in the engine uses (so e.g. a player who also owns
 * 育成者/JOB006 still sees its own GET-reactive PASSIVE fire correctly off this, same as any other
 * source). Only ever called once per placement action (placeDice: once per die; placeDiceGroup: once for
 * the whole group, not once per die within it -- confirmed with the user this is a "first move into this
 * AREA" reward, not a per-die one, so stacking several dice into a single group action shouldn't multiply
 * it). wasEmpty must be captured by the caller *before* this action's own die(s) are committed.
 *
 * TAP mechanic added 2026-08-18 (per user spec, a new sentence appended to the ability: "このカードがTAP
 * 状態なら代わりにアンタップする", confirmed with the user this introduces a real TAP concept 開拓者
 * never had before): every time the trigger condition fires, this card TAPS itself instead of staying
 * permanently reusable. If it's found already tapped the *next* time the condition fires, no resource is
 * granted that time -- it just untaps itself instead, so the ability effectively alternates between
 * "grant a resource (and tap)" and "just untap" on successive qualifying placements, rather than firing
 * unconditionally every time the way it used to. player.jobCardId doubles as JOB009's own physicalId (JOB
 * ids have no A/B tier the way CON does -- see game-state.splitCardId), so state.cards[player.jobCardId]
 * is this same card's own tapped state.
 *
 * Also reports through executor.notifyActivation (2026-08-17, per user request: "AIDATAも変更お願い") --
 * in both branches (grant-and-tap or just-untap), since either one is this ability genuinely doing
 * something -- 開拓者 has no TAP/PASSIVE at all in the DSL sense (no ON(...) wrapper for the usual
 * activationCounts listener to ever see), so without this its own AI.DATA.xlsx "使用回数" column would
 * always read 0 the same way JOB008's IF(...)-based PASSIVE needed its own bespoke job008BonusVp tracking
 * in game-runner.js -- this is the lighter-weight equivalent for an event that fires live during play
 * rather than one recomputable from final state alone. tools/ai_data_report.js's existing
 * `activationCounts[jobFaceId]` fallback picks this up automatically, no changes needed there.
 *
 * colorDieValues (2026-08-20, replacing the old single hasColorDie boolean): every COLOR die's own
 * face value placed as part of THIS action -- placeDice/placeWildcardDie always pass a 0- or 1-element
 * array (their own die is either COLOR or it isn't), placeDiceGroup passes one entry per COLOR die in
 * the group, since the user confirmed each die in a simultaneous group placement grants its own resource
 * separately (e.g. a 4 and a 5 placed together grant both 1C and 1Z). Still only ONE tap/untap
 * transition per call regardless of how many values are in the array -- the TAP-alternation gates the
 * whole grant-or-just-untap decision for this action, not each individual die within it. wouldHelp: see
 * resolvePioneerGrantForDie's own doc -- a caller-supplied "would this placement's own AREA action
 * succeed, given a hypothetical resulting state" predicate, reused (never re-derived) per call site. */
function grantPioneerBonusIfEarned(state, index, context, wasEmpty, colorDieValues, wouldHelp) {
  if (!wasEmpty || colorDieValues.length === 0) return;
  if (!hasPioneerAbility(state, index, context.playerId)) return;
  const player = state.players.find((p) => p.id === context.playerId);
  const cardInst = state.cards[player.jobCardId];
  if (cardInst.tapped) {
    cardInst.tapped = false;
  } else {
    for (const value of colorDieValues) {
      resolvePioneerGrantForDie(state, index, context, value, wouldHelp);
    }
    cardInst.tapped = true;
  }
  executor.notifyActivation(state, context.playerId, player.jobCardId, player.jobCardId, 'PASSIVE');
}

/** True if playerId's own JOB is 地主/JOB011 (2026-08-17, per user spec: "元老院以外のLVアップされたAREA
 * にダイスを配置した時食料を得る　そのAREAに自分の色Dがすでにあるなら代わりに1VPを得る", confirmed
 * with the user: 食料=K, and "すでにある" means a color die from an *earlier* placement action still
 * sitting in that map's slots, checked before this new one -- same live-state semantics as
 * playerHasOwnColorDieInMapSlots below, which this reuses directly). Bespoke, no DSL representation --
 * same class of exception as hasPioneerAbility above. Matched by NAME, not physical id, for the same
 * reorg-safety reason. */
function hasLandlordAbility(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player.jobCardId) return false;
  return getCardRow(index, player.jobCardId).NAME === '地主';
}

/** Whether mapId's *current* AREA face qualifies for 地主's bonus at all -- excluded entirely for
 * AREA009 (元老院) and for a map still at its base (not-yet-upgraded) tier, "元老院以外のLVアップされた
 * AREA". tier is null (not 'A') for AREA007/AREA008, which have no LVUP tiers at all (a single fixed
 * face, per splitCardId's own doc) -- `!tier` excludes those too, not just the literal 'A' case, since a
 * tier-less area can never have been "leveled up" in the first place. Split out from
 * grantLandlordBonusIfEarned (2026-08-18) so placeDice can cheaply check eligibility *before* deciding
 * whether the more expensive pre-grant snapshot below is even worth taking. */
function isLandlordEligibleArea(mapCurrentAreaId) {
  const { physicalId: areaPhysicalId, tier } = splitCardId(mapCurrentAreaId);
  return areaPhysicalId !== 'AREA009' && !!tier && tier !== 'A';
}

/** Grants 地主's bonus if earned by this placement: 1K always, PLUS 1VP more (2026-08-20, changed from
 * "1VP instead" to "1VP in addition to" the K, per user request) if the player already had one of their
 * own COLOR dice sitting in this map from an earlier placement action
 * (alreadyHadOwnColorDieThere -- captured by the caller via playerHasOwnColorDieInMapSlots *before* this
 * action's own die(s) are committed, same "read before mutation" requirement as grantPioneerBonusIfEarned's
 * own wasEmpty). No hasColorDie gate unlike grantPioneerBonusIfEarned above -- JOB011's own text has no
 * "ｗDでは発動しない" carve-out the way JOB009's did, so a white-die placement triggers this too (only the
 * *pre-existing* die checked for the bonus-VP branch must be a color one). Called once per placement
 * action (placeDice: once per die; placeDiceGroup: once for the whole group), same convention as
 * grantPioneerBonusIfEarned. Reports through executor.notifyActivation for the same AI.DATA "使用回数"
 * reason documented on grantPioneerBonusIfEarned.
 *
 * 2026-08-18 (per user request: "地主がLVアップされたAREAにダイスを置いてもらえるKをそのまますぐに使え
 * るようにして欲しい", worked examples: paying 孤児院LV2's own CHANGE(2K,VP) with the just-granted K,
 * and affording another player's 孤児院LV2 usage fee the same way, "この時配置候補にちゃんと出るよう
 * に") -- placeDice now calls this *before* wouldAreaActionHaveEffect's prediction and the usage-fee
 * check, not after, specifically so the granted K is already in state.players[...].resources by the time
 * either one reads it. See placeDice's own preLandlordSnapshot for how a placement that turns out illegal
 * anyway (for an unrelated reason) still gets this speculative grant rolled back cleanly. */
function grantLandlordBonusIfEarned(state, index, context, mapId, alreadyHadOwnColorDieThere) {
  if (!hasLandlordAbility(state, index, context.playerId)) return;
  const map = state.maps[mapId];
  if (!isLandlordEligibleArea(map.currentAreaId)) return;
  executor.grantResourceAndEmitGet(state, index, context, 'K', 1);
  if (alreadyHadOwnColorDieThere) executor.grantResourceAndEmitGet(state, index, context, 'VP', 1);
  const player = state.players.find((p) => p.id === context.playerId);
  executor.notifyActivation(state, context.playerId, player.jobCardId, player.jobCardId, 'PASSIVE');
}

/**
 * Lists every legal choice for a BUILD command (already lowered by
 * command-builder: {categories, buildValue}). Does not mutate state or pay
 * anything -- see resolveBuild() to commit one of these.
 *
 * @param {string[]} categories - e.g. ["A","B","C","U","M"]
 * @param {number} buildValue - resolved die value (BUILD's buildValue arg, or the die that triggered it),
 *   used for the A/B/C DICE_MIN/MAX range check
 * @param {number} [monumentBuildValue] - the same, but for the M (monument) DICE>=threshold check;
 *   defaults to buildValue (2026-08-19, JOB003/hasWildcardDice: a ☆ occupant's contribution differs by
 *   category -- 1 for A/B/C, 6 for M -- so the two checks can't always share one number; see
 *   occupantBuildContribution's own doc)
 * @returns {({type:'BUILD_NEW', faceId:string, shopKey:string, slotId:string}|{type:'UPGRADE', physicalId:string, fromFaceId:string, toFaceId:string})[]}
 */
function getBuildCandidates(state, index, playerId, categories, buildValue, monumentBuildValue = buildValue) {
  const candidates = [];
  const player = state.players.find((p) => p.id === playerId);
  const blocked = player.blockedBuildCategoriesThisTurn;
  const normalCategories = categories
    .filter((c) => c === 'A' || c === 'B' || c === 'C')
    .filter((c) => !blocked.includes(c));

  if (normalCategories.length > 0) {
    for (const shopKey of ['NORMAL', 'SPECIAL']) {
      for (const [slotId, faceId] of Object.entries(state.shops[shopKey].slots)) {
        if (!faceId) continue;
        if (!normalCategories.includes(faceId[0])) continue;
        const shopRow = getShopRow(index, slotId);
        if (buildValue >= shopRow.DICE_MIN && buildValue <= shopRow.DICE_MAX) {
          candidates.push({ type: 'BUILD_NEW', faceId, shopKey, slotId });
        }
      }
    }
  }

  if (categories.includes('M') && !blocked.includes('M')) {
    // Discounted by player.monumentDiceDiscountThisTurn if this player has an active MONUMENT_DICE_
    // DISCOUNT(n,THIS_TURN) grant (2026-08-18, JOB007/密使) -- floored at 0 so a large enough discount
    // just makes every monument buildable regardless of dice value, rather than going negative.
    const discountedThreshold = (rawThreshold) => Math.max(0, rawThreshold - player.monumentDiceDiscountThisTurn);
    for (const [slotId, faceId] of Object.entries(state.shops.M.slots)) {
      if (!faceId) continue;
      const threshold = discountedThreshold(parseMonumentThreshold(getCardRow(index, faceId).DICE));
      if (monumentBuildValue >= threshold) {
        candidates.push({ type: 'BUILD_NEW', faceId, shopKey: 'M', slotId });
      }
    }
  }

  if (categories.includes('U') && !blocked.includes('U') && !isUpgradeBlockedByQstRank(state, index, playerId)) {
    for (const physicalId of player.ownedCardPhysicalIds) {
      // UPGRADE only applies to actually-built cards (A/B/C) -- JOB/CON are drafted/dealt during
      // onboarding, never built via BUILD, so neither is upgrade-eligible even though CON happens to
      // share the same "ends in a tier letter" ID shape as A/B/C (confirmed 2026-07-30: "CONはアップ
      // グレードできません"; JOB is excluded on the same principle -- no JOB{n}B row exists in the
      // data today to make this observable, but the ID shape is identical so it's excluded on
      // principle rather than by accident of missing data).
      if (physicalId.startsWith('CON') || physicalId.startsWith('JOB')) continue;
      const inst = state.cards[physicalId];
      const { tier } = splitCardId(inst.currentFaceId);
      if (!tier) continue; // no back side (M, or a card already at its final tier's letter gap)
      const nextFace = findCardFace(index, physicalId, nextTierLetter(tier));
      if (nextFace) candidates.push({ type: 'UPGRADE', physicalId, fromFaceId: inst.currentFaceId, toFaceId: nextFace.ID });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// BUILD / UPGRADE resolution
// ---------------------------------------------------------------------------

/** Commits a BUILD_NEW candidate from getBuildCandidates(): pay (after context.bzDiscount, if any --
 * see executor.applyBzDiscount; resolveUpgrade below applies the same discount to UPGRADE's COST since
 * 2026-08-06), remove from shop, own it, run its ONCE, then emits BUILD(category) (2026-07-31 --
 * previously never emitted at all, so ON(BUILD(...),...) reactions like JOB002's were structurally
 * unreachable; category is the built card's own sheet letter, A/B/C/M). */
function resolveBuildNew(state, index, context, candidate) {
  const row = getCardRow(index, candidate.faceId);
  const discount = executor.applyBzDiscount(lowerCostList(row.COST), context.bzDiscount);
  if (!discount) return { success: false, reason: 'INVALID_BZ_DISCOUNT' };
  const payItems = discount.bzUsed > 0 ? [...discount.items, { resource: 'BZ', count: discount.bzUsed }] : discount.items;
  const payResult = executor.payCostList(state, context.playerId, payItems, context.colorPreference);
  if (!payResult.success) return payResult;

  state.shops[candidate.shopKey].slots[candidate.slotId] = null;
  // 2026-08-18: shift the row's remaining cards left immediately, so this slot never sits visibly empty
  // for the rest of the turn -- see compactShop's own doc. The actual refill (a new card from the draw
  // pile) still waits for TURNEND, unchanged.
  compactShop(state, candidate.shopKey);

  const inst = createCardInstance(candidate.faceId);
  inst.ownerId = context.playerId;
  state.cards[inst.physicalId] = inst;
  state.players.find((p) => p.id === context.playerId).ownedCardPhysicalIds.push(inst.physicalId);

  const onceResult = executor.runProgram(state, index, { ...context, sourcePhysicalId: inst.physicalId }, row.ONCE);
  executor.emitAndResolve(state, index, context, 'BUILD', candidate.faceId[0]);
  return { success: true, physicalId: inst.physicalId, onceResult };
}

/**
 * Commits an UPGRADE candidate: pay the original (tier-A) card's COST
 * (confirmed identical to the tier-B row's COST in the data), after
 * context.bzDiscount if any (2026-08-06, per user feedback -- BZ discounts an
 * UPGRADE's COST exactly like a BUILD_NEW's, see resolveBuildNew above), flip
 * the face (2026-08-15, per user request: LVUP no longer resets tap state --
 * the upgraded card keeps whatever TAP/untapped state it already had, instead
 * of always un-tapping), run the new face's ONCE, then emit BUILD('U') (see
 * resolveBuildNew's matching comment).
 */
function resolveUpgrade(state, index, context, candidate) {
  const fromRow = getCardRow(index, candidate.fromFaceId);
  const discount = executor.applyBzDiscount(lowerCostList(fromRow.COST), context.bzDiscount);
  if (!discount) return { success: false, reason: 'INVALID_BZ_DISCOUNT' };
  const payItems = discount.bzUsed > 0 ? [...discount.items, { resource: 'BZ', count: discount.bzUsed }] : discount.items;
  const payResult = executor.payCostList(state, context.playerId, payItems, context.colorPreference);
  if (!payResult.success) return payResult;

  const inst = state.cards[candidate.physicalId];
  inst.currentFaceId = candidate.toFaceId;

  const toRow = getCardRow(index, candidate.toFaceId);
  const onceResult = executor.runProgram(state, index, { ...context, sourcePhysicalId: inst.physicalId }, toRow.ONCE);
  executor.emitAndResolve(state, index, context, 'BUILD', 'U');
  return { success: true, onceResult };
}

/** Commits a candidate returned by getBuildCandidates(). */
function resolveBuild(state, index, context, candidate) {
  if (candidate.type === 'BUILD_NEW') return resolveBuildNew(state, index, context, candidate);
  if (candidate.type === 'UPGRADE') return resolveUpgrade(state, index, context, candidate);
  throw new executor.ExecutionError(`Unknown build candidate type: ${candidate.type}`);
}

// ---------------------------------------------------------------------------
// Shop restock (confirmed: restocking happens at TURNEND, not immediately)
// ---------------------------------------------------------------------------

/** Slides shopKey's row's remaining cards left to close any gap left by a build, so empty slots always
 * end up trailing at the row's right end (2026-08-07, per user request: "SHOP101のカードが建築された時、
 * 102のカードが101にズレ、103のカードが102にズレ、のような形で全部左にずれていき、カードの補充は必ず
 * SHOP106にされるように...SHOP001も同様に SHOP201も同じようにずれていくが、補充はなし" -- previously
 * each empty slot refilled independently, in place, with no shifting at all). Idempotent -- safe to call
 * on an already-compacted row, which is exactly what happens once restockShop (below) also calls this at
 * TURNEND. Split out from restockShop 2026-08-18, per user report: leaving the shift itself deferred to
 * TURNEND (its original bundled timing) meant a build left its own slot looking genuinely empty for the
 * rest of that turn -- including in the debug turn-history timeline, which snapshots real GameState and
 * so faithfully reproduced that same gap ("SHOP101が空のまま"). Now also called immediately after every
 * BUILD_NEW nulls out its own slot (resolveBuildNew), so a build's slot always shows *some* existing
 * card, shifted in, well before TURNEND -- while the refill half (a genuinely new card from the draw
 * pile) still only happens at TURNEND, unchanged, since that's the part that actually reveals new
 * information rather than just reordering what's already visible. */
function compactShop(state, shopKey) {
  const shop = state.shops[shopKey];
  const slotIds = Object.keys(shop.slots);
  const remaining = slotIds.map((id) => shop.slots[id]).filter((faceId) => faceId !== null);
  slotIds.forEach((id, i) => { shop.slots[id] = i < remaining.length ? remaining[i] : null; });
}

/** Compacts shopKey's row (see compactShop's own doc for why the shift half also now runs immediately
 * after every build, ahead of this), then, for restockable shops (M/NORMAL; SPECIAL never restocks),
 * refills those trailing empties from the draw pile in position order. Still only called at TURNEND,
 * unchanged -- the compactShop call here is harmless/idempotent even when nothing moved since the last
 * build. SPECIAL is deliberately excluded from the refill loop rather than relying on its drawPile
 * happening to be empty -- during round 1, before revealSpecialShop() runs, its 3 cards already sit in
 * drawPile with all slots null, so without this explicit exclusion the very first TURNEND would
 * prematurely reveal them ahead of the SHOP sheet's ROUND_MIN=2. */
function restockShop(state, shopKey) {
  compactShop(state, shopKey);
  if (shopKey === 'SPECIAL') return;
  const shop = state.shops[shopKey];
  for (const id of Object.keys(shop.slots)) {
    if (shop.slots[id] === null && shop.drawPile.length > 0) {
      shop.slots[id] = shop.drawPile.shift();
    }
  }
}

module.exports = {
  CASTLE_MAP_ID,
  AREA009_MAP_ID,
  getSlotRequirements,
  slotAcceptsValue,
  placeDice,
  placeDiceGroup,
  placeWildcardDie,
  previewPlaceDice,
  previewPlaceDiceGroup,
  previewPlaceWildcardDie,
  passDie,
  resolveAreaAction,
  resolveProgramOrBuild,
  completeAreaBuild,
  useBareTapAbility,
  getBuildCandidates,
  isUpgradeBlockedByQstRank,
  hasAnyUpgradeEligibleCard,
  isColorDieReuseBlocked,
  hasWildcardDice,
  isCandidateAffordable,
  resolveBuild,
  restockShop,
  compactShop,
};

})();
