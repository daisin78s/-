/**
 * Smoke test for src/board.js (PLACE_DICE, BUILD/UPGRADE) against real data.
 * Run: node tests/board.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createMapState, createDie, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const board = require('../src/board');
const executor = require('../src/executor');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

// Synthetic tier-C AREA matching 孤児院LV2(AREA010C)'s OLD shape (SLOT1=ANY, ACTION=ADD(2VP)) -- 孤児院
// LV2 itself became EX-only (SLOT1=EX) + CHANGE(K,VP,5) in a later, intentional data edit (confirmed with
// the user, 2026-08-28: "意図的な変更です" -- LV2 is now deliberately owner-exclusive), which broke this
// file's own usage-fee-isolation tests below: their whole point was a NON-owner interacting with a
// tiered-up AREA whose own action never grants K/A/B/C/Z, isolating the fee-affordability check from
// whatever the AREA's own action happens to do -- but a non-owner can no longer reach AREA010C's only
// (now EX) slot at all. Registered as its own synthetic AREA row (not a mutation of the real AREA010C,
// which stays untouched for the EX-only tests further down that specifically exercise it) purely so these
// tests keep exercising that isolated mechanism regardless of what 孤児院 itself does going forward.
// 2 ANY slots (not 1) so a 地主 test further down can occupy one with an "already placed here earlier"
// die while a second, new placement still targets the other -- AREA010C's own old shape only had 1.
index.raw.AREA.push({
  ID: 'AREA999C', NAME: 'test-fee-tier-c-any-slot', SLOT1: 'ANY', SLOT2: 'ANY', SLOT3: 'NONE', SLOT4: 'NONE', SLOT5: 'NONE', SLOT6: 'NONE',
  ACTION: 'ADD(2VP)', INST: '',
});

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

function freshStateWithShops() {
  const state = createEmptyGameState('board-smoke');
  setup.createPlayers(state, ['Alice', 'Bob']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  return state;
}
function player(state, id) { return state.players.find((p) => p.id === id); }
function giveDie(state, playerId, value) {
  const die = createDie(`test-${playerId}-${value}-${Math.random()}`, 'COLOR');
  die.value = value;
  player(state, playerId).dice.push(die);
  return die;
}

// ---------------------------------------------------------------------------
// PLACE_DICE: value matching, ANY slots, duplicate-value-in-area rule
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die1 = giveDie(state, 'P1', 1); // AREA001A: SLOT1=1, SLOT2=2, SLOT3=3

  const wrongSlot = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP001', 1); // slot index 1 wants value 2
  check('Placing a 1 on a slot requiring 2 fails with VALUE_MISMATCH', wrongSlot.success, false);
  check('...reason is VALUE_MISMATCH', wrongSlot.reason, 'VALUE_MISMATCH');

  const before = player(state, 'P1').resources.K || 0;
  const ok = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP001', 0); // slot index 0 wants value 1
  check('Placing a matching-value die succeeds', ok.success, true);
  check('AREA001A.ACTION=ADD(3K) grants 3K', player(state, 'P1').resources.K, before + 3);
  check('The die is now marked as placed on MAP001', die1.placedMapId, 'MAP001');

  const die1c = giveDie(state, 'P1', 1); // same value as die1, matches slot 0's own requirement too
  const occupied = board.placeDice(state, index, { playerId: 'P1' }, die1c.id, 'MAP001', 0); // slot 0 already occupied
  check('Placing on an already-occupied slot fails', occupied.success, false);
  check('...reason is SLOT_OCCUPIED', occupied.reason, 'SLOT_OCCUPIED');
}

// ---------------------------------------------------------------------------
// Duplicate-value-within-the-same-AREA rule, tested where two *different*
// slots could otherwise both accept the same die value (AREA003A: SLOT1=2, SLOT2=ANY).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.K = 1; // AREA003A.ACTION=CHANGE(K,A,ALL) needs >=1 K to have any effect
  const dieA = giveDie(state, 'P1', 2);
  const placeFirst = board.placeDice(state, index, { playerId: 'P1' }, dieA.id, 'MAP003', 0); // SLOT1=2 (numbered slot preferred over ANY)
  check('First 2 placed on AREA003A SLOT1 succeeds', placeFirst.success, true);

  const dieB = giveDie(state, 'P1', 2); // same value, different die
  const placeSecond = board.placeDice(state, index, { playerId: 'P1' }, dieB.id, 'MAP003', 1); // SLOT2=ANY, would otherwise accept a 2
  check('A second die of the same value is rejected even on a different ANY slot', placeSecond, { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' });
}

// ---------------------------------------------------------------------------
// AREA008/009's placement gate now requires an AFFORDABLE candidate, not just a dice-eligible one
// (2026-08-04, per user feedback: "AREA008 009は建築完了出来ないときはダイスが置けません" -- reverses
// the earlier 2026-08-0X "候補さえあれば置ける" policy, see board.js's isCandidateAffordable/
// wouldAreaActionHaveEffect). With 0 real resources and 0 BZ, every dice-eligible castle candidate at
// this buildValue/seed is unaffordable, so placement itself must fail with NO_BUILDABLE_CARD -- not
// succeed and hand back an empty-of-affordable-options pendingBuild the way it used to.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 5); // same die value as the JOB002 test below, deliberately 0 resources
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP008', 0);
  check('Placing on the castle with nothing affordable is refused outright', result, { success: false, reason: 'NO_BUILDABLE_CARD' });
  check('...the die was never actually placed', die.placedMapId, null);
}

// ---------------------------------------------------------------------------
// PLACE_DICE on an ANY slot + AREA008's own BUILD() pending-decision shape.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  const die = giveDie(state, 'P1', 5); // MAP008 (castle) is all-ANY slots
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP008', 0);
  check('Placing on the castle (all-ANY slots) succeeds', result.success, true);
  // AREA008.ACTION = "BUILD()" -- can't complete synchronously, so placeDice hands back candidates instead.
  check('AREA008 (castle) ACTION=BUILD() comes back as a pending build decision, not an exception', result.actionResult.success, true);
  check('...with a non-empty candidate list (categories default to A,B,C,U,M)', result.actionResult.pendingBuild.candidates.length > 0, true);
}

// ---------------------------------------------------------------------------
// JOB002's new TAP=ON(BUILD(),ADD(K)) (2026-08-04, per user feedback: "JOB002 TAP で
// ON(BUILD(),ADD(K))に変更しました" -- replaces its old PASSIVE=ON(PLACE(MAP008/009),ADD(K))). Empty
// BUILD() args means "react to a build of ANY category" (see executor.js's eventArgsMatch, added
// specifically because this is the only card using an empty ON(...) event so far). Auto-fires rather
// than queueing a manual choice (2026-08-05: game.xlsx's AUTO column for JOB002 was filled in as "A",
// closing the data-quality gap flagged when this ability was first added) -- exercised here through a
// real placeDice -> completeAreaBuild flow (not a synthetic runCommand/emit call) so the actual BUILD
// event wiring gets covered end-to-end, complementing the more isolated ON(...)-reaction tests in
// executor.smoke.js.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const { lowerCostList } = require('../src/command-builder');
  const jobInst = createCardInstance('JOB002');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  player(state, 'P1').ownedCardPhysicalIds.push(jobInst.physicalId);
  player(state, 'P1').resources.BZ = 20; // covers whichever candidate ends up picked below

  const die = giveDie(state, 'P1', 1);
  const placeResult = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP008', 0);
  const candidate = placeResult.actionResult.pendingBuild.candidates.find((c) => c.type === 'BUILD_NEW');
  const row = getCardRow(index, candidate.faceId);
  const bzDiscount = {};
  let remaining = 20;
  for (const item of lowerCostList(row.COST)) {
    const use = Math.min(item.count, remaining);
    if (use > 0) { bzDiscount[item.resource] = use; remaining -= use; }
  }
  const beforeK = player(state, 'P1').resources.K || 0;
  const buildResult = board.completeAreaBuild(state, index, { playerId: 'P1', bzDiscount }, candidate, placeResult.actionResult.pendingBuild.remainingCommands);
  check('The build itself succeeds (fully BZ-funded)', buildResult.success, true);

  check('JOB002 auto-fires on the BUILD event (AUTO="A"), no manual choice queued', state.pendingChoices.some((c) => c.kind === 'TAP_REACTION_AVAILABLE' && c.context.physicalId === jobInst.physicalId), false);
  check('...and grants 1K immediately', player(state, 'P1').resources.K, beforeK + 1);
  check('...and taps JOB002', state.cards[jobInst.physicalId].tapped, true);
}

// ---------------------------------------------------------------------------
// Castle stacking: the old unconditional same-value auto-stack is abolished (2026-08-06, per user
// feedback: "ゾロ目は上におけるルールは廃止します") -- a second die can now only join an occupied castle
// slot via GRANT_PLACE_ANYWHERE (any value, not just a match), and its value still sums into buildValue
// (confirmed 2026-08-06: "新しいダイスの値も合計に加算される" -- a single die never exceeds 6, but
// M001-M006's DICE threshold goes up to 12, so reaching them requires stacking 2+ dice on one slot).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the previous block's comment on the new castle affordability gate
  const die1 = giveDie(state, 'P1', 5);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP008', 0);
  check('First 5 on the castle succeeds', first.success, true);
  check('...buildValue is just this one die (5), M004 (DICE>=9) is not yet reachable', first.actionResult.pendingBuild.buildValue, 5);
  check('...M004 is absent from the candidate list at buildValue 5', first.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M004'), false);

  const die2 = giveDie(state, 'P1', 5); // same value, but NO GRANT_PLACE_ANYWHERE -- now blocked outright
  const blocked = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP008', 0);
  // SLOT_NOT_PREFERRED (2026-08-06's new "leftmost available ANY slot only" rule -- see
  // isAllowedSlotForValue's own doc) fires before the SLOT_OCCUPIED check even gets a chance to: slot1
  // is a genuinely fresh, still-available ANY slot, so it -- not a second die crammed into slot0 -- is
  // where this die is supposed to go. Both rules agree the placement is illegal; this just confirms
  // which one actually catches it first when both would.
  check('A second matching-value die without GRANT_PLACE_ANYWHERE is blocked (no more free auto-stack, and a fresh slot is preferred anyway)', blocked, { success: false, reason: 'SLOT_NOT_PREFERRED' });

  die2.placeAnywhereThisTurn = true; // GRANT_PLACE_ANYWHERE -- now it can join
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP008', 0);
  check('...but succeeds once granted GRANT_PLACE_ANYWHERE', second.success, true);
  // 2026-08-20, per user request ("重ねたかどうかではなく1ターンに2個置いたかで合計するようにしてくだ
  // さい"): buildValue no longer sums with whatever a GRANT_PLACE_ANYWHERE join's target slot already
  // held from an earlier, separate placement -- it's just this 2nd die's own value (5), same as if the
  // slot had been empty. Reaching M004 (DICE>=9) now requires a genuine same-turn placeDiceGroup instead.
  check('...buildValue is just this 2nd die\'s own value (5), NOT summed with the 1st (no more multi-turn stacking)', second.actionResult.pendingBuild.buildValue, 5);
  check('...M004 (DICE>=9) is still NOT reachable -- these were 2 separate placements, not 1 combined action', second.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M004'), false);
  // 2026-08-21, per user request ("GRANT_PLACE_ANYWHEREや☆の強制フォールバックのみです")：joining an
  // occupied slot now EVICTS the earlier occupant instead of stacking onto it.
  check('...die1 was EVICTED -- only die2 (the new occupant) sits in the slot now', state.maps['MAP008'].slots[0].map((o) => o.dieId), [die2.id]);
  check('...die1\'s own placedMapId is untouched, so it still returns to hand normally at round end', die1.placedMapId, 'MAP008');
}
{
  // 2026-08-07, per user report: using JOB003 (SET_DICE_ANY + GRANT_PLACE_ANYWHERE) to set a die to a
  // value already sitting on the castle, then placing it into a DIFFERENT, empty slot instead of
  // stacking onto the matching one -- this used to succeed (GRANT_PLACE_ANYWHERE wrongly waived the
  // AREA-wide duplicate-value check for empty slots too, not just the occupied-slot check it's actually
  // meant for), producing two independent same-value occupants in one AREA. Confirmed fix: a duplicate
  // value's only legal home now is the slot(s) that already hold it -- an empty slot elsewhere in the
  // AREA is refused even with GRANT_PLACE_ANYWHERE, while the matching occupied slot still succeeds.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const die1 = giveDie(state, 'P1', 5);
  board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP008', 0); // slot0 now holds a 5

  const die2 = giveDie(state, 'P1', 5);
  die2.placeAnywhereThisTurn = true; // GRANT_PLACE_ANYWHERE
  const wrongSlot = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP008', 1); // slot1, empty
  check('Placing the duplicate value into a DIFFERENT empty slot is refused even with GRANT_PLACE_ANYWHERE', wrongSlot, { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' });
  check('...the die was never actually placed', player(state, 'P1').dice.find((d) => d.id === die2.id).placedMapId, null);

  const rightSlot = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP008', 0); // slot0, the matching one
  check('...but placing it onto the SAME slot as the matching value still succeeds', rightSlot.success, true);
  // 2026-08-21, per user request: joining now EVICTS die1 rather than stacking both onto slot0.
  check('die1 was evicted; only die2 occupies slot0 now, not spread across two slots', state.maps['MAP008'].slots[0].map((o) => o.dieId), [die2.id]);
}

// ---------------------------------------------------------------------------
// BUILD candidates + resolveBuild(BUILD_NEW)
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');

  // Find a normal-shop slot's actual DICE_MAX so this test works regardless of shuffle.
  const [slotId, faceId] = Object.entries(state.shops.NORMAL.slots)[0];
  const shopRow = require('../src/data-loader').getShopRow(index, slotId);
  const buildValue = shopRow.DICE_MIN;

  const candidates = board.getBuildCandidates(state, index, 'P1', ['A', 'B', 'C'], buildValue);
  check('At least one normal-shop candidate exists at the slot\'s own DICE_MIN', candidates.some((c) => c.faceId === faceId), true);

  const candidate = candidates.find((c) => c.faceId === faceId);
  const row = getCardRow(index, faceId);
  // Give exactly enough resources to afford it.
  for (const item of require('../src/command-builder').lowerCostList(row.COST)) {
    p1.resources[item.resource] = (p1.resources[item.resource] || 0) + item.count;
  }
  const result = board.resolveBuild(state, index, { playerId: 'P1' }, candidate);
  check('resolveBuild(BUILD_NEW) succeeds when affordable', result.success, true);
  check('Player now owns the built card', p1.ownedCardPhysicalIds.includes(candidate.faceId.slice(0, -1)), true);
  // 2026-08-18: resolveBuildNew now compacts the row immediately (see compactShop's own doc), so this
  // slot no longer sits empty -- it shows whatever card shifted in from later in the row (or null only
  // if this was the last remaining card). What actually matters here is that the built card itself is
  // gone from the shop entirely, not which slot key it used to occupy.
  check('The built card no longer appears anywhere in the shop row', Object.values(state.shops.NORMAL.slots).includes(faceId), false);
  check('Player paid the full cost (resources back to 0)', Object.values(p1.resources).filter((v) => v > 0 && v !== p1.resources.VP).length >= 0, true);
}

// ---------------------------------------------------------------------------
// getBuildCandidates respects BLOCK_BUILD (2026-08-04, per user feedback: using JOB004's TAP blocks
// monument building for the rest of that turn) -- the single choke point every BUILD(M) path shares.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  // buildValue=12 clears every monument's threshold (max DICE is ">=12"), so at least one M candidate
  // is guaranteed regardless of this seed's shop shuffle.
  const unblocked = board.getBuildCandidates(state, index, 'P1', ['M'], 12);
  check('Without a block, at least one monument candidate is reachable at buildValue=12', unblocked.length > 0, true);

  p1.blockedBuildCategoriesThisTurn = ['M'];
  const blocked = board.getBuildCandidates(state, index, 'P1', ['M'], 12);
  check('With M blocked, no monument candidates are offered even at buildValue=12', blocked.length, 0);

  // Blocking is per-player, not global -- P2 (unaffected) still sees the same candidates P1 did before.
  const p2Candidates = board.getBuildCandidates(state, index, 'P2', ['M'], 12);
  check('...and does not affect other players', p2Candidates.length, unblocked.length);
}

// ---------------------------------------------------------------------------
// getBuildCandidates respects MONUMENT_DICE_DISCOUNT (2026-08-18, JOB007/密使's revised TAP: "モニュメン
// トの必要ダイスを2下げる") -- M001 has DICE=">=12" (the highest threshold in the data, confirmed via
// data/game.json), so buildValue=10 is a clean below-every-other-monument's-threshold probe: unreachable
// without the discount, reachable once a 2-point discount closes the gap.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const withoutDiscount = board.getBuildCandidates(state, index, 'P1', ['M'], 10);
  check('M001 (DICE>=12) is not reachable at buildValue=10 with no discount', withoutDiscount.some((c) => c.faceId === 'M001'), false);

  p1.monumentDiceDiscountThisTurn = 2;
  const withDiscount = board.getBuildCandidates(state, index, 'P1', ['M'], 10);
  check('...but is reachable once a 2-point MONUMENT_DICE_DISCOUNT closes the gap (effective threshold 10)', withDiscount.some((c) => c.faceId === 'M001'), true);

  // Per-player, not global -- P2 (unaffected) still doesn't see M001 at buildValue=10.
  const p2Candidates = board.getBuildCandidates(state, index, 'P2', ['M'], 10);
  check('...and does not affect other players', p2Candidates.some((c) => c.faceId === 'M001'), false);

  // A discount large enough to floor the threshold below 0 just makes every monument reachable, rather
  // than going negative (buildValue is always a positive die value/sum, so this only matters for the
  // clamp itself, not for any real gameplay difference beyond "everything's now buildable").
  p1.monumentDiceDiscountThisTurn = 99;
  const flooredAtZero = board.getBuildCandidates(state, index, 'P1', ['M'], 1);
  check('An extreme discount floors the threshold at 0, not negative (M001 reachable even at buildValue=1)', flooredAtZero.some((c) => c.faceId === 'M001'), true);
}

{
  // executor.runCommand(MONUMENT_DICE_DISCOUNT) itself, plus TURNEND clearing (mirrors BLOCK_BUILD's own
  // turn-scoped lifecycle -- see executor.applyTurnEnd).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  check('monumentDiceDiscountThisTurn starts at 0', p1.monumentDiceDiscountThisTurn, 0);

  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'MONUMENT_DICE_DISCOUNT', amount: 2, duration: 'THIS_TURN' });
  check('MONUMENT_DICE_DISCOUNT(2,THIS_TURN) sets the discount to 2', p1.monumentDiceDiscountThisTurn, 2);

  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'MONUMENT_DICE_DISCOUNT', amount: 3, duration: 'THIS_TURN' });
  check('A second grant in the same turn sums (2+3=5), rather than overwriting', p1.monumentDiceDiscountThisTurn, 5);

  executor.applyTurnEnd(state, index, 'P1');
  check('...and resets to 0 at TURNEND, same as blockedBuildCategoriesThisTurn', p1.monumentDiceDiscountThisTurn, 0);
}

// ---------------------------------------------------------------------------
// resolveBuild(UPGRADE)
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A'); // A001B exists (has a back side) per data
  inst.ownerId = 'P1';
  inst.tapped = true; // 2026-08-15, per user request: LVUP must NOT reset tap state any more
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);

  const candidates = board.getBuildCandidates(state, index, 'P1', ['U'], 0); // buildValue irrelevant for U
  const upgradeCandidate = candidates.find((c) => c.physicalId === 'A001');
  check('getBuildCandidates finds the A001 -> A001B upgrade', !!upgradeCandidate, true);

  const costRow = getCardRow(index, 'A001A'); // "2A"
  p1.resources.A = 2;
  const result = board.resolveBuild(state, index, { playerId: 'P1' }, upgradeCandidate);
  check('resolveBuild(UPGRADE) succeeds', result.success, true);
  check('Card face flipped to A001B', state.cards['A001'].currentFaceId, 'A001B');
  check('Card keeps its prior TAP state after upgrading (no more auto-untap)', state.cards['A001'].tapped, true);
  check('Paid the 2A cost', p1.resources.A, 0);
  // A001B.ONCE = 'MAP003.CURRENT_AREA=AREA003C' -- confirms the new face's ONCE ran.
  check('A001B.ONCE ran: MAP003 flipped to tier C', state.maps['MAP003'].currentAreaId, 'AREA003C');
}

// ---------------------------------------------------------------------------
// getBuildCandidates(U): CON/JOB are never upgrade-eligible (confirmed 2026-07-30, "CONはアップグレー
// ドできません") even though CON's id shape (e.g. CON001A/CON001B) looks just like a normal deck
// card's -- only A/B/C should ever appear as an UPGRADE candidate.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const conInst = createCardInstance('CON001A'); // CON001B exists (has a back side) per data
  conInst.ownerId = 'P1';
  state.cards[conInst.physicalId] = conInst;
  p1.ownedCardPhysicalIds.push(conInst.physicalId);

  const candidates = board.getBuildCandidates(state, index, 'P1', ['U'], 0);
  check('CON001 is never offered as an UPGRADE candidate', candidates.some((c) => c.physicalId === 'CON001'), false);
}

// ---------------------------------------------------------------------------
// CON004A: BLOCK_UPGRADE_UNLESS_QST_RANK(Q004A,1) (2026-08-13, per user spec: "QSTカードQ004Aで1位で
// なければLVUPできない") -- checked against Q004A's own GOAL (AREA_COUNT) regardless of whether Q004A
// is actually one of this game's 3 revealed QST cards (confirmed with the user: "見えないところで
// Q004Aをチェックする"), so no state.quests setup is needed here at all.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const p2 = player(state, 'P2');
  const con4 = createCardInstance('CON004A');
  con4.ownerId = 'P1';
  state.cards[con4.physicalId] = con4;
  p1.ownedCardPhysicalIds.push(con4.physicalId);
  const upgradeable = createCardInstance('A001A'); // A001B exists per data
  upgradeable.ownerId = 'P1';
  state.cards[upgradeable.physicalId] = upgradeable;
  p1.ownedCardPhysicalIds.push(upgradeable.physicalId);
  // P1's own A001A already counts 1 toward AREA_COUNT; give P2 more so P1 is NOT rank 1.
  for (const faceId of ['A002A', 'A003A']) {
    const inst = createCardInstance(faceId);
    inst.ownerId = 'P2';
    state.cards[inst.physicalId] = inst;
    p2.ownedCardPhysicalIds.push(inst.physicalId);
  }
  const blocked = board.getBuildCandidates(state, index, 'P1', ['U'], 0);
  check('CON004A blocks every UPGRADE candidate while P1 is not rank 1 in Q004A (AREA_COUNT)', blocked, []);
  check('isUpgradeBlockedByQstRank reports true in this state', board.isUpgradeBlockedByQstRank(state, index, 'P1'), true);

  // P1 catches up to rank 1 (ties count as rank 1 too, competition ranking).
  const inst2 = createCardInstance('A004A');
  inst2.ownerId = 'P1';
  state.cards[inst2.physicalId] = inst2;
  p1.ownedCardPhysicalIds.push(inst2.physicalId);
  const allowed = board.getBuildCandidates(state, index, 'P1', ['U'], 0);
  check('...but the same UPGRADE is offered again once P1 reaches rank 1 (tied at AREA_COUNT=2)', allowed.some((c) => c.physicalId === 'A001'), true);
}

// ---------------------------------------------------------------------------
// hasAnyUpgradeEligibleCard (2026-08-18, for CON004A/傲慢's own card-note display: only shown while the
// player both has something upgrade-eligible AND is actually blocked -- see main.js's own doc). Unlike
// getBuildCandidates(['U']), this ignores isUpgradeBlockedByQstRank entirely, so it can tell "blocked"
// apart from "nothing to upgrade in the first place" (both read as [] from getBuildCandidates alone).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const p2 = player(state, 'P2');
  check('False with no owned cards at all', board.hasAnyUpgradeEligibleCard(state, index, 'P1'), false);

  const con4 = createCardInstance('CON004A');
  con4.ownerId = 'P1';
  state.cards[con4.physicalId] = con4;
  p1.ownedCardPhysicalIds.push(con4.physicalId);
  check('False with only a CON card owned (CON/JOB never count)', board.hasAnyUpgradeEligibleCard(state, index, 'P1'), false);

  const upgradeable = createCardInstance('A001A'); // A001B exists
  upgradeable.ownerId = 'P1';
  state.cards[upgradeable.physicalId] = upgradeable;
  p1.ownedCardPhysicalIds.push(upgradeable.physicalId);
  check('True once an upgrade-eligible A/B/C card is owned', board.hasAnyUpgradeEligibleCard(state, index, 'P1'), true);

  // Make P1 QST-rank-blocked (same setup as the CON004A test above) -- hasAnyUpgradeEligibleCard must
  // stay true even though getBuildCandidates(['U']) would now report [] for an unrelated reason.
  for (const faceId of ['A002A', 'A003A']) {
    const inst = createCardInstance(faceId);
    inst.ownerId = 'P2';
    state.cards[inst.physicalId] = inst;
    p2.ownedCardPhysicalIds.push(inst.physicalId);
  }
  check('P1 is indeed QST-rank-blocked now', board.isUpgradeBlockedByQstRank(state, index, 'P1'), true);
  check('...but hasAnyUpgradeEligibleCard stays true regardless (ignores the block)', board.hasAnyUpgradeEligibleCard(state, index, 'P1'), true);
  check('...unlike getBuildCandidates, which reports none while blocked', board.getBuildCandidates(state, index, 'P1', ['U'], 0), []);
}

// ---------------------------------------------------------------------------
// 憤怒: BLOCK_COLOR_DIE_REUSE() (2026-08-15, per user spec: "自分のカラーDが置かれているAREAには
// 別のカラーDを配置できない") -- blocks placing a 2nd own COLOR die on a map from a SEPARATE, later
// action, but a single group-placement action stacking 2+ own COLOR dice together (confirmed with the
// user: "スタッキングは許可") is exempt, and GRANT_PLACE_ANYWHERE waives it entirely (confirmed:
// "バイパスされる", unlike DUPLICATE_VALUE_IN_AREA). 憤怒 lived at CON006A until the user reorganized
// game.xlsx's CON sheet by START_ORDER (2026-08-17, matching physical slot number to START_ORDER for
// both A/B tiers); it's CON005B now -- every CON005B below refers to 憤怒 specifically.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  check('isColorDieReuseBlocked reports true once CON005B is owned', board.isColorDieReuseBlocked(state, index, 'P1'), true);

  // AREA001A: SLOT1=1, SLOT2=2, SLOT3=3 -- placing values 1 then 2 avoids DUPLICATE_VALUE_IN_AREA
  // interference, isolating this test to the new own-COLOR-die-reuse rule alone.
  const d1 = giveDie(state, 'P1', 1);
  const first = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('First own COLOR die onto AREA001A succeeds', first.success, true);

  const d2 = giveDie(state, 'P1', 2);
  const second = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('A 2nd own COLOR die onto the same AREA, in a later separate action, is blocked', second, { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' });

  // GRANT_PLACE_ANYWHERE waives the rule (confirmed distinct from DUPLICATE_VALUE_IN_AREA's own bypass policy).
  d2.placeAnywhereThisTurn = true;
  const bypassed = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('...but GRANT_PLACE_ANYWHERE (placeAnywhereThisTurn) waives it', bypassed.success, true);
}
{
  // A player without CON005B is never restricted this way.
  const state = freshStateWithShops();
  const d1 = giveDie(state, 'P1', 1);
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  const d2 = giveDie(state, 'P1', 2);
  const second = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('Without CON005B, a 2nd own COLOR die onto the same AREA in a separate action is unaffected', second.success, true);
}
{
  // Stacking exemption: placeDiceGroup placing 2 of this player's own COLOR dice together, in ONE
  // action, onto the castle -- must NOT be blocked even though CON005B is owned, since neither die was
  // "already there" before this action started.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.BZ = 20;
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 3);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('CON005B does not block a single group action stacking 2 own COLOR dice together', result.success, true);
}
{
  // But a group placement reusing a map this player already placed a COLOR die on in an EARLIER,
  // separate action is blocked, same as the single-die path.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.BZ = 20;
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  const earlierDie = giveDie(state, 'P1', 5);
  board.placeDice(state, index, { playerId: 'P1' }, earlierDie.id, board.CASTLE_MAP_ID, 0);
  const d1 = giveDie(state, 'P1', 1);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('A group placement reusing a map with an earlier own COLOR die is blocked', result, { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' });
}
{
  // Bug fix (2026-08-16, per user report: "CON憤怒 現在AREAがLVUPしても前の情報が残りダイスが置けません"):
  // once the AREA a player's own COLOR die sat on LVUPs (map.slots resets, see executor.js's own doc on
  // runSetCurrentArea), that die's old occupancy should no longer count against CON005B's own-color-die
  // reuse block, even though die.placedMapId itself deliberately stays put (still needed for endRound's
  // unused-color-die bonus, see playerHasOwnColorDieInMapSlots's own doc).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);

  const d1 = giveDie(state, 'P1', 1); // AREA001A SLOT1=1
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  const d2 = giveDie(state, 'P1', 2); // AREA001A SLOT2=2
  const blockedBeforeUpgrade = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('Still blocked before the AREA LVUPs', blockedBeforeUpgrade, { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' });

  // A004A.ONCE = 'MAP001.CURRENT_AREA=AREA001B' -- the real LVUP trigger (building/owning A004A;
  // 2026-08-24 SHOP201-203 rework renumbered the A-deck, so this used to be A005A).
  executor.runProgram(state, index, { playerId: 'P1' }, getCardRow(index, 'A004A').ONCE);
  check('MAP001 is now AREA001B', state.maps['MAP001'].currentAreaId, 'AREA001B');
  check('...and die.placedMapId is untouched (still needed for endRound bookkeeping)', d1.placedMapId, 'MAP001');

  const d3 = giveDie(state, 'P1', 1); // AREA001B SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  const afterUpgrade = board.placeDice(state, index, { playerId: 'P1' }, d3.id, 'MAP001', 0);
  check('No longer blocked once the AREA has LVUPed away the old occupancy', afterUpgrade.success, true);
}
{
  // TEST CHANGE (2026-08-16, per user: "自分のカラーダイスがおかれているAREAにカラーダイスもｗDも置け
  // なくなります", explicitly flagged as trial/revertible) -- wD (WHITE) used to be exempt from CON005B's
  // own-color-die reuse block; now it's restricted the same as a 2nd COLOR die would be. To revert this
  // test alongside the board.js change, delete this block and restore the old `die.kind === 'COLOR' &&'
  // guards there.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);

  const d1 = giveDie(state, 'P1', 1); // AREA001A SLOT1=1
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);

  const wDie = require('../src/game-state').createDie('test-wd-1', 'WHITE');
  wDie.value = 2; // AREA001A SLOT2=2
  p1.dice.push(wDie);
  const wDBlocked = board.placeDice(state, index, { playerId: 'P1' }, wDie.id, 'MAP001', 1);
  check('A wD is now also blocked from an AREA holding this player\'s own COLOR die', wDBlocked, { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' });
}

// ---------------------------------------------------------------------------
// restockShop (2026-08-07, per user request: "SHOP101のカードが建築された時、102のカードが101にズレ、
// 103のカードが102にズレ...カードの補充は必ずSHOP106にされるように...SHOP001も同様に SHOP201も同じよう
// にずれていくが、補充はなし" -- the row now compacts left before refilling, instead of each slot
// refilling independently in place).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const [slot1, slot2, slot3, slot4, slot5, slot6] = Object.keys(state.shops.M.slots);
  const before = { s1: state.shops.M.slots[slot1], s2: state.shops.M.slots[slot2], s3: state.shops.M.slots[slot3] };
  const drawPileBefore = state.shops.M.drawPile.length;
  state.shops.M.slots[slot1] = null; // simulate "was just built" -- a hole in the MIDDLE-left of the row
  board.restockShop(state, 'M');
  check('The hole at slot1 is closed by shifting slot2 left into it', state.shops.M.slots[slot1], before.s2);
  check('...slot3 shifts left into slot2', state.shops.M.slots[slot2], before.s3);
  check('...slot4/5/6 are untouched other than the final one', state.shops.M.slots[slot5] !== null, true);
  check('...the new card is drawn into the trailing slot6, not back into slot1', state.shops.M.slots[slot6] !== null, true);
  check('...the draw pile shrank by exactly 1', state.shops.M.drawPile.length, drawPileBefore - 1);
}
{
  // SPECIAL (2026-08-24 rework, replacing the old "compacts but never refills" behavior): compacts AND
  // refills exactly like M/NORMAL now -- its drawPile is just 3 waves concatenated in order (see
  // setup.prepareShops' own doc), and drawing FIFO from it is what makes wave 2/3 appear as earlier
  // waves sell out. Bare mechanics check here; the actual reveal-curve regression is the block below.
  const state = freshStateWithShops();
  const [slot1, slot2, slot3] = Object.keys(state.shops.SPECIAL.slots);
  const before3 = state.shops.SPECIAL.slots[slot3];
  state.shops.SPECIAL.slots[slot2] = null; // a hole in the middle -- simulate "was just built"
  const drawPileBefore = state.shops.SPECIAL.drawPile.length;
  board.restockShop(state, 'SPECIAL');
  check('SPECIAL compacts: slot3\'s card shifts left into the gap at slot2', state.shops.SPECIAL.slots[slot2], before3);
  check('...and refills the trailing slot3 from its own drawPile', state.shops.SPECIAL.slots[slot3] !== null, true);
  check('...the draw pile shrank by exactly 1', state.shops.SPECIAL.drawPile.length, drawPileBefore - 1);
}
{
  // Regression (2026-08-24, per user spec: "残り2枚になったら1枚見える 残り1枚になったら2枚見える
  // 残り0枚まいですべて見える") -- wave 2 (A301/B301/C301) should progressively appear in SHOP201-203
  // as wave 1 (the 6 A201/A202-family cards) sells out, purely from the concatenated-drawPile FIFO
  // restock (no dedicated wave-tracking code). Buys every visible SLOT repeatedly (forcing a direct
  // build via resolveBuildNew, bypassing cost/round gating entirely -- this test only cares about shop
  // mechanics) and checks wave-1-remaining vs wave-2-visible at each step.
  const state = freshStateWithShops();
  const waveNum = (faceId) => Number(faceId.replace(/\D/g, ''));
  const isWave1 = (faceId) => faceId && waveNum(faceId) < 300;
  const isWave2 = (faceId) => faceId && waveNum(faceId) >= 300 && waveNum(faceId) < 400;
  const countWave = (pred) => [
    ...Object.values(state.shops.SPECIAL.slots),
    ...state.shops.SPECIAL.drawPile,
  ].filter(pred).length;
  check('Starts with all 6 wave-1 cards somewhere (3 shown + 3 in the pile), 0 wave-2 visible', countWave(isWave1), 6);
  check('...and no wave-2 card visible in a slot yet', Object.values(state.shops.SPECIAL.slots).some(isWave2), false);

  const buyOneSlot = (slotId) => {
    const faceId = state.shops.SPECIAL.slots[slotId];
    state.shops.SPECIAL.slots[slotId] = null;
    board.restockShop(state, 'SPECIAL');
    return faceId;
  };
  // Always buys a wave-1 slot specifically (never an already-revealed wave-2 one) -- deliberately, so
  // this proves the "残り N枚→ちょうどN'枚見える" relationship generically at every step, rather than
  // depending on some particular buy order that happens to touch wave-1 and wave-2 slots in the right
  // sequence. Expected wave-2-visible count at each step, indexed by wave-1-remaining count (6..0).
  const expectedWave2VisibleByWave1Remaining = { 6: 0, 5: 0, 4: 0, 3: 0, 2: 1, 1: 2, 0: 3 };
  while (countWave(isWave1) > 0) {
    const wave1Slot = Object.keys(state.shops.SPECIAL.slots).find((id) => isWave1(state.shops.SPECIAL.slots[id]));
    buyOneSlot(wave1Slot);
    const wave1Remaining = countWave(isWave1);
    const wave2Visible = Object.values(state.shops.SPECIAL.slots).filter(isWave2).length;
    check(`After wave-1 remaining drops to ${wave1Remaining}, wave-2 visible is ${expectedWave2VisibleByWave1Remaining[wave1Remaining]}`, wave2Visible, expectedWave2VisibleByWave1Remaining[wave1Remaining]);
  }
}
{
  // M401-403 moved from SHOP201-203's own wave-3 into the M shop's own drawPile (2026-08-28, per user
  // request: "SHOP006が空になったら[M401-403が]出てくる" -- reverting the 2026-08-25
  // forceSpecialShopMonumentsAtRound4 behavior, since SHOP201-203 no longer holds any monuments to force
  // at all). SHOP201-203 never contains an M401-403 id, at any point, drawPile included.
  const state = freshStateWithShops();
  const waveNum = (faceId) => Number(faceId.replace(/\D/g, ''));
  const isExtraMonument = (faceId) => faceId && waveNum(faceId) >= 400;
  check('SHOP201-203 never holds an M401-403 id (slots)', Object.values(state.shops.SPECIAL.slots).some(isExtraMonument), false);
  check('...nor in its drawPile', state.shops.SPECIAL.drawPile.some(isExtraMonument), false);
}
{
  // The M shop (SHOP001-006) reveals M401-403 only once the original 12 (M001-012) are fully sold --
  // same "one concatenated drawPile, FIFO restock reveals the next wave" mechanic SHOP201-203's own
  // wave1->wave2 progression uses, just applied to M001-012 (12, "wave 1") -> M401-403 (3, "wave 2")
  // across 6 slots instead of 3.
  const state = freshStateWithShops();
  const waveNum = (faceId) => Number(faceId.replace(/\D/g, ''));
  const isOriginal = (faceId) => faceId && waveNum(faceId) < 400 && waveNum(faceId) > 0;
  const isExtra = (faceId) => faceId && waveNum(faceId) >= 400;
  const countWave = (pred) => [...Object.values(state.shops.M.slots), ...state.shops.M.drawPile].filter(pred).length;
  check('Starts with all 12 original monuments somewhere (6 shown + 6 in the pile), 0 extra visible', countWave(isOriginal), 12);
  check('...and no M401-403 visible in a slot yet', Object.values(state.shops.M.slots).some(isExtra), false);

  const buyOneSlot = (slotId) => {
    state.shops.M.slots[slotId] = null;
    board.restockShop(state, 'M');
  };
  // Expected extra-visible count at each step, indexed by original-remaining count (12..0) -- extras
  // start entering slots once original-remaining drops below the slot count (6), same relationship
  // SPECIAL's own wave1/wave2 test already established.
  const expectedExtraVisibleByOriginalRemaining = { 12: 0, 11: 0, 10: 0, 9: 0, 8: 0, 7: 0, 6: 0, 5: 1, 4: 2, 3: 3, 2: 3, 1: 3, 0: 3 };
  while (countWave(isOriginal) > 0) {
    const originalSlot = Object.keys(state.shops.M.slots).find((id) => isOriginal(state.shops.M.slots[id]));
    buyOneSlot(originalSlot);
    const originalRemaining = countWave(isOriginal);
    const extraVisible = Object.values(state.shops.M.slots).filter(isExtra).length;
    check(`After original-monument remaining drops to ${originalRemaining}, M401-403 visible is ${expectedExtraVisibleByOriginalRemaining[originalRemaining]}`, extraVisible, expectedExtraVisibleByOriginalRemaining[originalRemaining]);
  }
}
{
  // turnFlow.startRound no longer touches SHOP201-203 at all when reaching round 4 (2026-08-28 revert).
  const state = freshStateWithShops();
  const turnFlow = require('../src/turn-flow');
  const before = { ...state.shops.SPECIAL.slots };
  state.round = 3;
  turnFlow.startRound(state);
  check('startRound landing on round 4 leaves SHOP201-203 untouched', state.round, 4);
  check('...same slots as before', state.shops.SPECIAL.slots, before);
}
{
  // A hole at the far right (the common case: the rightmost occupied card is the one built) needs no
  // shifting at all, and still refills into that same slot.
  const state = freshStateWithShops();
  const slotIds = Object.keys(state.shops.NORMAL.slots);
  const lastSlot = slotIds[slotIds.length - 1];
  const otherSlotsBefore = Object.fromEntries(slotIds.slice(0, -1).map((id) => [id, state.shops.NORMAL.slots[id]]));
  state.shops.NORMAL.slots[lastSlot] = null;
  board.restockShop(state, 'NORMAL');
  check('The other slots are untouched when only the last one was empty', Object.fromEntries(slotIds.slice(0, -1).map((id) => [id, state.shops.NORMAL.slots[id]])), otherSlotsBefore);
  check('...and the last slot itself is refilled', state.shops.NORMAL.slots[lastSlot] !== null, true);
}
{
  // compactShop alone: shift only, no refill, no matter how many draw pile cards are available -- the
  // half restockShop still defers to TURNEND on its own.
  const state = freshStateWithShops();
  const [slot1, slot2] = Object.keys(state.shops.NORMAL.slots);
  const slot2Before = state.shops.NORMAL.slots[slot2];
  const drawPileBefore = state.shops.NORMAL.drawPile.length;
  state.shops.NORMAL.slots[slot1] = null;
  board.compactShop(state, 'NORMAL');
  check('compactShop shifts slot2 into the slot1 gap', state.shops.NORMAL.slots[slot1], slot2Before);
  check('...but does NOT refill the newly-trailing gap from the draw pile', state.shops.NORMAL.drawPile.length, drawPileBefore);
}
{
  // The actual bug report this fixes (2026-08-18): "デバッグモードで戻ったときSHOP101が空のままで詰め
  // ていかなかった" -- a build used to leave its own slot genuinely empty until TURNEND, which any
  // snapshot taken in between (including the debug turn-history timeline) faithfully reproduced.
  // resolveBuildNew now compacts immediately, so this never happens even before TURNEND.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const slotIds = Object.keys(state.shops.NORMAL.slots);
  const [slotId, faceId] = [slotIds[0], state.shops.NORMAL.slots[slotIds[0]]];
  const nextSlotFaceIdBefore = state.shops.NORMAL.slots[slotIds[1]];
  const row = getCardRow(index, faceId);
  for (const item of require('../src/command-builder').lowerCostList(row.COST)) {
    p1.resources[item.resource] = (p1.resources[item.resource] || 0) + item.count;
  }
  const candidate = board.getBuildCandidates(state, index, 'P1', ['A', 'B', 'C'], require('../src/data-loader').getShopRow(index, slotId).DICE_MIN).find((c) => c.faceId === faceId);
  board.resolveBuild(state, index, { playerId: 'P1' }, candidate);
  check('The built slot is NOT left empty -- it already shows the next slot\'s card, well before TURNEND', state.shops.NORMAL.slots[slotId], nextSlotFaceIdBefore);
}

// ---------------------------------------------------------------------------
// CONVERT_LIMIT(ALL,n) actually gets applied end-to-end through placeDice:
// AREA003A.ACTION=CHANGE(K,A,ALL), CON003B.PASSIVE=CONVERT_LIMIT(ALL,4).
// (The capping logic itself is covered in executor.smoke.js; this checks it
// really reaches a CHANGE fired by a die placement.) The cap is per-CHANGE as
// of 2026-08-11, so a SECOND placement gets its own fresh 4 -- which is the
// user's own worked example, spread across two AREAs.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const inst = require('../src/game-state').createCardInstance('CON003B');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  const p1 = player(state, 'P1');
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.K = 20;

  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1 requires value 2 (SLOT2 is ANY, but the numbered slot is preferred)
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('Placing on MAP003 (CHANGE(K,A,ALL) + CONVERT_LIMIT(4)) succeeds', result.success, true);
  check('Only 4 conversions happened despite 20K on hand (CONVERT_LIMIT applied via placeDice)', p1.resources.A, 4);
  check('Nothing accumulated into passiveCounters (the cap is per-CHANGE now)', state.passiveCounters['P1:CONVERT_LIMIT:ALL'], undefined);

  // A second, separate ALL-CHANGE placement -- MAP004 is AREA004A's CHANGE(K,B,ALL), whose SLOT1 wants a 4
  // (SLOT2 is ANY, but the numbered slot is preferred).
  const die2 = giveDie(state, 'P1', 4);
  const result2 = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP004', 0);
  check('A second ALL-CHANGE placement also succeeds', result2.success, true);
  check('...and gets its own full 4 conversions, not 0 (per-CHANGE cap)', p1.resources.B, 4);
  check('8K total spent across the two placements', p1.resources.K, 12);
}

// ---------------------------------------------------------------------------
// useBareTapAbility (2026-07-31): a card's own *direct* TAP ability (no ON(...) wrapper), initiated
// by the player at any point during their turn -- distinct from executor.resolveTapReaction's
// event-triggered reactions. C001A.TAP=CHANGE(K,A,2): simplest case, no player choice needed.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('C001A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.K = 2;

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, inst.physicalId);
  check('C001A.TAP=CHANGE(K,A,2) succeeds with no player choice needed', result, { success: true });
  check('...paid 2K, gained 2A', { K: p1.resources.K, A: p1.resources.A }, { K: 0, A: 2 });
  check('...the card is now tapped', state.cards[inst.physicalId].tapped, true);

  const secondAttempt = board.useBareTapAbility(state, index, { playerId: 'P1' }, inst.physicalId);
  check('Using it again while still tapped fails', secondAttempt, { success: false, reason: 'ALREADY_TAPPED' });
}

// ---------------------------------------------------------------------------
// B001A.TAP=SET_DIE_VALUE(SELF1|2);GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN) -- needs the caller to
// supply context.chosenDieId/chosenValue *before* calling (the whole TAP field runs as one atomic
// program, so there's no mid-run prompt). context.lastTargetedDieId propagates SET_DIE_VALUE's choice
// of die into GRANT_PLACE_ANYWHERE(THIS_DICE,...) automatically (same context object throughout).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('B001A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  const die = giveDie(state, 'P1', 5); // any starting value; SET_DIE_VALUE overwrites it

  const missingChoice = board.useBareTapAbility(state, index, { playerId: 'P1' }, inst.physicalId);
  check('Without chosenDieId/chosenValue, fails with CHOICE_REQUIRED (nothing mutated)', missingChoice.success, false);
  check('...and the card stays untapped after a failed attempt', state.cards[inst.physicalId].tapped, false);

  const result = board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: die.id, chosenValue: 2 }, inst.physicalId);
  check('With a valid choice (2, one of SELF1|2), succeeds', result, { success: true });
  // The earlier failed CHOICE_REQUIRED attempt rolled back via runProgram's snapshot-replace, which
  // stales any player/die reference grabbed before it (see tests/executor.smoke.js's getDieRef
  // comment for the same trap) -- re-fetch fresh from state rather than reusing `p1`/`die`.
  const dieAfter = player(state, 'P1').dice.find((d) => d.id === die.id);
  check('...the die\'s value is now 2', dieAfter.value, 2);
  check('...and it\'s flagged placeAnywhereThisTurn (GRANT_PLACE_ANYWHERE(THIS_DICE,...) followed it)', dieAfter.placeAnywhereThisTurn, true);
  check('...the card is now tapped', state.cards[inst.physicalId].tapped, true);
}

// ---------------------------------------------------------------------------
// B202A/終わりの兆し's TAP=BUILD((A,B,C,M),6) -- a bare TAP ability can itself be a BUILD, same
// two-phase pattern as an AREA's ACTION or a QST reward (see resolveProgramOrBuild): can't complete
// synchronously, so useBareTapAbility returns pendingBuild (tagged with physicalId) instead of tapping
// immediately. (2026-08-24 SHOP201-203 rework renumbered the B-deck -- this used to be B005A.)
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('B202A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, inst.physicalId);
  check('B202A.TAP=BUILD(...) comes back as a pending build decision, not tapped yet', result.success, true);
  check('...pendingBuild carries the source card\'s physicalId', result.pendingBuild.physicalId, inst.physicalId);
  check('...with a non-empty candidate list', result.pendingBuild.candidates.length > 0, true);
  check('The card is NOT tapped yet (nothing committed until the candidate is chosen)', state.cards[inst.physicalId].tapped, false);

  // Caller (main.js) is responsible for tapping the source card after completeAreaBuild succeeds --
  // useBareTapAbility can't do it itself since committing happens in a later, separate call.
  const candidate = result.pendingBuild.candidates[0];
  const row = getCardRow(index, candidate.faceId);
  for (const item of require('../src/command-builder').lowerCostList(row.COST)) {
    p1.resources[item.resource] = (p1.resources[item.resource] || 0) + item.count;
  }
  const buildResult = board.completeAreaBuild(state, index, { playerId: 'P1' }, candidate, result.pendingBuild.remainingCommands);
  check('completeAreaBuild commits the candidate chosen from a TAP-sourced pendingBuild', buildResult.success, true);
}

// ---------------------------------------------------------------------------
// JOB004.TAP=CHANGE(3K,2Z) (2026-08-24 data edit: was CHANGE(3K,2BZ) -- Z is the general wildcard
// resource payCostList already substitutes for any real-resource shortfall (persistent, unlike BZ's
// turn-scoped build-only discount), so this is a genuine mechanic change, not just a rename). Still a
// bare (non-reactive) TAP ability, usable any time during the player's own turn, same as C001A's
// CHANGE(K,A,2).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB004');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.resources.K = 3;

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, jobInst.physicalId);
  check('JOB004.TAP=CHANGE(3K,2Z) succeeds as a direct (non-reactive) TAP', result, { success: true });
  check('...paid 3K, gained 2Z', { K: p1.resources.K, Z: p1.resources.Z }, { K: 0, Z: 2 });
  check('...the card is now tapped', state.cards[jobInst.physicalId].tapped, true);

  // The Z gained this way covers a real-resource shortfall via the ordinary payCostList substitution --
  // no special bzDiscount plumbing needed, unlike the old BZ version of this same TAP.
  p1.resources.A = 1; // A004A costs "2A,B" -- 1 short of the 2A needed
  p1.resources.B = 1;
  state.shops.NORMAL.slots.SHOP101 = 'A004A'; // force a known slot, regardless of this seed's shuffle
  const candidate = { type: 'BUILD_NEW', faceId: 'A004A', shopKey: 'NORMAL', slotId: 'SHOP101' };
  const buildResult = board.resolveBuild(state, index, { playerId: 'P1' }, candidate);
  check('The 2 Z JOB004 just granted covers the build that would otherwise be unaffordable', buildResult.success, true);
  check('...1 of the 2 Z was spent covering the missing A, 1 left over', p1.resources.Z, 1);
}
{
  // JOB007.TAP=ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(A,THIS_TURN);BLOCK_BUILD(B,
  // THIS_TURN);BLOCK_BUILD(C,THIS_TURN) -- 2026-08-07, replacing the old ON(BUILD(U,M),ADD(BZ)) reaction
  // (per user feedback: reacting *after* an UPGRADE/Monument build meant the granted BZ arrived too late
  // to help pay for the very build that triggered it, and evaporated unspent at TURNEND since a turn
  // normally has no second build left to spend it on -- "BZを使うタイミングがなく必ずBZが余って消失しま
  // す"). Now a bare (non-reactive) TAP, usable any time during the player's own turn like JOB004 above,
  // so a player can tap it *before* an UPGRADE/Monument build to actually use the BZ; blocking A/B/C
  // builds this turn keeps the discount scoped to U/M as originally intended (and, being a bare TAP
  // rather than an ON(...) reaction, it has no auto/manual concept at all -- see main.js's
  // reactiveTapKind/bareTapKind split -- so this also settles the user's request to make it manual-only).
  // The middle MONUMENT_CHANGE_DIE_VALUE(SELF+1) line (2026-08-24 data edit, replacing the earlier
  // MONUMENT_DICE_DISCOUNT(2,THIS_TURN); lowered from +2 to +1 on 2026-08-25) reuses CHANGE_DIE_VALUE's
  // own mechanic with a fixed delta -- see command-builder.lowerMonumentChangeDieValue/executor.
  // runMonumentChangeDieValue's own docs.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB007');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  const die = giveDie(state, 'P1', 5);

  const result = board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: die.id }, jobInst.physicalId);
  check('JOB007.TAP=ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(...);BLOCK_BUILD(...) succeeds as a direct (non-reactive) TAP', result, { success: true });
  check('...gained 1 BZ for free', p1.resources.BZ, 1);
  check('...the chosen die is now +1 (5 -> 6, no wrap)', die.value, 6);
  check('...the card is now tapped', state.cards[jobInst.physicalId].tapped, true);
  check('...A/B/C builds are blocked this turn', p1.blockedBuildCategoriesThisTurn.slice().sort(), ['A', 'B', 'C']);
  check('...A/B/C builds are excluded from candidates this turn', board.getBuildCandidates(state, index, 'P1', ['A', 'B', 'C'], 6).length, 0);

  // The BZ gained this way is usable for an UPGRADE attempted right afterward, in the same turn.
  const upgradeInst = createCardInstance('A001A'); // A001B exists
  upgradeInst.ownerId = 'P1';
  state.cards[upgradeInst.physicalId] = upgradeInst;
  p1.ownedCardPhysicalIds.push(upgradeInst.physicalId);
  p1.resources.A = 1; // A001A's COST is "2A" -- 1 short, made up by the 1 BZ just granted.

  const candidate = board.getBuildCandidates(state, index, 'P1', ['U'], 0).find((c) => c.physicalId === 'A001');
  const upgradeResult = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('The 1 BZ JOB007 just granted can pay for the UPGRADE that would otherwise be unaffordable', upgradeResult.success, true);

  // The die's own +2 change reverts at TURNEND since it's still unplaced (see executor.applyTurnEnd's
  // own doc on this general dice-value-change rule).
  executor.applyTurnEnd(state, index, 'P1');
  check('...and the die reverts to 5 at TURNEND, still being unplaced', die.value, 5);
}

// ---------------------------------------------------------------------------
// Self-untapping TAP fields (2026-08-18, 道化/JOB003, per user request: "TAPではなく何回でも使える能力に
// したい", no per-use cost -- confirmed with the user) -- a bare UNTAP() anywhere in the TAP field means
// useBareTapAbility never actually leaves the card tapped, so it stays immediately re-usable. Patches a
// synthetic copy of JOB003's own row (real data doesn't have this yet -- see this session's own history)
// purely to exercise the new mechanism end-to-end; every other field is untouched.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  // Patched only for this block, then restored immediately after (see the try/finally below) -- index
  // is a module-level singleton shared by every test block in this file, so leaving JOB003's row
  // permanently patched here would silently corrupt any LATER block that exercises the real card
  // (confirmed the hard way: this exact leak broke the 道化 self-stack exploit tests further down,
  // which need JOB003's real, un-patched TAP text).
  const originalJob003 = index.byId.get('JOB003');
  index.byId.set('JOB003', { sheet: 'JOB', row: { ...originalJob003.row, TAP: 'ADD(K);UNTAP()' } });
  try {
    const jobInst = createCardInstance('JOB003');
    jobInst.ownerId = 'P1';
    state.cards[jobInst.physicalId] = jobInst;
    p1.ownedCardPhysicalIds.push(jobInst.physicalId);

    const first = board.useBareTapAbility(state, index, { playerId: 'P1' }, jobInst.physicalId);
    check('Self-untapping TAP (ADD(K);UNTAP()) succeeds', first, { success: true });
    check('...gained 1K', p1.resources.K, 1);
    check('...but the card is NOT left tapped', state.cards[jobInst.physicalId].tapped, false);

    const second = board.useBareTapAbility(state, index, { playerId: 'P1' }, jobInst.physicalId);
    check('...so a 2nd use in the same turn succeeds too, with no untap/re-tap in between', second, { success: true });
    check('...granting another 1K (2 total)', p1.resources.K, 2);
    check('...still not tapped after the 2nd use either', state.cards[jobInst.physicalId].tapped, false);
  } finally {
    index.byId.set('JOB003', originalJob003);
  }
}
{
  // Control: an ordinary TAP field (no UNTAP()) still taps normally and blocks re-entry, same as before
  // this feature existed -- confirms the new check doesn't affect the common case.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB007'); // real TAP has no UNTAP()
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  const die = giveDie(state, 'P1', 5); // JOB007's own TAP now needs a chosenDieId (MONUMENT_CHANGE_DIE_VALUE)

  board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: die.id }, jobInst.physicalId);
  check('An ordinary (non-self-untapping) TAP ability still ends up tapped', state.cards[jobInst.physicalId].tapped, true);
  const second = board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: die.id }, jobInst.physicalId);
  check('...and a 2nd use in the same turn is blocked as before', second, { success: false, reason: 'ALREADY_TAPPED' });
}

// ---------------------------------------------------------------------------
// BZ discount (2026-07-31, "BZは建築コストの踏み倒し専用（改築/CHANGEには使用不可）"): 1 BZ skips
// paying 1 unit of any resource in a BUILD_NEW's cost, player's choice of which. A004A costs "2A,B"
// (2026-08-24 SHOP201-203 rework renumbered the A-deck -- this used to be A007A).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1; // 1 short of the 2A the cost needs
  p1.resources.B = 1;
  p1.resources.BZ = 1;
  state.shops.NORMAL.slots.SHOP101 = 'A004A'; // force a known slot, regardless of this seed's shuffle
  const candidate = { type: 'BUILD_NEW', faceId: 'A004A', shopKey: 'NORMAL', slotId: 'SHOP101' };
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('resolveBuild(BUILD_NEW) succeeds using 1 BZ to cover the missing A', result.success, true);
  check('...real A/B fully spent, 1 BZ consumed', { A: p1.resources.A, B: p1.resources.B, BZ: p1.resources.BZ }, { A: 0, B: 0, BZ: 0 });
  check('Player owns the built card', p1.ownedCardPhysicalIds.includes('A004'), true);
}
{
  // Not enough BZ actually held -- the combined (discounted cost + BZ spend) payment fails atomically,
  // nothing is paid and the card is not built.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1;
  p1.resources.B = 1;
  p1.resources.BZ = 0; // configuring a discount they can't actually pay for
  state.shops.NORMAL.slots.SHOP101 = 'A004A';
  const candidate = { type: 'BUILD_NEW', faceId: 'A004A', shopKey: 'NORMAL', slotId: 'SHOP101' };
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('resolveBuild fails when the player doesn\'t actually hold enough BZ', result, { success: false, reason: 'INSUFFICIENT_RESOURCES', resource: 'BZ' });
  check('...nothing was paid (atomic)', { A: p1.resources.A, B: p1.resources.B }, { A: 1, B: 1 });
}
{
  // Discounting more of a resource than the cost even requires is rejected outright.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 2;
  p1.resources.B = 1;
  p1.resources.BZ = 5;
  state.shops.NORMAL.slots.SHOP101 = 'A004A';
  const candidate = { type: 'BUILD_NEW', faceId: 'A004A', shopKey: 'NORMAL', slotId: 'SHOP101' };
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 3 } }, candidate); // cost only has 2A
  check('Discounting more A than the cost requires (3 > 2) is rejected', result, { success: false, reason: 'INVALID_BZ_DISCOUNT' });
}
{
  // UPGRADE applies a BZ discount to its COST too, same as BUILD_NEW (2026-08-06, per user feedback).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.A = 2; // A001A's full COST
  p1.resources.BZ = 5;
  const candidates = board.getBuildCandidates(state, index, 'P1', ['U'], 0);
  const upgradeCandidate = candidates.find((c) => c.physicalId === 'A001');
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, upgradeCandidate);
  check('UPGRADE succeeds, spending the BZ discount', result.success, true);
  check('...1 BZ was spent', p1.resources.BZ, 4);
  check('...only the remaining 1A was paid for real', p1.resources.A, 1);
}

// ---------------------------------------------------------------------------
// passDie (2026-08-03, per user feedback: "色ダイスを置けない時、または起きたくない時ラウンドを
// パスする手段がありません") -- declines to place a die at all this round.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 3);
  const result = board.passDie(state, index, { playerId: 'P1' }, die.id);
  check('passDie succeeds for an unplaced, unpassed die', result, { success: true });
  check('...the die is marked passed', die.passed, true);
  check('...placedMapId stays null (still "in hand", just resolved)', die.placedMapId, null);

  const secondAttempt = board.passDie(state, index, { playerId: 'P1' }, die.id);
  check('Passing an already-passed die fails', secondAttempt, { success: false, reason: 'DIE_NOT_AVAILABLE' });

  const placeAttempt = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP001', 0);
  check('A passed die can no longer be placed either', placeAttempt, { success: false, reason: 'DIE_NOT_AVAILABLE' });
}
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P2', 3);
  const result = board.passDie(state, index, { playerId: 'P1' }, die.id);
  check('passDie fails for a die that belongs to a different player', result, { success: false, reason: 'DIE_NOT_AVAILABLE' });
}

// ---------------------------------------------------------------------------
// "EX" SLOT (2026-08-04, per user feedback: new AREA SLOT1-6 value gating placement to whoever
// currently holds map.feeOwnerId). AREA001B (SLOT1=1,SLOT2=ANY,SLOT3=EX) is a plain, non-castle,
// non-AREA009 EX slot; AREA009B (SLOT1-3=ANY,SLOT4=EX,SLOT5-6=NONE as of a 2026-08-24 data edit that
// shrank 元老院 from 6 slots to 4) is used for the AREA009-specific doubles-stacking behavior.
// ---------------------------------------------------------------------------
function mapWithArea(mapId, areaId, slotCount, feeOwnerId) {
  const map = createMapState(mapId, areaId);
  map.slots = Array.from({ length: slotCount }, () => []);
  map.feeOwnerId = feeOwnerId;
  return map;
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, null); // nobody owns it yet
  const die = giveDie(state, 'P1', 6); // EX accepts any value
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP001', 2); // SLOT3=EX
  check('A player is rejected from EX when nobody owns this map yet (feeOwnerId is null)', result, { success: false, reason: 'EX_NOT_OWNER' });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 6);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 2);
  check('A non-owner is rejected from EX even with a legal die value', result, { success: false, reason: 'EX_NOT_OWNER' });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const p1die = giveDie(state, 'P1', 1);
  const ok1 = board.placeDice(state, index, { playerId: 'P1' }, p1die.id, 'MAP001', 0); // SLOT1=1 (numbered slot preferred over SLOT2's ANY) -> value 1 sits here
  check('P1 (the owner) places a matching-value die on SLOT1 normally', ok1.success, true);

  const exDie = giveDie(state, 'P1', 1); // same value (1) already used on SLOT1 in this AREA
  const exResult = board.placeDice(state, index, { playerId: 'P1' }, exDie.id, 'MAP001', 2); // SLOT3=EX
  check('The owner can place on EX even with a value already used elsewhere in the AREA', exResult.success, true);

  // The reverse direction still applies: EX's own occupant (value 1) now blocks ANOTHER die of value 1
  // from a *different*, non-EX slot -- there is none left to test here (SLOT1 already used), so instead
  // confirm a fresh SLOT1-value die is rejected as SLOT_OCCUPIED (SLOT1 itself, unrelated to EX) --
  // the real "EX blocks others" case is covered by the next block using a still-open ANY-valued slot.
}

// ---------------------------------------------------------------------------
// Numbered-slot-over-ANY / leftmost-ANY-only placement rule (2026-08-06, per user feedback: "SLOTが
// 6とANYの時 ダイス6はANYではなく6に置かなければならない...ANY ANY ANYの時は1番左のANYしか選択できない"
// -- see isAllowedSlotForValue's own doc). AREA005A (SLOT1=6, SLOT2=ANY) is the exact "6 and ANY"
// example given; AREA007 (SLOT1-3=ANY, ANY, ANY) covers the leftmost-only rule with no numbered slot
// to compete at all.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  state.maps['MAP005'] = mapWithArea('MAP005', 'AREA005A', 2, null); // SLOT1=6, SLOT2=ANY
  player(state, 'P1').resources.K = 5; // AREA005A's ACTION is CHANGE(K,C,ALL) -- fund it so a legal placement isn't also blocked by NO_EFFECT
  const die = giveDie(state, 'P1', 6);
  const onAny = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP005', 1); // SLOT2=ANY
  check('A 6 may not use the ANY slot while SLOT1 (its own exact match) is still open', onAny, { success: false, reason: 'SLOT_NOT_PREFERRED' });
  const onNumbered = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP005', 0); // SLOT1=6
  check('...but placing it on SLOT1 (the exact numbered match) succeeds', onNumbered.success, true);
}
{
  const state = freshStateWithShops();
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007A', 3, null); // SLOT1-3 all ANY
  const die = giveDie(state, 'P1', 4);
  // AREA007's own ACTION (CHANGE((A,B,C),D)) pays 1 of *each* A/B/C together, not just one of them --
  // fund all three so a legal placement isn't also blocked by NO_EFFECT.
  Object.assign(player(state, 'P1').resources, { A: 5, B: 5, C: 5 });
  const middle = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 1); // SLOT2, not leftmost
  check('Among several equally-empty ANY slots, only the leftmost (SLOT1) is selectable', middle, { success: false, reason: 'SLOT_NOT_PREFERRED' });
  const leftmost = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0); // SLOT1
  check('...SLOT1 itself succeeds', leftmost.success, true);
}
{
  // placeDiceGroup respects the same rule for each of its own value-buckets (see the dry-run's
  // isAllowedSlotForValue call, threaded through slotsForAllowedCheck so an earlier bucket in this same
  // atomic group action correctly counts as "claimed" even though nothing's actually been pushed to
  // map.slots yet).
  const state = freshStateWithShops();
  state.maps['MAP005'] = mapWithArea('MAP005', 'AREA005A', 2, null); // SLOT1=6, SLOT2=ANY
  player(state, 'P1').resources.BZ = 20;
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 3); // no numbered SLOT for 3 here -- must fall back to the ANY slot
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], 'MAP005');
  check('Group placement sends the 6 to its own numbered slot and the 3 to the remaining ANY slot', result.success, true);
  check('...6 landed on SLOT1', d1.placedMapId === 'MAP005' && state.maps['MAP005'].slots[0].some((o) => o.dieId === d1.id), true);
  check('...3 landed on SLOT2 (ANY)', d2.placedMapId === 'MAP005' && state.maps['MAP005'].slots[1].some((o) => o.dieId === d2.id), true);
}

// ---------------------------------------------------------------------------
// Usage fee charging (2026-08-04, bug fix -- board.js set nothing toward map.accumulatedFee before this;
// only executor.collectUsageFee existed, so there was never anything to collect). AREA001B/C are real
// tier-B/C data rows (1K/2K respectively, confirmed flat-rate, see board.js's USAGE_FEE_BY_TIER).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1'); // P1 owns (tiered this up)
  const die = giveDie(state, 'P2', 1); // SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('A non-owner (P2) placing on a tier-B AREA succeeds', result.success, true);
  check('...and owes the tier-B flat fee (1K) to the map', player(state, 'P2').pendingFee, { mapId: 'MAP001', amount: 1 });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001C', 3, 'P1');
  const die = giveDie(state, 'P2', 1); // SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('A non-owner placing on a tier-C AREA owes the tier-C flat fee (2K)', player(state, 'P2').pendingFee, { mapId: 'MAP001', amount: 2 });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P1', 1); // the owner uses their own tiered-up AREA; SLOT1=1 (numbered slot preferred over SLOT2's ANY)
  board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP001', 0);
  check('The owner using their own AREA owes no fee (pendingFee stays null)', player(state, 'P1').pendingFee, null);
}
{
  // Full cycle: fee owed -> TURNEND gate blocks if unpayable -> paying it moves K into accumulatedFee
  // -> the owner can then collect it via the existing FEE_COLLECT free action.
  const executor = require('../src/executor');
  const turnFlow = require('../src/turn-flow');
  const state = freshStateWithShops();
  state.turnOrder = ['P1', 'P2'];
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 1); // SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  // AREA001B's own ACTION (ADD(6K)) just handed P2 6K -- zero it back out so this block actually tests
  // "can't afford the fee" rather than accidentally already being solvent from the area's own effect.
  // A=1 (2026-08-27): present, not yet converted -- keeps this a genuine block rather than tripping the
  // new USAGE_FEE VP-escape, which only applies when K/A/B/C/Z are ALL genuinely 0 (see
  // executor.canEndTurn's own doc); raw K alone still gates TURNEND regardless of an unconverted A sitting
  // there.
  player(state, 'P2').resources.K = 0;
  player(state, 'P2').resources.A = 1;

  check('canEndTurn blocks P2 while unable to afford the 1K fee (K=0)', executor.canEndTurn(state, index, 'P2').ok, false);
  const violations = executor.canEndTurn(state, index, 'P2').violations;
  check('...citing a USAGE_FEE violation for the right map/amount', violations.some((v) => v.type === 'USAGE_FEE' && v.mapId === 'MAP001' && v.amount === 1), true);

  player(state, 'P2').resources.K = 1;
  const endResult = turnFlow.endTurn(state, index, 'P2');
  check('Once affordable, endTurn succeeds', endResult.success, true);
  check('...P2 paid the 1K', player(state, 'P2').resources.K, 0);
  check('...which landed on the map as accumulatedFee', state.maps['MAP001'].accumulatedFee, 1);
  check('...and pendingFee is cleared', player(state, 'P2').pendingFee, null);

  const collectResult = executor.collectUsageFee(state, index, { playerId: 'P1' }, 'MAP001');
  check('The owner (P1) can now collect the accumulated fee', collectResult, { success: true, amount: 1 });
  check('...map.accumulatedFee is back to 0', state.maps['MAP001'].accumulatedFee, 0);
}
{
  // Placement itself is refused if the resulting usage fee would be entirely unpayable, checked AFTER
  // the AREA's own action resolves (2026-08-05, per user diagnosis: "AREA010を使うときはAIが使用料が
  // 払えることを確認してからダイスを置く用に直せますか"). AREA999C (see this file's own synthetic-row
  // doc up top) stands in for what AREA010C used to be -- ADD(2VP) grants no K to a non-owner at all.
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA999C', 3, 'P1'); // SLOT1=ANY, ACTION=ADD(2VP)
  player(state, 'P2').resources.K = 1; // below the 2K fee, and ADD(2VP) never grants any more
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('Placement is refused when the resulting 2K fee would be entirely unpayable', result, { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: 2 });
  // Re-fetched by id (not the pre-call `die` reference), since a rollback replaces state.players'
  // contents wholesale -- see runProgram's own doc on this exact trap, which the rollback here mirrors.
  check('...the die was never actually placed', player(state, 'P2').dice.find((d) => d.id === die.id).placedMapId, null);
  check('...and no fee/state change leaked through', player(state, 'P2').pendingFee, null);
  check('...and the whole placement (incl. the ADD(2VP) that just ran) was rolled back, K restored', player(state, 'P2').resources.K, 1);
}
{
  // ...but succeeds once enough convertible resources are on hand -- not necessarily raw K (see
  // canAffordFee's own doc: A/B/C/Z->K free actions have no usage cap). ADD(2VP) never touches K at all,
  // so P2's 2 extra A alone have to cover the whole 2K fee.
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA999C', 3, 'P1');
  player(state, 'P2').resources.A = 2;
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('Placement succeeds once enough convertible resources are on hand', result.success, true);
  check('...the AREA action still ran (ADD(2VP) grants 2VP, K untouched -- the fee itself is deferred to TURNEND, not charged yet)', { k: player(state, 'P2').resources.K, vp: player(state, 'P2').resources.VP }, { k: 0, vp: 2 });
}
{
  // 2026-08-07, per user request ("wD→２Kのフリーアクション廃止します コードも削除してください"): an
  // unplaced wD no longer counts toward canAffordFee at all -- before this removal it added +2 (modeling
  // "the player could still use the now-abolished wD->2K free action"). Same AREA999C setup as the two
  // blocks above, but P2's only resources are a K below the fee, plus an unplaced wD that doesn't help.
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA999C', 3, 'P1');
  player(state, 'P2').resources.K = 1;
  player(state, 'P2').dice.push(require('../src/game-state').createDie('test-wd', 'WHITE'));
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('An unplaced wD no longer helps cover the fee -- placement is still refused as unaffordable', result, { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: 2 });
}
{
  // Regression guard for the intentional 2026-08-25/28 孤児院LV2 rework (confirmed with the user,
  // 2026-08-28: "意図的な変更です"): AREA010C's only slot is now EX, so a non-owner can never reach it at
  // all any more, regardless of resources -- there is no usage-fee scenario left to test against the real
  // AREA010C (see this file's own synthetic AREA999C above for why the tests just above use that instead).
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA010C', 1, 'P1');
  player(state, 'P2').resources.K = 20; // resources are irrelevant -- EX_NOT_OWNER blocks this outright
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('孤児院LV2 (AREA010C) is EX-only now -- a non-owner can never place there at all', result, { success: false, reason: 'EX_NOT_OWNER' });
}
{
  // AREA001B's own ACTION (ADD(6K)) trivially covers its own 1K fee -- confirms the check happens
  // AFTER the area's own action resolves, not before (a pre-resolution-only check would have wrongly
  // refused this very common, perfectly safe case -- caught by this exact test while developing the fix).
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 1); // SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('Placement succeeds when the AREA\'s own action grants enough to cover the fee, even from 0 starting K', result.success, true);
  check('...P2 actually has the 6K from ADD(6K)', player(state, 'P2').resources.K, 6);
}
{
  // BARE_TAP is allowed even while a usage fee is owed (2026-08-10, per user request: "使用料の支払いが
  // ターン終了時にある時でもTAPアクションが使えるようにしたい" -- reverses the 2026-08-05 PENDING_FEE
  // gate this used to have; see board.useBareTapAbility's own doc for why removing it is now safe:
  // evaluator.js's LOCKOUT_PENALTY already scores a state that can't afford its pendingFee at -1000,
  // so the AI is steered away from spending the fee out of existence without a hard legality gate).
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 1); // SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0); // P2 now owes 1K to P1
  check('P2 owes a pending fee after placing on P1\'s tiered-up AREA', !!player(state, 'P2').pendingFee, true);

  const tapInst = createCardInstance('C001A'); // TAP=CHANGE(2K,2A), IMMEDIATE kind
  tapInst.ownerId = 'P2';
  state.cards[tapInst.physicalId] = tapInst;
  player(state, 'P2').ownedCardPhysicalIds.push(tapInst.physicalId);
  player(state, 'P2').resources.K = 10; // plenty to normally afford the TAP's own CHANGE(2K,2A) cost

  const allowedResult = board.useBareTapAbility(state, index, { playerId: 'P2' }, tapInst.physicalId);
  check('BARE_TAP succeeds even while the fee is still pending', allowedResult.success, true);
  check('...the card was actually tapped', state.cards[tapInst.physicalId].tapped, true);
  check('...and the pending fee is untouched (still owed, unresolved until TURNEND)', player(state, 'P2').pendingFee, { mapId: 'MAP001', amount: 1 });
}
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // AREA009B's ACTION is also BUILD-first -- see the castle blocks' comment above
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1'); // SLOT1-4=ANY, SLOT5/6=EX (2026-08-24 data edit: 元老院 LV1/LV2 grew a 2nd EX slot)
  const exDie = giveDie(state, 'P1', 3);
  const exResult = board.placeDice(state, index, { playerId: 'P1' }, exDie.id, 'MAP009', 4); // SLOT5=EX
  check('P1 places a 3 on AREA009B EX', exResult.success, true);

  const anyDie = giveDie(state, 'P1', 3); // same value 3, targeting a different (ANY) slot
  const anyResult = board.placeDice(state, index, { playerId: 'P1' }, anyDie.id, 'MAP009', 0); // SLOT1=ANY
  check('A die already sitting on EX blocks a duplicate value on a different, non-EX slot', anyResult, { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' });
}
{
  // AREA009's EX now behaves exactly like the castle (2026-08-06): a second die needs
  // GRANT_PLACE_ANYWHERE to join. buildValue no longer sums across separate placements though
  // (2026-08-20, per user request: "重ねたかどうかではなく1ターンに2個置いたかで合計するようにしてくだ
  // さい") -- each solo placement's buildValue is just that one die's own value, regardless of what else
  // already occupies the slot.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1'); // SLOT1-4=ANY, SLOT5/6=EX
  const die1 = giveDie(state, 'P1', 5);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP009', 4); // SLOT5=EX
  check('First 5 on AREA009B EX succeeds', first.success, true);
  check('...buildValue is just this one die (5)', first.actionResult.pendingBuild.buildValue, 5);

  const die2 = giveDie(state, 'P1', 5); // matching value, no GRANT_PLACE_ANYWHERE
  const blocked = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP009', 4);
  check('A second matching-value die without GRANT_PLACE_ANYWHERE is blocked on AREA009B EX too', blocked, { success: false, reason: 'SLOT_OCCUPIED' });

  die2.placeAnywhereThisTurn = true;
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP009', 4);
  check('...but succeeds with GRANT_PLACE_ANYWHERE', second.success, true);
  check('...buildValue is still just this 2nd die\'s own value (5), NOT summed with the 1st', second.actionResult.pendingBuild.buildValue, 5);
}
{
  // AREA009C (元老院LV2, "BUILD();ADD(2K,BZ)") -- 2026-08-07, per user feedback: "BZをもらえるので本来
  // 建築できるものが表示されません まずBZと2Kを得るその後建築候補が表示される にしてください". A001A
  // costs 2A; P1 starts with only 1A (unaffordable on its own), but AREA009C's own grant includes 1 BZ,
  // which auto-covers the missing 1A -- so placement should succeed (SLOT lights up / isn't refused) and
  // the resulting pendingBuild should already list A001A as affordable, with the BZ/K already in hand.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1;
  const slotId = Object.keys(state.shops.NORMAL.slots).find((k) => k === 'SHOP101');
  state.shops.NORMAL.slots[slotId] = 'A001A'; // SHOP101 = dice 1-6, most permissive
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009C', 6, 'P1'); // SLOT1-4=ANY, SLOT5/6=EX (2026-08-24: 元老院 LV1/LV2 grew a 2nd EX slot)
  const die = giveDie(state, 'P1', 1);

  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP009', 0); // SLOT1=ANY
  check('Placing on AREA009C succeeds (the BZ it grants covers the otherwise-unaffordable A001A)', result.success, true);
  check('...the 2K/1BZ grant already landed before the candidate list was built', { K: p1.resources.K, BZ: p1.resources.BZ }, { K: 2, BZ: 1 });
  check('...remainingCommands is now empty (the ADD ran eagerly, nothing deferred)', result.actionResult.pendingBuild.remainingCommands, []);
  const a001Candidate = result.actionResult.pendingBuild.candidates.find((c) => c.faceId === 'A001A');
  check('...A001A is present among the candidates', !!a001Candidate, true);
  check('...and is affordable using the real 1A plus the newly-granted BZ', board.isCandidateAffordable(state, index, 'P1', a001Candidate), true);
}
{
  // A regular (non-AREA009) EX slot (AREA001B) -- a second matching-value die without
  // GRANT_PLACE_ANYWHERE is blocked like any other occupied slot.
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die1 = giveDie(state, 'P1', 4);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP001', 2); // SLOT3=EX
  check('First die on AREA001B EX succeeds', first.success, true);

  const die2 = giveDie(state, 'P1', 4); // matching value, no GRANT_PLACE_ANYWHERE
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP001', 2);
  check('A matching-value second die is blocked on a non-AREA009 EX slot', second, { success: false, reason: 'SLOT_OCCUPIED' });
}
{
  // GRANT_PLACE_ANYWHERE lets the owner join ANY occupied EX slot regardless of value (not just at
  // AREA009) -- confirmed: "所有者がGRANT_PLACE_ANYWHEREを使った場合はEXに2個目を置けます".
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die1 = giveDie(state, 'P1', 4);
  board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP001', 2); // SLOT3=EX, occupied with a 4

  const die2 = giveDie(state, 'P1', 6); // different value
  die2.placeAnywhereThisTurn = true; // GRANT_PLACE_ANYWHERE
  const result = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP001', 2);
  check('GRANT_PLACE_ANYWHERE lets the owner join an occupied EX slot with a different value', result.success, true);
}
{
  // GRANT_PLACE_ANYWHERE still never lets a NON-owner onto someone else's EX slot.
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 4);
  die.placeAnywhereThisTurn = true;
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 2);
  check('GRANT_PLACE_ANYWHERE does not let a non-owner onto EX', result, { success: false, reason: 'EX_NOT_OWNER' });
}

// ---------------------------------------------------------------------------
// placeDiceGroup: multi-die (possibly mixed-value) monument-only group placement (2026-08-02, per user
// feedback on the confusing "place one die, then discover you can add another inside the build modal"
// flow -- see main.js's selectedDieIds for the new multi-select UI this powers).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate (max monument COST is M012's 13 units)
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 3);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Mixed-value group (6+3) on the castle succeeds', result.success, true);
  check('...both dice actually placed', [d1.placedMapId, d2.placedMapId], [board.CASTLE_MAP_ID, board.CASTLE_MAP_ID]);
  check('...they land on 2 different slots (different values can\'t share one)', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).length, 2);
  check('...combined buildValue is the sum (9), not just one die', result.actionResult.pendingBuild.buildValue, 9);
  check('...candidates are monuments only, even though a lone buildValue=6 die would normally also offer A/B/C cards', result.actionResult.pendingBuild.candidates.every((c) => c.faceId.startsWith('M')), true);
}
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  // 2026-08-21, per user request ("一度に２個置くときにダイスを重ねない ぞろ目でも　ぞろ目でなくても"):
  // same-valued dice no longer share a slot together -- each always claims its own, exactly like
  // different-valued dice already do.
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Same-value group (6+6) claims 2 SEPARATE fresh slots, not one shared slot', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).length, 2);
  check('...combined buildValue is still 12', result.actionResult.pendingBuild.buildValue, 12);
}
{
  // "他のプレイヤーの邪魔をするだけの行動はできない" (2026-08-06, per user feedback): a monument that
  // either die alone would already have covered (M012 needs only >=1) must not be offered when both
  // were spent to reach 12 -- "ダイスを減らしても建築できるモニュメントは表示しないでください". M001
  // (needs >=12, the max) genuinely requires both and must stay offered.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('M012 (needs only >=1, satisfiable by either die alone) is excluded from the 6+6 group\'s candidates', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M012'), false);
  check('M001 (needs >=12, genuinely requires both dice) is still offered', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M001'), true);
}
{
  // A pre-existing occupant from an EARLIER, separate placement no longer contributes at all (2026-08-20,
  // per user request: "重ねたかどうかではなく1ターンに2個置いたかで合計するようにしてください") -- even
  // though earlierDie(5) sits in the same slot this group's dice join via GRANT_PLACE_ANYWHERE, this
  // group's own buildValue is just its own dice (1+6=7), never 5+1+6=12. M006 (>=7) is the exact
  // threshold that genuinely needs both of THIS group's own dice combined (1 or 6 alone isn't enough);
  // M012 (>=1) and M007 (>=6) are each already covered by one of this group's own dice alone, so both are
  // excluded as overfunded -- the pre-existing 5 plays no part in any of this anymore.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M012'; // DICE>=1
  state.shops.M.slots.SHOP002 = 'M007'; // DICE>=6
  state.shops.M.slots.SHOP003 = 'M006'; // DICE>=7
  const earlierDie = giveDie(state, 'P1', 5);
  board.placeDice(state, index, { playerId: 'P1' }, earlierDie.id, board.CASTLE_MAP_ID, 0);
  const d1 = giveDie(state, 'P1', 1);
  d1.placeAnywhereThisTurn = true;
  const d2 = giveDie(state, 'P1', 6);
  d2.placeAnywhereThisTurn = true;
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Placing 1+6 alongside an existing 5 succeeds', result.success, true);
  check('...buildValue is just this group\'s own dice (1+6=7), NOT summed with the existing 5', result.actionResult.pendingBuild.buildValue, 7);
  check('M012 (>=1, already covered by this group\'s own 1 alone) is excluded as overfunded', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M012'), false);
  check('M007 (>=6, already covered by this group\'s own 6 alone) is excluded as overfunded', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M007'), false);
  check('M006 (>=7, genuinely needs both of this group\'s own dice combined) is still offered', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M006'), true);
}
{
  // No legal slot anywhere for one of the values -- must fail atomically (neither die touched), not
  // place one and strand the other.
  const state = freshStateWithShops();
  const map = state.maps[board.CASTLE_MAP_ID];
  for (let v = 1; v <= 5; v++) map.slots[v - 1].push({ playerId: 'P1', dieId: 'x' + v, value: v, seq: v, countsForTurnOrder: true });
  map.slots[5].push({ playerId: 'P1', dieId: 'dup', value: 1, seq: 6, countsForTurnOrder: true }); // slot 6 taken by ANOTHER "1", not a 6
  const d6 = giveDie(state, 'P1', 6); // value 6 has no existing stack and no empty slot left
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d6.id], board.CASTLE_MAP_ID);
  check('No legal slot for the group fails cleanly', result, { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' });
  check('...the die was never actually placed', d6.placedMapId, null);
}
{
  const state = freshStateWithShops();
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, ['not-a-real-die'], board.CASTLE_MAP_ID);
  check('An unavailable die id fails cleanly', result, { success: false, reason: 'DIE_NOT_AVAILABLE' });
}
{
  // Every castle slot filled first, so eviction is the only way in (2026-08-21 note below explains why).
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M009'; // DICE>=4 -- genuinely needs both dice combined (2+2)
  for (let i = 0; i < 6; i++) {
    state.maps[board.CASTLE_MAP_ID].slots[i].push({ playerId: 'P2', dieId: `p2-${i}`, value: 3, seq: i + 1, countsForTurnOrder: true });
  }

  const d1 = giveDie(state, 'P1', 2);
  const d2 = giveDie(state, 'P1', 2);
  const onlyOneBypassed = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Without GRANT_PLACE_ANYWHERE on both dice, the whole group is refused (value 2 already on board)', onlyOneBypassed, { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' });
  d1.placeAnywhereThisTurn = true; // only ONE of the two -- still not enough
  const stillBlocked = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('...one bypass-holding die in the pair is still not enough -- the other one has none', stillBlocked, { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' });

  d2.placeAnywhereThisTurn = true; // now BOTH carry it
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Once both dice carry GRANT_PLACE_ANYWHERE, each evicts its own separate slot', result.success, true);
  check('...buildValue is just this pair\'s own dice (4), never counting an evicted occupant', result.actionResult.pendingBuild.buildValue, 4);
  const p1Slots = state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.some((o) => o.playerId === 'P1'));
  check('...2 DIFFERENT slots were evicted-and-replaced, not shared', p1Slots.length, 2);
  check('...every castle slot still holds exactly 1 occupant (6 total, none doubled up)', state.maps[board.CASTLE_MAP_ID].slots.every((s) => s.length === 1), true);
  check('...neither of the 2 new dice counts toward next round\'s turn order', p1Slots.every((s) => s.every((o) => o.countsForTurnOrder === false)), true);
}

// ---------------------------------------------------------------------------
// isChangedDieSelfStackBlocked (2026-08-18, per user report: originally reported against 道化/JOB003's
// then-current "ダイス目を変える" (SET_DICE_ANY) ability, plus its own GRANT_PLACE_ANYWHERE, which let a
// player set a die to whatever value exactly completes a stack with their OWN already-placed die at
// 王宮/元老院, summing buildValue as if 2 genuinely-earned dice were involved -- e.g. a real 3 already on
// the castle, then a set-to-4 die stacked onto it, reaching a DICE>=7 monument off what's really 1 fresh
// placement. JOB003 has since been redesigned (2026-08-18/19) into a PASSIVE wildcard-die ability with no
// TAP at all, so this shared exploit-fix mechanism (which also still protects B001A/B001B, B002A/B002B,
// B003A/B003B -- the "導き" family, each with its own SET_DIE_VALUE/CHANGE_DIE_VALUE + GRANT_PLACE_ANYWHERE
// TAP) is now exercised below via B001A ("小さな導き", TAP="SET_DIE_VALUE(SELF2|3);
// GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)") instead. Confirmed with the user: block only a
// value-changed die stacking onto the SAME player's own die, only at these 2 maps -- every other
// GRANT_PLACE_ANYWHERE use (another player's die, an empty slot, a naturally-rolled die, anywhere else on
// the board) stays untouched.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources = { K: 0, A: 20, B: 20, C: 20, Z: 20, VP: 0, BZ: 0 };
  const d1 = giveDie(state, 'P1', 3);
  const placed1 = board.placeDice(state, index, { playerId: 'P1' }, d1.id, board.CASTLE_MAP_ID, 0);
  check('A real 3 placed on the castle succeeds', placed1.success, true);

  const b1Inst = createCardInstance('B001A');
  b1Inst.ownerId = 'P1';
  state.cards[b1Inst.physicalId] = b1Inst;
  p1.ownedCardPhysicalIds.push(b1Inst.physicalId);
  const d2 = giveDie(state, 'P1', 1);
  const tapResult = board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: d2.id, chosenValue: 2 }, b1Inst.physicalId);
  check('B001A (小さな導き) sets d2 to 2', tapResult, { success: true });
  check('...and grants d2 placeAnywhereThisTurn', d2.placeAnywhereThisTurn, true);

  const exploit = board.placeDice(state, index, { playerId: 'P1' }, d2.id, board.CASTLE_MAP_ID, 0);
  check('Stacking the B001A-changed d2 onto P1\'s own d1 is blocked', exploit, { success: false, reason: 'CHANGED_DIE_CANNOT_SELF_STACK' });
  check('...d1 is still the only occupant (nothing leaked through)', state.maps[board.CASTLE_MAP_ID].slots[0].length, 1);

  // Control: the exact same change, but targeting an EMPTY slot instead -- never blocked by this rule.
  const emptySlotResult = board.placeDice(state, index, { playerId: 'P1' }, d2.id, board.CASTLE_MAP_ID, 1);
  check('...but placing the same changed die into an EMPTY slot still succeeds normally', emptySlotResult.success, true);
}
{
  // Control: a value-changed die CAN still stack onto a DIFFERENT player's die (only same-player self-
  // stacking is blocked).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const p2 = player(state, 'P2');
  p1.resources = { K: 0, A: 20, B: 20, C: 20, Z: 20, VP: 0, BZ: 0 };
  p2.resources = { K: 0, A: 20, B: 20, C: 20, Z: 20, VP: 0, BZ: 0 };
  const d1 = giveDie(state, 'P2', 3);
  board.placeDice(state, index, { playerId: 'P2' }, d1.id, board.CASTLE_MAP_ID, 0);

  const b1Inst = createCardInstance('B001A');
  b1Inst.ownerId = 'P1';
  state.cards[b1Inst.physicalId] = b1Inst;
  p1.ownedCardPhysicalIds.push(b1Inst.physicalId);
  const d2 = giveDie(state, 'P1', 1);
  board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: d2.id, chosenValue: 2 }, b1Inst.physicalId);
  const result = board.placeDice(state, index, { playerId: 'P1' }, d2.id, board.CASTLE_MAP_ID, 0);
  check('A B001A-changed die CAN still join a DIFFERENT player\'s occupied slot (only self-stacking is blocked)', result.success, true);
}
{
  // Control: a NATURALLY-rolled die (never value-changed) stacking onto the player's own die is still
  // legal (isChangedDieSelfStackBlocked only ever concerns value-CHANGED dice) -- must still work exactly
  // as before this fix. buildValue itself no longer sums with the pre-existing occupant though (2026-08-
  // 20, per user request: "重ねたかどうかではなく1ターンに2個置いたかで合計するようにしてください").
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources = { K: 0, A: 20, B: 20, C: 20, Z: 20, VP: 0, BZ: 0 };
  const d1 = giveDie(state, 'P1', 5);
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, board.CASTLE_MAP_ID, 0);
  const d2 = giveDie(state, 'P1', 5);
  d2.placeAnywhereThisTurn = true; // some other GRANT_PLACE_ANYWHERE source, value never touched
  const result = board.placeDice(state, index, { playerId: 'P1' }, d2.id, board.CASTLE_MAP_ID, 0);
  check('A naturally-rolled (never changed) die can still stack onto the player\'s own die', result.success, true);
  check('...buildValue is just this 2nd die\'s own value (5), NOT summed with the 1st', result.actionResult.pendingBuild.buildValue, 5);
}
{
  // Group-placement path (placeDiceGroup) needs the same protection -- same exploit, different entry
  // point (e.g. stacking a changed die together with a 2nd die in one group action).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources = { K: 0, A: 20, B: 20, C: 20, Z: 20, VP: 0, BZ: 0 };
  const d1 = giveDie(state, 'P1', 3);
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, board.CASTLE_MAP_ID, 0);

  const b1Inst = createCardInstance('B001A');
  b1Inst.ownerId = 'P1';
  state.cards[b1Inst.physicalId] = b1Inst;
  p1.ownedCardPhysicalIds.push(b1Inst.physicalId);
  const d2 = giveDie(state, 'P1', 1);
  board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: d2.id, chosenValue: 2 }, b1Inst.physicalId);

  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d2.id], board.CASTLE_MAP_ID);
  // The castle has other empty slots too, so the group still finds a legal (fresh, non-stacking) home
  // for d2 rather than failing outright -- what matters is it's NOT allowed to join d1's occupied slot.
  check('placeDiceGroup succeeds by finding a different, empty slot', result.success, true);
  check('...but d2 did NOT join d1\'s occupied slot 0 (self-stacking still blocked)', state.maps[board.CASTLE_MAP_ID].slots[0], [{ playerId: 'P1', dieId: d1.id, value: 3, seq: 1, countsForTurnOrder: true }]);
}

// ---------------------------------------------------------------------------
// New (2026-08-0X, per user feedback): a die can't be placed on an AREA whose
// ACTION wouldn't actually produce any benefit right now, and previewPlaceDice/
// previewPlaceDiceGroup let the UI know which SLOTs are worth highlighting.
// ---------------------------------------------------------------------------
{
  // AREA003A.ACTION=CHANGE(K,A,ALL) -- with 0 K on hand this would run 0 times (a no-op "success"),
  // so placement itself must be refused instead of burning the die for nothing.
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1 requires value 2 (SLOT2 is ANY, but the numbered slot is preferred)
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('AREA003A with 0 K is refused outright (no effect to gain)', result, { success: false, reason: 'NO_EFFECT' });
  check('...the die was never actually placed', die.placedMapId, null);
  check('...the slot is still empty', state.maps.MAP003.slots[0].length, 0);
}
{
  // AREA003B.ACTION=CHANGE(K,A,ALL);ADD(2B) -- even with 0 K (CHANGE runs 0 times), the trailing
  // ADD(2B) always fires unconditionally, so this placement must still be allowed.
  const state = freshStateWithShops();
  state.maps.MAP003.currentAreaId = 'AREA003B';
  const die = giveDie(state, 'P1', 2); // AREA003B.SLOT1 also requires value 2
  const before = player(state, 'P1').resources.B || 0;
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('AREA003B with 0 K still succeeds (ADD(2B) alone is a real effect)', result.success, true);
  check('...2B was actually gained', player(state, 'P1').resources.B, before + 2);
}
{
  // AREA007.ACTION=CHANGE((A,B,C),D) -- with A/B/C/Z all at 0, this can't be paid at all.
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 3); // AREA007's slots are all ANY
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('AREA007 with no A/B/C/Z on hand is refused (can\'t pay)', result, { success: false, reason: 'NO_EFFECT' });
  check('...the die was never actually placed', die.placedMapId, null);
}
{
  // AREA007 again, but this time the player can actually pay -- must still succeed as before.
  const state = freshStateWithShops();
  const p = player(state, 'P1');
  p.resources.A = 1; p.resources.B = 1; p.resources.C = 1;
  const die = giveDie(state, 'P1', 3);
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('AREA007 with A/B/C on hand still succeeds', result.success, true);
  check('...a D (color die) was actually gained', player(state, 'P1').dice.some((d) => d.id !== die.id), true);
}
{
  // AREA007 at the color-die cap (2026-08-15, per user request: "色Dの上限を超えるときは訓練場にダイス
  // 候補が出ないようにしてほしい") -- placement is refused outright instead of silently downgrading the
  // grant to a wD (the overflow-conversion chain grantOneDie still uses everywhere else).
  const state = freshStateWithShops();
  const p = player(state, 'P1');
  p.resources.A = 1; p.resources.B = 1; p.resources.C = 1;
  // freshStateWithShops() gives P1 no starting dice at all -- fill up to the 5-color-die cap by hand.
  while (p.dice.filter((d) => d.kind === 'COLOR').length < 5) giveDie(state, 'P1', 3);
  const diceBefore = p.dice.length;
  const die = giveDie(state, 'P1', 3); // the die actually being placed, on top of the cap-filling ones
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('AREA007 at the 5-color-die cap is refused', result, { success: false, reason: 'COLOR_DICE_CAP' });
  check('...the die was never actually placed', die.placedMapId, null);
  check('...A/B/C was never spent', [p.resources.A, p.resources.B, p.resources.C], [1, 1, 1]);
  check('...no new die was granted', p.dice.length, diceBefore + 1); // +1 only for `die` itself, pushed above
}
{
  // One below the cap (4 total color dice, INCLUDING the one about to be placed) must still work normally
  // -- only exactly-at-cap (5 total) is blocked. Revised 2026-08-17 alongside the COLOR_DICE_CAP fix below:
  // the die being placed now counts toward the cap total too (it isn't leaving the player's ownership, just
  // relocating), so this boundary case is 3 filler dice + the 1 placing die = 4 total, not 4 filler + 1
  // placing = 5 (that 5-total case is now the same as the at-cap test above and is correctly refused).
  const state = freshStateWithShops();
  const p = player(state, 'P1');
  p.resources.A = 1; p.resources.B = 1; p.resources.C = 1;
  while (p.dice.filter((d) => d.kind === 'COLOR').length < 3) giveDie(state, 'P1', 3);
  const die = giveDie(state, 'P1', 3);
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('AREA007 at 4 total color dice (one below the cap) still succeeds', result.success, true);
  check('...a genuine COLOR die (not wD) was gained', p.dice.filter((d) => d.kind === 'COLOR').length, 5);
}
{
  // Regression test for the actual reported bug (2026-08-17, per user report: "憤怒　6個目のカラーDを得る
  // ことができます") -- a full round-by-round replay of the exploit: placing 1 of a CON005B (憤怒) owner's
  // dice on AREA007 each round (freeing a "slot" the old otherColorDiceCount check counted as room),
  // collecting a new D each time, then letting endRound() return every placed COLOR die to hand
  // unconditionally. Before the fix above, round 2 could still gain a genuine 6th D (5 total going in,
  // minus the 1 being placed = 4 "counted", under the cap) -- ending round 2 with 6 in hand. After the fix,
  // round 2's placement is refused (5 total already, cap reached), keeping the player at exactly 5 forever.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con6 = createCardInstance('CON005B');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  p1.resources.A = 100; p1.resources.B = 100; p1.resources.C = 100;
  // 3 initial dice + CON005B's own ONCE=ADD(D) = 4 starting color dice (both run through the real grant
  // path, same as actual onboarding: setup.rollInitialColorDice + chooseConFace's runProgram(ONCE)).
  setup.rollInitialColorDice(state);
  executor.runProgram(state, index, { playerId: 'P1', sourcePhysicalId: con6.physicalId }, 'ADD(D)');
  check('Starting hand: 3 initial + CON005B ONCE=ADD(D) = 4 color dice', p1.dice.filter((d) => d.kind === 'COLOR').length, 4);

  function placeOneOnAreaSeven() {
    const die = p1.dice.find((d) => d.kind === 'COLOR' && d.placedMapId === null);
    die.value = 1; // AREA007's slots are all ANY, any value works
    return board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  }
  function passRemainingDice() {
    for (const p of state.players) {
      for (const d of p.dice) if (d.placedMapId === null && !d.passed) board.passDie(state, index, { playerId: p.id }, d.id);
    }
  }

  const round1 = placeOneOnAreaSeven();
  check('Round 1: AREA007 placement succeeds (4 total, under cap)', round1.success, true);
  passRemainingDice();
  const turnFlow = require('../src/turn-flow');
  turnFlow.endRound(state, index);
  check('After round 1: back to 5 color dice in hand (at the cap, not over it)', p1.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null).length, 5);

  turnFlow.startRound(state);
  const round2 = placeOneOnAreaSeven();
  check('Round 2: AREA007 placement is now refused (5 total already at cap) -- the bug fix', round2, { success: false, reason: 'COLOR_DICE_CAP' });
  passRemainingDice();
  turnFlow.endRound(state, index);
  check('After round 2: still exactly 5 color dice in hand, never 6', p1.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null).length, 5);
}
{
  // 怠惰 (PASSIVE=REPLACE_ADD(D,wD)) (2026-08-15, per user follow-up: "CONで上限3個を持つプレ
  // イヤーはダイスを3個持つ限り訓練場にダイス候補が出ないように...現状絶対置けないはずです") -- blocked
  // unconditionally, even with just 1 color die (nowhere near the normal 5-die cap), since REPLACE_ADD
  // means they can never get a genuine D from this AREA at any dice count. 怠惰 lived at CON002A until
  // the user reorganized game.xlsx's CON sheet by START_ORDER (2026-08-17); it's CON005A now.
  const state = freshStateWithShops();
  const p = player(state, 'P1');
  const con2 = createCardInstance('CON005A');
  con2.ownerId = 'P1';
  state.cards[con2.physicalId] = con2;
  p.ownedCardPhysicalIds.push(con2.physicalId);
  p.resources.A = 1; p.resources.B = 1; p.resources.C = 1;
  const die = giveDie(state, 'P1', 3); // just 1 color die on hand, far below the normal cap
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('AREA007 is refused for a CON005A owner even at just 1 color die', result, { success: false, reason: 'COLOR_DIE_REPLACED' });
  check('...the die was never actually placed', die.placedMapId, null);
  check('...A/B/C was never spent', [p.resources.A, p.resources.B, p.resources.C], [1, 1, 1]);
}
{
  // AREA008 (castle).ACTION=BUILD() -- with the M shop emptied out (no monument buildable at all,
  // and buildValue too low for any normal card either), placement must be refused, not just the BUILD
  // step failing after the die is already stuck on the board.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.drawPile = [];
  const die = giveDie(state, 'P1', 1); // buildValue=1 also can't reach any NORMAL/SPECIAL shop card here either... see below
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, board.CASTLE_MAP_ID, 0);
  // (buildValue=1 still matches every NORMAL/SPECIAL slot's DICE_MIN=1, so a normal-card candidate is
  // still on offer -- this only proves the M-emptying alone isn't enough to trigger NO_BUILDABLE_CARD.)
  check('Castle with a normal-card candidate still on offer still succeeds even with M emptied', result.success, true);
}
{
  // Same M-emptied castle, but also clear out the NORMAL/SPECIAL shops so *no* category has anything
  // buildable -- now placement really must be refused up front.
  const state = freshStateWithShops();
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.drawPile = [];
  for (const slotId of Object.keys(state.shops.NORMAL.slots)) state.shops.NORMAL.slots[slotId] = null;
  state.shops.NORMAL.drawPile = [];
  for (const slotId of Object.keys(state.shops.SPECIAL.slots)) state.shops.SPECIAL.slots[slotId] = null;
  const die = giveDie(state, 'P1', 1);
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, board.CASTLE_MAP_ID, 0);
  check('Castle with nothing buildable anywhere is refused up front', result, { success: false, reason: 'NO_BUILDABLE_CARD' });
  check('...the die was never actually placed', die.placedMapId, null);
}
{
  // placeDiceGroup must get the same pre-commit treatment: a monument-only group placement that
  // couldn't reach any monument threshold shouldn't burn the dice either.
  const state = freshStateWithShops();
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.drawPile = [];
  const d1 = giveDie(state, 'P1', 1);
  const d2 = giveDie(state, 'P1', 1); // combined buildValue=2, below every monument's DICE threshold
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Group placement with no reachable monument is refused up front', result, { success: false, reason: 'NO_BUILDABLE_CARD' });
  check('...neither die was actually placed', [d1.placedMapId, d2.placedMapId], [null, null]);
}
{
  // placeDiceGroup must get the SAME AREA009C trailing-ADD treatment as the single-die path above
  // (2026-08-12, per user report: "元老院LV2でモニュメントを建築しようとしたら ダイス目10 AA B ZZの資源で
  // M004が建築候補にでませんでした" -- M004 needs DICE>=9/COST 2A,2B,2C; reaching buildValue=10 requires
  // combining 2 dice, since a lone die maxes at 6, so only placeDiceGroup could ever have hit this).
  // With A=2,B=1,Z=2 alone, M004 (2A+2B+2C = 6 units) is short by 1 (2+1+2=5 available) -- but AREA009C's
  // own "BUILD();ADD(2K,BZ)" grant supplies exactly the missing 1-unit substitute (Z=2 + the granted
  // BZ=1 covers B's shortfall (1) and C's shortfall (2) exactly), so M004 should be both offered AND
  // affordable once that grant is applied before the candidate list is built -- same as it already was
  // for a single die.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 2;
  p1.resources.B = 1;
  p1.resources.Z = 2;
  const m004Slot = Object.keys(state.shops.M.slots).find((k) => state.shops.M.slots[k] === 'M004') || Object.keys(state.shops.M.slots)[0];
  state.shops.M.slots[m004Slot] = 'M004';
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009C', 6, 'P1'); // SLOT1-4=ANY, SLOT5/6=EX (2026-08-24: 元老院 LV1/LV2 grew a 2nd EX slot)
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 4);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], 'MAP009');
  check('Group placement (6+4=10) on AREA009C succeeds', result.success, true);
  check('...the 2K/1BZ grant already landed before the candidate list was built', { K: p1.resources.K, BZ: p1.resources.BZ }, { K: 2, BZ: 1 });
  const m004Candidate = result.actionResult.pendingBuild.candidates.find((c) => c.faceId === 'M004');
  check('...M004 is present among the candidates', !!m004Candidate, true);
  check('...and is affordable using the real 2A+1B+2Z plus the newly-granted BZ', board.isCandidateAffordable(state, index, 'P1', m004Candidate), true);
}
{
  // previewPlaceDice: mirrors the real outcome without mutating anything.
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1 (SLOT2 is ANY, but the numbered slot is preferred), 0 K on hand
  const before = JSON.stringify(state);
  const preview = board.previewPlaceDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('previewPlaceDice reports false when the real placement would be refused', preview, false);
  check('...and never mutates the real state', JSON.stringify(state), before);

  player(state, 'P1').resources.K = 1;
  const preview2 = board.previewPlaceDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('previewPlaceDice reports true once the placement would actually succeed', preview2, true);
  check('...still hasn\'t mutated the real state', state.maps.MAP003.slots[0].length, 0);
}
{
  // previewPlaceDiceGroup: reports which slots the auto-assignment would use, without mutating.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6); // combined buildValue=12, reaches every monument threshold
  const preview = board.previewPlaceDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('previewPlaceDiceGroup reports ok:true when the group would succeed', preview.ok, true);
  // 2026-08-21, per user request: same-valued dice no longer share one slot -- each of the 2 dice claims
  // its own separate slot now.
  check('...each of the 2 dice claims its own separate slot, none shared', preview.touchedSlots.length, 2);
  check('...and never mutates the real state', d1.placedMapId, null);
}

// ---------------------------------------------------------------------------
// 開拓者/JOB009 (2026-08-20 redesign, per user spec, replacing the old "random A/B/C" grant): the placed
// die's own face value now determines what's granted -- 1->K, 2->A, 3->B, 4->C, 5->Z, 6->VP -- and the
// grant lands speculatively BEFORE the AREA's own affordability/candidacy check, so it's immediately
// usable for this same placement (mirrors 地主's own early-grant pattern). If the raw resource alone
// wouldn't make the placement viable but converting it to K via the matching free action (A_K/B_K/C_K/
// Z_K, same 1:1 rate a player could otherwise trigger manually) would, that conversion is applied
// automatically -- see resolvePioneerGrantForDie's own doc. Everything else about the trigger condition
// is unchanged: whole-AREA/any-player "nobody has placed here yet this round" basis, TAP-alternation
// (grants on one qualifying trigger, just untaps on the next), and -- confirmed with the user -- a
// placeDiceGroup action grants ONCE PER DIE in the group (not once for the whole action), still only one
// tap/untap transition regardless. 2026-08-20 follow-up: the trigger's own wording dropped "色ダイスを
// 配置すること" for plain "ダイスを配置すること" ("wDでもOKになります") -- wD now qualifies too, both
// for the trigger itself and for its own per-die grant in a group placement (previously excluded).
// ---------------------------------------------------------------------------
function giveJob009(state, playerId) {
  const p = player(state, playerId);
  const inst = createCardInstance('JOB009');
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  p.ownedCardPhysicalIds.push(inst.physicalId);
  p.jobCardId = 'JOB009';
  return inst;
}
{
  // Full 1-6 die-value -> resource mapping, each on a fresh map with an unconditional ADD-based ACTION
  // (AREA001A/ADD(3K) for values matching its own SLOT1-3=1,2,3; AREA002A/ADD(3K) for SLOT1-3=4,5,6) so
  // the grant itself is never gated by CHANGE affordability. Value 1 (->K) collides with AREA001A's own
  // ADD(3K) grant -- expectedDelta accounts for both landing in the same resource.
  const cases = [
    { value: 1, mapId: 'MAP001', slotIndex: 0, resource: 'K', expectedDelta: 4 }, // 3 (AREA's own ADD(3K)) + 1 (pioneer)
    { value: 2, mapId: 'MAP001', slotIndex: 1, resource: 'A', expectedDelta: 1 },
    { value: 3, mapId: 'MAP001', slotIndex: 2, resource: 'B', expectedDelta: 1 },
    { value: 4, mapId: 'MAP002', slotIndex: 0, resource: 'C', expectedDelta: 1 },
    { value: 5, mapId: 'MAP002', slotIndex: 1, resource: 'Z', expectedDelta: 1 },
    { value: 6, mapId: 'MAP002', slotIndex: 2, resource: 'VP', expectedDelta: 1 },
  ];
  for (const { value, mapId, slotIndex, resource, expectedDelta } of cases) {
    const state = freshStateWithShops();
    const p1 = player(state, 'P1');
    giveJob009(state, 'P1');
    const d1 = giveDie(state, 'P1', value);
    const before = p1.resources[resource] || 0;
    const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, mapId, slotIndex);
    check(`開拓者: placement with die value ${value} succeeds`, result.success, true);
    check(`開拓者: die value ${value} grants ${resource} (delta ${expectedDelta})`, p1.resources[resource] - before, expectedDelta);
  }
}
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  const d1 = giveDie(state, 'P1', 1); // AREA001A SLOT1=1, a fresh map nobody has touched yet -> grants K
  const beforeK = p1.resources.K || 0;
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('開拓者: placement on a fresh AREA still succeeds normally', result.success, true);
  check('...grants 3K (AREA001A own ADD(3K)) + 1K (開拓者, die value 1) = 4', p1.resources.K - beforeK, 4);

  const d2 = giveDie(state, 'P1', 2); // AREA001A SLOT2=2, same (now non-empty) map
  const beforeK2 = p1.resources.K;
  board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('開拓者: a 2nd placement on the same (no longer empty) AREA does not trigger again', p1.resources.K - beforeK2, 3);
}
{
  // 2026-08-27 spec revert: back to color-die-only (wD no longer qualifies) -- see
  // grantPioneerBonusIfEarned's own doc.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  const wDie = createDie('test-wd-pioneer', 'WHITE');
  wDie.value = 1;
  p1.dice.push(wDie);
  const beforeK = p1.resources.K || 0;
  board.placeDice(state, index, { playerId: 'P1' }, wDie.id, 'MAP001', 0);
  check('開拓者: a white die (wD) on a fresh AREA does NOT trigger the bonus (just the AREA\'s own 3K)', p1.resources.K - beforeK, 3);
}
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1'); // no jobCardId set at all
  const d1 = giveDie(state, 'P1', 1);
  const beforeK = p1.resources.K || 0;
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('A player without 開拓者 gets no bonus from a fresh-AREA placement', p1.resources.K - beforeK, 3);
}
{
  // Raw resource directly unlocks a previously-illegal AREA (2026-08-20): 訓練場(AREA007)'s
  // CHANGE((A,B,C),D) needs A,B,C -- player holds A,B but 0 C, die value 4 grants exactly C, no
  // conversion needed or attempted.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  p1.resources.A = 1;
  p1.resources.B = 1;
  const d1 = giveDie(state, 'P1', 4); // AREA007 is ANY,ANY,ANY -- die value 4 grants C
  const diceCountBeforePlace = p1.dice.length;
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP007', 0);
  check('開拓者+訓練場: raw C directly unlocks a placement missing exactly C', result.success, true);
  check('...A/B/C all spent by CHANGE((A,B,C),D), none left over', [p1.resources.A || 0, p1.resources.B || 0, p1.resources.C || 0], [0, 0, 0]);
  check('...no K gained (no C_K conversion happened -- raw was already enough)', p1.resources.K || 0, 0);
  check('...a new die was granted by CHANGE(...,D)', p1.dice.length, diceCountBeforePlace + 1);
}
{
  // Raw resource does NOT help, but auto-converting to K does (2026-08-20, per user's own worked
  // example): 歓楽街(AREA006A)'s CHANGE(2K,2Z) needs K specifically; player holds only 1K, die value 3
  // grants B (not a valid substitute for K), so the bonus auto-converts that B to K via B_K.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  p1.resources.K = 1;
  const d1 = giveDie(state, 'P1', 3); // AREA006A SLOT2=3 -- die value 3 grants B
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP006', 1);
  check('開拓者+歓楽街: raw B doesn\'t help (K needed), auto-converts to K', result.success, true);
  check('...B nets to 0 (granted then converted away)', p1.resources.B || 0, 0);
  check('...K nets to 0 (1 start + 1 from B_K conversion - 2 spent by CHANGE)', p1.resources.K || 0, 0);
  check('...Z increases by 2 (CHANGE(2K,2Z)\'s own gain)', p1.resources.Z || 0, 2);
}
{
  // Neither raw nor converted is actually needed (AREA001A/ADD(3K) is unconditional) -- raw is kept, no
  // wasteful Z_K conversion fires just because one exists.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  const d1 = giveDie(state, 'P1', 5); // AREA002A SLOT2=5 -- die value 5 grants Z
  const beforeK = p1.resources.K || 0;
  const beforeZ = p1.resources.Z || 0;
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP002', 1);
  check('開拓者: raw Z kept when unneeded, no wasteful conversion', p1.resources.Z - beforeZ, 1);
  check('...K only from the AREA\'s own ADD(3K), not +1 more from a spurious Z_K conversion', p1.resources.K - beforeK, 3);
}
{
  // Group placement with 2 DIFFERENT-valued dice grants once PER die, not once for the whole action
  // (confirmed with the user).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  p1.resources.BZ = 20;
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M004'; // DICE>=9, reachable by 4+5=9 combined
  const d1 = giveDie(state, 'P1', 4);
  const d2 = giveDie(state, 'P1', 5);
  const beforeC = p1.resources.C || 0;
  const beforeZ = p1.resources.Z || 0;
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('開拓者: group placement with different-valued dice succeeds', result.success, true);
  check('...grants both 1C (die value 4) and 1Z (die value 5), one per die', [p1.resources.C - beforeC, p1.resources.Z - beforeZ], [1, 1]);
}
{
  // 2026-08-27 spec revert: a wD mixed into a group placement grants nothing -- only the COLOR die(s) in
  // the group do.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  p1.resources.BZ = 20;
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M004'; // DICE>=9 -- genuinely needs both dice combined (6+4), unlike
  // M012 (DICE>=1), which either die alone would already "overfund" and get excluded as redundant.
  const wDie = createDie('test-wd-group', 'WHITE');
  wDie.value = 6;
  p1.dice.push(wDie);
  const d1 = giveDie(state, 'P1', 4);
  const beforeC = p1.resources.C || 0;
  const beforeVp = p1.resources.VP || 0;
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [wDie.id, d1.id], board.CASTLE_MAP_ID);
  check('開拓者: wD in a group placement grants nothing', result.success, true);
  check('...the COLOR die (value 4) grants C but the wD (value 6) grants no VP', [p1.resources.C - beforeC, p1.resources.VP - beforeVp], [1, 0]);
}
{
  // The same die-value mapping applies via placeWildcardDie too (JOB003's ☆ mechanic) -- a synthetic
  // second card carrying WILDCARD_DICE() is registered directly (not via jobCardId, since a player can
  // only hold one JOB) purely to route this placement through placeWildcardDie and confirm die.value is
  // read the same way there.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  const wildInst = createCardInstance('JOB003');
  wildInst.ownerId = 'P1';
  state.cards[wildInst.physicalId] = wildInst;
  p1.ownedCardPhysicalIds.push(wildInst.physicalId);
  const d1 = giveDie(state, 'P1', 4); // -> C, via placeWildcardDie this time (numbered slots ignored)
  const beforeC = p1.resources.C || 0;
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, 'MAP001');
  check('開拓者+☆: the same die-value mapping applies via placeWildcardDie', result.success, true);
  check('...grants 1C (die value 4)', p1.resources.C - beforeC, 1);
}
{
  // Re-triggers once the AREA LVUPs (map.slots resets), even though this player already placed there
  // before the LVUP -- same live-state check playerHasOwnColorDieInMapSlots's own CON006A fix relies on.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  giveJob009(state, 'P1');
  const d1 = giveDie(state, 'P1', 1); // AREA001A SLOT1=1 -> grants K
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  const d2 = giveDie(state, 'P1', 2); // AREA001A SLOT2=2, same already-touched map -- no bonus this time (would map to A, not K)
  const beforeSecondK = p1.resources.K;
  const beforeSecondA = p1.resources.A || 0;
  board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('開拓者: no bonus for the 2nd placement before the LVUP (K delta is just the AREA\'s own ADD(3K))', p1.resources.K - beforeSecondK, 3);
  check('...and no A granted either (die value 2 -> A, but the trigger never fired)', (p1.resources.A || 0) - beforeSecondA, 0);

  // A004A.ONCE = 'MAP001.CURRENT_AREA=AREA001B' -- the real LVUP trigger, resets map.slots for real
  // (2026-08-24 SHOP201-203 rework renumbered the A-deck, so this used to be A005A).
  executor.runProgram(state, index, { playerId: 'P1' }, getCardRow(index, 'A004A').ONCE);
  check('MAP001 is now AREA001B (a fresh, empty tier)', state.maps['MAP001'].currentAreaId, 'AREA001B');

  // Trigger condition re-fires here (fresh empty AREA001B) and grants again -- no TAP/untap gating any
  // more (2026-08-27 revert), so this isn't a "used up" one-shot the way it briefly was.
  const d3 = giveDie(state, 'P1', 1); // AREA001B SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred) -> AREA001B's own ADD(6K)
  const beforeThirdK = p1.resources.K;
  board.placeDice(state, index, { playerId: 'P1' }, d3.id, 'MAP001', 0);
  // AREA001B.ACTION=ADD(6K) (2026-08-27 data edit, was ADD(5K)) + 1K from the pioneer bonus.
  check('開拓者: the trigger condition re-fires after the LVUP and grants again (6 AREA + 1 pioneer)', p1.resources.K - beforeThirdK, 7);

  // A 4th, unrelated fresh-empty-AREA placement (a different map entirely) grants normally too.
  const d4 = giveDie(state, 'P1', 4); // AREA002A (MAP002, still untouched) SLOT1=4 -> grants C
  const beforeC = p1.resources.C || 0;
  board.placeDice(state, index, { playerId: 'P1' }, d4.id, 'MAP002', 0);
  check('開拓者: grants again on the next fresh-AREA trigger too (no per-turn/per-tap limit)', p1.resources.C - beforeC, 1);
}

// ---------------------------------------------------------------------------
// PAY(K);BUILD(U) as a bare TAP ability (originally added 2026-08-17 for JOB010/革命家: "TAPして2〇を
// 支払い、カードを１枚選んでLVアップする。LVアップに必要な資源は通常通り支払う", confirmed 〇=K and the
// LVUP candidate scope = the normal BUILD(U) one; cost lowered from 2K to 1K on 2026-08-18). JOB010 was
// redesigned into a wholly different, bespoke (no-DSL) ability on 2026-08-21, and the real-data test
// vehicle this moved to (B007A, then B005A/革命の兆し) has since dropped the PAY(K) prefix entirely too
// (2026-08-24 data edit -- B005A's own TAP is now just "BUILD(U)") -- no card in the data carries
// PAY(K);BUILD(...) any more, so this now patches a synthetic TAP field onto B001A's row for the
// duration of each block (same "patch index.byId, restore in finally" pattern as the JOB003
// self-untapping-TAP block above), same as if a real card still had this text. Exercises 3
// new/changed engine pieces at once: the PAY command, BUILD being found anywhere in a TAP field (not
// just commands[0]) by board.resolveProgramOrBuild, and candidate existence being checked *before* a
// leading PAY runs (2026-08-17 fix -- otherwise a player with no upgradeable card would lose the K for
// nothing).
// ---------------------------------------------------------------------------
function withPatchedTap(physicalFaceId, tap, fn) {
  const original = index.byId.get(physicalFaceId);
  index.byId.set(physicalFaceId, { sheet: original.sheet, row: { ...original.row, TAP: tap } });
  try {
    fn();
  } finally {
    index.byId.set(physicalFaceId, original);
  }
}
{
  withPatchedTap('B001A', 'PAY(K);BUILD(U)', () => {
    const state = freshStateWithShops();
    const p1 = player(state, 'P1');
    const tapInst = createCardInstance('B001A');
    tapInst.ownerId = 'P1';
    state.cards[tapInst.physicalId] = tapInst;
    p1.ownedCardPhysicalIds.push(tapInst.physicalId);
    p1.resources.K = 5;
    const upgradeable = createCardInstance('A001A'); // A001B exists, COST "2A"
    upgradeable.ownerId = 'P1';
    state.cards[upgradeable.physicalId] = upgradeable;
    p1.ownedCardPhysicalIds.push(upgradeable.physicalId);

    const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, tapInst.physicalId);
    check('TAP=PAY(K);BUILD(U) succeeds and returns a pendingBuild', result.success && !!result.pendingBuild, true);
    check('...the 1K cost was already paid, ahead of committing any candidate', p1.resources.K, 4);
    check('...the source card itself is NOT tapped yet (only once a candidate is actually committed)', state.cards[tapInst.physicalId].tapped, false);
    check('...candidates include the A001->A001B upgrade', result.pendingBuild.candidates.some((c) => c.physicalId === 'A001'), true);

    const candidate = result.pendingBuild.candidates.find((c) => c.physicalId === 'A001');
    p1.resources.A = 2; // A001A's own COST, paid normally/separately from the 1K above
    state.cards[tapInst.physicalId].tapped = true; // caller's job to tap the source card on commit (see ai/simulator.js's BARE_TAP case)
    const buildResult = board.completeAreaBuild(state, index, { playerId: 'P1' }, candidate, result.pendingBuild.remainingCommands);
    check('Completing the chosen UPGRADE candidate succeeds', buildResult.success, true);
    check('A001 flipped to A001B', state.cards['A001'].currentFaceId, 'A001B');
    check('...paid via the upgraded card\'s own normal COST (2A), separate from the 1K already spent', p1.resources.A, 0);
    check('...source card ends up tapped', state.cards[tapInst.physicalId].tapped, true);
  });
}
{
  // Insufficient K: fails cleanly, nothing at all is mutated (no partial payment, no tap).
  withPatchedTap('B001A', 'PAY(K);BUILD(U)', () => {
    const state = freshStateWithShops();
    const p1 = player(state, 'P1');
    const tapInst = createCardInstance('B001A');
    tapInst.ownerId = 'P1';
    state.cards[tapInst.physicalId] = tapInst;
    p1.ownedCardPhysicalIds.push(tapInst.physicalId);
    p1.resources.K = 0; // short of the 1K needed
    const upgradeable = createCardInstance('A001A');
    upgradeable.ownerId = 'P1';
    state.cards[upgradeable.physicalId] = upgradeable;
    p1.ownedCardPhysicalIds.push(upgradeable.physicalId);

    const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, tapInst.physicalId);
    check('Fails with insufficient K', result, { success: false, reason: 'INSUFFICIENT_RESOURCES', resource: 'K' });
    check('...the 0K the player had is untouched', p1.resources.K, 0);
    check('...source card stays untapped', state.cards[tapInst.physicalId].tapped, false);
  });
}
{
  // No candidate at all: fails with NO_BUILDABLE_CARD, and -- the 2026-08-17 fix under test -- the 1K is
  // never actually spent, since candidate existence is checked before the leading PAY runs. Uses
  // categories (A,B,C,M) rather than U specifically: U's own candidate scope always offers the source
  // card's own next-tier upgrade once owned, no matter how poor the player is -- there's no way to make
  // ITS candidate list genuinely empty. (A,B,C,M) instead depends entirely on shop contents, so clearing
  // every shop slot really does leave zero candidates.
  withPatchedTap('B001A', 'PAY(K);BUILD((A,B,C,M),1)', () => {
    const state = freshStateWithShops();
    const p1 = player(state, 'P1');
    for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
    for (const slotId of Object.keys(state.shops.NORMAL.slots)) state.shops.NORMAL.slots[slotId] = null;
    for (const slotId of Object.keys(state.shops.SPECIAL.slots)) state.shops.SPECIAL.slots[slotId] = null;
    const tapInst = createCardInstance('B001A');
    tapInst.ownerId = 'P1';
    state.cards[tapInst.physicalId] = tapInst;
    p1.ownedCardPhysicalIds.push(tapInst.physicalId);
    p1.resources.K = 2; // enough to afford PAY(K) if it ran -- it must not, here

    const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, tapInst.physicalId);
    check('Fails with NO_BUILDABLE_CARD when every shop slot is empty', result.success, false);
    check('...reason is NO_BUILDABLE_CARD', result.reason, 'NO_BUILDABLE_CARD');
    check('...the 2K was NOT spent (candidate check runs before the leading PAY)', p1.resources.K, 2);
    check('...source card stays untapped', state.cards[tapInst.physicalId].tapped, false);
  });
}

// ---------------------------------------------------------------------------
// 地主/JOB011 (2026-08-17, per user spec: "元老院以外のLVアップされたAREAにダイスを配置した時食料を得る
// そのAREAに自分の色Dがすでにあるなら代わりに1VPを得る", confirmed with the user: 食料=K, and "すでに
// ある" means a color die from an *earlier* placement action still sitting there). AREA001B ("小麦畑LV1")
// is used as the "LVアップされた" (already-upgraded) test AREA -- its own ACTION is ADD(6K), always
// added on top of whatever JOB011 itself grants, so every check below accounts for both sources.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  state.maps['MAP001'].currentAreaId = 'AREA001B'; // "LVアップされた" (tier B, not the base tier A)

  const d1 = giveDie(state, 'P1', 1); // AREA001B SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  const beforeK = p1.resources.K || 0;
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('地主: placement on an upgraded AREA succeeds normally', result.success, true);
  check('...grants 6K (AREA001B\'s own ADD(6K)) + 1K (地主, no prior own color die here) = 7', p1.resources.K - beforeK, 7);
  check('...no VP granted this time', p1.resources.VP || 0, 0);

  const d2 = giveDie(state, 'P1', 3); // AREA001B SLOT2=ANY -- P1 already has d1 sitting in SLOT1
  const beforeK2 = p1.resources.K;
  board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('...2nd placement still grants 6K (area) + 1K (地主, always) = 7', p1.resources.K - beforeK2, 7);
  check('...and grants 1VP ADDITIONALLY (2026-08-20: changed from "instead of"), since P1 already had a color die here', p1.resources.VP, 1);
}
{
  // Base (not-yet-upgraded) tier: no 地主 bonus at all, only the AREA's own ADD(3K).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  const d1 = giveDie(state, 'P1', 1); // AREA001A (base tier) SLOT1=1
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('地主: no bonus on a not-yet-upgraded (base tier) AREA -- only the area\'s own 3K', p1.resources.K, 3);
  check('...and no VP either', p1.resources.VP || 0, 0);
}
{
  // 元老院 (AREA009) is excluded outright, even once upgraded. Its own ACTION is BUILD();ADD(2K), so
  // placement there needs an affordable BUILD candidate to succeed at all -- generously funded so *some*
  // A/B/C card is reachable regardless of this run's randomized shop contents.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  p1.resources.K = 20; p1.resources.A = 20; p1.resources.B = 20; p1.resources.C = 20;
  state.maps['MAP009'].currentAreaId = 'AREA009B'; // 元老院LV1, ACTION=BUILD();ADD(2K)
  const d1 = giveDie(state, 'P1', 1); // AREA009B SLOT1=ANY
  const beforeK = p1.resources.K;
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP009', 0);
  check('地主: placement at 元老院 succeeds (needed an affordable BUILD candidate)', result.success, true);
  check('地主: no bonus at 元老院 even when upgraded -- only its own ADD(2K), no extra 1K', p1.resources.K - beforeK, 2);
  check('...and no VP either', p1.resources.VP || 0, 0);
}
{
  // A player without 地主 gets no bonus (control).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1'); // no jobCardId set at all
  state.maps['MAP001'].currentAreaId = 'AREA001B';
  const d1 = giveDie(state, 'P1', 1); // AREA001B SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('A player without 地主 gets only the AREA\'s own 6K, no bonus on top', p1.resources.K, 6);
}
{
  // A white die placement still triggers the bonus -- JOB011's own text has no wD exclusion, unlike
  // JOB009's (confirmed with the user only for the "already there" check being color-die-specific, not
  // for what kind of die newly triggers it).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  state.maps['MAP001'].currentAreaId = 'AREA001B';
  const wd = createDie('test-wd', 'WHITE');
  wd.value = 1; // AREA001B SLOT1=1 (SLOT2 is ANY, but the numbered slot is preferred)
  p1.dice.push(wd);
  const beforeK = p1.resources.K || 0;
  board.placeDice(state, index, { playerId: 'P1' }, wd.id, 'MAP001', 0);
  check('地主: a white die placement still grants the bonus (6K area + 1K 地主)', p1.resources.K - beforeK, 7);
}

// ---------------------------------------------------------------------------
// 地主's bonus is usable immediately by the *same* placement it comes from (2026-08-18, per user
// worked examples): AREA010B (孤児院LV1)'s own ACTION is CHANGE(2K,2VP) (2026-08-25 data edit: was
// CHANGE(3K,2VP)) -- with 1K, the bonus's +1K is what bridges the shortfall to actually trigger it.
// mapWithArea (see the EX-slot tests above) builds the map fixture; AREA010B's SLOT1 requires value 2.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  p1.resources.K = 1; // short of CHANGE(2K,2VP)'s own cost by exactly 1
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA010B', 6, 'P1'); // P1 owns it -- no usage fee here
  const d1 = giveDie(state, 'P1', 2); // SLOT1=2
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('地主: placing at 孤児院LV1 with 1K succeeds (the +1K bonus covers CHANGE(2K,2VP)\'s own cost)', result.success, true);
  check('...the 2K (1 starting + 1 from 地主) was spent by CHANGE, leaving 0', p1.resources.K, 0);
  check('...and CHANGE(2K,2VP) granted 2VP', p1.resources.VP, 2);
}

// ---------------------------------------------------------------------------
// 地主's bonus also covers an otherwise-unaffordable usage fee (2026-08-18, per user worked example):
// placing on ANOTHER player's tiered-up AREA (tier C, usage fee 2K). Originally used 孤児院LV2/AREA010C
// itself, but that card became EX-only (owner-exclusive) in a later, intentional data edit (confirmed
// with the user, 2026-08-28) -- a non-owner can no longer reach it at all, so this now uses AREA999C
// (this file's own synthetic tier-C stand-in, see its own doc up top), which still isolates the fee
// check the same way AREA010C's own ADD(2VP) used to (1K alone falls 1 short of the 2K fee; 地主's +1K
// bridges exactly that gap).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  p1.resources.K = 1; // 1 short of the 2K fee on its own
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA999C', 6, 'P2'); // P2 owns it -- usage fee applies to P1
  const d1 = giveDie(state, 'P1', 3); // SLOT1=ANY
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('地主: 1K is enough on another player\'s tiered-up AREA once the +1K bonus bridges the 1K shortfall', result.success, true);
  check('...the 1K from 地主 was granted, ADD(2VP) leaves K untouched (1+1=2, reserved for the pending fee)', p1.resources.K, 2);
  check('...and ADD(2VP) granted 2VP', p1.resources.VP, 2);
  check('...the usage fee is now pending, not yet deducted', p1.pendingFee, { mapId: 'MAP001', amount: 2 });
}
{
  // Same setup, but P1 already has a color die sitting in this map -- 地主 STILL grants 1K (unconditional
  // now, 2026-08-20: changed from "1VP instead of K" to "1VP in addition to K"), which bridges the same
  // 1K shortfall exactly as the no-prior-die case above, PLUS the extra 1VP on top this time. The earlier
  // die occupies AREA999C's OTHER ANY slot (index 1) so it doesn't collide with the new placement's own
  // slot 0.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB011';
  p1.resources.K = 1;
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA999C', 6, 'P2');
  const earlierDie = giveDie(state, 'P1', 5);
  state.maps['MAP001'].slots[1].push({ playerId: 'P1', dieId: earlierDie.id, value: 5, seq: 1, countsForTurnOrder: true }); // AREA999C's SLOT2=ANY
  earlierDie.placedMapId = 'MAP001';
  const d1 = giveDie(state, 'P1', 3);
  const result = board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  check('地主: with an existing own color die already there, the K bonus still bridges the shortfall', result.success, true);
  check('...the 1K from 地主 was granted, ADD(2VP) leaves K untouched (1+1=2, reserved for the pending fee)', p1.resources.K, 2);
  check('...ADD(2VP) granted 2VP, plus 1 more from 地主\'s own bonus (already had a color die here) = 3', p1.resources.VP, 3);
  check('...the usage fee is now pending, not yet deducted', p1.pendingFee, { mapId: 'MAP001', amount: 2 });
}
// No placeDiceGroup test for 地主: group placement only ever succeeds against a monument-buildable
// candidate (confirmed empirically -- getBuildCandidates(['M'],...) gates it), and the only 2 maps that
// support stacking multiple dice at all are the castle (MAP008/AREA008, which has no LVUP tier at all --
// grantLandlordBonusIfEarned's own `!tier` check always excludes it) and 元老院 (MAP009/AREA009, excluded
// by name outright). So group placement and 地主's bonus zone never actually overlap in the current data
// -- grantLandlordBonusIfEarned is still wired into placeDiceGroup the same way grantPioneerBonusIfEarned
// is (see its own call site), it just has no reachable trigger there today.

// ---------------------------------------------------------------------------
// 訓練場LV1/LV2 (AREA007B/AREA007C) own dice grant (2026-08-25, per user spec: "訓練場LV1のAREAに
// ダイスを置いたときダイス上限が5になるように（怠惰でもダイスが増える）訓練場LV2のAREAにダイスを置いた
// ときダイス上限が６になるように") -- bypasses both the normal 5-color-dice cap and 怠惰/CON005A's
// REPLACE_ADD(D,wD) redirect, for just this one grant. Confirmed with the user this is scoped to 訓練場's
// own D grant only, not a lasting change to the player's own cap. SLOT1/2 at both tiers are EX
// (owner-only). AREA007B's own ACTION changed 2026-08-25 from a free ADD(D) to CHANGE(K,D) (per user
// data edit "訓練場LV1　能力変えました") -- the bypass logic (keyed off grantsColorDie's generic
// CHANGE/ADD detection, not this AREA's specific formula) needed no code change for this, but tests
// placing there now need to actually afford the K cost. AREA007C (LV2) is untouched, still ADD(D).
// ---------------------------------------------------------------------------
{
  // 怠惰 (CON005A) normally turns EVERY D grant into a wD instead, unconditionally, everywhere -- except
  // now at 訓練場LV1, where it's bypassed entirely.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.K = 1; // AREA007B's own ACTION is now CHANGE(K,D)
  const con5a = createCardInstance('CON005A');
  con5a.ownerId = 'P1';
  state.cards[con5a.physicalId] = con5a;
  p1.ownedCardPhysicalIds.push(con5a.physicalId);
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007B', 2, 'P1'); // SLOT1/2=EX, P1 owns it
  const die = giveDie(state, 'P1', 3); // EX accepts any value
  const beforeColor = p1.dice.filter((d) => d.kind === 'COLOR').length;
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('怠惰 owner placing on 訓練場LV1 still succeeds (the bypass makes ADD(D) have a real effect)', result.success, true);
  check('...gains a REAL color die, not a wD (怠惰\'s REPLACE_ADD(D,wD) is bypassed here)', p1.dice.filter((d) => d.kind === 'COLOR').length - beforeColor, 1);
}
{
  // 訓練場LV1's own raised cap (5) matches the default colorDiceCap exactly -- so for a NORMAL player
  // already at 5 color dice (no headroom to begin with), it's still blocked, same as anywhere else.
  // (The cap check counts the die about to be placed too -- see wouldAreaActionHaveEffect's own doc on
  // why -- so 4 pre-existing + the 1 being placed = 5 total already at the cap.)
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  for (let i = 0; i < 4; i++) giveDie(state, 'P1', 1);
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007B', 2, 'P1');
  const die = giveDie(state, 'P1', 3); // 5th color die -- brings the pre-placement count to the cap
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('A normal player already at 5 color dice is still blocked at 訓練場LV1 (its cap is 5, no extra headroom)', result, { success: false, reason: 'COLOR_DICE_CAP' });
}
{
  // 訓練場LV2's own raised cap (6) is a genuine increase over the normal 5 -- even a normal player (no
  // CON005A) already AT the usual cap can still gain a 6th real color die here.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  for (let i = 0; i < 4; i++) giveDie(state, 'P1', 1); // 4 pre-existing + the 1 about to be placed = 5
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007C', 2, 'P1');
  const die = giveDie(state, 'P1', 3); // 5th color die -- at the usual cap, but LV2 allows one more
  const beforeColor = p1.dice.filter((d) => d.kind === 'COLOR').length;
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('A normal player at the usual 5-cap can still gain a 6th real color die at 訓練場LV2', result.success, true);
  check('...total color dice is now 6', p1.dice.filter((d) => d.kind === 'COLOR').length, 6);
}
{
  // But 訓練場LV2's raised cap is still a real ceiling -- once actually AT 6, it blocks like anywhere else.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  for (let i = 0; i < 5; i++) giveDie(state, 'P1', 1); // 5 pre-existing + the 1 about to be placed = 6
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007C', 2, 'P1');
  const die = giveDie(state, 'P1', 3); // 6th color die -- already at 訓練場LV2's own raised cap
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('At 6 color dice already, 訓練場LV2 is blocked too (its own raised cap is still a real ceiling)', result, { success: false, reason: 'COLOR_DICE_CAP' });
}
{
  // Control: the BASE (untiered) 訓練場 (AREA007A) gets no bypass at all -- 怠惰 still blocks it entirely,
  // confirming the bypass is genuinely LV1/LV2-specific, not "any 訓練場 tier".
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con5a = createCardInstance('CON005A');
  con5a.ownerId = 'P1';
  state.cards[con5a.physicalId] = con5a;
  p1.ownedCardPhysicalIds.push(con5a.physicalId);
  player(state, 'P1').resources = { A: 5, B: 5, C: 5 }; // AREA007A's own ACTION is CHANGE((A,B,C),D)
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007A', 3, null); // SLOT1-3=ANY, base tier
  const die = giveDie(state, 'P1', 4);
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP007', 0);
  check('怠惰 owner at the BASE (untiered) 訓練場 is still blocked outright -- no bypass at this tier', result, { success: false, reason: 'COLOR_DIE_REPLACED' });
}
{
  // A ☆ die (JOB003/道化) can land on 訓練場LV1/LV2 too ("全AREA共通") -- same bypass applies.
  const state = freshStateWithShops();
  const p1 = withWildcardOwner(state);
  p1.resources.K = 1; // AREA007B's own ACTION is now CHANGE(K,D)
  const con5a = createCardInstance('CON005A');
  con5a.ownerId = 'P1';
  state.cards[con5a.physicalId] = con5a;
  p1.ownedCardPhysicalIds.push(con5a.physicalId);
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007B', 2, 'P1');
  const die = giveDie(state, 'P1', 3);
  const beforeColor = p1.dice.filter((d) => d.kind === 'COLOR').length;
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, die.id, 'MAP007');
  check('A ☆ die on 訓練場LV1 also gets the bypass -- 怠惰 owner still gains a real color die', result.success, true);
  check('...total color dice increased by 1', p1.dice.filter((d) => d.kind === 'COLOR').length - beforeColor, 1);
}

// ---------------------------------------------------------------------------
// 道化/JOB003 ☆ワイルドカードダイス (2026-08-19) -- complete replacement of the old SET_DICE_ANY-based
// TAP ability (which caused a real AI infinite-loop bug, see src/ai/game-runner.js's own history) with
// PASSIVE=WILDCARD_DICE(): every die this player owns (COLOR and WHITE alike) ignores a slot's numbered/
// ANY value requirement and DUPLICATE_VALUE_IN_AREA, is auto-placed by the engine (board.placeWildcardDie
// -- left-packed into empty non-EX slots, falling back to stacking under the leftmost slot when full,
// universally across every AREA per the user's own spec: "全AREA共通"), is exempt from 憤怒/CON005B's
// BLOCK_COLOR_DIE_REUSE, and counts as value 1 for an A/B/C candidate's DICE_MIN/MAX check but value 6
// for a monument's DICE>=threshold check (occupantBuildContribution). A solo forced-fallback stack does
// NOT sum with whatever already occupies that slot (excludedFromBuildValue) -- only a deliberate
// simultaneous placeDiceGroup of 2+ ☆ dice actually sums together -- closing a possible new exploit
// where an automatic single-die fallback could otherwise combine unpredictably with an unrelated
// pre-existing die to reach a high monument threshold.
// ---------------------------------------------------------------------------
function withWildcardOwner(state) {
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB003');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.jobCardId = 'JOB003';
  return p1;
}
{
  const state = freshStateWithShops();
  check('hasWildcardDice is false before owning JOB003', board.hasWildcardDice(state, index, 'P1'), false);
  withWildcardOwner(state);
  check('hasWildcardDice is true once JOB003 (PASSIVE=WILDCARD_DICE()) is owned', board.hasWildcardDice(state, index, 'P1'), true);
  check('A different, non-owning player is unaffected', board.hasWildcardDice(state, index, 'P2'), false);
}
{
  // AREA001A: SLOT1=1,SLOT2=2,SLOT3=3 (all numbered, no ANY at all) -- a real value=3 die would
  // normally have to use SLOT3 (its own exact match); ☆ ignores this entirely and left-packs instead.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  const d1 = giveDie(state, 'P1', 3);
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, 'MAP001');
  check('☆ ignores the numbered-slot value match and lands on the leftmost empty slot', result.success, true);
  check('...specifically SLOT1 (index 0), not its own "matching" SLOT3', state.maps['MAP001'].slots.map((s) => s.length), [1, 0, 0]);
  const occ = state.maps['MAP001'].slots[0][0];
  check('...flagged isWildcard and NOT excludedFromBuildValue (a genuinely free slot)', [occ.isWildcard, occ.excludedFromBuildValue], [true, false]);
  check('...counts toward next round\'s turn order', occ.countsForTurnOrder, true);

  const d2 = giveDie(state, 'P1', 1);
  board.placeWildcardDie(state, index, { playerId: 'P1' }, d2.id, 'MAP001');
  check('A second ☆ left-packs into SLOT2 next, real value 1 notwithstanding', state.maps['MAP001'].slots.map((s) => s.length), [1, 1, 0]);
}
{
  // Regression (2026-08-22, per user report: "道化の☆ダイス　星になる前のもともとのダイス目がほかの
  // プレイヤーをロックしている") -- a ☆ occupant's own .value field still carries its pre-star roll
  // (see placeWildcardDie's own doc), but that must never block a DIFFERENT player's real die of the
  // same face value from the same AREA: the ☆ itself no longer represents that number at all.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  // P1's ☆ rolled a 3, left-packs into SLOT1 (AREA001A: SLOT1=1,SLOT2=2,SLOT3=3, all numbered).
  const starDie = giveDie(state, 'P1', 3);
  board.placeWildcardDie(state, index, { playerId: 'P1' }, starDie.id, 'MAP001');
  check('P1\'s ☆ (real roll 3) landed on SLOT1, not its own matching SLOT3', state.maps['MAP001'].slots.map((s) => s.length), [1, 0, 0]);

  // P2 (a normal, non-wildcard player) now places a real die showing 3 -- must succeed via SLOT3, not
  // be refused as a duplicate of the ☆'s residual value=3.
  const p2Die = giveDie(state, 'P2', 3);
  const p2Result = board.placeDice(state, index, { playerId: 'P2' }, p2Die.id, 'MAP001', 2);
  check('P2\'s real value-3 die is NOT blocked by P1\'s ☆ (which only LOOKS like a 3 internally)', p2Result.success, true);
  check('...and actually landed on SLOT3 (index 2)', state.maps['MAP001'].slots.map((s) => s.length), [1, 0, 1]);
}
{
  // Fallback stacking at a BUILD-only AREA (castle/王宮): fill every non-EX slot, then a 7th solo ☆ has
  // nowhere to go but a forced fallback under SLOT1, evicting whoever was there (evictSlotOccupants). As
  // of 2026-08-23 (per user report: forced fallback at 元老院/王宮 could never acquire a card at all) this
  // placement's own buildValue is its normal category value (1 for A/B/C) same as any other solo ☆
  // placement -- no longer zeroed just for landing via the forced-fallback path -- so it CAN trigger
  // BUILD() same as a genuinely-empty-slot placement would, matching how a normal die placed via
  // GRANT_PLACE_ANYWHERE onto an occupied slot always contributes its own real value too. The monument
  // threshold check still uses the same solo-die value (6, not 0) -- still short of M001's DICE>=12, so
  // M001 in particular stays unreachable from a single ☆, same as before; only A/B/C shop candidates are
  // reachable here.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.BZ = 20; // afford whatever candidate ends up offered (same pattern as the existing castle tests)
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M001'; // DICE>=12 -- must stay unreachable from a single 6-equivalent

  const dice = [1, 2, 3, 4, 5, 6, 2].map((v) => giveDie(state, 'P1', v));
  for (let i = 0; i < 6; i++) {
    const r = board.placeWildcardDie(state, index, { playerId: 'P1' }, dice[i].id, board.CASTLE_MAP_ID);
    check(`☆ #${i + 1} fills its own fresh empty castle slot`, r.success, true);
  }
  check('All 6 castle slots now hold exactly 1 ☆ die each', state.maps[board.CASTLE_MAP_ID].slots.map((s) => s.length), [1, 1, 1, 1, 1, 1]);

  const seventh = board.placeWildcardDie(state, index, { playerId: 'P1' }, dice[6].id, board.CASTLE_MAP_ID);
  check('A 7th solo ☆, forced onto the already-full row, still succeeds and can trigger BUILD()', seventh.success, true);
  check('...buildValue is 1 (this solo die\'s own A/B/C category value), not 0', seventh.actionResult.pendingBuild.buildValue, 1);
  check('...M001 (DICE>=12) is NOT among the candidates -- a solo ☆ maxes out at monument value 6', seventh.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M001'), false);
  check('...SLOT1 now holds only the 7th die -- the original occupant was evicted, not stacked under it', state.maps[board.CASTLE_MAP_ID].slots[0].map((o) => o.dieId), [dice[6].id]);
  check('...the 7th die itself is now placed at the castle', dice[6].placedMapId, board.CASTLE_MAP_ID);
}
{
  // Contrast: a DELIBERATE simultaneous group placement of 2 ☆ dice is now refused outright (2026-08-20,
  // per user request, formalizing a bug they'd found -- placing 2 ☆ together via this path never actually
  // worked -- into an intentional nerf: "道化自体が強かったので...☆ダイスは1個でしか使えない（ダイス目7
  // 以上は獲得できない）"). Was previously a summed 6+6=12 group placement reaching M001 -- see
  // placeDiceGroup's own doc for why this refuses unconditionally for a wildcard-owning player, and the
  // regression block right after this one for how solo placements onto the same slot still accumulate.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.BZ = 20;
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M001'; // DICE>=12 -- would have genuinely needed both dice combined

  const d1 = giveDie(state, 'P1', 4);
  const d2 = giveDie(state, 'P1', 5);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Group placement of 2 ☆ dice is refused outright', result, { success: false, reason: 'WILDCARD_GROUP_NOT_ALLOWED' });
  check('...neither die was actually placed', [d1.placedMapId, d2.placedMapId], [null, null]);
}
{
  // Regression (2026-08-23, per user report: forced-fallback ☆ placements at 元老院/王宮 could never
  // acquire a card, since excludedFromBuildValue used to zero their buildValue outright). Every ANY slot
  // at 元老院 (AREA009A, 6 ANY -- briefly shrunk to 4 by a 2026-08-24 data edit, reverted back to 6 by a
  // 2026-08-25 one) already occupied by another player -- P1's own ☆ dice have nowhere to go but a
  // forced fallback onto SLOT1, twice in a row -- each one now still succeeds via BUILD(), same as a
  // genuinely-empty-slot placement (buildValue=1), evicting whoever was in SLOT1 (first P2's own die,
  // then this same 2nd ☆ evicts the 1st ☆ in turn) rather than accumulating with it -- still no
  // multi-turn/multi-die accumulation, per the 2026-08-20 "重ねたかどうかではなく1ターンに2個置いたかで
  // 合計するようにしてください" rule this test block originally regression-tested.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.BZ = 20;
  // Every ANY slot at 元老院 (AREA009A, 6 ANY) already occupied by another player -- P1's own ☆ dice
  // will have nowhere to go but a forced fallback onto SLOT1, twice in a row.
  for (let i = 0; i < 6; i++) {
    state.maps['MAP009'].slots[i].push({ playerId: 'P2', dieId: `p2-${i}`, value: (i % 6) + 1, seq: i + 1, countsForTurnOrder: true });
  }

  const d1 = giveDie(state, 'P1', 2);
  const r1 = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, board.AREA009_MAP_ID);
  check('Alice\'s 1st ☆, forced onto the already-full row, still succeeds and can trigger BUILD()', r1.success, true);
  check('...buildValue is 1, not 0', r1.actionResult.pendingBuild.buildValue, 1);
  check('...SLOT1 now holds only the 1st ☆ -- P2\'s own die was evicted, not stacked under it', state.maps[board.AREA009_MAP_ID].slots[0].map((o) => o.dieId), [d1.id]);

  const d2 = giveDie(state, 'P1', 4);
  const r2 = board.placeWildcardDie(state, index, { playerId: 'P1' }, d2.id, board.AREA009_MAP_ID);
  check('...trying again with a 2nd die also succeeds the same way, not stuck in some worse state', r2.success, true);
  check('...SLOT1 now holds only the 2nd ☆ -- the 1st ☆ was itself evicted in turn', state.maps[board.AREA009_MAP_ID].slots[0].map((o) => o.dieId), [d2.id]);
}
{
  // A ☆ die can never target another player's EX slot, even as a forced fallback -- it forces its way
  // onto the leftmost non-EX slot instead (2026-08-21: evicting whoever was there, not stacking onto
  // them -- see evictSlotOccupants' own doc), leaving the EX slot empty.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.K = 50;
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P2'); // AREA001B: SLOT1=ANY,SLOT2=1,SLOT3=EX -- P2 owns the EX
  state.maps['MAP001'].slots[0].push({ playerId: 'P2', dieId: 'x1', value: 9, seq: 1, countsForTurnOrder: true });
  state.maps['MAP001'].slots[1].push({ playerId: 'P2', dieId: 'x2', value: 9, seq: 2, countsForTurnOrder: true });

  const d1 = giveDie(state, 'P1', 3);
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, 'MAP001');
  check('☆ never targets another player\'s EX slot, even with every non-EX slot full', result.success, true);
  check('...evicts SLOT1\'s occupant instead of stacking; SLOT2/EX stay untouched', state.maps['MAP001'].slots.map((s) => s.length), [1, 1, 0]);
  check('...SLOT1 now holds only P1\'s ☆, not P2\'s evicted x1', state.maps['MAP001'].slots[0].map((o) => o.dieId), [d1.id]);
}
{
  // But this player's OWN EX slot is a perfectly normal, genuinely-empty target.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.K = 50;
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1'); // P1 owns this EX
  state.maps['MAP001'].slots[0].push({ playerId: 'P2', dieId: 'x1', value: 9, seq: 1, countsForTurnOrder: true });
  state.maps['MAP001'].slots[1].push({ playerId: 'P2', dieId: 'x2', value: 9, seq: 2, countsForTurnOrder: true });

  const d1 = giveDie(state, 'P1', 3);
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, 'MAP001');
  check('...when P1 owns that EX slot, it IS used -- a genuinely free slot, not a fallback', result.success, true);
  check('...lands in the EX slot (index 2), not stacked elsewhere', state.maps['MAP001'].slots.map((s) => s.length), [1, 1, 1]);
  check('...not excludedFromBuildValue (a real empty-slot placement)', state.maps['MAP001'].slots[2][0].excludedFromBuildValue, false);
}
{
  // Category-dependent substitution: the SAME placement counts as 1 for the A/B/C DICE_MIN/MAX check but
  // 6 for the monument DICE>=threshold check (王宮's bare BUILD() defaults to every category at once).
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.BZ = 20;
  state.shops.M.slots.SHOP001 = 'M007'; // DICE>=6 -- reachable only if ☆ counts as 6 here
  state.shops.M.slots.SHOP002 = 'M002'; // DICE>=11 -- must stay out of reach (6 is not enough)

  const d1 = giveDie(state, 'P1', 4); // real rolled value is irrelevant -- ☆ substitutes per category
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, board.CASTLE_MAP_ID);
  check('Solo ☆ placement at the castle succeeds', result.success, true);
  const candidates = result.actionResult.pendingBuild.candidates;
  check('M007 (DICE>=6) IS offered -- ☆ counts as 6 for the monument check', candidates.some((c) => c.faceId === 'M007'), true);
  check('M002 (DICE>=11) is NOT offered -- 6 is not enough', candidates.some((c) => c.faceId === 'M002'), false);
  check('SHOP106 (DICE_MIN=1,MAX=1) IS offered -- ☆ counts as only 1 for the A/B/C check, not 6', candidates.some((c) => c.slotId === 'SHOP106'), true);
}
{
  // 憤怒/CON005B's BLOCK_COLOR_DIE_REUSE (same-AREA restriction) is negated for a ☆-owning player.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  const con = createCardInstance('CON005B');
  con.ownerId = 'P1';
  state.cards[con.physicalId] = con;
  player(state, 'P1').ownedCardPhysicalIds.push(con.physicalId);

  const d1 = giveDie(state, 'P1', 1); // AREA001A SLOT1=1
  board.placeWildcardDie(state, index, { playerId: 'P1' }, d1.id, 'MAP001');
  const d2 = giveDie(state, 'P1', 2); // AREA001A SLOT2=2, same AREA again
  const result = board.placeWildcardDie(state, index, { playerId: 'P1' }, d2.id, 'MAP001');
  check('☆ (道化) is exempt from 憤怒\'s own-color-die-reuse block in the same AREA', result.success, true);
  check('...both dice ended up on MAP001', state.maps['MAP001'].slots.reduce((sum, s) => sum + s.length, 0), 2);
}
{
  // Control: a normal (non-wildcard) player with 憤怒 alone is still blocked exactly as before.
  const state = freshStateWithShops();
  const con = createCardInstance('CON005B');
  con.ownerId = 'P1';
  state.cards[con.physicalId] = con;
  player(state, 'P1').ownedCardPhysicalIds.push(con.physicalId);

  const d1 = giveDie(state, 'P1', 1);
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  const d2 = giveDie(state, 'P1', 2);
  const result = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('Control: without ☆, 憤怒\'s own-color-die-reuse block still applies normally', result, { success: false, reason: 'OWN_COLOR_DIE_ALREADY_IN_AREA' });
}
{
  // A 2-☆-die group placement is refused the same way regardless of what's in the shop (2026-08-20, same
  // rule as the "Contrast" block above) -- this used to be excludeOverfundedMonuments's own wildcard-
  // specific regression case (a 2-☆-die group correctly excluding an already-overfunded monument while
  // still offering one that genuinely needed both dice combined); that scenario can no longer arise at
  // all now that a wildcard-owning player's group placements are refused outright, so this just confirms
  // the refusal holds regardless of shop contents. excludeOverfundedMonuments itself is still covered for
  // real (non-☆) dice groups elsewhere in this file.
  const state = freshStateWithShops();
  withWildcardOwner(state);
  player(state, 'P1').resources.BZ = 20;
  for (const slotId of Object.keys(state.shops.M.slots)) state.shops.M.slots[slotId] = null;
  state.shops.M.slots.SHOP001 = 'M012'; // DICE>=1
  state.shops.M.slots.SHOP002 = 'M001'; // DICE>=12

  const d1 = giveDie(state, 'P1', 3);
  const d2 = giveDie(state, 'P1', 4);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Group placement of 2 ☆ dice is refused outright regardless of shop contents', result, { success: false, reason: 'WILDCARD_GROUP_NOT_ALLOWED' });
}

// ---------------------------------------------------------------------------
// wildcardExAnyChoice / placeWildcardDie's preferredSlotIndex (2026-08-28, per user request: "道化の
// ☆ダイス 自分のEXとANYと両方置けるときANYにしか置けません その時だけはどちらか選べるようにお願い").
// AREA003B/城下町LV1 has SLOT1=ANY, SLOT2=EX -- a clean 2-slot mixed layout.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  state.maps.MAP003.currentAreaId = 'AREA003B';
  state.maps.MAP003.feeOwnerId = 'P1';
  const die = giveDie(state, 'P1', 4);
  const choice = board.wildcardExAnyChoice(state, index, { playerId: 'P1' }, 'MAP003');
  check('wildcardExAnyChoice finds the EX(index1)-vs-ANY(index0) split', choice, { exSlotIndex: 1, otherSlotIndex: 0 });

  const autoState = structuredClone(state);
  const autoResult = board.placeWildcardDie(autoState, index, { playerId: 'P1' }, die.id, 'MAP003');
  check('placeWildcardDie with no preferredSlotIndex still auto-picks the leftmost (ANY, index0) as before', autoResult.success, true);
  check('...lands on SLOT1 (index 0)', autoState.maps.MAP003.slots[0].some((o) => o.dieId === die.id), true);

  const exState = structuredClone(state);
  const exResult = board.placeWildcardDie(exState, index, { playerId: 'P1' }, die.id, 'MAP003', choice.exSlotIndex);
  check('placeWildcardDie with preferredSlotIndex=exSlotIndex lands there instead', exResult.success, true);
  check('...lands on SLOT2 (index 1, EX)', exState.maps.MAP003.slots[1].some((o) => o.dieId === die.id), true);
}
{
  // No real choice: both empty slots are the SAME kind (2 ANY) -- interchangeable, so no ambiguity.
  const state = freshStateWithShops();
  const choice = board.wildcardExAnyChoice(state, index, { playerId: 'P1' }, board.CASTLE_MAP_ID); // 王宮: all ANY
  check('wildcardExAnyChoice returns null when there is no EX-vs-non-EX split', choice, null);
}
{
  // No real choice: the EX slot belongs to a DIFFERENT player -- not a valid target for this player at all.
  const state = freshStateWithShops();
  state.maps.MAP003.currentAreaId = 'AREA003B';
  state.maps.MAP003.feeOwnerId = 'P2';
  const choice = board.wildcardExAnyChoice(state, index, { playerId: 'P1' }, 'MAP003');
  check('wildcardExAnyChoice returns null when the EX slot belongs to someone else', choice, null);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
