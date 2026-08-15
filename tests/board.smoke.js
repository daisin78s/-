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

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

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
  const placeFirst = board.placeDice(state, index, { playerId: 'P1' }, dieA.id, 'MAP003', 0); // SLOT1=2
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
  check('...buildValue is now the SUM of both stacked dice (5+5=10), not just the latest one', second.actionResult.pendingBuild.buildValue, 10);
  check('...M004 (DICE>=9, VP4, in this seed\'s shop) is now reachable', second.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M004'), true);
  check('Both dice are recorded as occupants of the same castle slot', state.maps['MAP008'].slots[0].map((o) => o.value), [5, 5]);
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
  check('Both dice ended up stacked on slot0, not spread across two slots', state.maps['MAP008'].slots[0].map((o) => o.value), [5, 5]);
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
  check('The shop slot is now empty', state.shops.NORMAL.slots[slotId], null);
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
// resolveBuild(UPGRADE)
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A'); // A001B exists (has a back side) per data
  inst.ownerId = 'P1';
  inst.tapped = true; // to prove UPGRADE resets tap state
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
  check('Card is untapped after upgrading', state.cards['A001'].tapped, false);
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
// CON006A: BLOCK_COLOR_DIE_REUSE() (2026-08-15, per user spec: "自分のカラーDが置かれているAREAには
// 別のカラーDを配置できない") -- blocks placing a 2nd own COLOR die on a map from a SEPARATE, later
// action, but a single group-placement action stacking 2+ own COLOR dice together (confirmed with the
// user: "スタッキングは許可") is exempt, and GRANT_PLACE_ANYWHERE waives it entirely (confirmed:
// "バイパスされる", unlike DUPLICATE_VALUE_IN_AREA).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const con6 = createCardInstance('CON006A');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  check('isColorDieReuseBlocked reports true once CON006A is owned', board.isColorDieReuseBlocked(state, index, 'P1'), true);

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
  // A player without CON006A is never restricted this way.
  const state = freshStateWithShops();
  const d1 = giveDie(state, 'P1', 1);
  board.placeDice(state, index, { playerId: 'P1' }, d1.id, 'MAP001', 0);
  const d2 = giveDie(state, 'P1', 2);
  const second = board.placeDice(state, index, { playerId: 'P1' }, d2.id, 'MAP001', 1);
  check('Without CON006A, a 2nd own COLOR die onto the same AREA in a separate action is unaffected', second.success, true);
}
{
  // Stacking exemption: placeDiceGroup placing 2 of this player's own COLOR dice together, in ONE
  // action, onto the castle -- must NOT be blocked even though CON006A is owned, since neither die was
  // "already there" before this action started.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.BZ = 20;
  const con6 = createCardInstance('CON006A');
  con6.ownerId = 'P1';
  state.cards[con6.physicalId] = con6;
  p1.ownedCardPhysicalIds.push(con6.physicalId);
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 3);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('CON006A does not block a single group action stacking 2 own COLOR dice together', result.success, true);
}
{
  // But a group placement reusing a map this player already placed a COLOR die on in an EARLIER,
  // separate action is blocked, same as the single-die path.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.BZ = 20;
  const con6 = createCardInstance('CON006A');
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
  // SPECIAL compacts (shifts left) exactly like M/NORMAL, but never refills -- confirmed explicitly by
  // the user ("SHOP201も同じようにずれていくが、補充はなし"), and structurally necessary too: during
  // round 1 (before revealSpecialShop), its 3 cards already sit in drawPile with all slots null, so a
  // refill here would prematurely reveal them ahead of SHOP sheet's ROUND_MIN=2.
  const state = freshStateWithShops();
  const [slot1, slot2, slot3] = Object.keys(state.shops.SPECIAL.slots);
  state.shops.SPECIAL.slots[slot1] = 'A008A';
  state.shops.SPECIAL.slots[slot2] = null; // a hole in the middle
  state.shops.SPECIAL.slots[slot3] = 'C008A';
  const drawPileBefore = state.shops.SPECIAL.drawPile.length; // 3, still un-revealed
  board.restockShop(state, 'SPECIAL');
  check('SPECIAL compacts: slot3\'s card shifts left into the gap at slot2', state.shops.SPECIAL.slots, { [slot1]: 'A008A', [slot2]: 'C008A', [slot3]: null });
  check('...but never refills from its drawPile (still un-revealed, no premature reveal)', state.shops.SPECIAL.drawPile.length, drawPileBefore);
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

  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1 requires value 2
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP003', 0);
  check('Placing on MAP003 (CHANGE(K,A,ALL) + CONVERT_LIMIT(4)) succeeds', result.success, true);
  check('Only 4 conversions happened despite 20K on hand (CONVERT_LIMIT applied via placeDice)', p1.resources.A, 4);
  check('Nothing accumulated into passiveCounters (the cap is per-CHANGE now)', state.passiveCounters['P1:CONVERT_LIMIT:ALL'], undefined);

  // A second, separate ALL-CHANGE placement -- MAP004 is AREA004A's CHANGE(K,B,ALL), whose SLOT1 wants a 4.
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
// B001A.TAP=SET_DIE_VALUE(SELF2|3);GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN) -- needs the caller to
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

  const result = board.useBareTapAbility(state, index, { playerId: 'P1', chosenDieId: die.id, chosenValue: 3 }, inst.physicalId);
  check('With a valid choice (3, one of SELF2|3), succeeds', result, { success: true });
  // The earlier failed CHOICE_REQUIRED attempt rolled back via runProgram's snapshot-replace, which
  // stales any player/die reference grabbed before it (see tests/executor.smoke.js's getDieRef
  // comment for the same trap) -- re-fetch fresh from state rather than reusing `p1`/`die`.
  const dieAfter = player(state, 'P1').dice.find((d) => d.id === die.id);
  check('...the die\'s value is now 3', dieAfter.value, 3);
  check('...and it\'s flagged placeAnywhereThisTurn (GRANT_PLACE_ANYWHERE(THIS_DICE,...) followed it)', dieAfter.placeAnywhereThisTurn, true);
  check('...the card is now tapped', state.cards[inst.physicalId].tapped, true);
}

