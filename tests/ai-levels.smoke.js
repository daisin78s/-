/**
 * Smoke test for src/ai/levels.js -- the shared LEVELS registry tools/ai_data_report.js and
 * tools/ai_level_comparison.js both read from (see that file's own doc).
 * Run: node tests/ai-levels.smoke.js
 */

'use strict';

const { LEVELS, getLevel } = require('../src/ai/levels');

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

// 2026-10-27: LV4 (retired) / LV5 (same as LV3) removed so the names match the game's own LV1/LV2/LV3.
check('LEVELS lists exactly the game\'s LV1/LV2/LV3, in that order', LEVELS.map((l) => l.name), ['LV1', 'LV2', 'LV3']);
check('getLevel("LV2") returns the matching registry entry', getLevel('LV2'), LEVELS[1]);
// 2026-10-11: LV1/LV2/LV3 updated to mirror main.js's 2026-10-04 LV1/2/3 consolidation (旧LV1→LV1、
// 旧LV3→LV2、旧LV5→LV3 -- see levels.js's own doc) -- every level now shares the SAME full evaluator
// (qstAware+conBuildAware+monumentIncentiveAware, the former LV4/LV5-only table), not just a bare
// qstAware for the old LV3.
const UNIFIED_EVALUATOR_OPTIONS = { qstAware: true, conBuildAware: true, monumentIncentiveAware: true };
check('getLevel("LV1") shares the unified evaluatorOptions', getLevel('LV1').evaluatorOptions, UNIFIED_EVALUATOR_OPTIONS);
check('getLevel("LV2") shares the unified evaluatorOptions', getLevel('LV2').evaluatorOptions, UNIFIED_EVALUATOR_OPTIONS);
check('getLevel("LV3") shares the unified evaluatorOptions', getLevel('LV3').evaluatorOptions, UNIFIED_EVALUATOR_OPTIONS);
check('getLevel("LV3") uses preferCastleOverSenate moveGeneratorOptions (matching main.js\'s aiPlayerLv3)', getLevel('LV3').moveGeneratorOptions, { preferCastleOverSenate: true });
check('getLevel("LV3") includes crossRoundLookahead aiOptions', getLevel('LV3').aiOptions.crossRoundLookahead, true);
check('getLevel("LV3") uses beamWidth 3', getLevel('LV3').aiOptions.beamWidth, 3);
{
  let threw = false;
  try { getLevel('LV99'); } catch (e) { threw = true; }
  check('getLevel throws on an unknown level name rather than returning undefined', threw, true);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
