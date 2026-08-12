/**
 * Smoke test for src/undo.js against real data via setup.js. Run: node tests/undo.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState } = require('../src/game-state');
const setup = require('../src/setup');
const turnFlow = require('../src/turn-flow');
const undoMod = require('../src/undo');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

// ---------------------------------------------------------------------------
// No checkpoint yet -> undo() fails cleanly
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('undo-smoke-1');
  const result = undoMod.undo(state);
  check('undo() with no checkpoint fails with NO_CHECKPOINT', result, { success: false, reason: 'NO_CHECKPOINT' });
}

// ---------------------------------------------------------------------------
// rollInitialColorDice() records a checkpoint before rolling; undo() restores
// the pre-roll dice-less state (setup steps before the roll are preserved).
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('undo-smoke-2');
  setup.createPlayers(state, ['Alice', 'Bob']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);

  check('No dice yet, before rolling', state.players[0].dice.length, 0);
  setup.rollInitialColorDice(state);
  check('3 dice rolled', state.players[0].dice.length, 3);
  check('Undo checkpoint was recorded', state.undoCheckpoint !== null, true);

  const diceValuesBeforeUndo = state.players[0].dice.map((d) => d.value);
  const result = undoMod.undo(state);
  check('undo() succeeds', result.success, true);
  check('Player has no dice again (back to pre-roll)', state.players[0].dice.length, 0);
  check('Players/maps/shops from before the roll are preserved', state.players.length === 2 && Object.keys(state.maps).length === 10, true);
  assertNotUndefined('diceValuesBeforeUndo captured something', diceValuesBeforeUndo.length === 3);
}

function assertNotUndefined(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------------------
// Round 2+: rerollDiceForNextRound records its own checkpoint (confirmed
// 2026-08-12, per the INST rulebook sheet: both COLOR and still-in-hand
// WHITE dice bulk-reroll at ROUND END, not round start, except after round
// 4 -- see turn-flow.js/executor.js). This checks the checkpoint fires at
// the right moment (endRound's reroll) and undo restores both dice kinds.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('undo-smoke-3');
  setup.createPlayers(state, ['Alice']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  const die = state.players[0].dice[0];
  die.kind = 'WHITE';
  const whiteValueBeforeRoundEnd = die.value;
  turnFlow.startRound(state); // -> round 1, no dice touched here at all (confirmed)

  const colorDie = state.players[0].dice.find((d) => d.kind === 'COLOR');
  const colorValueBeforeRoundEnd = colorDie.value;
  turnFlow.endRound(state, index); // round 1 < 4 -> rerolls COLOR + in-hand WHITE dice, records a fresh checkpoint

  const result = undoMod.undo(state);
  check('undo() after endRound succeeds', result.success, true);
  const restoredColorDie = state.players[0].dice.find((d) => d.kind === 'COLOR');
  const restoredWhiteDie = state.players[0].dice.find((d) => d.kind === 'WHITE');
  check('Undo restores the color die to its value from just before the round-end reroll', restoredColorDie.value, colorValueBeforeRoundEnd);
  check('Undo restores the white die to its value from just before the round-end reroll', restoredWhiteDie.value, whiteValueBeforeRoundEnd);
}

// ---------------------------------------------------------------------------
// Confirmed exception: no color-dice reroll after round 4 (no round 5 to
// prepare for) -- so endRound() shouldn't even touch the checkpoint there.
// ---------------------------------------------------------------------------
{
  const state = createEmptyGameState('undo-smoke-4');
  setup.createPlayers(state, ['Alice']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  state.round = 4;
  const colorDie = state.players[0].dice.find((d) => d.kind === 'COLOR');
  const valueBefore = colorDie.value;
  state.undoCheckpoint = null; // clear the setup-time checkpoint so we can tell if endRound(4) creates a new one

  turnFlow.endRound(state, index);
  check('endRound() after round 4 does NOT reroll color dice (confirmed exception)', colorDie.value, valueBefore);
  check('...and records no new checkpoint (nothing was rolled)', state.undoCheckpoint, null);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
