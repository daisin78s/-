/**
 * Smoke test for src/qst.js (QST/Quest cards) and the evalMetric extensions in executor.js added
 * alongside it. Injects synthetic QST rows into the loaded index rather than relying on
 * data/game.xlsx's real QST sheet content, so these cases stay fixed and readable regardless of what
 * the real cards say. That only replaces the *data*; the engine code under test (qst.js, plus the
 * CARD_COUNT/AREA_COUNT/EMBLEM_COUNT extensions in executor.js) is exactly what real cards run
 * through.
 *
 * Rank-based rewards (2026-08-09, replacing the original claim-based design -- see qst.js's own doc
 * for the full story): GOAL is now a bare metric expression evaluated as a number per player; REWARD1/
 * REWARD2/REWARD3 go automatically to whoever ranks 1st/2nd/3rd (competition ranking, ties share a
 * rank) once the game actually ends -- there is no more player-facing claim action to test.
 * Run: node tests/qst.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const qst = require('../src/qst');
const turnFlow = require('../src/turn-flow');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));
// Synthetic QST fixtures (see file header) -- 4 physical cards, A/B faces, covering a monument-
// ownership goal and a couple of always-computable ones.
index.raw.QST = [
  { ID: 'Q001A', NAME: 'Q001A', GOAL: 'CARD_COUNT(M)', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
  { ID: 'Q001B', NAME: 'Q001B', GOAL: 'CARD_COUNT(M)', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
  { ID: 'Q002A', NAME: 'Q002A', GOAL: 'CARD_COUNT', REWARD1: 'ADD(2K)', REWARD2: 'ADD(K)', REWARD3: 'ADD(K)', INST: '' },
  { ID: 'Q002B', NAME: 'Q002B', GOAL: 'CARD_COUNT', REWARD1: 'ADD(2K)', REWARD2: 'ADD(K)', REWARD3: 'ADD(K)', INST: '' },
  { ID: 'Q003A', NAME: 'Q003A', GOAL: 'CARD_COUNT', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
  { ID: 'Q003B', NAME: 'Q003B', GOAL: 'CARD_COUNT', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
  { ID: 'Q004A', NAME: 'Q004A', GOAL: 'AREA_COUNT', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
  { ID: 'Q004B', NAME: 'Q004B', GOAL: 'AREA_COUNT(2)', REWARD1: 'ADD(3VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
];

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

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
// CARD_COUNT-family metrics count DISTINCT owned physicalIds (ownedCardRows scans state.cards' keys,
// and a physicalId is derived from its faceId with the tier letter stripped -- see splitCardId) --
// giving the same faceId N times collapses onto one physicalId, not N cards, and giving two different
// players cards from the same faceId pool at the same offsets collides for the same reason. Tests
// needing "N owned cards" (possibly for several players in the same state) must draw from a shared
// pool of genuinely distinct physical ids, each used at most once per state. 36 across A/B/C/M decks.
const DISTINCT_FACE_ID_POOL = [
  ...['A001A', 'A002A', 'A003A', 'A004A', 'A005A', 'A006A', 'A007A', 'A008A'],
  ...['B001A', 'B002A', 'B003A', 'B004A', 'B005A', 'B006A', 'B007A', 'B008A'],
  ...['C001A', 'C002A', 'C003A', 'C004A', 'C005A', 'C006A', 'C007A', 'C008A'],
  ...['M001', 'M002', 'M003', 'M004', 'M005', 'M006', 'M007', 'M008', 'M009', 'M010', 'M011', 'M012'],
];
/** Gives ownerId n cards drawn from DISTINCT_FACE_ID_POOL starting at `offset` -- caller is
 * responsible for keeping offsets non-overlapping across every giveNCards call in the same state. */
function giveNCards(state, ownerId, n, offset) {
  if (offset + n > DISTINCT_FACE_ID_POOL.length) throw new Error(`giveNCards: offset+n=${offset + n} exceeds the ${DISTINCT_FACE_ID_POOL.length}-card distinct pool`);
  for (let i = 0; i < n; i++) giveCard(state, DISTINCT_FACE_ID_POOL[offset + i], ownerId);
}

// ---------------------------------------------------------------------------
// 1. setupQuests: 3 of 4 physical cards revealed, never both faces of one physical card, each
// revealed face is just a `true` marker now (no more claimCount/claimedPlayers).
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
  check('Every revealed face is just `true` (no per-card claim state anymore)', Object.values(state.quests).every((v) => v === true), true);

  // Different seed -> re-running setup is allowed to reveal a different combination (just checking
  // it doesn't crash / still obeys the same invariants, not asserting a specific different result).
  const state2 = freshState('qst-setup-2', ['Alice']);
  qst.setupQuests(state2);
  check('A different seed still reveals exactly 3', Object.keys(state2.quests).length, 3);
}

