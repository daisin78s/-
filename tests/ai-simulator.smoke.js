/**
 * Smoke test for src/ai/simulator.js against real data. Covers every Move type applyInPlace dispatches
 * (see move-generator.js's own doc for the shapes) plus Simulator.apply's clone isolation.
 * Run: node tests/ai-simulator.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createDie, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const executor = require('../src/executor');
const { Simulator, SimulationError, applyInPlace } = require('../src/ai/simulator');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));
const simulator = new Simulator();

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

function freshStateWithShops() {
  const state = createEmptyGameState('ai-simulator-smoke');
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
// PLACE_DIE (simple, no BUILD): AREA001A SLOT1=1 -> ADD(3K). Also confirms Simulator.apply never
// mutates the state it's given (the whole reason AIPlayer can safely try many candidates).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 1);
  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP001', slotIndex: 0 };

  const { state: resultState, result } = simulator.apply(state, index, move);
  check('PLACE_DIE succeeds', result.success, true);
  check('The die is placed in the returned (cloned) state', resultState.players[0].dice.find((d) => d.id === die.id).placedMapId, 'MAP001');
  check('AREA001A.ACTION=ADD(3K) reflected in the returned state', resultState.players[0].resources.K, 3);

  check('The ORIGINAL state is untouched (die still unplaced)', player(state, 'P1').dice.find((d) => d.id === die.id).placedMapId, null);
  check('The ORIGINAL state is untouched (no K granted)', player(state, 'P1').resources.K || 0, 0);
}

// ---------------------------------------------------------------------------
// PLACE_DIE with a BUILD-triggering AREA (castle, MAP008) + buildCandidateIndex: completes the build.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  for (const r of ['K', 'A', 'B', 'C', 'Z']) p1.resources[r] = 20; // affords any candidate
  const die = giveDie(state, 'P1', 5);

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 });
  assertTrue('Probe: placing on the castle without a buildCandidateIndex returns pendingBuild', probe.pendingBuild && probe.pendingBuild.candidates.length > 0);

  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: 0 };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('PLACE_DIE with buildCandidateIndex completes the build', result.success, true);
  check('The player owns one more card in the returned state', resultState.players.find((p) => p.id === 'P1').ownedCardPhysicalIds.length, 1);
  check('The ORIGINAL state owns no cards', p1.ownedCardPhysicalIds.length, 0);
}

// ---------------------------------------------------------------------------
// PLACE_DIE with a BUILD-triggering AREA but NO buildCandidateIndex: die still gets placed (matches a
// player declining every candidate, e.g. because none are affordable), nothing else happens.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 5);
  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('Declining the build still succeeds (die placed, build left unresolved)', result.success, true);
  check('The die is placed', resultState.players[0].dice.find((d) => d.id === die.id).placedMapId, 'MAP008');
  check('No card was built', resultState.players[0].ownedCardPhysicalIds.length, 0);
}

// ---------------------------------------------------------------------------
// An out-of-range buildCandidateIndex is a programming error (MoveGenerator should never produce one),
// not a normal failure -- applyInPlace throws rather than silently returning success:false.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 5);
  let threw = false;
  try {
    applyInPlace(state, index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: 9999 });
  } catch (e) {
    threw = e instanceof SimulationError;
  }
  check('An out-of-range buildCandidateIndex throws SimulationError', threw, true);
}

// ---------------------------------------------------------------------------
// BARE_TAP (immediate): C001A.TAP=CHANGE(K,A,2).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('C001A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.K = 2;

  const move = { type: 'BARE_TAP', playerId: 'P1', physicalId: inst.physicalId };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('BARE_TAP (immediate) succeeds', result.success, true);
  check('...paid 2K, gained 2A in the returned state', { K: resultState.players[0].resources.K, A: resultState.players[0].resources.A }, { K: 0, A: 2 });
  check('...the card is tapped in the returned state', resultState.cards[inst.physicalId].tapped, true);
  check('The ORIGINAL state\'s card is still untapped', state.cards[inst.physicalId].tapped, false);
}

// ---------------------------------------------------------------------------
// FREE_ACTION: A->K has no usage limit (confirmed 2026-08-02) -- applying it twice in a row succeeds
// both times as long as the resource holds out.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.A = 2;
  const move = { type: 'FREE_ACTION', playerId: 'P1', freeActionId: 'A_K' };
  const first = applyInPlace(state, index, move);
  check('FREE_ACTION A->K succeeds', first.success, true);
  const second = applyInPlace(state, index, move);
  check('FREE_ACTION A->K succeeds again immediately (no usage limit)', second.success, true);
  check('Both conversions applied (2A -> 2K)', { A: player(state, 'P1').resources.A, K: player(state, 'P1').resources.K }, { A: 0, K: 2 });
}

// ---------------------------------------------------------------------------
// COLLECT_FEE: still gated once-per-round (unlike the 5 resource->K free actions).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  state.maps['MAP001'].feeOwnerId = 'P1';
  state.maps['MAP001'].accumulatedFee = 3;
  const move = { type: 'COLLECT_FEE', playerId: 'P1', mapId: 'MAP001' };
  const { result } = simulator.apply(state, index, move);
  check('COLLECT_FEE succeeds and returns the collected amount', result, { success: true, amount: 3 });
}

// ---------------------------------------------------------------------------
// TAP_REACTION: JOB005.TAP=ON(GET(K),CHANGE(K,Z)), forced to manual mode so GET(K) queues a choice
// instead of auto-resolving.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB005');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  executor.setCardAutoMode(state, 'P1', jobInst.physicalId, false);
  executor.grantResourceAndEmitGet(state, index, { playerId: 'P1' }, 'K', 1);
  const choice = state.pendingChoices.find((c) => c.playerId === 'P1' && c.kind === 'TAP_REACTION_AVAILABLE');
  assertTrue('GET(K) queued a manual TAP_REACTION_AVAILABLE choice', !!choice);

  const declineState = require('../src/game-state').cloneState(state);
  const declineResult = applyInPlace(declineState, index, { type: 'TAP_REACTION', playerId: 'P1', choiceId: choice.id, use: false });
  check('Declining a TAP_REACTION succeeds and just removes the choice', declineResult, { success: true, declined: true });
  check('...resources are unaffected by declining', declineState.players[0].resources.K, 1);

  const useResult = applyInPlace(state, index, { type: 'TAP_REACTION', playerId: 'P1', choiceId: choice.id, use: true });
  check('Using the TAP_REACTION succeeds', useResult.success, true);
  check('CHANGE(K,Z) applied: K spent, Z gained', { K: player(state, 'P1').resources.K, Z: player(state, 'P1').resources.Z }, { K: 0, Z: 1 });
  check('The pendingChoice is consumed', state.pendingChoices.some((c) => c.id === choice.id), false);
}

// ---------------------------------------------------------------------------
// END_TURN: ordinary success case advances the turn cursor; RESOURCE_TOTAL_LIMIT-blocked case fails
// without mutating anything (CON005B: RESOURCE_TOTAL_LIMIT((A,B,C),7)).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const move = { type: 'END_TURN', playerId: 'P1' };
  const before = state.currentPlayerIndex;
  const { result } = simulator.apply(state, index, move);
  check('END_TURN succeeds with no blocking TURNEND rule', result.success, true);
  check('The ORIGINAL state is untouched (currentPlayerIndex unchanged)', state.currentPlayerIndex, before);
}
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const conInst = createCardInstance('CON005B');
  conInst.ownerId = 'P1';
  state.cards[conInst.physicalId] = conInst;
  p1.ownedCardPhysicalIds.push(conInst.physicalId);
  p1.resources.A = 8; // A+B+C=8 > limit 7
  const move = { type: 'END_TURN', playerId: 'P1' };
  const result = applyInPlace(state, index, move);
  check('END_TURN fails when RESOURCE_TOTAL_LIMIT is exceeded', result.success, false);
  check('...reason is BLOCKED_BY_RESOURCE_TOTAL_LIMIT', result.reason, 'BLOCKED_BY_RESOURCE_TOTAL_LIMIT');
  check('Nothing was mutated (currentPlayerIndex unchanged)', state.currentPlayerIndex, 0);
}

// ---------------------------------------------------------------------------
// BUILD_NEW always pays using as much held BZ as the candidate's own COST can absorb (2026-08-04, per
// user feedback: "3K→2BZその2BZも必ず使う" -- see maxBzDiscount's own doc). M012 (DICE=">=1", COST=
// "13C", confirmed present in this seed's M shop) is used since a single die (max 6) already meets its
// threshold, isolating the payment behavior from castle-stacking.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.C = 10;
  p1.resources.BZ = 3; // 10 real C + 3 BZ-discounted = 13, exactly M012's COST
  const die = giveDie(state, 'P1', 1); // castle SLOTs are all ANY; die value 1 meets M012's DICE">=1"

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 });
  const m012Index = probe.pendingBuild.candidates.findIndex((c) => c.faceId === 'M012');
  assertTrue('M012 is offered as a build candidate at die value 1', m012Index >= 0);

  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: m012Index };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('M012 (13C) is buildable with only 10 real C, using 3 held BZ to cover the rest', result.success, true);
  const p1After = resultState.players.find((p) => p.id === 'P1');
  check('All 10 real C were spent', p1After.resources.C, 0);
  check('All 3 BZ were spent as the discount', p1After.resources.BZ, 0);
  check('M012 was actually built', p1After.ownedCardPhysicalIds.length, 1);
}
{
  // Same setup but with NO held BZ -- confirms 10 C alone genuinely isn't enough for M012's 13C cost,
  // proving the discount above was actually necessary, not incidental.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.C = 10;
  const die = giveDie(state, 'P1', 1);
  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 });
  const m012Index = probe.pendingBuild.candidates.findIndex((c) => c.faceId === 'M012');
  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: m012Index };
  const result = applyInPlace(state, index, move);
  check('Without any held BZ, 10 C alone is not enough for M012 (13C)', result.success, false);
}
{
  // UPGRADE never receives a discount, even with BZ on hand (confirmed rule: BZ only ever shirks a NEW
  // build's cost, never an UPGRADE's -- board.resolveUpgrade ignores context.bzDiscount entirely).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A'); // A001B exists; UPGRADE cost is "2A" (see board.smoke.js)
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.A = 2; // exactly the UPGRADE cost
  p1.resources.BZ = 5; // plenty on hand -- must be left untouched
  const die = giveDie(state, 'P1', 1);

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 });
  const upgradeIndex = probe.pendingBuild.candidates.findIndex((c) => c.type === 'UPGRADE' && c.physicalId === 'A001');
  assertTrue('The A001->A001B upgrade is offered from the castle', upgradeIndex >= 0);

  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: upgradeIndex };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('The upgrade succeeds', result.success, true);
  const p1After = resultState.players.find((p) => p.id === 'P1');
  check('The full 2A cost was paid in real resources', p1After.resources.A, 0);
  check('BZ was left completely untouched (UPGRADE never gets a discount)', p1After.resources.BZ, 5);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