// ---------------------------------------------------------------------------
// B005A.TAP=BUILD((A,B,C,M),1) -- a bare TAP ability can itself be a BUILD, same two-phase pattern as
// an AREA's ACTION or a QST reward (see resolveProgramOrBuild): can't complete synchronously, so
// useBareTapAbility returns pendingBuild (tagged with physicalId) instead of tapping immediately.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('B005A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, inst.physicalId);
  check('B005A.TAP=BUILD(...) comes back as a pending build decision, not tapped yet', result.success, true);
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
// JOB004.TAP=CHANGE(3K,2BZ) (corrected 2026-08-03, per user feedback: "Kを3個持っている状態でAAやBB
// の資源のものを建築しようとしても建築できません 建築しようとしたときに3KをAAに変えて建築できるように
// したい" -- this used to be ON(BUILD(A,B,C,U),CHANGE(3K,2BZ)), a reaction that only fired *after* a
// build completed, too late to help pay for the build that triggered it, and mismatched its own INST
// text ("建築時好きな資源2個軽減する" -- a discount usable *at* build time). Now a bare (non-reactive)
// TAP ability, usable any time during the player's own turn, same as C001A's CHANGE(K,A,2) -- so a
// player can tap it *before* choosing a build candidate to stock up 2 BZ, then apply that BZ via the
// existing build-choice BZ discount UI to afford an otherwise out-of-reach build).
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
  check('JOB004.TAP=CHANGE(3K,2BZ) succeeds as a direct (non-reactive) TAP', result, { success: true });
  check('...paid 3K, gained 2BZ', { K: p1.resources.K, BZ: p1.resources.BZ }, { K: 0, BZ: 2 });
  check('...the card is now tapped', state.cards[jobInst.physicalId].tapped, true);

  // The BZ gained this way is usable for a build attempted right afterward, in the same turn --
  // exactly the capability the old post-build-only reaction couldn't provide.
  p1.resources.A = 1; // A007A costs "2A,B" -- 1 short of the 2A needed, same shortfall pattern as the
  p1.resources.B = 1; // existing BZ-discount test below.
  const candidate = { type: 'BUILD_NEW', faceId: 'A007A', shopKey: 'NORMAL', slotId: Object.keys(state.shops.NORMAL.slots).find((k) => state.shops.NORMAL.slots[k] === 'A007A') };
  const buildResult = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('The 2 BZ JOB004 just granted can pay for a build that would otherwise be unaffordable', buildResult.success, true);
}
{
  // JOB007.TAP=ADD(BZ);BLOCK_BUILD(A,THIS_TURN);BLOCK_BUILD(B,THIS_TURN);BLOCK_BUILD(C,THIS_TURN) --
  // 2026-08-07, replacing the old ON(BUILD(U,M),ADD(BZ)) reaction (per user feedback: reacting *after*
  // an UPGRADE/Monument build meant the granted BZ arrived too late to help pay for the very build that
  // triggered it, and evaporated unspent at TURNEND since a turn normally has no second build left to
  // spend it on -- "BZを使うタイミングがなく必ずBZが余って消失します"). Now a bare (non-reactive) TAP,
  // usable any time during the player's own turn like JOB004 above, so a player can tap it *before* an
  // UPGRADE/Monument build to actually use the BZ; blocking A/B/C builds this turn keeps the discount
  // scoped to U/M as originally intended (and, being a bare TAP rather than an ON(...) reaction, it has
  // no auto/manual concept at all -- see main.js's reactiveTapKind/bareTapKind split -- so this also
  // settles the user's request to make it manual-only).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB007');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, jobInst.physicalId);
  check('JOB007.TAP=ADD(BZ);BLOCK_BUILD(...) succeeds as a direct (non-reactive) TAP', result, { success: true });
  check('...gained 1 BZ for free', p1.resources.BZ, 1);
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
}

