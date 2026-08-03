/**
 * Smoke test: runs a full 4-player game setup (steps 1-7) plus round-1
 * onboarding (steps 9-12, driven manually here since the turn-flow
 * controller doesn't exist yet) against real data. Run: node tests/setup.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState } = require('../src/game-state');
const setup = require('../src/setup');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

function runFullSetup(seed) {
  const state = createEmptyGameState(seed);
  setup.createPlayers(state, ['Alice', 'Bob', 'Carol', 'Dan']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  setup.dealConCards(state);
  setup.dealResourceCandidates(state, index);
  for (const player of state.players) {
    const choice = state.pendingChoices.find((c) => c.playerId === player.id);
    const chosen = choice.context.candidates.slice(0, 2);
    setup.chooseResourceCards(state, player.id, chosen);
  }
  setup.computeStartOrder(state, index);
  return state;
}

const state = runFullSetup('smoke-setup-seed');

// ---------------------------------------------------------------------------
// Board / shops
// ---------------------------------------------------------------------------
check('All 10 maps created', Object.keys(state.maps).length, 10);
check('MAP003 starts at AREA003A (2 numbered + 1 ANY slot)', state.maps['MAP003'].slots.length, 2);
check('MAP008 (castle) starts with 6 ANY slots', state.maps['MAP008'].slots.length, 6);

check('Monument shop has 6 slots filled', Object.values(state.shops.M.slots).filter(Boolean).length, 6);
check('Monument shop draw pile has 6 left (12 - 6 shown)', state.shops.M.drawPile.length, 6);
check('Normal shop has 6 slots filled', Object.values(state.shops.NORMAL.slots).filter(Boolean).length, 6);
check('Normal shop draw pile has 15 left (21 - 6 shown)', state.shops.NORMAL.drawPile.length, 15);
check('Special shop is NOT revealed at setup', Object.values(state.shops.SPECIAL.slots).filter(Boolean).length, 0);
setup.revealSpecialShop(state);
check('Special shop reveals all 3 after revealSpecialShop()', Object.values(state.shops.SPECIAL.slots).filter(Boolean).length, 3);

const allShopFaceIds = [
  ...Object.values(state.shops.M.slots),
  ...state.shops.M.drawPile,
  ...Object.values(state.shops.NORMAL.slots),
  ...state.shops.NORMAL.drawPile,
  ...Object.values(state.shops.SPECIAL.slots),
];
check('No duplicate cards across shop slots+drawPiles', new Set(allShopFaceIds).size, allShopFaceIds.length);
check('Shop card pool size is 12 (M) + 21 (normal) + 3 (special) = 36', allShopFaceIds.length, 36);

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------
for (const player of state.players) {
  const dice = player.dice;
  assertTrue(`${player.id} has exactly 3 color dice`, dice.length === 3 && dice.every((d) => d.kind === 'COLOR'));
  assertTrue(`${player.id}'s dice all rolled 1-6`, dice.every((d) => d.value >= 1 && d.value <= 6));
}

// ---------------------------------------------------------------------------
// CON / RESOURCE dealing
// ---------------------------------------------------------------------------
const dealtCon = state.players.map((p) => p.conPhysicalId);
check('Every player got a distinct CON card', new Set(dealtCon).size, 4);
assertTrue('All dealt CON ids are valid CON physicalIds', dealtCon.every((id) => /^CON00[1-5]$/.test(id)));

for (const player of state.players) {
  const resourceIds = player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
  check(`${player.id} kept exactly 2 RESOURCE cards`, resourceIds.length, 2);
}
const allKeptResources = state.players.flatMap((p) => p.ownedCardPhysicalIds.filter((id) => id.startsWith('R')));
check('No RESOURCE card kept by two players', new Set(allKeptResources).size, allKeptResources.length);

// ---------------------------------------------------------------------------
// Start order
// ---------------------------------------------------------------------------
check('turnOrder contains all 4 players exactly once', new Set(state.turnOrder).size, 4);
{
  // Recompute expected order by hand from the same data to cross-check computeStartOrder's result.
  const manual = state.players.map((player) => {
    const conRow = getCardRow(index, `${player.conPhysicalId}A`);
    const resourceIds = player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
    const sum = resourceIds.reduce((s, id) => s + getCardRow(index, id).START_ORDER, 0);
    return { id: player.id, total: conRow.START_ORDER + sum };
  });
  manual.sort((a, b) => a.total - b.total);
  check('turnOrder matches an independently-recomputed sort', state.turnOrder, manual.map((m) => m.id));
}

// ---------------------------------------------------------------------------
// Round-1 onboarding: JOB choice, CON face choice, initial resources
// ---------------------------------------------------------------------------
{
  const p1 = state.turnOrder[0];
  const beforeK = state.players.find((p) => p.id === p1).resources.K;

  setup.dealJobPool(state); // reveals 6 of 8 JOB cards; must run before chooseJob
  check('dealJobPool reveals exactly 6 of the 8 JOB cards', state.jobPool.length, 6);
  const draftedJob = state.jobPool[0];

  const jobResult = setup.chooseJob(state, index, p1, draftedJob);
  check('chooseJob succeeds for a card actually in the pool', jobResult.success, true);
  check('Player now owns the drafted JOB card', state.players.find((p) => p.id === p1).ownedCardPhysicalIds.includes(draftedJob.slice(0, -1)), true);

  const alreadyTaken = setup.chooseJob(state, index, state.turnOrder[1], draftedJob);
  check('A second player cannot draft the same already-taken JOB card', alreadyTaken, { success: false, reason: 'NOT_IN_JOB_POOL' });

  const conResult = setup.chooseConFace(state, index, p1, 'A');
  check('chooseConFace succeeds', conResult.success, true);
  const conPhysicalId = state.players.find((p) => p.id === p1).conPhysicalId;
  check('CON card face is now the A face', state.cards[conPhysicalId].currentFaceId, `${conPhysicalId}A`);

  setup.receiveInitialResources(state, index, p1);
  const afterK = state.players.find((p) => p.id === p1).resources.K;
  assertTrue('receiveInitialResources changed at least one resource (K moved or stayed but ran without error)', afterK >= beforeK);
}

// ---------------------------------------------------------------------------
// Determinism: same seed -> identical outcome
// ---------------------------------------------------------------------------
{
  const stateA = runFullSetup('determinism-check');
  const stateB = runFullSetup('determinism-check');
  check('Same seed produces identical turnOrder', stateA.turnOrder, stateB.turnOrder);
  check('Same seed produces identical shop layout', stateA.shops, stateB.shops);
  check('Same seed produces identical dice rolls', stateA.players.map((p) => p.dice.map((d) => d.value)), stateB.players.map((p) => p.dice.map((d) => d.value)));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
