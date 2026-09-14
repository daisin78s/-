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
  // use the flat +/-5 small-value escape step, never staying stuck at exactly 0 forever. Flat across all
  // 4 rounds now (2026-09-14, replacing the old round-scaled 5/10/20/50 -- see SMALL_VALUE_ESCAPE_STEP's
  // own doc for why the user chose a single flat step over scaling to each round's typical magnitude).
  const genome = { 1: { X: 0 }, 2: { X: 0 }, 3: { X: 0 }, 4: { X: 0 } };
  const rngState = rng.createRng('seed5');
  const seenNonzero = { 1: false, 2: false, 3: false, 4: false };
  const seenWithinStep = { 1: true, 2: true, 3: true, 4: true };
  for (let i = 0; i < 20; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2);
    for (const round of [1, 2, 3, 4]) {
      if (mutated[round].X !== 0) seenNonzero[round] = true;
      if (Math.abs(mutated[round].X) > 5.0001) seenWithinStep[round] = false;
    }
  }
  check('A zero-valued cell can escape zero in every round', seenNonzero, { 1: true, 2: true, 3: true, 4: true });
  check('...and stays within the flat +/-5 escape step in every round', seenWithinStep, { 1: true, 2: true, 3: true, 4: true });
}
{
  // The actual motivating case (2026-09-14, per user report: a percentage step can never change a value's
  // SIGN, so a small negative value stays negative forever under pure +/-20% mutation -- confirmed via
  // node -e empirically before this fix). A small nonzero value (|value| < SMALL_VALUE_THRESHOLD=10) now
  // gets the SAME flat +/-5 escape step as exactly-0, which CAN cross zero.
  const genome = { 1: { X: -1 }, 2: { X: -1 }, 3: { X: -1 }, 4: { X: -1 } };
  const rngState = rng.createRng('seed5b');
  let everWentPositive = false;
  let allWithinStep = true;
  for (let i = 0; i < 40; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2);
    for (const round of [1, 2, 3, 4]) {
      if (mutated[round].X > 0) everWentPositive = true;
      if (Math.abs(mutated[round].X) > 5.0001) allWithinStep = false;
    }
  }
  assertTrue('A small negative value (-1) CAN flip to positive under the small-value escape step', everWentPositive);
  assertTrue('...and stays within the flat +/-5 step regardless of its starting sign', allWithinStep);
}
{
  // A value right at the boundary keeps using the percentage branch (>=10 is NOT "small"), while just
  // under it switches to the flat step -- confirms the threshold is |value| < 10, not <=.
  const genomeAtBoundary = { 1: { X: 10 }, 2: { X: 10 }, 3: { X: 10 }, 4: { X: 10 } };
  const mutatedAtBoundary = mutateGenomePercent(genomeAtBoundary, rng.createRng('seed5c'), 1, 0.2);
  assertTrue('Exactly 10 (not "small") uses the percentage branch, never exceeding +/-20%=2', [1, 2, 3, 4].every((r) => Math.abs(mutatedAtBoundary[r].X - 10) <= 2.0001));
  const genomeJustUnder = { 1: { X: 9.9999 }, 2: { X: 9.9999 }, 3: { X: 9.9999 }, 4: { X: 9.9999 } };
  const mutatedJustUnder = mutateGenomePercent(genomeJustUnder, rng.createRng('seed5d'), 1, 0.2);
  assertTrue('Just under 10 uses the flat +/-5 step instead, which a 20% move never would', [1, 2, 3, 4].every((r) => Math.abs(mutatedJustUnder[r].X) <= 5.0001));
}
{
  // Never mutates the input genome in place (same convention as mutateGenome).
  const genome = { 1: { X: 10 }, 2: { X: 10 }, 3: { X: 10 }, 4: { X: 10 } };
  mutateGenomePercent(genome, rng.createRng('seed6'), 1, 0.5);
  check('mutateGenomePercent never mutates the input genome in place', genome[1].X, 10);
}
{
  // bigMutationChance/bigMutationPercent (2026-09-06, per user request after a 361-generation plateau:
  // "今+-10%の変動になっていますが 変動した時10%の確率で+-30%にするのはどうですか") -- omitted entirely,
  // every existing caller's behavior is unchanged (defaults to 0/0, i.e. never triggers).
  const genome = { 1: { X: 100 }, 2: { X: 100 }, 3: { X: 100 }, 4: { X: 100 } };
  const rngState = rng.createRng('seed7');
  let everExceededNormalPercent = false;
  for (let i = 0; i < 30; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2);
    for (const round of [1, 2, 3, 4]) {
      if (Math.abs(mutated[round].X - 100) > 20.0001) everExceededNormalPercent = true;
    }
  }
  assertTrue('Omitting bigMutationChance/bigMutationPercent never exceeds the normal +/-20%', !everExceededNormalPercent);
}
{
  // bigMutationChance=1 -- every mutating cell always takes the big jump instead of the normal one.
  const genome = { 1: { X: 100 }, 2: { X: 100 }, 3: { X: 100 }, 4: { X: 100 } };
  const rngState = rng.createRng('seed8');
  let allWithinBigPercent = true;
  let sawBiggerThanNormal = false;
  for (let i = 0; i < 20; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2, 1, 0.3);
    for (const round of [1, 2, 3, 4]) {
      const delta = Math.abs(mutated[round].X - 100);
      if (delta > 30.0001) allWithinBigPercent = false; // 30% of 100 = 30
      if (delta > 20.0001) sawBiggerThanNormal = true; // bigger than the normal 20% would ever allow
    }
  }
  assertTrue('bigMutationChance=1 always stays within the bigger +/-30%', allWithinBigPercent);
  assertTrue('...and actually exceeds the normal +/-20% at least once', sawBiggerThanNormal);
}
{
  // A currently-zero cell is unaffected by bigMutationChance/bigMutationPercent -- still governed
  // entirely by the flat +/-5 SMALL_VALUE_ESCAPE_STEP, same as the plain mutateGenomePercent case above.
  const genome = { 1: { X: 0 }, 2: { X: 0 }, 3: { X: 0 }, 4: { X: 0 } };
  const rngState = rng.createRng('seed9');
  let seenWithinStep = true;
  for (let i = 0; i < 20; i++) {
    const mutated = mutateGenomePercent(genome, rngState, 1, 0.2, 1, 0.3);
    for (const round of [1, 2, 3, 4]) {
      if (Math.abs(mutated[round].X) > 5.0001) seenWithinStep = false;
    }
  }
  assertTrue('A zero-valued cell still uses the flat +/-5 escape step, unaffected by bigMutationChance/Percent', seenWithinStep);
}

