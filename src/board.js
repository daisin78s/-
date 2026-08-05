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
/** CONVERT_LIMIT(ALL,n) (confirmed 2026-07-29) applies only to ALL-based CHANGEs from these 3 AREAs. */
const CONVERT_LIMIT_ELIGIBLE_MAP_IDS = ['MAP003', 'MAP004', 'MAP005'];

/** Usage fee owed by a non-owner who uses a tier-B/C AREA (confirmed: "tier Bは一律1K...tier Cは一律2K",
 * a flat system rule, not per-AREA data). Tier A has no fee. */
const USAGE_FEE_BY_TIER = { B: 1, C: 2 };

/** Sets player.pendingFee (see its own doc in game-state.js) if placing on mapId right now means using
 * someone else's tiered-up AREA -- a no-op (leaves pendingFee untouched) for the map's own owner, a
 * tier-A map (feeOwnerId null), or an AREA with no tier suffix at all (castle/AREA007, confirmed to have
 * no tier concept). Called once per placement action (placeDice, or once for the whole group in
 * placeDiceGroup) -- "using the area" is what's billed, not per-die, matching how this is always exactly
 * one turn's worth of action even when placeDiceGroup lets multiple dice land in it. */
function chargeUsageFeeIfOwed(state, map, playerId) {
  if (!map.feeOwnerId || map.feeOwnerId === playerId) return;
  const { tier } = splitCardId(map.currentAreaId);
  const amount = USAGE_FEE_BY_TIER[tier];
  if (!amount) return;
  const player = state.players.find((p) => p.id === playerId);
  player.pendingFee = { mapId: map.mapId, amount };
}

/**
 * Places one of the player's own, not-yet-placed dice onto AREA slot
 * `slotIndex` of `mapId`, then resolves that AREA's ACTION. Enforces the
 * slot's value requirement (specific number, "ANY", or "EX" -- see below)
 * always, plus one of:
 *
 *  - Normal case (die.placeAnywhereThisTurn is false): the slot must be
 *    empty, AND this die's value must not already sit in some *other* slot
 *    of the same AREA (confirmed "no duplicate value per AREA" rule) --
 *    EXCEPT at the castle (MAP008), where a slot already holding the same
 *    value is fine to join (confirmed 2026-07-29: "ゾロ目は重ねます" --
 *    same-value dice stack onto one slot instead of each claiming a fresh
 *    one, so the castle's 6 slots end up one per *distinct* value seen).
 *  - GRANT_PLACE_ANYWHERE case (die.placeAnywhereThisTurn is true): both of
 *    the above are waived -- this die may join *any* already-occupied slot,
 *    matching value or not (confirmed 2026-07-29). Whether this waiver was
 *    actually needed for this particular placement is recorded as
 *    countsForTurnOrder=false on the resulting SlotDie -- confirmed such
 *    placements don't count when the castle's dice determine next round's
 *    turn order (see turn-flow.js's computeNextRoundTurnOrder).
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
 * an occupant, a second die from the owner can only join via one of: (a) matching value, but ONLY at
 * AREA009_MAP_ID's own EX slot(s) -- the same unconditional same-value stacking the castle gets,
 * confirmed EX-slot-and-AREA009-specific, not a general EX behavior; or (b) GRANT_PLACE_ANYWHERE
 * (die.placeAnywhereThisTurn), which -- same as anywhere else in this function -- waives the value
 * match and lets the owner join regardless (confirmed: "GRANT_PLACE_ANYWHEREはこのターンすでにダイスが
 * おいてあるSLOTにも置けるなので"). A non-owner is rejected before any of this even runs.
 *
 * Emits a PLACE(mapId) event (e.g. for JOB002A) before resolving ACTION.
 */
