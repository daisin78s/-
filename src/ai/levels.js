(function () {
'use strict';

/**
 * Canonical registry of AI strength levels (2026-08-10, per user request for a random-level-mix battle
 * tool: "0がランダムで LV4や5が出てもランダムになるように") -- single source of truth for
 * tools/ai_data_report.js's LV1/LV2/LV3 branch and tools/ai_level_comparison.js's random mix, so adding
 * a future level here is enough for both to pick it up automatically; no other code in either tool needs
 * to change. Each entry's aiOptions/moveGeneratorOptions/evaluatorOptions are exactly what gets passed
 * to AIPlayer/MoveGenerator/Evaluator's own constructors -- see their own docs for what each field means.
 *
 * LV1/LV2/LV3 updated 2026-10-11 (per user report: "AILVの変更が反映されていません" -- run_ai_battle.bat
 * still offered the old 1-5 lineup/meanings after main.js's own 2026-10-04 LV1/2/3 consolidation (旧LV1
 * stays LV1, 旧LV3→LV2, 旧LV5→LV3; 旧LV2/旧LV4 dropped from the live selector entirely -- see main.js's
 * own aiPlayerLv1/Lv2/Lv3 construction comment for the exact mapping/history) rebuilt the live human-vs-
 * AI selector's own meaning for those 3 names without this file following along. Now mirrors main.js's
 * aiPlayerLv1/aiPlayerLv2/aiPlayerLv3 exactly, including the single shared aiEvaluator.
 *
 * LV4/LV5 removed 2026-10-27 (per user request: "混乱しないように直しておいて") -- the old LV4 (retired) and
 * LV5 (identical settings to LV3, kept only because the GA ran with --ai-level=LV5) made this registry's
 * names disagree with the game's own LV1/LV2/LV3. Only the game's 3 levels remain; the GA/tools now use
 * 'LV3' for the strongest level. Old output folders/logs still say "lv5" -- that was this same LV3 search.
 * The retired LV4's round-4 deep-search setting, for reference: {lookaheadExtraTurns:1,
 * roundOverrides:{4:{lookaheadExtraTurns:20, beamWidth:10, maxRolloutMoves:200}}, dieScarcityTieBreak:true,
 * preferExOnOwnTerritory:true} (see git history for the full entry).
 *
 * Deliberately NOT used by main.js's in-browser play (its LV1/LV2/LV3 human-vs-AI selector stays its
 * own separate, hardcoded construction) -- this file just now tracks the SAME meaning by hand.
 */
const LEVELS = [
  { name: 'LV1', aiOptions: { lookaheadExtraTurns: 0 }, moveGeneratorOptions: undefined, evaluatorOptions: { qstAware: true, conBuildAware: true, monumentIncentiveAware: true } },
  { name: 'LV2', aiOptions: { lookaheadExtraTurns: 1 }, moveGeneratorOptions: undefined, evaluatorOptions: { qstAware: true, conBuildAware: true, monumentIncentiveAware: true } },
  {
    name: 'LV3',
    aiOptions: {
      lookaheadExtraTurns: 2,
      beamWidth: 3,
      dieScarcityTieBreak: true,
      preferExOnOwnTerritory: true,
      crossRoundLookahead: true,
    },
    moveGeneratorOptions: { preferCastleOverSenate: true },
    evaluatorOptions: { qstAware: true, conBuildAware: true, monumentIncentiveAware: true },
  },
];

/** @param {string} name - e.g. "LV2" @returns {Object} the matching LEVELS entry, or throws */
function getLevel(name) {
  const level = LEVELS.find((l) => l.name === name);
  if (!level) throw new Error(`Unknown AI level: ${name} (LV1/LV2/LV3 only -- the old LV5 is now LV3)`);
  return level;
}

module.exports = { LEVELS, getLevel };

})();