// ---------------------------------------------------------------------------
// isStructurallyBlankRound-pinned cells (2026-09-14, per user request: "進化で動かす評価値 1r 2rに出てこ
// ないカードは空白にしてください" -- e.g. 訓練場/A202 can't be built before round 2, 晩餐会/M401 not before
// round 3). randomGenome/mutateGenome/mutateGenomePercent must all force these to exactly 0 and never move
// them, regardless of population/mutation settings -- see eval-table.js's own isStructurallyBlankRound doc
// for the full id list/reasoning.
// ---------------------------------------------------------------------------
{
  // A202A: wave-1 special-shop card, no 1R value (round<2 gate). M401: no 1R or 2R value.
  const genome = randomGenome(['A202A', 'M401', 'X'], rng.createRng('seed10'), -10, 10);
  check('randomGenome pins A202A\'s 1R to 0 (wave-1, round<2 gate)', genome[1].A202A, 0);
  assertTrue('...but leaves A202A\'s own 2R/3R/4R randomized as usual', [2, 3, 4].some((r) => genome[r].A202A !== 0));
  check('randomGenome pins M401\'s 1R AND 2R to 0', [genome[1].M401, genome[2].M401], [0, 0]);
  assertTrue('...but leaves M401\'s own 3R/4R randomized as usual', [3, 4].some((r) => genome[r].M401 !== 0));
  assertTrue('A plain id (X) with no round gate is randomized in every round, unaffected', [1, 2, 3, 4].every((r) => genome[r].X !== 0));
}
{
  // Even a genome that (incorrectly) already has a nonzero value in a pinned cell -- e.g. seeded from a
  // real 評価値 table that drifted before this feature existed -- must be forced back to 0, never just
  // left alone or nudged.
  const genome = { 1: { A202A: 7, M401: 3 }, 2: { A202A: 7, M401: 3 }, 3: { A202A: 7, M401: 3 }, 4: { A202A: 7, M401: 3 } };
  const mutated = mutateGenome(genome, rng.createRng('seed11'), 1, 5); // rate=1 -- would otherwise always mutate
  check('mutateGenome forces A202A\'s 1R back to 0 even from a stray nonzero seed', mutated[1].A202A, 0);
  check('mutateGenome forces M401\'s 1R/2R back to 0 even from a stray nonzero seed', [mutated[1].M401, mutated[2].M401], [0, 0]);
  assertTrue('...but A202A\'s own 2R (not pinned) still mutates normally', mutated[2].A202A !== 7);
}
{
  const genome = { 1: { A202A: 7, M401: 3 }, 2: { A202A: 7, M401: 3 }, 3: { A202A: 7, M401: 3 }, 4: { A202A: 7, M401: 3 } };
  const mutated = mutateGenomePercent(genome, rng.createRng('seed12'), 1, 0.5);
  check('mutateGenomePercent forces A202A\'s 1R back to 0 even from a stray nonzero seed', mutated[1].A202A, 0);
  check('mutateGenomePercent forces M401\'s 1R/2R back to 0 even from a stray nonzero seed', [mutated[1].M401, mutated[2].M401], [0, 0]);
  assertTrue('...but A202A\'s own 2R (not pinned) still mutates normally', mutated[2].A202A !== 7);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
