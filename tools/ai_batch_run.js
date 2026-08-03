/**
 * Runs N full AI-vs-AI games (src/ai/game-runner.js's playGame) and appends one human-readable match
 * history line per player per game to a TSV log file. Per the user's 2026-08-01 spec, the human-facing
 * log carries EXACTLY these 5 tab-separated fields, in this order, one line per player per game:
 *   CON面ID  JOB面ID  1R目に最初に建てたカード面ID(未建築ならNONE)  1R目に獲得した色ダイス枚数  最終得点
 * ("それ以外の情報はいまのところ人間側には不要です" -- no game id, no player id/name, nothing else).
 * The AI/internal side (historyByPlayerId, see game-runner.js) already tracks more; this log is
 * deliberately just the 5 fields for a human skimming results.
 *
 * Appends to the same output file across runs (default output/ai_match_history.tsv) so the companion
 * tools/ai_aggregate_report.js can accumulate stats across many invocations, not just one run.
 *
 * Usage: node tools/ai_batch_run.js <N> [outputPath]
 * Exit code: 0 on success, 1 if any game throws (a crash is reported and the run stops early --
 * unlike validate_dsl.js's "collect all errors" style, a mid-batch crash means something is genuinely
 * broken and continuing would just waste the remaining games).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'ai_match_history.tsv');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

function main() {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1) {
    console.error('Usage: node tools/ai_batch_run.js <N> [outputPath]');
    process.exit(1);
  }
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);

  // A fresh runId per invocation keeps seeds unique across separate `node tools/ai_batch_run.js` runs
  // (so the accumulated log in outputPath isn't just the same N games replayed), while still being
  // fully reproducible per-seed if a specific game ever needs to be re-driven for debugging.
  const runId = Date.now();
  const lines = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const seed = `batch-${runId}-${i}`;
    let historyByPlayerId;
    try {
      ({ historyByPlayerId } = playGame(seed, PLAYER_NAMES, index, evalTable));
    } catch (e) {
      console.error(`Game ${i + 1}/${n} (seed=${seed}) crashed: ${e.message}`);
      console.error(e.stack);
      process.exit(1);
    }
    for (const playerId of Object.keys(historyByPlayerId)) {
      const h = historyByPlayerId[playerId];
      lines.push([h.conFaceId, h.jobFaceId, h.firstRound1BuildFaceId, h.round1DDiceGained, h.finalScore].join('\t'));
    }
    if ((i + 1) % 10 === 0 || i + 1 === n) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${i + 1}/${n} games done (${elapsed}s elapsed)`);
    }
  }

  fs.appendFileSync(outputPath, lines.join('\n') + '\n');
  console.log(`Appended ${lines.length} lines (${n} games x 4 players) to ${outputPath}`);
}

main();