function placeDice(state, index, context, dieId, mapId, slotIndex) {
  const player = state.players.find((p) => p.id === context.playerId);
  const die = player.dice.find((d) => d.id === dieId && d.placedMapId === null && !d.passed);
  if (!die) return { success: false, reason: 'DIE_NOT_AVAILABLE' };

  const map = state.maps[mapId];
  if (!map) throw new executor.ExecutionError(`Unknown map: ${mapId}`);
  const areaRow = getAreaRow(index, map.currentAreaId);
  const requirements = getSlotRequirements(areaRow);

  if (slotIndex < 0 || slotIndex >= requirements.length) {
    return { success: false, reason: 'INVALID_SLOT' };
  }
  const requirement = requirements[slotIndex];
  const isExSlot = requirement === 'EX';
  if (isExSlot) {
    if (map.feeOwnerId !== context.playerId) return { success: false, reason: 'EX_NOT_OWNER' };
    // Any die, any value -- no VALUE_MISMATCH check for EX.
  } else if (requirement !== 'ANY' && requirement !== die.value) {
    return { success: false, reason: 'VALUE_MISMATCH', requirement, dieValue: die.value };
  }

  const targetOccupants = map.slots[slotIndex];
  const bypass = die.placeAnywhereThisTurn;
  let wouldBeBlocked = false;
  if (targetOccupants.length > 0) {
    const isCastleStack = mapId === CASTLE_MAP_ID && targetOccupants[0].value === die.value;
    const isArea009ExStack = isExSlot && mapId === AREA009_MAP_ID && targetOccupants[0].value === die.value;
    wouldBeBlocked = !(isCastleStack || isArea009ExStack);
  } else if (!isExSlot) {
    wouldBeBlocked = map.slots.some((occ, i) => i !== slotIndex && occ.some((o) => o.value === die.value));
  }
  // (isExSlot && targetOccupants.length === 0): wouldBeBlocked stays false -- placing onto an empty EX
  // slot is never blocked by a duplicate value sitting elsewhere in the AREA (confirmed: "EXはどんな
  // ダイスでも置けます すでに同AREA別SLOTに置かれているダイスと同じ目でも"). The reverse direction (an
  // EX occupant blocking some *other* slot) still goes through the normal map.slots.some(...) check
  // above whenever that OTHER slot is the one being placed into, so this asymmetry is deliberate.
  if (wouldBeBlocked && !bypass) {
    return { success: false, reason: targetOccupants.length > 0 ? 'SLOT_OCCUPIED' : 'DUPLICATE_VALUE_IN_AREA' };
  }

  // Same-value stacking sums to a combined buildValue (2026-08-04, per user bug report: "ダイス目12を
  // 出そうとして複数のダイスを選択するやり方がわからない") -- a lone die only ever rolls 1-6, but
  // M001-M006's DICE threshold goes up to 12, so reaching those requires stacking 2+ same-value dice on
  // one slot (the "ゾロ目は重ねます" rule this function already enforces above). Computed here, *before*
  // committing anything, so the NO_EFFECT guard right below can use it (see predictedBuildValueForPlacement's
  // own doc for why this must stay in lockstep with the post-commit math it replaced).
  const buildValue = predictedBuildValueForPlacement(mapId, isExSlot, targetOccupants, die.value);

  // CONVERT_LIMIT(ALL,n) (confirmed 2026-07-29) only applies to ALL-based CHANGEs triggered from
  // these 3 AREAs -- only placeDice knows which AREA is being resolved, so it's the one place that
  // can set this; executor.js's runChange reads it back off context.
  const actionContext = { ...context, convertLimitEligible: CONVERT_LIMIT_ELIGIBLE_MAP_IDS.includes(mapId) };

  // Refuse the placement outright if it wouldn't actually do anything (2026-08-0X, per user feedback:
  // "効果を得られない時ダイスの配置不可にして" -- e.g. AREA003A's CHANGE(K,A,ALL) with 0 K on hand, or
  // AREA007's CHANGE((A,B,C),D) when A/B/C can't be paid, or AREA008/009's BUILD() with no buildable
  // candidate at all) -- see wouldAreaActionHaveEffect's own doc for exactly what "no effect" means.
  // Deliberately checked *before* any mutation below so a doomed placement never burns the die.
  const prediction = wouldAreaActionHaveEffect(state, index, actionContext, areaRow, buildValue);
  if (!prediction.ok) return { success: false, reason: prediction.reason };

  state.placementSeq += 1;
  die.placedMapId = mapId;
  targetOccupants.push({
    playerId: context.playerId,
    dieId,
    value: die.value,
    seq: state.placementSeq,
    countsForTurnOrder: !(bypass && wouldBeBlocked),
  });
  chargeUsageFeeIfOwed(state, map, context.playerId);

  executor.emitAndResolve(state, index, actionContext, 'PLACE', mapId);
  const actionResult = resolveAreaAction(state, index, actionContext, areaRow, buildValue);
  return { success: true, actionResult };
}

