/**
 * Integration smoke test for src/ai/game-runner.js: drives full AI-vs-AI games (setupGame ->
 * onboarding -> every round -> GAME_END) using the real engine and real data. Slower than the other
 * ai-*.smoke.js files (a full 4-player game takes several seconds) since it's exercising the whole
 * stack, not one class in isolation -- kept to a small, fixed set of seeds on purpose.
 * Run: node tests/ai-game-runner.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');

const raw = loadGameData(path.join(__dirname, '..', 'data', 'game.json'));
const index = buildDataIndex(raw);
const evalTable = buildEvalTable(raw);
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------------------
// A full 4-player AI-vs-AI game reaches GAME_END (not stuck in an infinite loop / MAX_ITERATIONS
// safety valve) -- this is the exact regression this integration test exists to catch: 2026-08-02's
// stuck-AI bugs (see [[project-dice-wp]]) all manifested as state.phase staying 'ROUND' forever.
// ---------------------------------------------------------------------------
const { state: state1, historyByPlayerId: history1 } = playGame('ai-integration-smoke-1', PLAYER_NAMES, index, evalTable);
check('A full game reaches GAME_END, not stuck at MAX_ITERATIONS', state1.phase, 'GAME_END');

// ---------------------------------------------------------------------------
// historyByPlayerId has exactly the 5 fields the user specified (2026-08-01: "IDでCON JOB 1R目に建築
// したはじめのカード 1R目に手に入れた色D 最終得点"), one entry per player, well-formed values.
// ---------------------------------------------------------------------------
{
  const playerIds = Object.keys(history1);
  check('One history entry per player', playerIds.sort(), ['P1', 'P2', 'P3', 'P4']);
  for (const playerId of playerIds) {
    const h = history1[playerId];
    check(`${playerId}: history has exactly the 5 specified fields`, Object.keys(h).sort(), ['conFaceId', 'finalScore', 'firstRound1BuildFaceId', 'jobFaceId', 'round1DDiceGained'].sort());
    assertTrue(`${playerId}: conFaceId looks like a CON face ID`, /^CON\d+[AB]$/.test(h.conFaceId));
    assertTrue(`${playerId}: jobFaceId looks like a JOB face ID`, /^JOB\d+[AB]$/.test(h.jobFaceId));
    assertTrue(`${playerId}: firstRound1BuildFaceId is NONE or a card face ID`, h.firstRound1BuildFaceId === 'NONE' || /^[A-Z]+\d+[AB]$/.test(h.firstRound1BuildFaceId));
    assertTrue(`${playerId}: round1DDiceGained is a non-negative integer`, Number.isInteger(h.round1DDiceGained) && h.round1DDiceGained >= 0);
    assertTrue(`${playerId}: finalScore is a finite number`, Number.isFinite(h.finalScore));
  }
}

// ---------------------------------------------------------------------------
// No randomness anywhere in the AI's own decision-making (confirmed 2026-08-01): the RNG seed alone
// must fully determine the outcome, so the same seed run twice produces an identical result.
// ---------------------------------------------------------------------------
{
  const { state: state1b, historyByPlayerId: history1b } = playGame('ai-integration-smoke-1', PLAYER_NAMES, index, evalTable);
  check('Same seed run twice reaches GAME_END both times', state1b.phase, 'GAME_END');
  check('Same seed run twice produces identical historyByPlayerId', history1b, history1);
}

// ---------------------------------------------------------------------------
// A second, different seed also completes cleanly -- guards against a fix that only happens to work
// for one specific seed/board layout.
// ---------------------------------------------------------------------------
{
  const { state: state2 } = playGame('ai-integration-smoke-2', PLAYER_NAMES, index, evalTable);
  check('A second seed also reaches GAME_END', state2.phase, 'GAME_END');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
