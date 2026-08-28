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

check('LEVELS lists LV1/LV2/LV3/LV4, in that order', LEVELS.map((l) => l.name), ['LV1', 'LV2', 'LV3', 'LV4']);
check('getLevel("LV2") returns the matching registry entry', getLevel('LV2'), LEVELS[1]);
check('getLevel("LV3") includes qstAware evaluatorOptions', getLevel('LV3').evaluatorOptions, { qstAware: true });
check('getLevel("LV4") includes dieScarcityTieBreak aiOptions', getLevel('LV4').aiOptions.dieScarcityTieBreak, true);
{
  let threw = false;
  try { getLevel('LV99'); } catch (e) { threw = true; }
  check('getLevel throws on an unknown level name rather than returning undefined', threw, true);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
