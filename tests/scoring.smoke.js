/**
 * Smoke test for src/scoring.js against real data. Run: node tests/scoring.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createCardInstance } = require('../src/game-state');
const scoring = require('../src/scoring');
function getQstRowForTest(faceId) { return require('../src/data-loader').getQstRow(index, faceId); }
function rewardVpForTest(text) { const m = /ADD\((\d+)VP\)/.exec(text || ''); return m ? Number(m[1]) : 0; }
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
  // 2026-11-02: CON003A's emblem penalty was removed (emblems abolished) -> 強欲/CON002B's
  // VP_PENALTY_IF_BELOW(RESOURCE(A,B,C,Z),7) instead: A/B/C/Z all 0 -> short 7 -> -7.
  giveCard(state, 'CON001A', 'P1');

  const expected = 4 + a001Vp + 5 + -7;
  check('computeFinalScore sums card VP + resource VP + active VP_PENALTY_IF_BELOW', scoring.computeFinalScore(state, index, 'P1'), expected);
}

// ---------------------------------------------------------------------------
// 晩餐会(物理id M401->M403、2026-10-13の宝物庫追加に伴うモニュメント再編で移動)自身の
// VP_MODIFIER_FINAL(PER(K,1),8) (2026-09-01, cap most recently lowered from 9 to 8) --
// computeFinalScore must include it once the game has actually ended, and NOT before
// (see executor.collectFinalOnlyVpModifiers's own doc for why this is gated on
// state.phase==='GAME_END' rather than being a plain VP_MODIFIER).
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-M403');
  state.players.push(createPlayer('P1', 'Alice'));
  state.turnOrder = ['P1'];
  giveCard(state, 'M403', 'P1');
  state.players[0].resources.K = 8;

  state.phase = 'ROUND';
  check('Mid-game: 晩餐会\'s own VP_MODIFIER_FINAL contributes nothing yet', scoring.computeFinalScore(state, index, 'P1'), 0);

  state.phase = 'GAME_END';
  check('At the real GAME_END: 8K -> 8VP added (exactly at the cap)', scoring.computeFinalScore(state, index, 'P1'), 8);
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
// ○○が必要　足りない１個につき-1VP"). 強欲 uses it as real PASSIVE data now --
// "VP_PENALTY_IF_BELOW(RESOURCE(A,B,C,Z),7)" (threshold raised 3->5->7, most recently 2026-10-13, per
// user edit to game.xlsx) -- rather than the bespoke conCardVpAdjustment code this used to be (see that
// function's own updated doc), so it's exercised here via the generic executor.collectVpModifiers path,
// same as any other VP_MODIFIER-bearing card. 強欲 lived at CON005B until the user reorganized
// game.xlsx's CON sheet by START_ORDER (2026-08-17); it's CON002B now.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con005b');
  state.players.push(createPlayer('P1', 'Alice'));
  giveCard(state, 'CON001A', 'P1');
  const p1 = state.players[0];

  p1.resources.A = 1; p1.resources.B = 1; p1.resources.C = 0; p1.resources.Z = 0; // total 2, short 5
  check('CON001A: total=2 (short 5 of 7) -> -5VP', executor.collectVpModifiers(state, index, 'P1'), -5);

  p1.resources.A = 0; p1.resources.B = 0; p1.resources.C = 0; p1.resources.Z = 0; // total 0, short 7
  check('CON001A: total=0 (short 7 of 7) -> -7VP', executor.collectVpModifiers(state, index, 'P1'), -7);

  p1.resources.A = 2; p1.resources.B = 2; p1.resources.C = 2; p1.resources.Z = 1; // total 7, at/above 7
  check('CON001A: total=7 (at/above 7) -> 0VP, no bonus for the surplus', executor.collectVpModifiers(state, index, 'P1'), 0);

  p1.resources.K = 100; // K is deliberately excluded from the A/B/C/Z total ("資源とはA,B,C,Zのこと")
  check('CON001A: K holdings never count toward the total', executor.collectVpModifiers(state, index, 'P1'), 0);
}

// (CON003A emblem-shortfall test removed 2026-11-02 -- emblems abolished.)

// ---------------------------------------------------------------------------
// conCardOwnVpEffect: isolates ONE card's own PASSIVE-driven VP effect out of a player who owns
// SEVERAL such cards at once (2026-08-15, for AI.DATA.xlsx's per-CON "VPペナルティ平均" column) --
// collectVpModifiers/computeFinalScore would report only the combined total; this must split it back
// apart per face without double- or under-counting either one.
// ---------------------------------------------------------------------------
{
  // 強欲 (VP_PENALTY_IF_BELOW(RESOURCE(A,B,C,Z),7), threshold raised 3->5->7 -- see the earlier test
  // block's own doc) lived at CON005B until the user reorganized game.xlsx's CON sheet by START_ORDER
  // (2026-08-17, matching physical slot number to START_ORDER for both A/B tiers); it's CON002B now.
  const state = createEmptyGameState('scoring-smoke-own-vp-effect');
  state.players.push(createPlayer('P1', 'Alice'));
  // 2026-11-02: the CON003A half of this split test was dropped (emblems abolished; no other CON with a VP
  // penalty has its own physical id -- CON002A shares CON002 with CON002B).
  giveCard(state, 'CON001A', 'P1'); // A+B+C+Z total 0, short 7 -> -7 on its own
  const p1 = state.players[0];
  p1.resources.A = 0; p1.resources.B = 0; p1.resources.C = 0; p1.resources.Z = 0;

  check('conCardOwnVpEffect(CON001A) reports its own -7', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON001A'), -7);
  check('...matching collectVpModifiers', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON001A'), executor.collectVpModifiers(state, index, 'P1'));
  check('conCardOwnVpEffect returns 0 for a card this player does not actually own', scoring.conCardOwnVpEffect(state, index, 'P1', 'CON006B'), 0);
}

// conCardVpAdjustment: 嫉妬 (CON004A, 2026-11-02 redesign, per user INST「ゲーム終了時クエスト１位が必要 １位でないクエスト数だけ-1VP」).
//
//
// Q001A's GOAL=CARD_COUNT drives 4 distinct ranks via 4 distinct built-card counts.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('scoring-smoke-con004b');
  state.players.push(createPlayer('P1', 'Alice'), createPlayer('P2', 'Bob'), createPlayer('P3', 'Carol'), createPlayer('P4', 'Dan'));
  state.quests = { Q001A: true }; // single revealed quest -- trivially "the first" one
  giveCard(state, 'CON004A', 'P1');
  giveCard(state, 'CON004A', 'P2');
  giveCard(state, 'CON004A', 'P3');
  giveCard(state, 'CON004A', 'P4');
  // CARD_COUNT via distinct owned-card totals: P1=3 (rank1), P2=2 (rank2), P3=1 (rank3), P4=0 (rank4, a
  // 0 value is always NO_REWARD_RANK per rankPlayersForQuest's own rule). Disjoint physical A-card ids
  // per player (A001-A006 exist) -- state.cards is keyed by physicalId, so reusing the same one across
  // players would silently overwrite each other's instance. CON004B itself doesn't count (CON isn't a
  // CARD_COUNT sheet).
  for (const faceId of ['A001A', 'A002A', 'A003A']) giveCard(state, faceId, 'P1');
  for (const faceId of ['A004A', 'A005A']) giveCard(state, faceId, 'P2');
  giveCard(state, 'A006A', 'P3');

  check('嫉妬 (CON004A): rank 1 on the only quest -> 0VP', scoring.conCardVpAdjustment(state, index, 'P1'), 0);
  check('嫉妬: rank 2 -> -1VP (1 quest not 1st)', scoring.conCardVpAdjustment(state, index, 'P2'), -1);
  check('嫉妬: rank 3 -> also just -1VP (counts quests, not rank)', scoring.conCardVpAdjustment(state, index, 'P3'), -1);
  check('嫉妬: rank 4 -> -1VP', scoring.conCardVpAdjustment(state, index, 'P4'), -1);
}

// ---------------------------------------------------------------------------
// 裏切 (CON004B, 2026-11-02 redesign, per user INST「クエストからVPを得ることができない」 + answer: still holds
// its rank, nobody moves up) -- qst.resolveEndGameRewards grants it nothing.
// ---------------------------------------------------------------------------
{
  const qst = require('../src/qst');
  const state = createEmptyGameState('scoring-smoke-betrayal');
  state.players.push(createPlayer('P1', 'Alice'), createPlayer('P2', 'Bob'));
  state.quests = { Q001A: true };
  giveCard(state, 'CON004B', 'P1');
  for (const faceId of ['A001A', 'A002A']) giveCard(state, faceId, 'P1'); // P1: CARD_COUNT=2 -> rank 1
  giveCard(state, 'A003A', 'P2'); // P2: CARD_COUNT=1 -> rank 2 (does NOT move up to 1st)
  const granted = qst.resolveEndGameRewards(state, index);
  check('裏切: rank-1 player gets no quest VP', granted.P1, 0);
  const row = getQstRowForTest('Q001A');
  check('...and the rank-2 player gets the normal 2nd-place reward, not 1st', granted.P2 > 0 && granted.P2 < rewardVpForTest(row.REWARD1), true);
}


console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
