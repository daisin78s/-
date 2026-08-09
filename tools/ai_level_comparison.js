/**
 * Runs N full AI-vs-AI games where each of the 4 seats independently, uniformly at random, gets one of
 * src/ai/levels.js's registered AI levels (2026-08-10, per user request: "LV1 2 3をランダムで入れる対戦
 * ができるようにしたい...AILVが上がることで得点が上がることを確かめたい" -- so mixing levels within the
 * SAME games, rather than running separate same-level batches, keeps every level exposed to the same
 * spread of opponent strength/CON/JOB/dice luck). Each of the 4 seats is assigned independently (not
 * forced into a fixed distribution) -- "完全ランダムで", confirmed with the user -- so a single game can
 * land on any mix (e.g. 4x the same level, or 0 of another); the level-level sample sizes even out over
 * enough games. Sourced from src/ai/levels.js's LEVELS, not a hardcoded LV1/LV2/LV3 list, so a future
 * level added there is included here automatically with no code change ("0がランダムで LV4や5が出ても
 * ランダムになるように").
 *
 * Output: an aggregated summary BY LEVEL (per user's own choice of "B案" over a raw per-game log) --
 * see writeSummary's own doc for exactly which fields and why. Printed to the console and written to a
 * JSON file; never touches AI.DATA.xlsx (a completely different report shape, not the CONJOB/ABCM grid
 * tools/ai_data_report.js fills in).
 *
 * Usage: node tools/ai_level_comparison.js <N> [outputJsonPath]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');
const { rankPlayers } = require('../src/scoring');
const { LEVELS } = require('../src/ai/levels');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'ai_level_comparison.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

/** Aggregates per-level stats from `rows` ({levelName, finalScore, qstScore, rank, won}[], one per
 * player-seat across every game) into the summary reported to the user:
 *   - n: how many player-seats were observed at this level (the sample size every average below is
 *     over -- levels aren't forced to equal counts, see this file's own doc on independent assignment).
 *   - avgFinalScore: the PRIMARY comparison metric -- QST rewards included, i.e. exactly the number that
 *     actually decides who wins a game (src/scoring.js's own computeFinalScore + QST's rank-based
 *     rewards). "Does a higher level score higher" should be read from this field first.
 *   - avgScoreExQst / avgQstScore: the same existing split tools/ai_data_report.js's CONJOB/ABCM sheets
 *     use (finalScore minus QST reward VP, and QST's own contribution separately) -- lets a look-alike
 *     "is LV3's edge coming from being QST-aware specifically, or from playing better generally"
 *     question get answered from this same run, without a separate one.
 *   - avgRank: average finish position (1-4, ties broken by turn order -- see scoring.rankPlayers) within
 *     just that player's own game. Less sensitive than avgFinalScore to which OTHER levels happened to
 *     be at the same table a given seat, since it's relative to that specific game's opponents.
 *   - winRate: fraction of this level's player-seats that had the single highest final score in their
 *     game (rankPlayers()[0], the actual in-game winner -- turn-order tie-break, not a shared "tied for
 *     1st"). The most intuitive "which level actually wins games" number. */
function summarizeByLevel(rows) {
  const byLevel = new Map(LEVELS.map((l) => [l.name, { n: 0, scoreSum: 0, qstScoreSum: 0, rankSum: 0, wins: 0 }]));
  for (const row of rows) {
    const bucket = byLevel.get(row.levelName);
    bucket.n++;
    bucket.scoreSum += row.finalScore;
    bucket.qstScoreSum += row.qstScore;
    bucket.rankSum += row.rank;
    if (row.won) bucket.wins++;
  }
  const summary = [];
  for (const [levelName, b] of byLevel) {
    if (b.n === 0) { summary.push({ level: levelName, n: 0 }); continue; }
    summary.push({
      level: levelName,
      n: b.n,
      avgFinalScore: Number((b.scoreSum / b.n).toFixed(2)),
      avgScoreExQst: Number(((b.scoreSum - b.qstScoreSum) / b.n).toFixed(2)),
      avgQstScore: Number((b.qstScoreSum / b.n).toFixed(2)),
      avgRank: Number((b.rankSum / b.n).toFixed(2)),
      winRate: Number((b.wins / b.n).toFixed(3)),
    });
  }
  return summary;
}

function printSummaryTable(summary) {
  console.log('');
  console.log('level  n     avgFinalScore  avgScoreExQst  avgQstScore  avgRank  winRate');
  for (const row of summary) {
    if (row.n === 0) { console.log(`${row.level.padEnd(6)} 0     (no games this run)`); continue; }
    console.log(
      `${row.level.padEnd(6)} ${String(row.n).padEnd(5)} ${String(row.avgFinalScore).padEnd(14)}`
      + `${String(row.avgScoreExQst).padEnd(15)}${String(row.avgQstScore).padEnd(13)}`
      + `${String(row.avgRank).padEnd(9)}${row.winRate}`,
    );
  }
  console.log('');
}

function main() {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1) {
    console.error('Usage: node tools/ai_level_comparison.js <N> [outputJsonPath]');
    process.exit(1);
  }
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);

  const runId = Date.now();
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const seed = `level-comparison-${runId}-${i}`;
    // Independent per-seat random assignment (2026-08-10, confirmed with the user: "完全ランダムで") --
    // Math.random() here, not state.rng, since this choice happens BEFORE any GameState exists (it picks
    // which engine config plays this seat at all) and reproducibility-from-seed only needs to cover the
    // game itself, same as every other tools/*.js CLI script's own top-level randomness.
    const levelByPlayerId = {};
    for (let seat = 0; seat < PLAYER_NAMES.length; seat++) {
      levelByPlayerId[`P${seat + 1}`] = LEVELS[Math.floor(Math.random() * LEVELS.length)].name;
    }

    let state;
    try {
      ({ state } = playGame(seed, PLAYER_NAMES, index, evalTable, undefined, undefined, undefined, levelByPlayerId));
    } catch (e) {
      console.error(`Game ${i + 1}/${n} (seed=${seed}) crashed: ${e.message}`);
      console.error(e.stack);
      process.exit(1);
    }

    const rankings = rankPlayers(state, index); // winner-first, turn-order tie-break -- see scoring.js
    const qstScoreByPlayerId = state.qstRewardsGranted || {};
    for (const player of state.players) {
      rows.push({
        levelName: levelByPlayerId[player.id],
        finalScore: rankings.find((r) => r.playerId === player.id).score,
        qstScore: qstScoreByPlayerId[player.id] || 0,
        rank: rankings.findIndex((r) => r.playerId === player.id) + 1,
        won: rankings[0].playerId === player.id,
      });
    }

    if ((i + 1) % 10 === 0 || i + 1 === n) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${i + 1}/${n} games done (${elapsed}s elapsed)`);
    }
  }

  const summary = summarizeByLevel(rows);
  printSummaryTable(summary);
  fs.writeFileSync(outputPath, JSON.stringify({ gamesRun: n, summary }, null, 1));
  console.log(`Wrote summary (${n} games, ${rows.length} player-seats) to ${outputPath}`);
}

main();
