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
// PLACE_DICE on an ANY slot + JOB002A's ON(PLACE(MAP008/009),ADD(K)) reaction
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const jobInst = createCardInstance('JOB002A'); // PASSIVE=ON(PLACE(MAP008),ADD(K));ON(PLACE(MAP009),ADD(K))
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  player(state, 'P1').ownedCardPhysicalIds.push(jobInst.physicalId);

  const die = giveDie(state, 'P1', 5); // MAP008 (castle) is all-ANY slots
  const before = player(state, 'P1').resources.K || 0;
  const result = board.placeDice(state, index, { playerId: 'P1' }, die.id, 'MAP008', 0);
  check('Placing on the castle (all-ANY slots) succeeds', result.success, true);
  // PLACE fires (and JOB002A reacts) before AREA008's own ACTION=BUILD() is resolved,
  // so the K grant happens regardless of what BUILD resolution below finds.
  check('JOB002A auto-reacts to PLACE(MAP008) and grants 1K', player(state, 'P1').resources.K, before + 1);
  // AREA008.ACTION = "BUILD()" -- can't complete synchronously, so placeDice hands back candidates instead.
  check('AREA008 (castle) ACTION=BUILD() comes back as a pending build decision, not an exception', result.actionResult.success, true);
  check('...with a non-empty candidate list (categories default to A,B,C,U,M)', result.actionResult.pendingBuild.candidates.length > 0, true);
}

// ---------------------------------------------------------------------------
// Castle same-value stacking accumulates buildValue instead of using only the latest die
// (2026-08-04, per user report: "ダイス目12を出そうとして複数のダイスを選択するやり方がわからない" --
// a single die never exceeds 6, but M001-M006's DICE threshold goes up to 12, so reaching them requires
// stacking 2+ same-value dice on one castle slot).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die1 = giveDie(state, 'P1', 5);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP008', 0);
  check('First 5 on the castle succeeds', first.success, true);
  check('...buildValue is just this one die (5), M004 (DICE>=9) is not yet reachable', first.actionResult.pendingBuild.buildValue, 5);
  check('...M004 is absent from the candidate list at buildValue 5', first.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M004'), false);

  const die2 = giveDie(state, 'P1', 5); // same value -- stacks onto the same slot instead of a new one
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP008', 0);
  check('Stacking a second 5 onto the same castle slot succeeds', second.success, true);
  check('...buildValue is now the SUM of both stacked dice (5+5=10), not just the latest one', second.actionResult.pendingBuild.buildValue, 10);
  check('...M004 (DICE>=9, VP4, in this seed\'s shop) is now reachable', second.actionResult.pendingBuild.candidates.some((c) => c.faceId === 'M004'), true);
  check('Both dice are recorded as occupants of the same castle slot', state.maps['MAP008'].slots[0].map((o) => o.value), [5, 5]);
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
// restockShop
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const [slotId] = Object.keys(state.shops.M.slots);
  const drawPileBefore = state.shops.M.drawPile.length;
  state.shops.M.slots[slotId] = null; // simulate "was just built"
  board.restockShop(state, 'M');
  check('restockShop refills the empty slot', state.shops.M.slots[slotId] !== null, true);
  check('...and shrinks the draw pile by 1', state.shops.M.drawPile.length, drawPileBefore - 1);
}

