/**
 * Integration smoke test: full setup -> round 1 (interleaved onboarding +
 * first turns for all 4 players) -> a couple of ordinary round-robin turns
 * -> forced round end -> round 2 start (dice reroll, special shop reveal).
 * Run: node tests/turn-flow.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createMapState } = require('../src/game-state');
const setup = require('../src/setup');
const board = require('../src/board');
const turnFlow = require('../src/turn-flow');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

// Avoids MAP008/MAP009 (both ACTION=BUILD()) so this test doesn't also have to drive
// build-candidate selection -- BUILD/UPGRADE are already covered by board.smoke.js.
const NON_BUILD_MAP_IDS = Object.keys(index.raw.MAP.reduce((acc, r) => ({ ...acc, [r.ID]: true }), {})).filter(
  (id) => id !== 'MAP008' && id !== 'MAP009'
);

function placeFirstLegalDie(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const die = player.dice.find((d) => d.placedMapId === null);
  if (!die) return null;
  for (const mapId of NON_BUILD_MAP_IDS) {
    const map = state.maps[mapId];
    const areaRow = require('../src/data-loader').getAreaRow(index, map.currentAreaId);
    const requirements = board.getSlotRequirements(areaRow);
    for (let slotIndex = 0; slotIndex < requirements.length; slotIndex++) {
      if (map.slots[slotIndex].length > 0) continue;
      const req = requirements[slotIndex];
      if (req !== 'ANY' && req !== die.value) continue;
      if (map.slots.some((occ) => occ.some((o) => o.value === die.value))) continue;
      const result = board.placeDice(state, index, { playerId }, die.id, mapId, slotIndex);
      if (result.success) return { mapId, slotIndex, result };
    }
  }
  return null;
}

function setupGame() {
  const state = createEmptyGameState('turn-flow-smoke');
  setup.createPlayers(state, ['Alice', 'Bob', 'Carol', 'Dan']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  setup.dealConCards(state);
  setup.dealResourceCandidates(state, index);
  for (const player of state.players) {
    const choice = state.pendingChoices.find((c) => c.playerId === player.id);
    setup.chooseResourceCards(state, player.id, choice.context.candidates.slice(0, 2));
  }
  setup.computeStartOrder(state, index);
  return state;
}

const state = setupGame();

// ---------------------------------------------------------------------------
// Round 1: interleaved onboarding + first turn, in turnOrder
// ---------------------------------------------------------------------------
turnFlow.startRound(state);
check('startRound(1) sets round=1', state.round, 1);

setup.dealJobPool(state); // confirmed: 6 of 8 JOB cards revealed as a shared draft pool
check('dealJobPool reveals exactly 6 of the 8 JOB cards', state.jobPool.length, 6);

for (let i = 0; i < state.turnOrder.length; i++) {
  const expectedPlayerId = state.turnOrder[i];

  const onboardingStep = turnFlow.getNextTurn(state);
  check(`getNextTurn() says ${expectedPlayerId} needs onboarding (turn ${i + 1}/4)`, onboardingStep, { type: 'ONBOARDING_NEEDED', playerId: expectedPlayerId, playerIndex: i });

  setup.chooseJob(state, index, expectedPlayerId, state.jobPool[0]); // draft in start-play order, confirmed
  setup.chooseConFace(state, index, expectedPlayerId, 'A');
  setup.receiveInitialResources(state, index, expectedPlayerId);

  const turnStep = turnFlow.getNextTurn(state);
  check(`After onboarding, getNextTurn() now says TURN for ${expectedPlayerId}`, turnStep, { type: 'TURN', playerId: expectedPlayerId, playerIndex: i });

  const placement = placeFirstLegalDie(state, expectedPlayerId);
  assertTrue(`${expectedPlayerId} found a legal first placement`, placement !== null);

  const endResult = turnFlow.endTurn(state, index, expectedPlayerId);
  check(`endTurn succeeds for ${expectedPlayerId}`, endResult.success, true);
}

// ---------------------------------------------------------------------------
// After all 4 have onboarded + taken turn 1, round-robin continues with no
// more onboarding (round 2 of dice-placement, still round 1 of the game).
// ---------------------------------------------------------------------------
{
  const next = turnFlow.getNextTurn(state);
  check('No more onboarding needed once all 4 players have jobs', next.type, 'TURN');
  check('Round-robin wrapped back to turnOrder[0]', next.playerId, state.turnOrder[0]);
}

// ---------------------------------------------------------------------------
// FEE_COLLECT's reset is round-scoped, not turn-scoped (confirmed rule): tapping it now should still
// show tapped after an endTurn. (A/B/C/Z->K and wD->2K have no usage limit at all -- confirmed
// 2026-08-02, "回数制限ありません" -- so FEE_COLLECT is the only free action still worth testing here.)
// ---------------------------------------------------------------------------
{
  const p0 = state.turnOrder[0];
  const player = state.players.find((p) => p.id === p0);
  const executor = require('../src/executor');
  state.maps['MAP001'].feeOwnerId = p0;
  state.maps['MAP001'].accumulatedFee = 2;
  executor.collectUsageFee(state, index, { playerId: p0 }, 'MAP001');
  check('FEE_COLLECT is tapped', player.freeActionTaps.FEE_COLLECT, true);
  const placement = placeFirstLegalDie(state, p0);
  assertTrue(`${p0} found a legal placement on their 2nd turn`, placement !== null);
  turnFlow.endTurn(state, index, p0);
  check('FEE_COLLECT is STILL tapped after endTurn (round-scoped, not turn-scoped)', player.freeActionTaps.FEE_COLLECT, true);
}

// ---------------------------------------------------------------------------
// Force the round to finish (place every remaining die directly -- the
// legal-placement search isn't guaranteed to succeed once slots fill up
// deep into a round, and that's not what this test is verifying) and check
// endRound()/startRound(2) integration: dice return, slots clear, free
// actions untap, special shop reveals, dice reroll.
// ---------------------------------------------------------------------------
const beforeDiceValues = state.players.map((p) => p.dice.map((d) => d.value));
for (const player of state.players) {
  for (const die of player.dice) die.placedMapId = die.placedMapId || 'MAP001'; // force-mark placed
}
check('isRoundOver() is true once every die is placed', turnFlow.isRoundOver(state), true);

turnFlow.endRound(state, index); // round 1 < 4 -> also bulk-rerolls every COLOR die (confirmed rule)
assertTrue('endRound() returns every die to hand', state.players.every((p) => p.dice.every((d) => d.placedMapId === null)));
assertTrue('endRound() clears every map slot', Object.values(state.maps).every((m) => m.slots.every((occ) => occ.length === 0)));
{
  const p0 = state.turnOrder[0];
  check('endRound() untaps free actions (round-scoped reset)', state.players.find((p) => p.id === p0).freeActionTaps.A_K, false);
}
check('Special shop is still hidden at the end of round 1', Object.values(state.shops.SPECIAL.slots).filter(Boolean).length, 0);
const afterDiceValues = state.players.map((p) => p.dice.map((d) => d.value));
assertTrue('endRound() re-rolled at least one color die (astronomically unlikely all stayed identical)', JSON.stringify(beforeDiceValues) !== JSON.stringify(afterDiceValues));

turnFlow.startRound(state);
check('startRound(2) sets round=2', state.round, 2);
check('startRound(2) reveals the special shop', Object.values(state.shops.SPECIAL.slots).filter(Boolean).length, 3);
check('startRound(2) itself does not touch dice (already rerolled at the previous endRound)', state.players.map((p) => p.dice.map((d) => d.value)), afterDiceValues);

// ---------------------------------------------------------------------------
// computeNextRoundTurnOrder: the user's worked example (2026-07-29) --
// castle placements in order Red, Green, Green, Red (P2=BLUE and P3=YELLOW
// never place there) should yield [Red, Green, <old order of the rest>].
// A GRANT_PLACE_ANYWHERE-forced placement into an occupied slot must NOT
// count toward this, even though the die is genuinely placed there.
// ---------------------------------------------------------------------------
{
  const { createEmptyGameState: freshEmptyState } = require('../src/game-state');
  const s = freshEmptyState('castle-turn-order-smoke');
  setup.createPlayers(s, ['Red', 'Blue', 'Yellow', 'Green']); // P1=RED, P2=BLUE, P3=YELLOW, P4=GREEN
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index); // AREA008's ACTION=BUILD() needs shop state to resolve
  s.turnOrder = ['P1', 'P2', 'P3', 'P4']; // this round's (soon-to-be "previous round's") order
  // BZ (2026-08-04, per user feedback: "AREA008 009は建築完了出来ないときはダイスが置けません" --
  // castle placement now requires at least one AFFORDABLE candidate; a generous grant for both players
  // who place here covers whatever the cheapest candidate turns out to be, unrelated to what this test
  // is actually checking (turn-order recency).
  s.players.find((p) => p.id === 'P1').resources.BZ = 20;
  s.players.find((p) => p.id === 'P4').resources.BZ = 20;

  const giveCastleDie = (playerId, value) => {
    const die = require('../src/game-state').createDie(`${playerId}-${value}-${Math.random()}`, 'COLOR');
    die.value = value;
    s.players.find((p) => p.id === playerId).dice.push(die);
    return die;
  };

  const red1 = giveCastleDie('P1', 1);
  board.placeDice(s, index, { playerId: 'P1' }, red1.id, 'MAP008', 0);
  const green1 = giveCastleDie('P4', 2);
  board.placeDice(s, index, { playerId: 'P4' }, green1.id, 'MAP008', 1);
  const green2 = giveCastleDie('P4', 3);
  board.placeDice(s, index, { playerId: 'P4' }, green2.id, 'MAP008', 2);
  const red2 = giveCastleDie('P1', 4);
  board.placeDice(s, index, { playerId: 'P1' }, red2.id, 'MAP008', 3);

  const nextOrder = turnFlow.computeNextRoundTurnOrder(s);
  check('Castle sequence Red,Green,Green,Red -> [Red, Green, Blue, Yellow] (Red/Green by recency, Blue/Yellow keep prior relative order)', nextOrder, ['P1', 'P4', 'P2', 'P3']);
}
{
  const { createEmptyGameState: freshEmptyState } = require('../src/game-state');
  const s = freshEmptyState('castle-grant-place-anywhere-smoke');
  setup.createPlayers(s, ['Red', 'Blue', 'Yellow', 'Green']);
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index);
  s.turnOrder = ['P1', 'P2', 'P3', 'P4'];
  // BZ (see the previous block's comment on the new castle affordability gate).
  s.players.find((p) => p.id === 'P1').resources.BZ = 20;
  s.players.find((p) => p.id === 'P2').resources.BZ = 20;

  const gs = require('../src/game-state');
  const redDie = gs.createDie('red-1', 'COLOR');
  redDie.value = 1;
  s.players.find((p) => p.id === 'P1').dice.push(redDie);
  board.placeDice(s, index, { playerId: 'P1' }, redDie.id, 'MAP008', 0);

  const blueDie = gs.createDie('blue-1', 'COLOR');
  blueDie.value = 5; // different value, would normally need a fresh (empty) slot
  blueDie.placeAnywhereThisTurn = true; // simulates having tapped B001A/etc. this turn
  s.players.find((p) => p.id === 'P2').dice.push(blueDie);
  const forced = board.placeDice(s, index, { playerId: 'P2' }, blueDie.id, 'MAP008', 0); // forced into Red's occupied slot
  check('GRANT_PLACE_ANYWHERE lets Blue force into Red\'s occupied castle slot', forced.success, true);
  check('...both dice now occupy that one slot', s.maps['MAP008'].slots[0].length, 2);

  const nextOrder = turnFlow.computeNextRoundTurnOrder(s);
  check('Blue\'s forced placement does NOT count for turn order (only Red placed "for real")', nextOrder, ['P1', 'P2', 'P3', 'P4']);
}

// ---------------------------------------------------------------------------
// Unused color dice auto-resolve to 3K at round end (confirmed 2026-07-29):
// a die the player never placed this round is NOT just left alone -- it
// grants 3K, which is what makes it "used" and thus eligible for the same
// collection+reroll as an actually-placed die. Round 4 still grants the 3K
// (only the *reroll* is skipped in round 4, not this fallback).
// ---------------------------------------------------------------------------
{
  const { createEmptyGameState: freshEmptyState, createDie: freshDie } = require('../src/game-state');
  const s = freshEmptyState('unused-die-3k-smoke');
  setup.createPlayers(s, ['Alice']);
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index);
  s.turnOrder = ['P1'];
  s.round = 1;

  const placedDie = freshDie('placed-1', 'COLOR');
  placedDie.value = 3;
  const unusedDie = freshDie('unused-1', 'COLOR');
  unusedDie.value = 5;
  s.players[0].dice.push(placedDie, unusedDie);
  placedDie.placedMapId = 'MAP001'; // simulate having actually been placed this round; unusedDie was not

  const beforeK = s.players[0].resources.K;
  turnFlow.endRound(s, index);
  check('An unused color die grants its owner 3K at round end', s.players[0].resources.K, beforeK + 3);
  check('A die that WAS placed grants nothing extra', s.players[0].dice.length, 2); // (no die was removed/duplicated)
  assertTrue('Both dice are collected (back in hand) after endRound', s.players[0].dice.every((d) => d.placedMapId === null));
}
{
  // Round 4: the 3K fallback still applies even though the reroll itself is skipped.
  const { createEmptyGameState: freshEmptyState, createDie: freshDie } = require('../src/game-state');
  const s = freshEmptyState('unused-die-3k-round4-smoke');
  setup.createPlayers(s, ['Alice']);
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index);
  s.turnOrder = ['P1'];
  s.round = 4;
  const unusedDie = freshDie('unused-r4', 'COLOR');
  unusedDie.value = 2;
  s.players[0].dice.push(unusedDie);

  const beforeK = s.players[0].resources.K;
  const valueBefore = unusedDie.value;
  turnFlow.endRound(s, index);
  check('Round 4: unused color die still grants 3K', s.players[0].resources.K, beforeK + 3);
  check('Round 4: but the die itself is NOT rerolled (confirmed exception)', unusedDie.value, valueBefore);
}

// ---------------------------------------------------------------------------
// endRound untaps every card, not just free actions (2026-08-01 fix, per user feedback: "ラウンド終了
// 時ダイスを回収するときに全てのカードはUNTAPします" -- previously only free actions were untapped
// here, so a card with no TURNEND=UNTAP() of its own, e.g. C004A's bare TAP=ADD(K), stayed tapped
// forever after a single use instead of being usable again every round).
// ---------------------------------------------------------------------------
{
  const { createEmptyGameState: freshEmptyState, createCardInstance } = require('../src/game-state');
  const s = freshEmptyState('untap-all-cards-smoke');
  setup.createPlayers(s, ['Alice', 'Bob']);
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index);

  const inst = createCardInstance('C004A'); // TAP=ADD(K), no TURNEND of its own
  inst.ownerId = 'P1';
  inst.tapped = true;
  s.cards[inst.physicalId] = inst;
  s.players[0].ownedCardPhysicalIds.push(inst.physicalId);

  turnFlow.endRound(s, index);
  check('endRound untaps a card with no TURNEND=UNTAP() of its own (e.g. C004A)', s.cards[inst.physicalId].tapped, false);
}

// ---------------------------------------------------------------------------
// A passed die (2026-08-03, see board.passDie) counts as resolved for isRoundOver/getNextTurn the same
// way a placed one does, without ever being placed -- and still gets endRound's unused-color-die 3K,
// and gets un-passed (passable/placeable again) at the next round's reset.
// ---------------------------------------------------------------------------
{
  const { createEmptyGameState: freshEmptyState, createDie } = require('../src/game-state');
  const s = freshEmptyState('pass-die-smoke');
  setup.createPlayers(s, ['Alice', 'Bob']);
  setup.prepareMaps(s, index);
  setup.prepareShops(s, index);
  s.turnOrder = ['P1', 'P2'];
  s.round = 1;
  const p1 = s.players.find((p) => p.id === 'P1');
  const p2 = s.players.find((p) => p.id === 'P2');
  const die = createDie('pass-test-die', 'COLOR');
  die.value = 4;
  p1.dice.push(die);
  p1.jobCardId = 'JOB001'; // finished onboarding, so getNextTurn reports TURN not ONBOARDING_NEEDED

  check('isRoundOver is false while the die is still unplaced/unpassed', turnFlow.isRoundOver(s), false);
  check('getNextTurn reports P1s real TURN', turnFlow.getNextTurn(s), { type: 'TURN', playerId: 'P1', playerIndex: 0 });

  const before = p1.resources.K || 0;
  board.passDie(s, index, { playerId: 'P1' }, die.id);
  check('isRoundOver is now true (the passed die counts as resolved)', turnFlow.isRoundOver(s), true);
  check('getNextTurn now reports ROUND_OVER, skipping P1 entirely', turnFlow.getNextTurn(s), { type: 'ROUND_OVER' });

  turnFlow.endRound(s, index);
  check('endRound grants 3K for the passed (unused) color die, same as a genuinely-unplaced one', p1.resources.K, before + 3);
  check('endRound un-passes the die (placeable again next round)', p1.dice.find((d) => d.id === die.id).passed, false);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