/** Pure: what buildValue would result if a die of `dieValue` became the next occupant of a slot
 * currently holding `occupants` -- sums same-value stacking at the castle/AREA009's own EX slot(s)
 * (see placeDice's own doc for the stacking rule itself), otherwise just dieValue alone. Factored out
 * (2026-08-0X) so placeDice's own pre-commit NO_EFFECT check and the UI's slot-highlight preview can't
 * drift from each other. */
function predictedBuildValueForPlacement(mapId, isExSlot, occupants, dieValue) {
  const wouldStack = (mapId === CASTLE_MAP_ID || (isExSlot && mapId === AREA009_MAP_ID))
    && occupants.length > 0 && occupants[0].value === dieValue;
  return wouldStack ? occupants.reduce((sum, o) => sum + o.value, 0) + dieValue : dieValue;
}

/** Whether playerId can currently pay candidate's COST -- BUILD_NEW auto-maxes any BZ they hold (see
 * executor.enumerateBzOutcomes' own doc), UPGRADE never gets BZ (per [[project-dice-wp-dsl-spec]]'s
 * "BZは建築コストの踏み倒し専用（改築には使用不可）"). Used by wouldAreaActionHaveEffect's BUILD branch.
 * Mirrors main.js's own candidateAffordable (UI-side) -- can't be shared, that file is a browser-only
 * classic script, not a requireable module (same reasoning as move-generator.js's bareTapKind). */