// ---------------------------------------------------------------------------
// 1b. setupQuests(state, forcedFaceIds) (2026-08-18, debug test-game feature: "テストゲームでQSTも選べる
// ようにしてください 選んだ順に上からおかれる") -- forced faces come first, in the given order (insertion
// order into state.quests, which Object.keys() preserves and main.js's renderQsts relies on for display
// order), topped up with random ones for whatever's left.
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-forced-1', ['Alice']);
  qst.setupQuests(state, ['Q003B', 'Q001A']);
  check('The 2 forced faces are revealed, in the given order', Object.keys(state.quests).slice(0, 2), ['Q003B', 'Q001A']);
  check('Exactly 3 total (1 more filled in randomly)', Object.keys(state.quests).length, 3);
  const thirdPhysicalId = Object.keys(state.quests)[2].slice(0, -1);
  check('The randomly-filled 3rd one is neither Q003 nor Q001 (no duplicate physical ids)', ['Q003', 'Q001'].includes(thirdPhysicalId), false);

  const stateFull = freshState('qst-forced-2', ['Alice']);
  qst.setupQuests(stateFull, ['Q002A', 'Q004B', 'Q001B']);
  check('All 3 forced faces used as-is, in order, when exactly 3 are given', Object.keys(stateFull.quests), ['Q002A', 'Q004B', 'Q001B']);

  const stateEmpty = freshState('qst-forced-3', ['Alice']);
  qst.setupQuests(stateEmpty, []);
  check('An empty forced list behaves exactly like omitting it -- still exactly 3, fully random', Object.keys(stateEmpty.quests).length, 3);

  const stateDupe = freshState('qst-forced-4', ['Alice']);
  qst.setupQuests(stateDupe, ['Q001A', 'Q001B', 'Q002A']);
  check('A duplicate physical id (both Q001 tiers) drops the 2nd one, not silently allowed through', Object.keys(stateDupe.quests).includes('Q001B'), false);
  check('...still exactly 3 total (topped up randomly for the dropped slot)', Object.keys(stateDupe.quests).length, 3);

  const stateInvalid = freshState('qst-forced-5', ['Alice']);
  qst.setupQuests(stateInvalid, ['NotARealFaceX', 'Q002B']);
  check('An unrecognized entry is dropped silently, not thrown', Object.keys(stateInvalid.quests).includes('Q002B'), true);
  check('...still exactly 3 total', Object.keys(stateInvalid.quests).length, 3);
}

// ---------------------------------------------------------------------------
// 2. evalGoalMetric: a bare metric expression evaluated as a NUMBER, not a boolean condition.
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-goal-metric', ['Alice']);
  check('CARD_COUNT(M) is 0 with no monuments owned', qst.evalGoalMetric(state, index, 'P1', 'CARD_COUNT(M)'), 0);
  giveCard(state, 'M001', 'P1');
  giveCard(state, 'M002', 'P1');
  check('CARD_COUNT(M) counts owned monuments', qst.evalGoalMetric(state, index, 'P1', 'CARD_COUNT(M)'), 2);
  check('evalGoalMetric is 0 for missing/blank GOAL text', qst.evalGoalMetric(state, index, 'P1', ''), 0);
}

// ---------------------------------------------------------------------------
// 3. rankPlayersForQuest: competition ranking with ties, per the user's own worked example
// (build counts 8/8/7/7 -> ranks 1/1/3/3 -- nobody is "2nd").
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-rank-ties', ['Alice', 'Bob', 'Carol', 'Dan']);
  giveNCards(state, 'P1', 8, 0);
  giveNCards(state, 'P2', 8, 8);
  giveNCards(state, 'P3', 7, 16);
  giveNCards(state, 'P4', 7, 23);
  state.quests = { Q002A: true }; // GOAL='CARD_COUNT'

  const ranking = qst.rankPlayersForQuest(state, index, 'Q002A');
  const byPlayer = Object.fromEntries(ranking.map((r) => [r.playerId, r.rank]));
  check('P1 (8) ranks 1st', byPlayer.P1, 1);
  check('P2 (8) also ranks 1st (tied)', byPlayer.P2, 1);
  check('P3 (7) ranks 3rd (rank 2 is skipped -- 2 players tied ahead)', byPlayer.P3, 3);
  check('P4 (7) also ranks 3rd (tied)', byPlayer.P4, 3);
}

