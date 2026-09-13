/**
 * Shared "load a 評価値-shaped genome from a training tool's own output file" helper -- split out
 * 2026-09-11 from tools/train_from_human_replay.js so tools/ai_variant_tournament.js can load the exact
 * same two kinds of files (a best_genome.json, or a raw gen_XXXX.json population checkpoint) without
 * duplicating this logic.
 */

'use strict';

const fs = require('fs');

/** Loads one genome file as {label, genome}. Accepts either a tools/ga_train.js or
 * tools/train_from_human_replay.js best_genome.json ({generation, avgRank, genome}) or a raw gen_XXXX.json
 * population checkpoint ({generation, population: [{genome, avgRank, ...}]}) -- for the latter, the best
 * individual BY THAT RUN'S OWN avgRank is picked out, since a checkpoint's population is unsorted and most
 * individuals in it are mediocre. */
function loadSeedGenome(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(data.population)) {
    const best = data.population.slice().sort((a, b) => a.avgRank - b.avgRank)[0];
    return { label: `gen${data.generation}(best of that gen, avgRank=${best.avgRank.toFixed(2)})`, genome: best.genome };
  }
  return { label: `gen${data.generation}(best-ever, avgRank=${data.avgRank.toFixed(2)})`, genome: data.genome };
}

module.exports = { loadSeedGenome };