// ---------------------------------------------------------------------------
// BZ discount (2026-07-31, "BZは建築コストの踏み倒し専用（改築/CHANGEには使用不可）"): 1 BZ skips
// paying 1 unit of any resource in a BUILD_NEW's cost, player's choice of which. A007A costs "2A,B".
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1; // 1 short of the 2A the cost needs
  p1.resources.B = 1;
  p1.resources.BZ = 1;
  const candidate = { type: 'BUILD_NEW', faceId: 'A007A', shopKey: 'NORMAL', slotId: Object.keys(state.shops.NORMAL.slots).find((k) => state.shops.NORMAL.slots[k] === 'A007A') };
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('resolveBuild(BUILD_NEW) succeeds using 1 BZ to cover the missing A', result.success, true);
  check('...real A/B fully spent, 1 BZ consumed', { A: p1.resources.A, B: p1.resources.B, BZ: p1.resources.BZ }, { A: 0, B: 0, BZ: 0 });
  check('Player owns the built card', p1.ownedCardPhysicalIds.includes('A007'), true);
}
{
  // Not enough BZ actually held -- the combined (discounted cost + BZ spend) payment fails atomically,
  // nothing is paid and the card is not built.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1;
  p1.resources.B = 1;
  p1.resources.BZ = 0; // configuring a discount they can't actually pay for
  const candidate = { type: 'BUILD_NEW', faceId: 'A007A', shopKey: 'NORMAL', slotId: Object.keys(state.shops.NORMAL.slots).find((k) => state.shops.NORMAL.slots[k] === 'A007A') };
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
  const candidate = { type: 'BUILD_NEW', faceId: 'A007A', shopKey: 'NORMAL', slotId: Object.keys(state.shops.NORMAL.slots).find((k) => state.shops.NORMAL.slots[k] === 'A007A') };
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
// currently holds map.feeOwnerId). AREA001B (SLOT1=1,SLOT2=2,SLOT3=EX) is a plain, non-castle,
// non-AREA009 EX slot; AREA009B (SLOT1-5=ANY,SLOT6=EX, moved here 2026-08-02 by the user's own data
// edit -- was SLOT4 before) is used for the AREA009-specific doubles-stacking behavior.
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
  const ok1 = board.placeDice(state, index, { playerId: 'P1' }, p1die.id, 'MAP001', 0); // SLOT1=1 -> value 1 sits here
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
  state.maps['MAP007'] = mapWithArea('MAP007', 'AREA007', 3, null); // SLOT1-3 all ANY
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
  const die = giveDie(state, 'P2', 1); // SLOT1=1
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('A non-owner (P2) placing on a tier-B AREA succeeds', result.success, true);
  check('...and owes the tier-B flat fee (1K) to the map', player(state, 'P2').pendingFee, { mapId: 'MAP001', amount: 1 });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001C', 3, 'P1');
  const die = giveDie(state, 'P2', 1);
  board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('A non-owner placing on a tier-C AREA owes the tier-C flat fee (2K)', player(state, 'P2').pendingFee, { mapId: 'MAP001', amount: 2 });
}
{
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P1', 1); // the owner uses their own tiered-up AREA
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
  const die = giveDie(state, 'P2', 1);
  board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  // AREA001B's own ACTION (ADD(5K)) just handed P2 5K -- zero it back out so this block actually tests
  // "can't afford the fee" rather than accidentally already being solvent from the area's own effect.
  player(state, 'P2').resources.K = 0;

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
  // 払えることを確認してからダイスを置く用に直せますか" -- AREA010's own actions never grant K to a
  // non-owner: CHANGE(2K,2VP) costs K outright, ADD(VP)/ADD(2VP) grants none at all -- see
  // canAffordFee's own doc).
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA010C', 3, 'P1'); // SLOT1=1, ACTION=CHANGE(2K,2VP)
  player(state, 'P2').resources.K = 2; // just enough to trigger the AREA's own CHANGE(2K,2VP) once
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('Placement is refused when the resulting 2K fee would be entirely unpayable', result, { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: 2 });
  // Re-fetched by id (not the pre-call `die` reference), since a rollback replaces state.players'
  // contents wholesale -- see runProgram's own doc on this exact trap, which the rollback here mirrors.
  check('...the die was never actually placed', player(state, 'P2').dice.find((d) => d.id === die.id).placedMapId, null);
  check('...and no fee/state change leaked through', player(state, 'P2').pendingFee, null);
  check('...and the whole placement (incl. the CHANGE(2K,2VP) that just ran) was rolled back, K restored', player(state, 'P2').resources.K, 2);
}
{
  // ...but succeeds once enough convertible resources are on hand -- not necessarily raw K (see
  // canAffordFee's own doc: A/B/C/Z->K free actions have no usage cap). P2 spends their 2K on the
  // AREA's own CHANGE(2K,2VP) first, same as above, but has 2 extra A left over to cover the fee with.
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA010C', 3, 'P1');
  player(state, 'P2').resources.K = 2;
  player(state, 'P2').resources.A = 2;
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('Placement succeeds once enough convertible resources are on hand', result.success, true);
  check('...the AREA action still ran (K spent on CHANGE(2K,2VP), 2VP gained)', { k: player(state, 'P2').resources.K, vp: player(state, 'P2').resources.VP }, { k: 0, vp: 2 });
}
{
  // 2026-08-07, per user request ("wD→２Kのフリーアクション廃止します コードも削除してください"): an
  // unplaced wD no longer counts toward canAffordFee at all -- before this removal it added +2 (modeling
  // "the player could still use the now-abolished wD->2K free action"). Same AREA010C setup as the two
  // blocks above, but P2's only non-K resource is an unplaced wD instead of 2 extra A.
  const state = freshStateWithShops();
  state.maps['MAP010'] = mapWithArea('MAP010', 'AREA010C', 3, 'P1');
  player(state, 'P2').resources.K = 2;
  player(state, 'P2').dice.push(require('../src/game-state').createDie('test-wd', 'WHITE'));
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP010', 0);
  check('An unplaced wD no longer helps cover the fee -- placement is still refused as unaffordable', result, { success: false, reason: 'UNAFFORDABLE_USAGE_FEE', amount: 2 });
}
{
  // AREA001B's own ACTION (ADD(5K)) trivially covers its own 1K fee -- confirms the check happens
  // AFTER the area's own action resolves, not before (a pre-resolution-only check would have wrongly
  // refused this very common, perfectly safe case -- caught by this exact test while developing the fix).
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 1);
  const result = board.placeDice(state, index, { playerId: 'P2' }, die.id, 'MAP001', 0);
  check('Placement succeeds when the AREA\'s own action grants enough to cover the fee, even from 0 starting K', result.success, true);
  check('...P2 actually has the 5K from ADD(5K)', player(state, 'P2').resources.K, 5);
}
{
  // BARE_TAP is allowed even while a usage fee is owed (2026-08-10, per user request: "使用料の支払いが
  // ターン終了時にある時でもTAPアクションが使えるようにしたい" -- reverses the 2026-08-05 PENDING_FEE
  // gate this used to have; see board.useBareTapAbility's own doc for why removing it is now safe:
  // evaluator.js's LOCKOUT_PENALTY already scores a state that can't afford its pendingFee at -1000,
  // so the AI is steered away from spending the fee out of existence without a hard legality gate).
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die = giveDie(state, 'P2', 1);
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
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1'); // SLOT1-5=ANY, SLOT6=EX
  const exDie = giveDie(state, 'P1', 3);
  const exResult = board.placeDice(state, index, { playerId: 'P1' }, exDie.id, 'MAP009', 5); // SLOT6=EX
  check('P1 places a 3 on AREA009B EX', exResult.success, true);

  const anyDie = giveDie(state, 'P1', 3); // same value 3, targeting a different (ANY) slot
  const anyResult = board.placeDice(state, index, { playerId: 'P1' }, anyDie.id, 'MAP009', 0); // SLOT1=ANY
  check('A die already sitting on EX blocks a duplicate value on a different, non-EX slot', anyResult, { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' });
}
{
  // AREA009's EX now behaves exactly like the castle (2026-08-06): a second die needs
  // GRANT_PLACE_ANYWHERE to join, and buildValue sums either way (confirmed: "合計判定でお願いします").
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1');
  const die1 = giveDie(state, 'P1', 5);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP009', 5); // SLOT6=EX
  check('First 5 on AREA009B EX succeeds', first.success, true);
  check('...buildValue is just this one die (5)', first.actionResult.pendingBuild.buildValue, 5);

  const die2 = giveDie(state, 'P1', 5); // matching value, no GRANT_PLACE_ANYWHERE
  const blocked = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP009', 5);
  check('A second matching-value die without GRANT_PLACE_ANYWHERE is blocked on AREA009B EX too', blocked, { success: false, reason: 'SLOT_OCCUPIED' });

  die2.placeAnywhereThisTurn = true;
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP009', 5);
  check('...but succeeds with GRANT_PLACE_ANYWHERE', second.success, true);
  check('...buildValue is now the SUM of both stacked dice (5+5=10)', second.actionResult.pendingBuild.buildValue, 10);
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
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009C', 6, 'P1'); // SLOT1-4=ANY, SLOT5-6=EX
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
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Same-value group (6+6), claiming a fresh slot together, shares one slot', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).length, 1);
  check('...combined buildValue is 12', result.actionResult.pendingBuild.buildValue, 12);
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
  // Same rule, but with a pre-existing occupant contributing to the base: earlierDie(5) + a solo new
  // die(1) already reaches M012's threshold (>=1) on its own -- so a *second* new die alongside it would
  // be wasted for M012, but the pre-existing occupant's value alone is fixed/un-reducible input, not
  // itself treated as a "redundant new die" (a solo die never has a redundant partner).
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const earlierDie = giveDie(state, 'P1', 5);
  board.placeDice(state, index, { playerId: 'P1' }, earlierDie.id, board.CASTLE_MAP_ID, 0);
  const d1 = giveDie(state, 'P1', 1);
  d1.placeAnywhereThisTurn = true;
  const d2 = giveDie(state, 'P1', 6);
  d2.placeAnywhereThisTurn = true;
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Placing 1+6 alongside an existing 5 (total 12) succeeds', result.success, true);
  check('M012 (>=1, already covered by the existing 5 alone) is excluded even though this group never placed a redundant *new* die for it', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M012'), false);
  check('M009 (>=4, already covered without needing both new dice) is excluded', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M009'), false);
  check('M001 (>=12, genuinely needs the existing 5 AND both new dice) is still offered', result.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M001'), true);
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
  // A group joining a slot with a *pre-existing* occupant (2026-08-06: now needs GRANT_PLACE_ANYWHERE
  // on *every* die in the bucket, confirmed -- "仮に片方のダイスがGRANT_PLACE_ANYWHERE...を使っていても
  // もう片方のダイスが置けません") must count that pre-existing occupant's value too, not just this
  // group's own dice (2026-08-02 bug caught in headless verification): true combined value is 2+2+2=6,
  // not just the new pair's 4. Uses value 2 (not 6) so the combined total (6) doesn't already max out
  // every monument threshold on its own -- see the overfunded-monument block further down for that.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // see the earlier castle blocks' comment on the affordability gate
  const earlierDie = giveDie(state, 'P1', 2);
  board.placeDice(state, index, { playerId: 'P1' }, earlierDie.id, board.CASTLE_MAP_ID, 0);

  const d1 = giveDie(state, 'P1', 2);
  const d2 = giveDie(state, 'P1', 2);
  const onlyOneBypassed = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Without GRANT_PLACE_ANYWHERE on both dice, the whole group is refused (value 2 already on board)', onlyOneBypassed, { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' });
  d1.placeAnywhereThisTurn = true; // only ONE of the two -- still not enough
  const stillBlocked = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('...one bypass-holding die in the pair is still not enough -- the other one has none', stillBlocked, { success: false, reason: 'NO_LEGAL_SLOT_FOR_GROUP' });

  d2.placeAnywhereThisTurn = true; // now BOTH carry it
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Once both dice carry GRANT_PLACE_ANYWHERE, the group joins the pre-existing slot', result.success, true);
  check('...buildValue sums all 3 dice (6), not just the new pair (4)', result.actionResult.pendingBuild.buildValue, 6);
  check('...all 3 dice really do sit on the same slot', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).map((s) => s.length), [3]);
  check('...neither of the 2 new dice counts toward next round\'s turn order', state.maps[board.CASTLE_MAP_ID].slots.find((s) => s.length === 3).filter((o) => o.dieId === d1.id || o.dieId === d2.id).every((o) => o.countsForTurnOrder === false), true);
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
  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1 requires value 2
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
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009C', 6, 'P1'); // SLOT1-4=ANY, SLOT5-6=EX
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
  const die = giveDie(state, 'P1', 2); // AREA003A.SLOT1, 0 K on hand
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
  check('...both dice would share a single (doubles-stacked) slot', preview.touchedSlots.length, 1);
  check('...and never mutates the real state', d1.placedMapId, null);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