// ---------------------------------------------------------------------------
// 3b. A GOAL value of 0 is always NO_REWARD_RANK, never 1st/2nd/3rd (2026-08-11, per user rule:
// "QSTカードの目標が０の時は４位になる（２人プレイなどでも）").
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-rank-zero-is-last', ['Alice', 'Bob', 'Carol', 'Dan']);
  giveNCards(state, 'P1', 3, 0); // 3 -> rank 1
  giveNCards(state, 'P2', 1, 3); // 1 -> rank 2
  // P3/P4 own nothing -> 0
  state.quests = { Q002A: true }; // GOAL='CARD_COUNT'

  const byPlayer = Object.fromEntries(qst.rankPlayersForQuest(state, index, 'Q002A').map((r) => [r.playerId, r.rank]));
  check('P1 (3) still ranks 1st', byPlayer.P1, 1);
  check('P2 (1) still ranks 2nd -- a positive value keeps the rank it earns', byPlayer.P2, 2);
  check('P3 (0) is pushed to NO_REWARD_RANK instead of 3rd', byPlayer.P3, qst.NO_REWARD_RANK);
  check('P4 (0) likewise', byPlayer.P4, qst.NO_REWARD_RANK);
  check('NO_REWARD_RANK is past the last REWARD field, i.e. 4位', qst.NO_REWARD_RANK, qst.REWARD_FIELDS.length + 1);
}
{
  // The user's own example: a 2-player game, where competition ranking alone would have made the
  // zero-value player 2nd (and paid them REWARD2).
  const state = freshState('qst-rank-zero-two-players', ['Alice', 'Bob']);
  giveCard(state, 'M001', 'P1');
  state.quests = { Q001A: true }; // GOAL='CARD_COUNT(M)'
  const byPlayer = Object.fromEntries(qst.rankPlayersForQuest(state, index, 'Q001A').map((r) => [r.playerId, r.rank]));
  check('2 players: the one with 1 monument ranks 1st', byPlayer.P1, 1);
  check('2 players: the one with 0 is 4位, not 2nd', byPlayer.P2, qst.NO_REWARD_RANK);
}

// ---------------------------------------------------------------------------
// 4. resolveEndGameRewards: rank 1/2/3 get REWARD1/2/3 respectively; ties share the same reward in
// full (not split); rank 4+ (only reachable with 4 distinct values) gets nothing.
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-end-game-distinct', ['Alice', 'Bob', 'Carol', 'Dan']);
  giveNCards(state, 'P1', 4, 0); // 4 -> rank 1 -> REWARD1 (3VP)
  giveNCards(state, 'P2', 3, 4); // 3 -> rank 2 -> REWARD2 (2VP)
  giveNCards(state, 'P3', 2, 7); // 2 -> rank 3 -> REWARD3 (1VP)
  giveNCards(state, 'P4', 1, 9); // 1 -> rank 4 -> nothing (only 3 REWARD fields)
  state.quests = { Q003A: true }; // GOAL='CARD_COUNT', REWARD1/2/3 = 3VP/2VP/1VP

  const granted = qst.resolveEndGameRewards(state, index);
  check('Rank 1 (P1) gets REWARD1 (3VP)', player(state, 'P1').resources.VP, 3);
  check('Rank 2 (P2) gets REWARD2 (2VP)', player(state, 'P2').resources.VP, 2);
  check('Rank 3 (P3) gets REWARD3 (1VP)', player(state, 'P3').resources.VP, 1);
  check('Rank 4 (P4) gets nothing', player(state, 'P4').resources.VP, 0);
  check('resolveEndGameRewards return value matches the actual VP granted, per player (used by tools/ai_data_report.js)', granted, { P1: 3, P2: 2, P3: 1, P4: 0 });
}
{
  const state = freshState('qst-end-game-ties', ['Alice', 'Bob', 'Carol', 'Dan']);
  giveNCards(state, 'P1', 8, 0); // tied rank 1
  giveNCards(state, 'P2', 8, 8); // tied rank 1
  giveNCards(state, 'P3', 7, 16); // tied rank 3
  giveNCards(state, 'P4', 7, 23); // tied rank 3
  state.quests = { Q003A: true };

  qst.resolveEndGameRewards(state, index);
  check('Both rank-1-tied players get the FULL REWARD1 (3VP each, not split)', [player(state, 'P1').resources.VP, player(state, 'P2').resources.VP], [3, 3]);
  check('Both rank-3-tied players get the FULL REWARD3 (1VP each) -- REWARD2 goes unawarded', [player(state, 'P3').resources.VP, player(state, 'P4').resources.VP], [1, 1]);
}
{
  // Everyone on 0 (nobody built anything relevant) -- nobody is rewarded at all, since a GOAL value of 0
  // is always NO_REWARD_RANK (2026-08-11 rule, see rankPlayersForQuest's own doc). Before that rule this
  // degenerate case paid every player a full REWARD1.
  const state = freshState('qst-end-game-all-zero', ['Alice', 'Bob', 'Carol', 'Dan']);
  state.quests = { Q003A: true };
  qst.resolveEndGameRewards(state, index);
  check('All 4 players on 0 get NOTHING (0 is never a rewarded rank)', state.players.map((p) => p.resources.VP), [0, 0, 0, 0]);
}
{
  // Multiple revealed cards each resolve independently.
  const state = freshState('qst-end-game-multi-card', ['Alice', 'Bob']);
  giveCard(state, 'M001', 'P1'); // Q001A GOAL=CARD_COUNT(M): P1=1 -> rank1(3VP); P2=0 -> no reward at all
  giveCard(state, 'A001A', 'P2'); // Q002A GOAL=CARD_COUNT: P1=1(the M001 above also counts), P2=1 -> tied rank1(2K each)
  state.quests = { Q001A: true, Q002A: true };
  qst.resolveEndGameRewards(state, index);
  check('Q001A: P1 (1 monument) ranks 1st, gets 3VP', player(state, 'P1').resources.VP, 3);
  // 2-player game, so plain competition ranking would have made P2 2nd and paid them REWARD2 -- the
  // 2026-08-11 rule overrides that because their GOAL value is 0 (per user: "２人プレイなどでも").
  check('Q001A: P2 (0 monuments) gets nothing even though they are 2nd of only 2 players', player(state, 'P2').resources.VP, 0);
  check('Q002A: P1 and P2 tie at 1 card each -> both get REWARD1 (2K)', [player(state, 'P1').resources.K, player(state, 'P2').resources.K], [2, 2]);
}

