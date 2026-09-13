/**
 * Shared genome-vs-human-decision scoring logic for tools/train_from_human_replay.js and its worker pool
 * (tools/train_from_human_replay_worker.js) -- split out 2026-09-11 so both the main thread (anchor
 * fitness, computed once against the FULL decisionPoints set) and every worker (per-generation fitness,
 * computed against just its own slice) use the exact same rank/top1 definitions instead of two copies
 * drifting apart.
 *
 * evaluateFitness returns rankSum/top1Count (raw sums) alongside avgRank/top1Rate (those sums divided by
 * `decisionPoints.length`) -- the raw sums are what a caller combining several workers' own PARTIAL slices
 * actually needs (sum every worker's rankSum/top1Count, then divide by the GLOBAL total decisionPoints
 * count, not any one slice's own length); avgRank/top1Rate are only meaningful as-is when `decisionPoints`
 * is already the full set, which is how the main thread's own anchor computation uses this function.
 */

'use strict';

const { Evaluator } = require('../../src/ai/evaluator');

/** Competition-ranked position (1 = best) of the human's own resulting state among every candidate's,
 * under `evaluator`'s own scoring -- ties share the same rank (matches how avgRank is computed elsewhere
 * in this project's AI tooling, e.g. turn-flow's own ranking). Scored from the seat that actually made the
 * decision (decisionPoint.playerId), not a fixed seat -- see train_from_human_replay.js's own doc on why. */
function humanRankFor(decisionPoint, evaluator) {
  const scores = decisionPoint.resultStates.map((s) => evaluator.score(s, decisionPoint.playerId));
  const humanScore = scores[decisionPoint.humanIndex];
  return 1 + scores.filter((s) => s > humanScore).length;
}

function evaluateFitness(genome, decisionPoints, index, level) {
  const evaluator = new Evaluator(index, genome, level.evaluatorOptions);
  let rankSum = 0;
  let top1Count = 0;
  for (const dp of decisionPoints) {
    const rank = humanRankFor(dp, evaluator);
    rankSum += rank;
    if (rank === 1) top1Count++;
  }
  return { rankSum, top1Count, avgRank: rankSum / decisionPoints.length, top1Rate: top1Count / decisionPoints.length };
}

module.exports = { humanRankFor, evaluateFitness };
