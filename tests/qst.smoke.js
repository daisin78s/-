/**
 * Smoke test for src/qst.js (QST/Quest cards). data/game.xlsx's real QST sheet is still blank
 * (GOAL/REWARD1-3 not authored yet, per the user -- being written collaboratively later), so this
 * test injects synthetic QST rows into the loaded index rather than waiting on real content. That
 * only replaces the *data*; the engine code under test (qst.js, plus the CARD_COUNT(sheet) scoping
 * added to executor.js) is exactly what real cards will run through once they're written.
 * Run: node tests/qst.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const qst = require('../src/qst');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));
// Synthetic QST fixtures (see file header) -- 4 physical cards, A/B faces, covering: a
// monument-ownership goal, an always-true goal, and a BUILD-type reward.
index.raw.QST = [
  { ID: 'Q001A', NAME: 'Q001A', GOAL: 'CARD_COUNT(M)>=1', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(1VP)', INST: '' },
  { ID: 'Q001B', NAME: 'Q001B', GOAL: 'CARD_COUNT(M)>=1', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(1VP)', INST: '' },
  { ID: 'Q002A', NAME: 'Q002A', GOAL: 'CARD_COUNT>=0', REWARD1: 'ADD(2K)', REWARD2: 'ADD(1K)', REWARD3: 'ADD(1K)', INST: '' },
  { ID: 'Q002B', NAME: 'Q002B', GOAL: 'CARD_COUNT>=0', REWARD1: 'ADD(2K)', REWARD2: 'ADD(1K)', REWARD3: 'ADD(1K)', INST: '' },
  { ID: 'Q003A', NAME: 'Q003A', GOAL: 'CARD_COUNT>=0', REWARD1: 'BUILD(M)', REWARD2: 'ADD(1VP)', REWARD3: 'ADD(1VP)', INST: '' },
  { ID: 'Q003B', NAME: 'Q003B', GOAL: 'CARD_COUNT>=0', REWARD1: 'BUILD(M)', REWARD2: 'ADD(1VP)', REWARD3: 'ADD(1VP)', INST: '' },
  { ID: 'Q004A', NAME: 'Q004A', GOAL: 'CARD_COUNT(M)>=99', REWARD1: 'ADD(1VP)', REWARD2: 'ADD(1VP)', REWARD3: 'ADD(1VP)', INST: '' },
  { ID: 'Q004B', NAME: 'Q004B', GOAL: 'CARD_COUNT(M)>=99', REWARD1: 'ADD(1VP)', REWARD2: 'ADD(1VP)', REWARD3: 'ADD(1VP)', INST: '' },
];

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

function freshState(seed, playerNames) {
  const state = createEmptyGameState(seed);
  setup.createPlayers(state, playerNames);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  return state;
}
function player(state, id) { return state.players.find((p) => p.id === id); }
function giveCard(state, faceCardId, ownerId) {
  const inst = createCardInstance(faceCardId);
  inst.ownerId = ownerId;
  state.cards[inst.physicalId] = inst;
  player(state, ownerId).ownedCardPhysicalIds.push(inst.physicalId);
  return inst.physicalId;
}

// ---------------------------------------------------------------------------
// 1. setupQuests: 3 of 4 physical cards revealed, never both faces of one physical card
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-setup-1', ['Alice']);
  qst.setupQuests(state);
  const revealed = Object.keys(state.quests);
  check('Exactly 3 quests revealed', revealed.length, 3);

  const physicalIds = revealed.map((id) => id.slice(0, -1));
  const uniquePhysicalIds = new Set(physicalIds);
  check('All 3 are distinct physical cards (no sibling faces revealed together)', uniquePhysicalIds.size, 3);
  check('Every revealed physical id is one of Q001-Q004', physicalIds.every((id) => qst.QST_PHYSICAL_IDS.includes(id)), true);
  check('Every revealed face starts at claimCount 0', Object.values(state.quests).every((q) => q.claimCount === 0), true);

  // Different seed -> re-running setup is allowed to reveal a different combination (just checking
  // it doesn't crash / still obeys the same invariants, not asserting a specific different result).
  const state2 = freshState('qst-setup-2', ['Alice']);
  qst.setupQuests(state2);
  check('A different seed still reveals exactly 3', Object.keys(state2.quests).length, 3);
}

// ---------------------------------------------------------------------------
// 2. goalMet: CARD_COUNT(M)>=1 -- false before owning a monument, true after
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-goal', ['Alice']);
  check('GOAL not met with no monuments owned', qst.goalMet(state, index, 'P1', 'CARD_COUNT(M)>=1'), false);
  giveCard(state, 'M001', 'P1');
  check('GOAL met once a monument is owned', qst.goalMet(state, index, 'P1', 'CARD_COUNT(M)>=1'), true);
  check('goalMet is false for missing/blank GOAL text', qst.goalMet(state, index, 'P1', ''), false);
}

// ---------------------------------------------------------------------------
// 3. Claim order (REWARD1/2/3), per-card one-claim-per-player, and COMPLETE after REWARD3
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-order', ['Alice', 'Bob', 'Carol', 'Dan']);
  state.quests = { Q002A: { claimCount: 0, claimedPlayers: [] } }; // GOAL='CARD_COUNT>=0', always met

  const p1 = qst.claimQuestReward(state, index, { playerId: 'P1' }, 'Q002A');
  check('1st claimer succeeds', p1.success, true);
  check('1st claimer got REWARD1 (2K)', player(state, 'P1').resources.K, 2);
  check('claimCount is now 1', state.quests.Q002A.claimCount, 1);

  const p1Again = qst.claimQuestReward(state, index, { playerId: 'P1' }, 'Q002A');
  check('Same player claiming the same card again is rejected', p1Again, { success: false, reason: 'ALREADY_CLAIMED' });

  const p2 = qst.claimQuestReward(state, index, { playerId: 'P2' }, 'Q002A');
  check('2nd claimer succeeds', p2.success, true);
  check('2nd claimer got REWARD2 (1K)', player(state, 'P2').resources.K, 1);

  const p3 = qst.claimQuestReward(state, index, { playerId: 'P3' }, 'Q002A');
  check('3rd claimer succeeds', p3.success, true);
  check('3rd claimer got REWARD3 (1K)', player(state, 'P3').resources.K, 1);
  check('claimCount is now 3 (COMPLETE)', state.quests.Q002A.claimCount, 3);

  const p4 = qst.claimQuestReward(state, index, { playerId: 'P4' }, 'Q002A');
  check('4th claimer (goal met, but card is COMPLETE) gets nothing', p4, { success: false, reason: 'COMPLETE' });
  check('4th claimer\'s K is untouched', player(state, 'P4').resources.K, 0);
}

// ---------------------------------------------------------------------------
// 4. Per-player game-wide cap: 2 rewards total, even across different cards
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-cap', ['Alice']);
  state.quests = {
    Q002A: { claimCount: 0, claimedPlayers: [] },
    Q004A: { claimCount: 0, claimedPlayers: [] }, // GOAL='CARD_COUNT(M)>=99', never met on its own
  };
  giveCard(state, 'M001', 'P1'); // so Q001A-style goals would pass; irrelevant to Q002A/Q004A here

  const first = qst.claimQuestReward(state, index, { playerId: 'P1' }, 'Q002A');
  check('1st claim (of this player\'s 2 lifetime) succeeds', first.success, true);
  check('qstRewardCount is now 1', player(state, 'P1').qstRewardCount, 1);

  // Q004A's GOAL is unreachable (CARD_COUNT(M)>=99) -- swap it for a synthetic always-true card at
  // the same key so this step exercises the *cap*, not another GOAL failure.
  state.quests.Q004A = { claimCount: 0, claimedPlayers: [] };
  index.raw.QST.push({ ID: '__TEST_ALWAYS_TRUE__', NAME: 'test', GOAL: 'CARD_COUNT>=0', REWARD1: 'ADD(1VP)', REWARD2: '', REWARD3: '', INST: '' });
  state.quests.__TEST_ALWAYS_TRUE__ = { claimCount: 0, claimedPlayers: [] };
  const second = qst.claimQuestReward(state, index, { playerId: 'P1' }, '__TEST_ALWAYS_TRUE__');
  check('2nd claim (different card) succeeds', second.success, true);
  check('qstRewardCount is now 2 (cap)', player(state, 'P1').qstRewardCount, 2);

  index.raw.QST.push({ ID: '__TEST_ALWAYS_TRUE_2__', NAME: 'test2', GOAL: 'CARD_COUNT>=0', REWARD1: 'ADD(1VP)', REWARD2: '', REWARD3: '', INST: '' });
  state.quests.__TEST_ALWAYS_TRUE_2__ = { claimCount: 0, claimedPlayers: [] };
  const third = qst.claimQuestReward(state, index, { playerId: 'P1' }, '__TEST_ALWAYS_TRUE_2__');
  check('3rd claim (goal met, different card) is blocked by the game-wide cap', third, { success: false, reason: 'PLAYER_LIMIT_REACHED' });
}

// ---------------------------------------------------------------------------
// 5. BUILD-type reward: two-phase claim via candidates + completeQuestClaim
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-build', ['Alice']);
  state.quests = { Q003A: { claimCount: 0, claimedPlayers: [] } }; // REWARD1='BUILD(M)'

  // Building still costs its normal resource price (confirmed 2026-07-30: a QST reward's BUILD
  // isn't free, same "no QST-specific special-casing" principle as everything else here) -- fund
  // the player generously so this step exercises completeQuestClaim, not an unrelated payment failure.
  Object.assign(player(state, 'P1').resources, { K: 99, A: 99, B: 99, C: 99, Z: 99 });

  const before = qst.claimQuestReward(state, index, { playerId: 'P1' }, 'Q003A');
  check('BUILD-type reward returns a pendingBuild instead of completing synchronously', before.success && !!before.pendingBuild, true);
  check('No claim was committed yet (still claimCount 0)', state.quests.Q003A.claimCount, 0);
  check('Candidates were found (real shop, unconditional buildValue since none was specified)', before.pendingBuild.candidates.length > 0, true);

  const kBefore = player(state, 'P1').resources.K;
  const candidate = before.pendingBuild.candidates[0];
  const completed = qst.completeQuestClaim(state, index, { playerId: 'P1' }, before.pendingBuild, candidate);
  check('completeQuestClaim succeeds', completed.success, true);
  check('Claim is now committed (claimCount 1)', state.quests.Q003A.claimCount, 1);
  check('Player now owns the built card', player(state, 'P1').ownedCardPhysicalIds.length > 0, true);
  check('Building actually cost resources (K went down, or at least did not go up)', player(state, 'P1').resources.K <= kBefore, true);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
