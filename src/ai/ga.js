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
const { isStructurallyBlankRound } = require('./eval-table');

/** A fresh genome with every (round, id) pair independently uniform-random in [min, max]. `ids` is the
 * full addressable id list (every resource row + every card row the real 評価値 sheet has, see
 * eval-table.js's own doc) -- reusing the real sheet's own key set keeps a trained genome's shape
 * identical to production data, so it drops straight into game.xlsx's 評価値 sheet if it performs well.
 * `rngState` is an rng.createRng(seed) result, mutated in place as usual. isStructurallyBlankRound-pinned
 * cells (2026-09-14, per user request -- see that function's own doc) are forced to exactly 0 instead of a
 * random value: a card that can't possibly be owned that early has nothing real to evolve there, so
 * spending genome search space randomizing it is pure waste (and, once written back into game.xlsx by
 * tools/apply_evolved_genome.py, spreadsheet noise). */
function randomGenome(ids, rngState, min, max) {
  const genome = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const id of ids) {
    for (const round of [1, 2, 3, 4]) {
      genome[round][id] = isStructurallyBlankRound(id, round) ? 0 : min + rng.next(rngState) * (max - min);
    }
  }
  return genome;
}

/** A mutated copy of genome (never mutates the input): each (round, id) value independently has
 * `mutationRate` probability of being nudged by a uniform-random delta in [-mutationAmount,
 * +mutationAmount]. Everything else is copied unchanged -- this is plain Gaussian-free "small step"
 * mutation, no crossover (kept deliberately simple for this first training pass; see tools/ga_train.js's
 * own doc for why crossover was left out for now). isStructurallyBlankRound-pinned cells never mutate,
 * staying exactly 0 regardless of `value` or the mutation roll -- see randomGenome's own doc. */
function mutateGenome(genome, rngState, mutationRate, mutationAmount) {
  const mutated = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const [id, value] of Object.entries(genome[round])) {
      mutated[round][id] = (!isStructurallyBlankRound(id, round) && rng.next(rngState) < mutationRate)
        ? value + (rng.next(rngState) * 2 - 1) * mutationAmount
        : (isStructurallyBlankRound(id, round) ? 0 : value);
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
 * weight, not just rescale ones that already have one.
 *
 * bigMutationChance/bigMutationPercent (2026-09-06, per user request, after a 361-generation run plateaued
 * for its last 168 generations with zero improvement: "今+-10%の変動になっていますが 変動した時10%の確率
 * で+-30%にするのはどうですか" -- both optional, default 0/unused so every existing caller keeps its exact
 * prior behavior): among the cells that DO mutate this call, a bigMutationChance fraction use
 * bigMutationPercent's wider spread instead of the normal mutationPercent -- an occasional larger "jump"
 * alongside the usual small "creep" steps, meant to let a converged/plateaued population occasionally
 * escape a local optimum that small steps alone can't climb out of. Only affects the nonzero-value branch
 * (ZERO_ESCAPE_STEP_BY_ROUND's own flat step is unrelated to this percentage scheme either way).
 * isStructurallyBlankRound-pinned cells (2026-09-14, see randomGenome's own doc) are forced to exactly 0
 * and skip every branch above -- including the zero-escape one, which exists precisely to let a
 * genuinely-unused-so-far id discover a real nonzero value, the opposite of what these cells need. */
function mutateGenomePercent(genome, rngState, mutationRate, mutationPercent, bigMutationChance = 0, bigMutationPercent = 0) {
  const mutated = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const [id, value] of Object.entries(genome[round])) {
      if (isStructurallyBlankRound(id, round)) {
        mutated[round][id] = 0;
        continue;
      }
      if (rng.next(rngState) >= mutationRate) {
        mutated[round][id] = value;
        continue;
      }
      if (value === 0) {
        const step = ZERO_ESCAPE_STEP_BY_ROUND[round];
        mutated[round][id] = (rng.next(rngState) * 2 - 1) * step;
      } else {
        const percent = rng.next(rngState) < bigMutationChance ? bigMutationPercent : mutationPercent;
        mutated[round][id] = value * (1 + (rng.next(rngState) * 2 - 1) * percent);
      }
    }
  }
  return mutated;
}

/** A crossed-over copy of two genomes (never mutates either input): each (round, id) value is
 * independently taken from `genomeA` or `genomeB` with 50/50 probability (uniform crossover -- no
 * single-point/multi-point cut, since a 評価値 genome's ids have no meaningful linear order for a cut
 * point to respect). Deliberately left out of ga_train.js's own first pass (see its own doc) as
 * unnecessary complexity for a single-lineage self-play run; added 2026-09-11 for
 * tools/train_from_human_replay.js, where multiple qualitatively different seed genomes (hand-tuned vs.
 * self-play-evolved) are combined and each generation is cheap (no simulation), making it worth trying. */
function crossoverGenome(genomeA, genomeB, rngState) {
  const child = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const id of Object.keys(genomeA[round])) {
      child[round][id] = rng.next(rngState) < 0.5 ? genomeA[round][id] : genomeB[round][id];
    }
  }
  return child;
}

module.exports = { randomGenome, mutateGenome, mutateGenomePercent, crossoverGenome };

})();
