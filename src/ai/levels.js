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
 * aiPlayerLv1/aiPlayerLv2/aiPlayerLv3 exactly, including the single shared aiEvaluator (every level now
 * gets the full qstAware+conBuildAware+monumentIncentiveAware table, not just the old LV4/LV5). LV4/LV5
 * below are left exactly as they were -- several other one-off dev tools (manual_play.js,
 * replay_ai_takeover.js, train_from_human_replay.js, the lv4_depth_experiment/ai_lv4_vs_lv5_tournament
 * scripts) still reference 'LV4'/'LV5' by name for their own historical comparisons; none of them ever
 * referenced 'LV1'/'LV2'/'LV3', so updating those 3 here is safe and doesn't disturb any of them.
 *
 * Deliberately NOT used by main.js's in-browser play (its LV1/LV2/LV3 human-vs-AI selector stays its
 * own separate, hardcoded construction) -- this file just now tracks the SAME meaning by hand, same as
 * LV4/LV5 already did relative to main.js's own former aiPlayerLv4 construction.
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
  {
    // AI LV4 (2026-08-28): same aiOptions as LV3 (main.js's aiPlayerLv4 uses the exact same values), plus
    // dieScarcityTieBreak and preferExOnOwnTerritory (2026-08-31, see ai-player.js's own doc on each).
    // evaluatorOptions adds conBuildAware on top of LV3's own qstAware (see Evaluator's own doc/
    // con-build-synergy.js -- main.js's aiEvaluatorLv4 uses the exact same value).
    // tools/ai_data_report.js additionally wires this level's own resourceCardPicker/synergyTable2
    // (smart-onboarding.js) whenever aiLevel==='LV4', matching main.js's live-UI behavior -- see that
    // tool's own doc; this entry alone only covers the aiOptions/moveGeneratorOptions/evaluatorOptions
    // half of "LV4", same as every other level here.
    name: 'LV4',
    aiOptions: {
      lookaheadExtraTurns: 1,
      roundOverrides: { 4: { lookaheadExtraTurns: 20, beamWidth: 10, maxRolloutMoves: 200 } },
      dieScarcityTieBreak: true,
      preferExOnOwnTerritory: true,
    },
    moveGeneratorOptions: { preferCastleOverSenate: true },
    evaluatorOptions: { qstAware: true, conBuildAware: true, monumentIncentiveAware: true },
  },
  {
    // AI LV5 (2026-09-16, per user design consultation): same evaluator/move-generator settings as LV4
    // (evaluatorOptions unchanged -- LV5 reads AI LV4's own real 評価値 table, not a separate one, per
    // user confirmation "評価値はAILV4を使う"), but a different rounds 1-3 search: beamWidth 6->3 (see
    // tools/ai_lookahead_variant_tournament.js's own 2026-09-16 finding -- 100-game seat-rotated testing
    // showed beamWidth 3 vs 6 is not measurably weaker, only cheaper) and lookaheadExtraTurns 1->2 (the
    // "321" scheme discussed with the user), PLUS crossRoundLookahead:true (see ai-player.js's own
    // constructor doc for the full mechanism) -- lets the own-turns-only rollout genuinely peek 1 turn
    // into round 2/3/4 instead of only ever seeing the current round's own numbers, so hoarding resources
    // late in a round specifically to afford a round 2/3 card can actually show up as a better score than
    // spending them immediately.
    // roundOverrides removed (2026-10-06, per user request: "設定を今のAILV3と同じにして" / "4Rの思考
    // 方法" -- main.jsのlive AI LV3は2026-10-04のLV1/2/3統合で4R専用の深読みoverrideを撤廃済み(4Rの処理
    // が重すぎたため)、GA学習の適応度評価(--ai-level=LV5が参照するこのLEVELS定義)も同じ思考方法に揃える。
    // 現在進行中のGA学習(output/ga_train_lv5_20260917)はこの変更を適用してgen 2557付近から再開する。
    name: 'LV5',
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
  if (!level) throw new Error(`Unknown AI level: ${name}`);
  return level;
}

module.exports = { LEVELS, getLevel };

})();
