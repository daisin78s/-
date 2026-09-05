(function () {
'use strict';

/**
 * Genetic-algorithm helpers for evolving an eval-table from scratch (tools/ga_train.js's "AI LV4"
 * training, 2026-08-27, per user request). A "genome" is exactly the shape eval-table.js's
 * buildEvalTable() produces -- {1:{id:value}, 2:{...}, 3:{...}, 4:{...}} -- so `new Evaluator(index,
 * genome)` works directly on one with zero conversion, and a genome discovered by training can later be
 * written back into the 評価値 sheet's own shape unchanged.
 *
 * Deliberately pure/stateless (no file I/O, no knowledge of population size or game-running) -- the
 * training loop itself lives in tools/ga_train.js, matching this project's existing split between pure
 * src/*.js logic and tools/ orchestration scripts (e.g. eval-table.js vs. ai_data_report.js).
 *
 * Uses the passed-in rng state (never Math.random()) for every random choice, same convention as every
 * other random pick in this project (src/rng.js's own doc) -- callers pass their own rng.createRng(seed)
 * so a whole training run stays reproducible from one seed.
 */

const rng = require('../rng');

/** A fresh genome with every (round, id) pair independently uniform-random in [min, max]. `ids` is the
 * full addressable id list (every resource row + every card row the real 評価値 sheet has, see
 * eval-table.js's own doc) -- reusing the real sheet's own key set keeps a trained genome's shape
 * identical to production data, so it drops straight into game.xlsx's 評価値 sheet if it performs well.
 * `rngState` is an rng.createRng(seed) result, mutated in place as usual. */
function randomGenome(ids, rngState, min, max) {
  const genome = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const id of ids) {
    for (const round of [1, 2, 3, 4]) {
      genome[round][id] = min + rng.next(rngState) * (max - min);
    }
  }
  return genome;
}

/** A mutated copy of genome (never mutates the input): each (round, id) value independently has
 * `mutationRate` probability of being nudged by a uniform-random delta in [-mutationAmount,
 * +mutationAmount]. Everything else is copied unchanged -- this is plain Gaussian-free "small step"
 * mutation, no crossover (kept deliberately simple for this first training pass; see tools/ga_train.js's
 * own doc for why crossover was left out for now). */
function mutateGenome(genome, rngState, mutationRate, mutationAmount) {
  const mutated = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const [id, value] of Object.entries(genome[round])) {
      mutated[round][id] = rng.next(rngState) < mutationRate
        ? value + (rng.next(rngState) * 2 - 1) * mutationAmount
        : value;
    }
  }
  return mutated;
}

/** Round-scaled flat step used by mutateGenomePercent below ONLY for a currently-zero cell (see its own
 * doc for why a pure percentage step can never move a 0 at all). Picked as roughly 5-6% of each round's
 * own observed real-data max (round1 up to ~80, round2 ~200, round3 ~400, round4 ~1000, confirmed via
 * buildEvalTable(loadGameData('data/game.json')) on 2026-09-04) -- keeps a "discovered from zero" value
 * in the same rough ballpark as that round's other real values, rather than using one flat constant
 * across all 4 rounds despite their wildly different scales. */
const ZERO_ESCAPE_STEP_BY_ROUND = { 1: 5, 2: 10, 3: 20, 4: 50 };

/** A mutated copy of genome (never mutates the input), scaling each nudge to the cell's OWN current
 * value instead of mutateGenome's flat +/-mutationAmount (2026-09-04, per user request: "変異差は大きく
 * して" while starting from the real, already-tuned 評価値 table rather than randomGenome's uniform
 * [-10,10] spread -- with real values ranging from 0 up to 1000 depending on round (see
 * ZERO_ESCAPE_STEP_BY_ROUND's own doc), a single flat delta is either negligible for a round-4 VP-scale
 * cell or wildly disruptive for a round-1 K-scale one; scaling by the cell's own value keeps the nudge
 * proportionate everywhere). Each (round, id) value independently has `mutationRate` probability of being
 * nudged: a nonzero value gets multiplied by `1 + uniform(-mutationPercent, +mutationPercent)`; a value
 * that's currently exactly 0 (blank in the sheet) would otherwise be unable to ever move at all under a
 * pure percentage rule (0 times anything is still 0), so it instead gets ZERO_ESCAPE_STEP_BY_ROUND's own
 * flat step for that round -- letting evolution discover that a currently-unused id deserves a nonzero
 * weight, not just rescale ones that already have one. */
function mutateGenomePercent(genome, rngState, mutationRate, mutationPercent) {
  const mutated = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const [id, value] of Object.entries(genome[round])) {
      if (rng.next(rngState) >= mutationRate) {
        mutated[round][id] = value;
        continue;
      }
      if (value === 0) {
        const step = ZERO_ESCAPE_STEP_BY_ROUND[round];
        mutated[round][id] = (rng.next(rngState) * 2 - 1) * step;
      } else {
        mutated[round][id] = value * (1 + (rng.next(rngState) * 2 - 1) * mutationPercent);
      }
    }
  }
  return mutated;
}

module.exports = { randomGenome, mutateGenome, mutateGenomePercent };

})();