function isCandidateAffordable(state, index, playerId, candidate) {
  if (candidate.type !== 'BUILD_NEW') {
    const row = getCardRow(index, candidate.fromFaceId);
    return executor.resolvePayment(state, playerId, lowerCostList(row.COST)).ok;
  }
  const row = getCardRow(index, candidate.faceId);
  const player = state.players.find((p) => p.id === playerId);
  const bzAvailable = (player && player.resources.BZ) || 0;
  return executor.enumerateBzOutcomes(state, playerId, lowerCostList(row.COST), bzAvailable).length > 0;
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
 *    affordability rule the build-choice modal itself uses.
 *  - Everything else (ADD/CHANGE fields): runs the field on a throwaway clone (never mutates the real
 *    state) and compares the acting player's resources/dice before vs. after. A field can technically
 *    "succeed" while changing nothing at all -- e.g. CHANGE(K,A,ALL) with 0 K on hand runs 0 times and
 *    returns success -- so success alone isn't enough; only an observed change counts as "an effect".
 *    This diffing approach is deliberately DSL-type-agnostic (no per-command-type special-casing) so it
 *    keeps working if AREA ACTION ever grows a new command shape.
 */
function wouldAreaActionHaveEffect(state, index, context, areaRow, buildValue) {
  const commands = lowerProgram(parse(areaRow.ACTION));
  if (commands.length > 0 && commands[0].type === 'BUILD') {
    const buildCmd = commands[0];
    const resolvedBuildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : buildValue;
    const candidates = getBuildCandidates(state, index, context.playerId, buildCmd.categories, resolvedBuildValue);
    const affordable = candidates.some((c) => isCandidateAffordable(state, index, context.playerId, c));
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
 * default false) waives the occupied/duplicate-value checks exactly like placeDice's own `bypass` local
 * does -- still NOT the slot's base value/EX-ownership requirement, which always applies regardless
 * (added 2026-08-0X so the UI's slot-highlight preview can reuse this instead of re-deriving the rule a
 * third time; placeDiceGroup's own dice never carry this flag, so its callers just omit the argument). */
function slotAcceptsValue(map, mapId, playerId, requirement, occupants, value, bypass = false) {
  const isExSlot = requirement === 'EX';
  if (isExSlot) {
    if (map.feeOwnerId !== playerId) return false;
  } else if (requirement !== 'ANY' && requirement !== value) {
    return false;
  }
  if (occupants.length > 0) {
    if (bypass) return true;
    const isCastleStack = mapId === CASTLE_MAP_ID && occupants[0].value === value;
    const isArea009ExStack = isExSlot && mapId === AREA009_MAP_ID && occupants[0].value === value;
    return isCastleStack || isArea009ExStack;
  }
  if (isExSlot) return true; // empty EX slot: never blocked by a duplicate value elsewhere (see placeDice's doc)
  if (bypass) return true;
  return !map.slots.some((occ) => occ.some((o) => o.value === value));
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
 * Same-valued dice among dieIds share a single slot (the existing doubles-stacking rule); different-
 * valued dice each claim their own slot. Fully atomic via a two-pass design: first a pure dry-run
 * (slotAcceptsValue) that finds a legal slot for every die without mutating anything; only if the
 * *entire* group has somewhere to go does it actually commit each die (confirmed 2026-08-02: "選べる
 * だけ選ばせて、配置時に失敗メッセージ" -- let the player select freely, only reject at commit time) --
 * a partial placement (some dice down, others stranded) would have no clean way to undo just the
 * failed ones, so this never happens; returns NO_LEGAL_SLOT_FOR_GROUP instead, touching nothing.
 *
 * Deliberately always forces categories to ["M"] rather than parsing the AREA's own ACTION categories
 * the way a normal single-die placement does (confirmed 2026-08-02: "ダイスを複数置いたときはモニュメ
 * ントのみ建築候補に表示です") -- multi-die is monument-only here regardless of what BUILD(...) in the
 * data would otherwise allow for a single die.
 *
 * Emits a PLACE(mapId) event per die (not once for the whole group) -- matching what placing them one
 * at a time across separate turns would have triggered (e.g. JOB002A's "get 1K per castle placement").
 *
 * @returns {{success:true, actionResult:{success:true,pendingBuild:object}|{success:false,reason:'NO_BUILDABLE_CARD',categories:['M'],buildValue:number}}|{success:false,reason:'DIE_NOT_AVAILABLE'|'NO_LEGAL_SLOT_FOR_GROUP'}}
 */
function placeDiceGroup(state, index, context, dieIds, mapId) {
  const { playerId } = context;
  const player = state.players.find((p) => p.id === playerId);
  const dice = dieIds.map((id) => player.dice.find((d) => d.id === id && d.placedMapId === null && !d.passed));
  if (dice.some((d) => !d)) return { success: false, reason: 'DIE_NOT_AVAILABLE' };

  const map = state.maps[mapId];
  if (!map) throw new executor.ExecutionError(`Unknown map: ${mapId}`);
  const areaRow = getAreaRow(index, map.currentAreaId);
  const requirements = getSlotRequirements(areaRow);

  const dieIdsByValue = new Map();
  for (const die of dice) {
    if (!dieIdsByValue.has(die.value)) dieIdsByValue.set(die.value, []);
    dieIdsByValue.get(die.value).push(die.id);
  }

  // Dry-run pass: find one legal, not-yet-claimed-by-this-batch slot per distinct value.
  const usedSlots = new Set();
  const slotForDie = new Map();
  const slotOfValue = new Map(); // value -> targetSlot, kept for the buildValue prediction below
  for (const [value, ids] of dieIdsByValue) {
    let targetSlot = null;
    for (let i = 0; i < requirements.length; i++) {
      if (usedSlots.has(i)) continue;
      if (slotAcceptsValue(map, mapId, playerId, requirements[i], map.slots[i], value)) { targetSlot = i; break; }
    }
    if (targetSlot === null) return { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' };
    usedSlots.add(targetSlot);
    slotOfValue.set(value, targetSlot);
    for (const id of ids) slotForDie.set(id, targetSlot);
  }

  // Predict the resulting buildValue *before* touching anything (same "sum each touched slot's full
  // occupancy" math as the post-commit version below, just computed off map.slots as it stands right
  // now instead of after pushing) -- lets this whole group placement be refused outright if it couldn't
  // possibly reach any monument (2026-08-0X, per user feedback: "建築するのはマストなので建築候補が無い
  // 場合置けません", same principle placeDice's own wouldAreaActionHaveEffect applies to a single die).
  // Affordability-checked too (corrected 2026-08-04, same policy change as wouldAreaActionHaveEffect's
  // BUILD branch -- see isCandidateAffordable's own doc).
  let predictedBuildValue = 0;
  for (const [value, slotIndex] of slotOfValue) {
    const existing = map.slots[slotIndex].reduce((sum, o) => sum + o.value, 0);
    predictedBuildValue += existing + value * dieIdsByValue.get(value).length;
  }
  const predictedCandidates = getBuildCandidates(state, index, playerId, ['M'], predictedBuildValue);
  if (!predictedCandidates.some((c) => isCandidateAffordable(state, index, playerId, c))) {
    return { success: false, reason: 'NO_BUILDABLE_CARD' };
  }

  // Everything fits and can lead somewhere -- commit for real.
  const touchedSlots = new Set();
  const actionContext = { ...context, convertLimitEligible: CONVERT_LIMIT_ELIGIBLE_MAP_IDS.includes(mapId) };
  for (const die of dice) {
    const slotIndex = slotForDie.get(die.id);
    state.placementSeq += 1;
    die.placedMapId = mapId;
    map.slots[slotIndex].push({ playerId, dieId: die.id, value: die.value, seq: state.placementSeq, countsForTurnOrder: true });
    touchedSlots.add(slotIndex);
    executor.emitAndResolve(state, index, actionContext, 'PLACE', mapId);
  }
  chargeUsageFeeIfOwed(state, map, playerId);

  // Sum each touched slot's *full* occupancy (2026-08-02 fix, caught in headless verification) -- not
  // just this group's own dice. A slot this group joined via the doubles-stacking rule (see
  // slotAcceptsValue) may already have held a die from an earlier, unrelated single-die placement
  // (placeDice's own stacking works the same way, e.g. two separate turns each adding a 6) -- ignoring
  // that pre-existing occupant would silently undercount buildValue. (Recomputed post-commit rather than
  // reusing predictedBuildValue above on the theory that PLACE event reactions fired mid-loop could in
  // principle add dice to these same slots -- no current data does that, but this stays exact either way.)
  let buildValue = 0;
  for (const slotIndex of touchedSlots) {
    buildValue += map.slots[slotIndex].reduce((sum, o) => sum + o.value, 0);
  }

  const candidates = getBuildCandidates(state, index, playerId, ['M'], buildValue);
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
 * Runs dslText normally, UNLESS it starts with BUILD(...) (AREA008/009's "BUILD()"/"BUILD();ADD(...)",
 * a QST reward's "BUILD((A,B,C),1);ADD(2BZ)", or a card's own bare TAP field like B005A's
 * "BUILD((A,B,C,M),1)") -- that can't complete synchronously, so instead of throwing
 * executor.NotImplementedError this returns the build candidates for the caller to choose from via
 * completeAreaBuild(). Any commands *after* the BUILD in the same field are deferred until the build
 * is completed (see remainingCommands). dieValueForBuild is only used when the BUILD command itself
 * omits an explicit buildValue -- an AREA-triggered BUILD falls back to the placed die's value; a
 * QST/TAP-triggered one has no die to fall back on, so its caller passes Infinity ("unconditional",
 * confirmed 2026-07-30 for QST -- no current data actually omits buildValue outside AREA anyway).
 */
function resolveProgramOrBuild(state, index, context, dslText, dieValueForBuild) {
  const commands = lowerProgram(parse(dslText));
  if (commands.length > 0 && commands[0].type === 'BUILD') {
    const buildCmd = commands[0];
    const buildValue = buildCmd.buildValue !== null ? buildCmd.buildValue : dieValueForBuild;
    const candidates = getBuildCandidates(state, index, context.playerId, buildCmd.categories, buildValue);
    if (candidates.length === 0) {
      return { success: false, reason: 'NO_BUILDABLE_CARD', categories: buildCmd.categories, buildValue };
    }
    return { success: true, pendingBuild: { categories: buildCmd.categories, buildValue, candidates, remainingCommands: commands.slice(1) } };
  }
  return executor.runProgram(state, index, context, dslText);
}

/** Resolves an AREA's ACTION field -- see resolveProgramOrBuild. */
function resolveAreaAction(state, index, context, areaRow, dieValue) {
  return resolveProgramOrBuild(state, index, context, areaRow.ACTION, dieValue);
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
 * @returns {{success:true}|{success:true,pendingBuild:{physicalId,...}}|{success:false,reason:string}}
 */
function useBareTapAbility(state, index, context, physicalId) {
  const inst = state.cards[physicalId];
  if (inst.tapped) return { success: false, reason: 'ALREADY_TAPPED' };
  // Blocked while a usage fee is still owed (2026-08-05, per user diagnosis of the AI softlock bug:
  // "SLOTにダイスを置く→解決する→使用料を払う...おそらく...TAPアクションで資源を使い果たしてしまった
  // ことが原因" -- the fee itself isn't actually deducted until TURNEND (see board.chargeUsageFeeIfOwed/
  // executor.canEndTurn's own docs), so without this gate a player could spend away the very resources
  // (or the A/B/C/Z/wD a free action would've converted into K) needed to pay it, via a TAP ability, in
  // the window between owing the fee and TURNEND actually collecting it -- occasionally leaving them
  // with truly nothing to pay with or convert, a permanent deadlock. FREE_ACTION/COLLECT_FEE are
  // deliberately NOT gated here (the user explicitly wants those to stay usable in this same window,
  // since they're the way OUT of the debt, not a way to dig deeper into it).
  const player = state.players.find((p) => p.id === context.playerId);
  if (player && player.pendingFee) return { success: false, reason: 'PENDING_FEE' };
  const row = getCardRow(index, inst.currentFaceId);
  const tapContext = { ...context, sourcePhysicalId: physicalId };
  const result = resolveProgramOrBuild(state, index, tapContext, row.TAP, Infinity);
  if (result.pendingBuild) {
    return { success: true, pendingBuild: { physicalId, ...result.pendingBuild } };
  }
  if (!result.success) return result;
  inst.tapped = true;
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

/**
 * Lists every legal choice for a BUILD command (already lowered by
 * command-builder: {categories, buildValue}). Does not mutate state or pay
 * anything -- see resolveBuild() to commit one of these.
 *
 * @param {string[]} categories - e.g. ["A","B","C","U","M"]
 * @param {number} buildValue - resolved die value (BUILD's buildValue arg, or the die that triggered it)
 * @returns {({type:'BUILD_NEW', faceId:string, shopKey:string, slotId:string}|{type:'UPGRADE', physicalId:string, fromFaceId:string, toFaceId:string})[]}
 */
function getBuildCandidates(state, index, playerId, categories, buildValue) {
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
    for (const [slotId, faceId] of Object.entries(state.shops.M.slots)) {
      if (!faceId) continue;
      const threshold = parseMonumentThreshold(getCardRow(index, faceId).DICE);
      if (buildValue >= threshold) {
        candidates.push({ type: 'BUILD_NEW', faceId, shopKey: 'M', slotId });
      }
    }
  }

  if (categories.includes('U') && !blocked.includes('U')) {
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
 * see executor.applyBzDiscount; BUILD-only, never applied for UPGRADE), remove from shop, own it, run
 * its ONCE, then emits BUILD(category) (2026-07-31 -- previously never emitted at all, so ON(BUILD(...
 * ),...) reactions like JOB004A/JOB007A's were structurally unreachable; category is the built card's
 * own sheet letter, A/B/C/M). */
function resolveBuildNew(state, index, context, candidate) {
  const row = getCardRow(index, candidate.faceId);
  const discount = executor.applyBzDiscount(lowerCostList(row.COST), context.bzDiscount);
  if (!discount) return { success: false, reason: 'INVALID_BZ_DISCOUNT' };
  const payItems = discount.bzUsed > 0 ? [...discount.items, { resource: 'BZ', count: discount.bzUsed }] : discount.items;
  const payResult = executor.payCostList(state, context.playerId, payItems, context.colorPreference);
  if (!payResult.success) return payResult;

  state.shops[candidate.shopKey].slots[candidate.slotId] = null;

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
 * (confirmed identical to the tier-B row's COST in the data), flip the face,
 * reset tap state (UPGRADE always un-taps -- [[project-dice-wp-dsl-spec]]),
 * run the new face's ONCE, then emit BUILD('U') (see resolveBuildNew's matching comment).
 */
function resolveUpgrade(state, index, context, candidate) {
  const fromRow = getCardRow(index, candidate.fromFaceId);
  const payResult = executor.payCostList(state, context.playerId, lowerCostList(fromRow.COST), context.colorPreference);
  if (!payResult.success) return payResult;

  const inst = state.cards[candidate.physicalId];
  inst.currentFaceId = candidate.toFaceId;
  inst.tapped = false;

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

/** Refills every empty slot in shopKey ("M" or "NORMAL"; "SPECIAL" never restocks) from its drawPile. */
function restockShop(state, shopKey) {
  const shop = state.shops[shopKey];
  for (const slotId of Object.keys(shop.slots)) {
    if (shop.slots[slotId] === null && shop.drawPile.length > 0) {
      shop.slots[slotId] = shop.drawPile.shift();
    }
  }
}

module.exports = {
  CASTLE_MAP_ID,
  AREA009_MAP_ID,
  CONVERT_LIMIT_ELIGIBLE_MAP_IDS,
  getSlotRequirements,
  slotAcceptsValue,
  placeDice,
  placeDiceGroup,
  previewPlaceDice,
  previewPlaceDiceGroup,
  passDie,
  resolveAreaAction,
  resolveProgramOrBuild,
  completeAreaBuild,
  useBareTapAbility,
  getBuildCandidates,
  resolveBuild,
  restockShop,
};

})();
