(function () {
'use strict';

/**
 * RandomEvaluator: an Evaluator with no knowledge at all -- score(state, playerId) returns a fresh
 * random number every call, ignoring both arguments entirely. AIPlayer.selectMove always picks the
 * candidate move with the highest score (first-max-wins tie-break) -- feeding it random scores per
 * candidate is a standard "argmax of iid random values" trick for selecting uniformly at random among
 * N candidates, so wiring this into AIPlayer/MoveGenerator/Simulator exactly as normal reuses that
 * whole pipeline unchanged (including MoveGenerator's forcedBzConversionMove/forcedJob004ConversionMove/
 * forcedEndSignLv2Move/forcedTrainingGroundMove short-circuits, which stay forced here too -- that's a
 * genuine game rule, not a policy choice, same as every other AI level).
 *
 * Built 2026-08-27 as "Generation 0" for tools/ga_train.js's genetic-algorithm AI training (per user
 * request: "完全ランダムウォークから第一世代第二世代という風に進化させていく方式でAIを作りたい"): a
 * from-scratch baseline with zero hand-tuned knowledge, measured once for comparison before the real
 * evolving population (Generation 1's randomly-initialized eval-tables, see src/ai/ga.js) takes over --
 * there is no eval-table here to mutate INTO Generation 1, so Generation 1 starts its own fresh random
 * genomes rather than being derived from this class.
 *
 * Uses state.rng (never Math.random()) so a whole game driven by this evaluator stays exactly as
 * reproducible from its seed as every other random choice in this project (see rng.js's own doc).
 */

const rng = require('../rng');

class RandomEvaluator {
  // eslint-disable-next-line class-methods-use-this
  score(state) {
    return rng.next(state.rng);
  }
}

module.exports = { RandomEvaluator };

})();
