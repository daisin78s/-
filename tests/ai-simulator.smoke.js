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
// CON005B used to carry TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7) before the 2026-08-13 CON rewrite (all
// new sin-themed names/abilities); no real card in the current dataset has RESOURCE_TOTAL_LIMIT at all
// anymore, so this patches a synthetic copy of it back onto CON005B's row (every other field left
// as-is) purely so the END_TURN test below can keep exercising that still-real, still-used generic
// engine mechanism against an actual ownable card id.
index.byId.set('CON005B', { sheet: 'CON', row: { ...index.byId.get('CON005B').row, TURNEND: 'RESOURCE_TOTAL_LIMIT((A,B,C),7)' } });
// B006A's own TAP used to be PAY(K);BUILD((A,B,C,M),6) -- no card in the current dataset uses PAY(...)
// in its TAP any more (2026-08-24 SHOP201-203 rework dropped it from every card that had it), but the
// PAY-then-BUILD shape itself is still real, still-used engine behavior (board.resolveProgramOrBuild),
// so this patches the old text back onto B006A's row (every other field left as-is) purely so the tests
// below can keep exercising it against an actual ownable card id.
index.byId.set('B006A', { sheet: 'B', row: { ...index.byId.get('B006A').row, TAP: 'PAY(K);BUILD((A,B,C,M),6)' } });
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
// player declining every candidate out of choice), nothing else happens. Needs BZ (2026-08-04, per user
// feedback: "AREA008 009は建築完了出来ないときはダイスが置けません" -- board.js's
// wouldAreaActionHaveEffect now refuses the placement itself unless at least one candidate is genuinely
// AFFORDABLE, so "declining because nothing is affordable" is no longer a reachable state here -- this
// now models a player choosing not to build even though they could).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const die = giveDie(state, 'P1', 5);
  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('Declining the build still succeeds (die placed, build left unresolved)', result.success, true);
  check('The die is placed', resultState.players[0].dice.find((d) => d.id === die.id).placedMapId, 'MAP008');
  check('No card was built', resultState.players[0].ownedCardPhysicalIds.length, 0);
}

// ---------------------------------------------------------------------------
// An out-of-range buildCandidateIndex is a programming error (MoveGenerator should never produce one),
// not a normal failure -- applyInPlace throws rather than silently returning success:false. Needs BZ
// too (see the previous block's comment) so the placement itself succeeds far enough to reach the
// buildCandidateIndex validation at all.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
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
// PLACE_DICE_GROUP (2026-08-21, see move-generator.js's own doc): mirrors the 3 PLACE_DIE/castle blocks
// above, just with a die pair (dieIds) instead of a single die + slotIndex.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  for (const r of ['K', 'A', 'B', 'C', 'Z']) p1.resources[r] = 20; // affords any candidate
  const dieA = giveDie(state, 'P1', 4);
  const dieB = giveDie(state, 'P1', 5); // combined buildValue 9

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DICE_GROUP', playerId: 'P1', dieIds: [dieA.id, dieB.id], mapId: 'MAP008' });
  assertTrue('Probe: group-placing on the castle without a buildCandidateIndex returns pendingBuild', probe.pendingBuild && probe.pendingBuild.candidates.length > 0);

  const move = { type: 'PLACE_DICE_GROUP', playerId: 'P1', dieIds: [dieA.id, dieB.id], mapId: 'MAP008', buildCandidateIndex: 0 };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('PLACE_DICE_GROUP with buildCandidateIndex completes the build', result.success, true);
  const resultP1 = resultState.players.find((p) => p.id === 'P1');
  check('Both dice are placed in the returned state', [dieA.id, dieB.id].every((id) => resultP1.dice.find((d) => d.id === id).placedMapId === 'MAP008'), true);
  check('...on separate slots (not stacked together)', new Set(resultState.maps.MAP008.slots.flatMap((occ, i) => occ.length > 0 ? [i] : [])).size, 2);
  check('The player owns one more card in the returned state', resultP1.ownedCardPhysicalIds.length, 1);
  check('The ORIGINAL state owns no cards', p1.ownedCardPhysicalIds.length, 0);
}
{
  // No buildCandidateIndex: both dice still get placed (declining the build out of choice), nothing built.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const dieA = giveDie(state, 'P1', 4);
  const dieB = giveDie(state, 'P1', 5);
  const move = { type: 'PLACE_DICE_GROUP', playerId: 'P1', dieIds: [dieA.id, dieB.id], mapId: 'MAP008' };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('Declining the build still succeeds (both dice placed, build left unresolved)', result.success, true);
  const resultP1 = resultState.players.find((p) => p.id === 'P1');
  check('Both dice are placed', [dieA.id, dieB.id].every((id) => resultP1.dice.find((d) => d.id === id).placedMapId === 'MAP008'), true);
  check('No card was built', resultP1.ownedCardPhysicalIds.length, 0);
}
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const dieA = giveDie(state, 'P1', 4);
  const dieB = giveDie(state, 'P1', 5);
  let threw = false;
  try {
    applyInPlace(state, index, { type: 'PLACE_DICE_GROUP', playerId: 'P1', dieIds: [dieA.id, dieB.id], mapId: 'MAP008', buildCandidateIndex: 9999 });
  } catch (e) {
    threw = e instanceof SimulationError;
  }
  check('An out-of-range buildCandidateIndex throws SimulationError (group placement too)', threw, true);
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
// TAP_REACTION: JOB005.TAP=ON(GET(K),CHANGE(K,A)), forced to manual mode so GET(K) queues a choice
// instead of auto-resolving. (2026-08-25 data edit: was CHANGE(K,Z).)
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
  check('CHANGE(K,A) applied: K spent, A gained', { K: player(state, 'P1').resources.K, A: player(state, 'P1').resources.A }, { K: 0, A: 1 });
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
  // UPGRADE now receives the same auto-maxed BZ discount as BUILD_NEW (2026-08-06, per user feedback --
  // board.resolveUpgrade applies context.bzDiscount just like resolveBuildNew does).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('A001A'); // A001B exists; UPGRADE cost is "2A" (see board.smoke.js)
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  p1.resources.A = 2; // exactly the UPGRADE cost -- but the auto-maxed BZ discount below covers it instead
  p1.resources.BZ = 5; // plenty on hand -- the sim always maxes out usable BZ (see maxBzDiscount)
  const die = giveDie(state, 'P1', 1);

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0 });
  const upgradeIndex = probe.pendingBuild.candidates.findIndex((c) => c.type === 'UPGRADE' && c.physicalId === 'A001');
  assertTrue('The A001->A001B upgrade is offered from the castle', upgradeIndex >= 0);

  const move = { type: 'PLACE_DIE', playerId: 'P1', dieId: die.id, mapId: 'MAP008', slotIndex: 0, buildCandidateIndex: upgradeIndex };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('The upgrade succeeds', result.success, true);
  const p1After = resultState.players.find((p) => p.id === 'P1');
  check('The full 2A cost was covered by BZ, so real A was left untouched', p1After.resources.A, 2);
  check('...and exactly 2 BZ (the full cost) was spent', p1After.resources.BZ, 3);
}

