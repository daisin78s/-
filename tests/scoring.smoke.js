/**
 * Smoke test for src/scoring.js against real data. Run: node tests/scoring.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createCardInstance } = require('../src/game-state');
const scoring = require('../src/scoring');

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

  giveCard(state, 'M001', 'P1'); // VP=3
  giveCard(state, 'A001A', 'P1'); // A sheet VP -- check actual value below
  const a001Vp = getCardRow(index, 'A001A').VP;
  state.players[0].resources.VP = 5;
  giveCard(state, 'CON003A', 'P1'); // PASSIVE=IF(CARD_COUNT<=6,VP_MODIFIER(-2)) -- CARD_COUNT is 2 (M001+A001), so active

  const expected = 3 + a001Vp + 5 + -2;
  check('computeFinalScore sums card VP + resource VP + active VP_MODIFIER', scoring.computeFinalScore(state, index, 'P1'), expected);
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

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