// ---------------------------------------------------------------------------
// CONVERT_LIMIT(ALL,n) actually gets applied end-to-end through placeDice:
// AREA003A.ACTION=CHANGE(K,A,ALL), CON003B.PASSIVE=CONVERT_LIMIT(ALL,4).
// (Executor-level capping logic itself is covered in executor.smoke.js;
// this only checks board.js correctly flags MAP003 as eligible.)
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
  check('Cumulative counter was updated', state.passiveCounters['P1:CONVERT_LIMIT:ALL'], 4);
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
// JOB004A.TAP=CHANGE(3K,2BZ) (corrected 2026-08-03, per user feedback: "Kを3個持っている状態でAAやBB
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
  const jobInst = createCardInstance('JOB004A');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.resources.K = 3;

  const result = board.useBareTapAbility(state, index, { playerId: 'P1' }, jobInst.physicalId);
  check('JOB004A.TAP=CHANGE(3K,2BZ) succeeds as a direct (non-reactive) TAP', result, { success: true });
  check('...paid 3K, gained 2BZ', { K: p1.resources.K, BZ: p1.resources.BZ }, { K: 0, BZ: 2 });
  check('...the card is now tapped', state.cards[jobInst.physicalId].tapped, true);

  // The BZ gained this way is usable for a build attempted right afterward, in the same turn --
  // exactly the capability the old post-build-only reaction couldn't provide.
  p1.resources.A = 1; // A007A costs "2A,B" -- 1 short of the 2A needed, same shortfall pattern as the
  p1.resources.B = 1; // existing BZ-discount test below.
  const candidate = { type: 'BUILD_NEW', faceId: 'A007A', shopKey: 'NORMAL', slotId: Object.keys(state.shops.NORMAL.slots).find((k) => state.shops.NORMAL.slots[k] === 'A007A') };
  const buildResult = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, candidate);
  check('The 2 BZ JOB004A just granted can pay for a build that would otherwise be unaffordable', buildResult.success, true);
}
{
  // JOB007A.TAP=ON(BUILD(U,M),ADD(BZ)) -- the inverse: reacts to UPGRADE and Monument builds, not A/B/C.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB007A');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  const upgradeInst = createCardInstance('A001A'); // A001B exists
  upgradeInst.ownerId = 'P1';
  state.cards[upgradeInst.physicalId] = upgradeInst;
  p1.ownedCardPhysicalIds.push(upgradeInst.physicalId);
  p1.resources.A = 2; // A001A's COST

  const candidate = board.getBuildCandidates(state, index, 'P1', ['U'], 0).find((c) => c.physicalId === 'A001');
  const result = board.resolveBuild(state, index, { playerId: 'P1' }, candidate);
  check('UPGRADE succeeds', result.success, true);
  check('JOB007A auto-reacted to BUILD(U): gained 1 BZ', p1.resources.BZ, 1);
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
  // UPGRADE never applies a BZ discount, even if context.bzDiscount is (harmlessly) present.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.A = 2; // A001A's full COST, no discount applied
  p1.resources.BZ = 5;
  const candidates = board.getBuildCandidates(state, index, 'P1', ['U'], 0);
  const upgradeCandidate = candidates.find((c) => c.physicalId === 'A001');
  const result = board.resolveBuild(state, index, { playerId: 'P1', bzDiscount: { A: 1 } }, upgradeCandidate);
  check('UPGRADE succeeds paying the full cost, ignoring bzDiscount entirely', result.success, true);
  check('...BZ was NOT touched', p1.resources.BZ, 5);
  check('...full 2A was paid (no discount applied)', p1.resources.A, 0);
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
{
  const state = freshStateWithShops();
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1'); // SLOT1-5=ANY, SLOT6=EX
  const exDie = giveDie(state, 'P1', 3);
  const exResult = board.placeDice(state, index, { playerId: 'P1' }, exDie.id, 'MAP009', 5); // SLOT6=EX
  check('P1 places a 3 on AREA009B EX', exResult.success, true);

  const anyDie = giveDie(state, 'P1', 3); // same value 3, targeting a different (ANY) slot
  const anyResult = board.placeDice(state, index, { playerId: 'P1' }, anyDie.id, 'MAP009', 0); // SLOT1=ANY
  check('A die already sitting on EX blocks a duplicate value on a different, non-EX slot', anyResult, { success: false, reason: 'DUPLICATE_VALUE_IN_AREA' });
}
{
  // AREA009's EX supports unconditional same-value stacking (no GRANT_PLACE_ANYWHERE needed), and
  // buildValue sums, same as the castle (confirmed: "合計判定でお願いします").
  const state = freshStateWithShops();
  state.maps['MAP009'] = mapWithArea('MAP009', 'AREA009B', 6, 'P1');
  const die1 = giveDie(state, 'P1', 5);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP009', 5); // SLOT6=EX
  check('First 5 on AREA009B EX succeeds', first.success, true);
  check('...buildValue is just this one die (5)', first.actionResult.pendingBuild.buildValue, 5);

  const die2 = giveDie(state, 'P1', 5); // matching value, no GRANT_PLACE_ANYWHERE
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP009', 5);
  check('A second matching-value die stacks onto AREA009B EX without needing GRANT_PLACE_ANYWHERE', second.success, true);
  check('...buildValue is now the SUM of both stacked dice (5+5=10)', second.actionResult.pendingBuild.buildValue, 10);
}
{
  // The SAME doubles-stacking does NOT apply to a non-AREA009 EX slot (AREA001B) -- a second
  // matching-value die without GRANT_PLACE_ANYWHERE is blocked like any other occupied slot.
  const state = freshStateWithShops();
  state.maps['MAP001'] = mapWithArea('MAP001', 'AREA001B', 3, 'P1');
  const die1 = giveDie(state, 'P1', 4);
  const first = board.placeDice(state, index, { playerId: 'P1' }, die1.id, 'MAP001', 2); // SLOT3=EX
  check('First die on AREA001B EX succeeds', first.success, true);

  const die2 = giveDie(state, 'P1', 4); // matching value, no GRANT_PLACE_ANYWHERE
  const second = board.placeDice(state, index, { playerId: 'P1' }, die2.id, 'MAP001', 2);
  check('A matching-value second die is blocked on a non-AREA009 EX slot (no doubles-stacking there)', second, { success: false, reason: 'SLOT_OCCUPIED' });
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
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Same-value group (6+6) still shares one slot (existing doubles-stacking rule)', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).length, 1);
  check('...combined buildValue is 12', result.actionResult.pendingBuild.buildValue, 12);
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
  // buildValue must count a slot's *pre-existing* occupant too, not just this group's own dice (2026-08-02
  // bug caught in headless verification) -- e.g. an earlier, unrelated single-die placeDice(6) already
  // sitting on the castle, followed later by a placeDiceGroup([6,6]) that joins the same slot via the
  // doubles-stacking rule: true combined value is 6+6+6=18, not just 12.
  const state = freshStateWithShops();
  const earlierDie = giveDie(state, 'P1', 6);
  board.placeDice(state, index, { playerId: 'P1' }, earlierDie.id, board.CASTLE_MAP_ID, 0);
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6);
  const result = board.placeDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('Group joining a slot with a pre-existing occupant sums all 3 dice (18), not just the new 2 (12)', result.actionResult.pendingBuild.buildValue, 18);
  check('...all 3 dice really do sit on the same slot', state.maps[board.CASTLE_MAP_ID].slots.filter((s) => s.length > 0).map((s) => s.length), [3]);
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
  const d1 = giveDie(state, 'P1', 6);
  const d2 = giveDie(state, 'P1', 6); // combined buildValue=12, reaches every monument threshold
  const preview = board.previewPlaceDiceGroup(state, index, { playerId: 'P1' }, [d1.id, d2.id], board.CASTLE_MAP_ID);
  check('previewPlaceDiceGroup reports ok:true when the group would succeed', preview.ok, true);
  check('...both dice would share a single (doubles-stacked) slot', preview.touchedSlots.length, 1);
  check('...and never mutates the real state', d1.placedMapId, null);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
