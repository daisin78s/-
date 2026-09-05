/**
 * Smoke test for src/ai/ga.js. Run: node tests/ga.smoke.js
 */

'use strict';

const rng = require('../src/rng');
const { randomGenome, mutateGenome, mutateGenomePercent } = require('../src/ai/ga');

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (condition) passCount++; else failCount++;
}

// ---------------------------------------------------------------------------
// randomGenome / mutateGenome (pre-existing, flat-amount mutation) -- unchanged by this session's own
// mutateGenomePercent addition, spot-checked here just to confirm nothing regressed.
// ---------------------------------------------------------------------------
{
  const genome = randomGenome(['X', 'Y'], rng.createRng('seed1'), -10, 10);
  check('randomGenome has all 4 rounds', Object.keys(genome).sort(), ['1', '2', '3', '4']);
  check('randomGenome has every id in every round', Object.keys(genome[1]).sort(), ['X', 'Y']);
  assertTrue('randomGenome values land in [-10, 10]', [1, 2, 3, 4].every((r) => Object.values(genome[r]).every((v) => v >= -10 && v <= 10)));
}
{
  const genome = { 1: { X: 5 }, 2: { X: 5 }, 3: { X: 5 }, 4: { X: 5 } };
  const mutated = mutateGenome(genome, rng.createRng('seed2'), 1, 2); // rate=1 -- always mutate
  assertTrue('mutateGenome (rate=1) moves the value by at most mutationAmount', [1, 2, 3, 4].every((r) => Math.abs(mutated[r].X - 5) <= 2));
  check('mutateGenome never mutates the input genome in place', genome[1].X, 5);
}

// ---------------------------------------------------------------------------
// mutateGenomePercent (2026-09-04, per user request: seeding GA training from the real, already-tuned
// 評価値 table instead of randomGenome's uniform spread -- see this function's own doc for why a flat
// +/-amount doesn't work once real values span 0..1000 depending on round).
// ---------------------------------------------------------------------------
{
  // rate=0 -- nothing should ever change, regardless of value.
  const genome = { 1: { X: 10 }, 2: { X: 0 }, 3: { X: -40 }, 4: { X: 1000 } };
  const mutated = mutateGenomePercent(genome, rng.createRng('seed3'), 0, 0.5);
  check('mutationRate=0 leaves every value untouched', mutated, genome);
}
{
  // rate=1, a nonzero value -- always mutates, scaled to the value's own magnitude (20% here), never a
  // flat amount. Checked across many trials/rounds since the nudge direction is random.
  const genome = { 1: { X: 100 }, 2: { X: 100 }, 3: { X: 100 }, 4: { X: 100 } };
  const rngState = rng.createRng('seed4');
  let allWithinPercent = true;
  let sawSomeChange = false;
  for (let i = 0; i < 20; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2);
    for (const round of [1, 2, 3, 4]) {
      const delta = Math.abs(mutated[round].X - 100);
      if (delta > 20.0001) allWithinPercent = false; // 20% of 100 = 20
      if (delta > 0) sawSomeChange = true;
    }
  }
  assertTrue('A nonzero value (100) always stays within +/-20% (=20) of itself', allWithinPercent);
  assertTrue('...and actually does change across repeated mutations (not silently a no-op)', sawSomeChange);
}
{
  // A currently-zero cell can't be moved by any percentage of itself (0 * anything = 0) -- must instead
  // use the round-specific flat escape step, never staying stuck at exactly 0 forever.
  const genome = { 1: { X: 0 }, 2: { X: 0 }, 3: { X: 0 }, 4: { X: 0 } };
  const rngState = rng.createRng('seed5');
  const seenNonzero = { 1: false, 2: false, 3: false, 4: false };
  const seenWithinStep = { 1: true, 2: true, 3: true, 4: true };
  const steps = { 1: 5, 2: 10, 3: 20, 4: 50 };
  for (let i = 0; i < 20; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2);
    for (const round of [1, 2, 3, 4]) {
      if (mutated[round].X !== 0) seenNonzero[round] = true;
      if (Math.abs(mutated[round].X) > steps[round] + 0.0001) seenWithinStep[round] = false;
    }
  }
  check('A zero-valued cell can escape zero in every round', seenNonzero, { 1: true, 2: true, 3: true, 4: true });
  check('...and stays within that round\'s own escape step (5/10/20/50)', seenWithinStep, { 1: true, 2: true, 3: true, 4: true });
}
{
  // Never mutates the input genome in place (same convention as mutateGenome).
  const genome = { 1: { X: 10 }, 2: { X: 10 }, 3: { X: 10 }, 4: { X: 10 } };
  mutateGenomePercent(genome, rng.createRng('seed6'), 1, 0.5);
  check('mutateGenomePercent never mutates the input genome in place', genome[1].X, 10);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
