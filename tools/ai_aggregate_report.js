/**
 * Reads the tab-separated match-history log produced by tools/ai_batch_run.js (default
 * output/ai_match_history.tsv, 5 fields per line: CON JOB firstRound1Build round1DDiceGained
 * finalScore) and prints the average final score for every CON x JOB combination that actually
 * occurred, plus how many games backed each average (a combination seen only once or twice is noisy --
 * the count column makes that visible rather than hiding it behind a single number).
 *
 * Usage: node tools/ai_aggregate_report.js [logPath]
 * Exit code: 0 normally, 1 if the log file doesn't exist or has no valid lines.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOG_PATH = path.join(PROJECT_ROOT, 'output', 'ai_match_history.tsv');

function main() {
  const logPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LOG_PATH;
  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    console.error('Run tools/ai_batch_run.js first to generate match history.');
    process.exit(1);
  }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const totalsByKey = new Map(); // "CON\tJOB" -> { con, job, count, scoreSum }
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 5) continue; // skip malformed/partial lines rather than crash the whole report
    const [con, job, , , finalScoreRaw] = fields;
    const finalScore = Number(finalScoreRaw);
    if (!Number.isFinite(finalScore)) continue;
    const key = `${con}\t${job}`;
    if (!totalsByKey.has(key)) totalsByKey.set(key, { con, job, count: 0, scoreSum: 0 });
    const entry = totalsByKey.get(key);
    entry.count++;
    entry.scoreSum += finalScore;
  }

  if (totalsByKey.size === 0) {
    console.error('No valid match-history lines found in the log.');
    process.exit(1);
  }

  const rows = [...totalsByKey.values()]
    .map((e) => ({ con: e.con, job: e.job, count: e.count, avgScore: e.scoreSum / e.count }))
    .sort((a, b) => (a.con === b.con ? a.job.localeCompare(b.job) : a.con.localeCompare(b.con)));

  const totalGames = lines.length; // 1 line per player per game, but total row count is fine as a scale indicator
  console.log(`CON x JOB combination average final score (from ${logPath}, ${totalGames} player-game rows):\n`);
  console.log(['CON', 'JOB', '対戦数', '平均得点'].join('\t'));
  for (const row of rows) {
    console.log([row.con, row.job, row.count, row.avgScore.toFixed(2)].join('\t'));
  }
}

main();
