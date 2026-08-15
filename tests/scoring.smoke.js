/**
 * Smoke test for src/scoring.js against real data. Run: node tests/scoring.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createCardInstance } = require('../src/game-state');
const scoring = require('../src/scoring');
const executor = require('../src/executor');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

function giveCard(state, faceCardId, ownerId) {
  const inst = createCardInstance(faceCardId);
  inst.ownerId = ownerId;
  state.cards[inst.physicalId] = inst;
  state.players.find((p) => p.id === ownerId).ownedCardPhysicalIds.push(inst.physicalId);
}

// ---------------------------------------------------------------------------
// computeFinalScore: card VP + resource VP + VP_MODIFIER, summed correctly
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke');
  state.players.push(createPlayer('P1', 'Alice'));
  state.turnOrder = ['P1'];

  giveCard(state, 'M001', 'P1'); // VP=4, EMBLEM_C(人)=1, no 天
  giveCard(state, 'A001A', 'P1'); // A sheet VP -- check actual value below
  const a001Vp = getCardRow(index, 'A001A').VP;
  state.players[0].resources.VP = 5;
  // PASSIVE=VP_PENALTY_IF_BELOW(EMBLEM_COUNT(天,M),2) (2026-08-15: CON003A's old IF(CARD_COUNT<=6,
  // VP_MODIFIER(-2)) clause was retired, not kept alongside this one -- see executor.smoke.js's own
  // updated doc on CON003A) -- EMBLEM_COUNT(天,M) is 0 (M001 has no 天 emblem) vs a threshold of 2, so
  // this contributes -2.
  giveCard(state, 'CON003A', 'P1');

  const expected = 4 + a001Vp + 5 + -2;
  check('computeFinalScore sums card VP + resource VP + active VP_PENALTY_IF_BELOW', scoring.computeFinalScore(state, index, 'P1'), expected);
}

// ---------------------------------------------------------------------------
// rankPlayers: highest score wins; ties broken by turnOrder position
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-2');
  state.players.push(createPlayer('P1', 'Alice'), createPlayer('P2', 'Bob'), createPlayer('P3', 'Carol'));
  state.turnOrder = ['P2', 'P1', 'P3']; // deliberately not P1,P2,P3 order

  state.players.find((p) => p.id === 'P1').resources.VP = 10;
  state.players.find((p) => p.id === 'P2').resources.VP = 15;
  state.players.find((p) => p.id === 'P3').resources.VP = 10; // ties P1

  const ranking = scoring.rankPlayers(state, index);
  check('Highest score ranks first', ranking[0], { playerId: 'P2', score: 15 });
  check('Tie between P1 and P3 (both 10) broken by turnOrder: P1 is earlier than P3', ranking[1], { playerId: 'P1', score: 10 });
  check('...P3 ranks after the tied P1', ranking[2], { playerId: 'P3', score: 10 });
}

// ---------------------------------------------------------------------------
// VP_PENALTY_IF_BELOW: the general "○○が必要" shortfall rule (2026-08-15, per user spec: "ゲーム終了時
// ○○が必要　足りない１個につき-1VP"). CON005B (強欲) uses it as real PASSIVE data now --
// "VP_PENALTY_IF_BELOW(RESOURCE(A,B,C,Z),3)" -- rather than the bespoke conCardVpAdjustment code this
// used to be (see that function's own updated doc), so it's exercised here via the generic
// executor.collectVpModifiers path, same as any other VP_MODIFIER-bearing card.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con005b');
  state.players.push(createPlayer('P1', 'Alice'));
  giveCard(state, 'CON005B', 'P1');
  const p1 = state.players[0];

  p1.resources.A = 1; p1.resources.B = 1; p1.resources.C = 0; p1.resources.Z = 0; // total 2, short 1
  check('CON005B: total=2 (short 1 of 3) -> -1VP', executor.collectVpModifiers(state, index, 'P1'), -1);

  p1.resources.A = 0; p1.resources.B = 0; p1.resources.C = 0; p1.resources.Z = 0; // total 0, short 3
  check('CON005B: total=0 (short 3 of 3) -> -3VP', executor.collectVpModifiers(state, index, 'P1'), -3);

  p1.resources.A = 2; p1.resources.B = 1; p1.resources.C = 1; p1.resources.Z = 0; // total 4, at/above 3
  check('CON005B: total=4 (at/above 3) -> 0VP, no bonus for the surplus', executor.collectVpModifiers(state, index, 'P1'), 0);

  p1.resources.K = 100; // K is deliberately excluded from the A/B/C/Z total ("資源とはA,B,C,Zのこと")
  check('CON005B: K holdings never count toward the total', executor.collectVpModifiers(state, index, 'P1'), 0);
}

// ---------------------------------------------------------------------------
// VP_PENALTY_IF_BELOW via CON003A: "モニュメント天が2個必要" -- EMBLEM_COUNT(天,M) (sheet-scoped emblem
// count, 2026-08-15) sums 天 emblems from owned M-sheet cards only, ignoring A/B/C-sheet 天 emblems.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con003a-emblem');
  state.players.push(createPlayer('P1', 'Alice'));
  giveCard(state, 'CON003A', 'P1');
  const p1 = state.players[0];

  check('CON003A: no monuments at all -> EMBLEM_COUNT(天,M)=0, short 2 -> -2VP', executor.collectVpModifiers(state, index, 'P1'), -2);

  giveCard(state, 'B001A', 'P1'); // B-sheet card, EMBLEM_B(天)=1 -- does NOT count (wrong sheet)
  check('CON003A: a B-sheet 天 emblem does not count toward the M-only threshold, still -2VP', executor.collectVpModifiers(state, index, 'P1'), -2);

  const m002Ten = getCardRow(index, 'M002').EMBLEM_B; // whatever M002's own 天 count actually is
  giveCard(state, 'M002', 'P1');
  const expectedAfterM002 = -Math.max(0, 2 - (m002Ten || 0));
  check('CON003A: owning an M-sheet card with its own 天 emblem(s) reduces (or clears) the shortfall', executor.collectVpModifiers(state, index, 'P1'), expectedAfterM002);
}

// ---------------------------------------------------------------------------
// conCardOwnVpEffect: isolates ONE card's own PASSIVE-driven VP effect out of a player who owns
// SEVERAL such cards at once (2026-08-15, for AI.DATA.xlsx's per-CON "VPペナルティ平均" column) --
// collectVpModifiers/computeFinalScore would report only the combined total; this must split it back
// apart per face without double- or under-counting either one.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-own-vp-effect');
  state.players.push(createPlayer('P1', 'Alice'));
  giveCard(state, 'CON003A', 'P1'); // no monuments -> -2 on its own
  giveCard(state, 'CON005B', 'P1'); // A+B+C+Z total 0, short 3 -> -3 on its own
  const p1 = state.players[0];
  p1.resources.A = 0; p1.resources.B = 0; p1.resources.C = 0; p1.resources.Z = 0;

  check('conCardOwnVpEffect(CON003A) reports only its own -2, not CON005B\'s share', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON003A'), -2);
  check('conCardOwnVpEffect(CON005B) reports only its own -3, not CON003A\'s share', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON005B'), -3);
  check('...and the two sum to the same combined total collectVpModifiers reports', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON003A') + scoring.conCardOwnVpEffect(state, index, 'P1', 'CON005B'), executor.collectVpModifiers(state, index, 'P1'));
  check('conCardOwnVpEffect returns 0 for a card this player does not actually own', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON001A'), 0);
}

// ---------------------------------------------------------------------------
// conCardVpAdjustment: CON004B (嫉妬, 2026-08-13, per user spec: "一番上のQSTカードの順位に応じて
// (順位-1)VP失う" -- "一番上" confirmed as Object.keys(state.quests)[0], i.e. reveal-shuffle order).
// Q001A's GOAL=CARD_COUNT drives 4 distinct ranks via 4 distinct built-card counts.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con004b');
  state.players.push(createPlayer('P1', 'Alice'), createPlayer('P2', 'Bob'), createPlayer('P3', 'Carol'), createPlayer('P4', 'Dan'));
  state.quests = { Q001A: true }; // single revealed quest -- trivially "the first" one
  giveCard(state, 'CON004B', 'P1');
  giveCard(state, 'CON004B', 'P2');
  giveCard(state, 'CON004B', 'P3');
  giveCard(state, 'CON004B', 'P4');
  // CARD_COUNT via distinct owned-card totals: P1=3 (rank1), P2=2 (rank2), P3=1 (rank3), P4=0 (rank4, a
  // 0 value is always NO_REWARD_RANK per rankPlayersForQuest's own rule). Disjoint physical A-card ids
  // per player (A001-A007 exist) -- state.cards is keyed by physicalId, so reusing the same one across
  // players would silently overwrite each other's instance. CON004B itself doesn't count (CON isn't a
  // CARD_COUNT sheet).
  for (const faceId of ['A001A', 'A002A', 'A003A']) giveCard(state, faceId, 'P1');
  for (const faceId of ['A004A', 'A005A']) giveCard(state, faceId, 'P2');
  giveCard(state, 'A006A', 'P3');

  check('CON004B: rank 1 in the top QST -> 0VP', scoring.conCardVpAdjustment(state, index, 'P1'), 0);
  check('CON004B: rank 2 -> -1VP', scoring.conCardVpAdjustment(state, index, 'P2'), -1);
  check('CON004B: rank 3 -> -2VP', scoring.conCardVpAdjustment(state, index, 'P3'), -2);
  check('CON004B: rank 4 (CARD_COUNT=0, NO_REWARD_RANK) -> -3VP', scoring.conCardVpAdjustment(state, index, 'P4'), -3);
}

// ---------------------------------------------------------------------------
// conCardVpAdjustment: CON001B (裏切, 2026-08-13, per user spec: "QSTで1位がある→-4VP、1位がなく2位が
// ある→-2VP、1-2位がなく3位がある→-1VP、1-2-3位がない→0VP") -- best rank across EVERY revealed quest,
// not just the first one (unlike CON004B above).
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con001b');
  state.players.push(createPlayer('P1', 'Alice'), createPlayer('P2', 'Bob'));
  // Q001A (GOAL=CARD_COUNT): P2 owns more cards, so P1 ranks 2nd. Q002B (GOAL=EMBLEM_SET_COUNT, the
  // min across 天/地/人): P1 owns one card of each emblem type (地+天+人 -> EMBLEM_SET_COUNT=1) while
  // P2's cards are all A-sheet (地 only -> EMBLEM_SET_COUNT=0), so P1 ranks 1st there. P1's BEST rank
  // across both quests is 1st, so CON001B should apply the rank-1 penalty (-4), not the rank-2 one a
  // "just look at one quest" implementation would wrongly pick.
  state.quests = { Q001A: true, Q002B: true };
  giveCard(state, 'CON001B', 'P1');
  giveCard(state, 'A001A', 'P1'); // 地
  giveCard(state, 'B001A', 'P1'); // 天
  giveCard(state, 'C001A', 'P1'); // 人 -- P1: CARD_COUNT=3, EMBLEM_SET_COUNT=1
  for (const faceId of ['A002A', 'A003A', 'A004A', 'A005A']) giveCard(state, faceId, 'P2'); // P2: CARD_COUNT=4, EMBLEM_SET_COUNT=0 (地 only)

  const result = scoring.conCardVpAdjustment(state, index, 'P1');
  check('CON001B: best rank across all revealed quests (not just one) drives the penalty', result, -4);

  // No revealed quest at all (or none the player ranks well on) -> no penalty.
  const stateNoQuests = createEmptyGameState('scoring-smoke-con001b-none');
  stateNoQuests.players.push(createPlayer('P1', 'Alice'));
  stateNoQuests.quests = {};
  giveCard(stateNoQuests, 'CON001B', 'P1');
  check('CON001B: no revealed quests at all -> 0VP (nothing to rank against)', scoring.conCardVpAdjustment(stateNoQuests, index, 'P1'), 0);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
