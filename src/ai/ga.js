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

module.exports = { randomGenome, mutateGenome };

})();