// ---------------------------------------------------------------------------
// 5. Integration: turn-flow.endRound resolves QST rewards automatically exactly when the game
// actually ends (round 4 -> GAME_END), not before.
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-turnflow-integration', ['Alice', 'Bob']);
  giveCard(state, 'A001A', 'P1');
  state.quests = { Q003A: true }; // GOAL='CARD_COUNT', REWARD1=3VP -- P1 (1 card) outranks P2 (0)
  state.turnOrder = ['P1', 'P2'];

  state.round = 1;
  turnFlow.endRound(state, index);
  check('endRound before round 4 does NOT resolve QST rewards yet', player(state, 'P1').resources.VP, 0);

  state.round = 4;
  turnFlow.endRound(state, index);
  check('endRound AT round 4 (-> GAME_END) resolves QST rewards', player(state, 'P1').resources.VP, 3);
  check('phase is now GAME_END', state.phase, 'GAME_END');
}

// ---------------------------------------------------------------------------
// 6. New GOAL metrics added for the rank-based redesign (executor.js's evalMetric): multi-sheet
// CARD_COUNT, AREA_COUNT (+ optional LEVEL filter), and bare EMBLEM_COUNT.
// ---------------------------------------------------------------------------
{
  const state = freshState('qst-new-metrics', ['Alice']);
  giveCard(state, 'A001A', 'P1');
  giveCard(state, 'A002B', 'P1'); // LEVEL 2 (tier B)
  giveCard(state, 'B001A', 'P1');
  giveCard(state, 'C001A', 'P1');
  giveCard(state, 'M001', 'P1');

  check('CARD_COUNT(A,B,C) counts A+B+C but excludes M', qst.evalGoalMetric(state, index, 'P1', 'CARD_COUNT(A,B,C)'), 4);
  check('Bare CARD_COUNT includes M too', qst.evalGoalMetric(state, index, 'P1', 'CARD_COUNT'), 5);
  check('AREA_COUNT counts owned A-series cards at any tier', qst.evalGoalMetric(state, index, 'P1', 'AREA_COUNT'), 2);
  check('AREA_COUNT(2) counts only LEVEL-2 (tier B) A-series cards', qst.evalGoalMetric(state, index, 'P1', 'AREA_COUNT(2)'), 1);

  const totalEmblems = qst.evalGoalMetric(state, index, 'P1', 'TOTAL_EMBLEM_COUNT');
  check('Bare EMBLEM_COUNT (no args) equals TOTAL_EMBLEM_COUNT', qst.evalGoalMetric(state, index, 'P1', 'EMBLEM_COUNT'), totalEmblems);
  assertTrue('...and that total is actually positive (sanity, not vacuously equal)', totalEmblems > 0);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