{
  // A TAP-sourced BUILD (B006A.TAP=PAY(K);BUILD((A,B,C,M),6)) that builds a card whose own ONCE untaps
  // the source card back (C301A.ONCE=UNTAP_ALL(SELF)) must end up untapped, not stuck tapped (2026-08-09
  // fix, per user report: "B006AをTAPしてその効果でC301Aを建築したときB006Aがアンタップしない"). The
  // built card's ONCE runs *inside* completeAreaBuild, so the source card must already be marked tapped
  // *before* that call for UNTAP_ALL(SELF) to have any chance of reaching it back.
  const state = freshStateWithShops();
  state.round = 3; // C301A is a SHOP201-203 wave-2 card, purchasable only from round 3 (board.specialShopMinRound)
  const p1 = player(state, 'P1');
  const b006a = createCardInstance('B006A');
  b006a.ownerId = 'P1';
  state.cards[b006a.physicalId] = b006a;
  p1.ownedCardPhysicalIds.push(b006a.physicalId);
  // C301A is placed directly into a SPECIAL slot for this test -- SHOP201 shares SHOP101's dice range
  // (1-6), matching B006A's fixed buildValue=6.
  state.shops.SPECIAL.slots.SHOP201 = 'C301A';
  p1.resources.A = 1; // C301A's COST is "1A,3C"
  p1.resources.C = 3;
  p1.resources.K = 1; // 2026-08-21 data edit: B006A's TAP now costs PAY(K) up front, before the BUILD half

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'BARE_TAP', playerId: 'P1', physicalId: b006a.physicalId });
  const c008Index = probe.pendingBuild.candidates.findIndex((c) => c.faceId === 'C301A');
  assertTrue('C301A is offered as a build candidate via B006A\'s bare TAP', c008Index >= 0);

  const move = { type: 'BARE_TAP', playerId: 'P1', physicalId: b006a.physicalId, buildCandidateIndex: c008Index };
  const { state: resultState, result } = simulator.apply(state, index, move);
  check('Building C301A via B006A\'s TAP succeeds', result.success, true);
  check('C301A was actually built', resultState.players.find((p) => p.id === 'P1').ownedCardPhysicalIds.includes(b006a.physicalId) && resultState.players.find((p) => p.id === 'P1').ownedCardPhysicalIds.length === 2, true);
  check('B006A ends up untapped (C301A\'s UNTAP_ALL(SELF) reached it back)', resultState.cards[b006a.physicalId].tapped, false);
}
{
  // Failure case: if the chosen candidate turns out unaffordable, the speculative tap must be reverted
  // (the TAP wasn't actually spent) so the player can retry with a different, affordable candidate.
  const state = freshStateWithShops();
  state.round = 3; // C301A is a SHOP201-203 wave-2 card, purchasable only from round 3 (board.specialShopMinRound)
  const p1 = player(state, 'P1');
  const b006a = createCardInstance('B006A');
  b006a.ownerId = 'P1';
  state.cards[b006a.physicalId] = b006a;
  p1.ownedCardPhysicalIds.push(b006a.physicalId);
  state.shops.SPECIAL.slots.SHOP201 = 'C301A';
  p1.resources.K = 1; // 2026-08-21 data edit: B006A's TAP now costs PAY(K) up front -- must be affordable
  // No A/C granted -- C301A's "1A,3C" cost still can't be paid.

  const probe = applyInPlace(require('../src/game-state').cloneState(state), index, { type: 'BARE_TAP', playerId: 'P1', physicalId: b006a.physicalId });
  const c008Index = probe.pendingBuild.candidates.findIndex((c) => c.faceId === 'C301A');
  const move = { type: 'BARE_TAP', playerId: 'P1', physicalId: b006a.physicalId, buildCandidateIndex: c008Index };
  const result = applyInPlace(state, index, move);
  check('Building C301A fails with no resources to pay for it', result.success, false);
  check('B006A is NOT left tapped -- the speculative tap was reverted', state.cards[b006a.physicalId].tapped, false);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
