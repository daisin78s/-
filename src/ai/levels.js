(function () {
'use strict';

/**
 * Canonical registry of AI strength levels (2026-08-10, per user request for a random-level-mix battle
 * tool: "0がランダムで LV4や5が出てもランダムになるように") -- single source of truth for
 * tools/ai_data_report.js's LV1/LV2/LV3 branch and tools/ai_level_comparison.js's random mix, so adding
 * a future level here is enough for both to pick it up automatically; no other code in either tool needs
 * to change. Each entry's aiOptions/moveGeneratorOptions/evaluatorOptions are exactly what gets passed
 * to AIPlayer/MoveGenerator/Evaluator's own constructors -- see their own docs for what each field means
 * (LV3's own fields mirror main.js's aiPlayerLv3/aiEvaluatorLv3 exactly).
 *
 * Deliberately NOT used by main.js's in-browser play (its LV1/LV2/LV3 human-vs-AI selector stays its
 * own separate, hardcoded construction) -- changing what a live human-vs-AI game offers is a bigger,
 * separate decision from what the batch analysis tools iterate over, and out of scope here.
 */
const LEVELS = [
  { name: 'LV1', aiOptions: undefined, moveGeneratorOptions: undefined, evaluatorOptions: undefined },
  { name: 'LV2', aiOptions: { lookaheadExtraTurns: 1 }, moveGeneratorOptions: undefined, evaluatorOptions: undefined },
  {
    name: 'LV3',
    aiOptions: {
      lookaheadExtraTurns: 1,
      roundOverrides: { 4: { lookaheadExtraTurns: 20, beamWidth: 10, maxRolloutMoves: 200 } },
    },
    moveGeneratorOptions: undefined,
    evaluatorOptions: { qstAware: true },
  },
  {
    // AI LV4 (2026-08-28): same aiOptions as LV3 (main.js's aiPlayerLv4 uses the exact same values), plus
    // dieScarcityTieBreak (see ai-player.js's own doc) and its own MoveGenerator policy,
    // preferCastleOverSenate (see move-generator.js's own doc -- main.js's aiMoveGeneratorLv4 uses the
    // exact same value). evaluatorOptions adds conBuildAware on top of LV3's own qstAware (see
    // Evaluator's own doc/con-build-synergy.js -- main.js's aiEvaluatorLv4 uses the exact same value).
    // tools/ai_data_report.js additionally wires this level's own resourceCardPicker/synergyTable2
    // (smart-onboarding.js) whenever aiLevel==='LV4', matching main.js's live-UI behavior -- see that
    // tool's own doc; this entry alone only covers the aiOptions/moveGeneratorOptions/evaluatorOptions
    // half of "LV4", same as every other level here.
    name: 'LV4',
    aiOptions: {
      lookaheadExtraTurns: 1,
      roundOverrides: { 4: { lookaheadExtraTurns: 20, beamWidth: 10, maxRolloutMoves: 200 } },
      dieScarcityTieBreak: true,
    },
    moveGeneratorOptions: { preferCastleOverSenate: true },
    evaluatorOptions: { qstAware: true, conBuildAware: true },
  },
];

/** @param {string} name - e.g. "LV2" @returns {Object} the matching LEVELS entry, or throws */
function getLevel(name) {
  const level = LEVELS.find((l) => l.name === name);
  if (!level) throw new Error(`Unknown AI level: ${name}`);
  return level;
}

module.exports = { LEVELS, getLevel };

})();
