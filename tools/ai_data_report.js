/**
 * Runs N full AI-vs-AI games and aggregates the results into the exact shape AI.DATA.xlsx's two sheets
 * need (see the user's 2026-08-03 spec):
 *   - CONJOB sheet: for every (CON face, JOB face) combination that occurred, the number of games and
 *     the average final score of the player holding that combination.
 *   - ABCM sheet: for every card face (A001A..M012) plus "D", for each round 1-4, the number of
 *     player-games where that face was built (or, for "D", where the player gained at least one new
 *     colored die) in that round, and the average final score across those player-games.
 *
 * QST split (2026-08-09, per user request): since QST's rank-based rewards (src/qst.js) now grant VP
 * automatically at GAME_END, the "average score" above is computed with that VP *excluded*
 * ("QSTカードなしの今までの得点で平均を出してください" -- i.e. it keeps its original, pre-QST-reward
 * meaning) and QST's own contribution is reported separately as a parallel "avgQstScore"/"QST平均得点"
 * value everywhere avgScore appears (both sheets) -- see game-runner.js's roundDetailByPlayerId.qstScore
 * for where the split itself comes from.
 *
 * Average rank (2026-08-20, per user request: "これを参考に平均順位を書き出すようにしてほしい") -- a
 * third parallel value, "avgRank", alongside avgScore/avgQstScore in both sheets: the average final
 * placement (1-4) of the player-games behind that row, using the exact same winner-first/turn-order-
 * tie-break ranking rule the real in-game UI's own standings panel and GAME_END screen use (see
 * game-runner.js's historyByPlayerId.rank, sourced from scoring.rankPlayers -- not a new tie-break rule).
 *
 * Requires re-running games -- rank was never captured by any previously-collected
 * output/ai_data_report.json or output/ai_match_history.tsv, so this metric only appears from this
 * change onward.
 *
 * ABCM's own AI.DATA.xlsx "平均順位" column (unlike its 平均得点/QST平均得点 columns) is a SINGLE column,
 * not one per round 1R-4R -- confirmed against the user's own pre-added sheet layout. abcmOut[id] carries
 * this as a sibling `avgRank` key alongside the per-round `1`/`2`/`3`/`4` keys: the overall average rank
 * across every round that card was ever built in, not broken out per round the way avgScore/avgUsage are.
 *

 * Writes one JSON file (default output/ai_data_report.json) that tools/ai_data_write.py then loads and
 * writes into AI.DATA.xlsx's existing cell layout -- kept as two steps (Node aggregates, Python writes
 * xlsx) since this project has no xlsx-writing library in Node, only openpyxl in Python (same split
 * tools/xlsx_to_json.py already uses in the other direction).
 *
 * Usage: node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath] [highScoreThreshold] [concurrency]
 *   aiLevel: one of src/ai/levels.js's LEVELS (2026-08-10, that file is the single source of truth for
 *   what each level actually means -- see its own doc). "LV1" (default, no lookahead -- fast,
 *   ~10s/game), "LV2" (1-turn lookahead, same as main.js's AI LV2 -- measurably slower, ~60-70s/game per
 *   2026-08-03's measurement, budget accordingly for a large N), or "LV3" (same lookahead as LV2 in
 *   rounds 1-3, plus AREA007-avoidance/QST-awareness/a much deeper round-4-only lookahead -- notably
 *   slower again just in round 4, budget accordingly).
 *   xlsxOutputPath: which .xlsx the every-10-games checkpoint (see writeReport) writes into -- defaults
 *   to AI.DATA.xlsx itself (the original behavior), but tools/run_ai_battle.js passes a fresh dated copy
 *   instead (2026-08-04, per user feedback: "同じフォルダにAIDATA20260802-1のような名前でエクセルを生成
 *   して") so a self-service battle run never touches the main AI.DATA.xlsx.
 *   highScoreThreshold: default 40 (originally 30 per 2026-08-04 user feedback: "20点以上の点数があった時
 *   その得点を取ったAIが何をしたのか確認できるように"; raised to 40 on 2026-09-02 per user request). Any
 *   player whose finalScore reaches this gets their own score/CON/JOB/initial-RESOURCE/builds-by-round
 *   recorded as a row in a "HighScores" sheet inside the SAME xlsxOutputPath workbook (per user feedback:
 *   "ログは一つのエクセルファイルにまとめる") -- see collectHighScoreRows's own doc for exactly what's
 *   captured and why (JOB/CON/initial RESOURCE/builds only, not full move-by-move detail), and for the
 *   2026-09-02 change limiting rows to just the players who crossed the threshold themselves.
 *   concurrency: default 1 (original single-threaded behavior, unchanged). >1 plays that many games at
 *   once across tools/ai_data_report_worker.js threads instead (2026-09-16, per user request to
 *   tools/run_ai_battle.js) -- see its own doc where it's read, below.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame } = require('../src/ai/game-runner');
const { LEVELS, getLevel } = require('../src/ai/levels');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { createAggregate } = require('./ai_data_aggregate'); // the CONJOB/ABCM/HighScores sums (moved there 2026-10-30)

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'ai_data_report.json');
const XLSX_WRITE_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ai_data_write.py');
const DEFAULT_XLSX_PATH = path.join(PROJECT_ROOT, 'AI.DATA.xlsx');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

async function main() {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1) {
    console.error('Usage: node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath]');
    process.exit(1);
  }
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const aiLevel = (process.argv[4] || 'LV1').toUpperCase();
  if (!LEVELS.some((l) => l.name === aiLevel)) {
    console.error(`Unknown aiLevel "${aiLevel}" -- expected one of: ${LEVELS.map((l) => l.name).join(', ')}`);
    process.exit(1);
  }
  const XLSX_PATH = process.argv[5] ? path.resolve(process.argv[5]) : DEFAULT_XLSX_PATH;
  const highScoreThreshold = process.argv[6] !== undefined ? Number(process.argv[6]) : 40;
  if (!Number.isFinite(highScoreThreshold)) {
    console.error(`Invalid highScoreThreshold "${process.argv[6]}" -- expected a number`);
    process.exit(1);
  }
  // Sourced from src/ai/levels.js (2026-08-10) rather than an inline per-level if/else, so it and
  // tools/ai_level_comparison.js's random mix always agree on what each level actually means, and a
  // future level added there is usable here immediately too.
  const { aiOptions, moveGeneratorOptions, evaluatorOptions } = getLevel(aiLevel);

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);

  // "LV1"/"LV3" smart onboarding (2026-08-28, originally "LV4"/"LV5"; updated 2026-10-11 to match
  // main.js's 2026-10-04 LV1/2/3 consolidation -- see levels.js's own doc on the rename/remapping, and
  // driveOneAiStepInner's RESOURCE_CHOICE/ONBOARDING branches there for the live-UI behavior this
  // mirrors): resource-card picks go smart for BOTH LV1 and LV3 (usesSmartOnboarding there), but the
  // full JOB/CON smart-onboarding.js treatment (synergyTable2) is LV3-only (isLv3 there) -- LV1 never
  // got that half even before the consolidation (see main.js's own 2026-09-23 "AILV1の初期資源カードの
  // 選び方をAILV5と同じに" request, resource-cards only). LV2 leaves both undefined, so its onboarding
  // stays exactly as before.
  let resourceCardPicker;
  let synergyTable2;
  if (aiLevel === 'LV1' || aiLevel === 'LV3') {
    const synergyTable3 = buildResourceSynergyTable(raw);
    resourceCardPicker = (candidateIds, state, idx, player) => pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);
  }
  if (aiLevel === 'LV3') {
    synergyTable2 = buildConJobSynergyTable(raw);
  }

  const aggregate = createAggregate(index, highScoreThreshold);

  const runId = Date.now();
  const t0 = Date.now();

  const processGameResult = aggregate.addGame;

  // concurrency (2026-09-16, per user request to tools/run_ai_battle.js: "4戦同時にできるようにしてほし
  // い" -- self-service AI-vs-AI runs previously always played one game at a time on a single core despite
  // this machine having many idle ones during a long run). 1 (default) keeps the ORIGINAL plain sequential
  // loop byte-for-byte -- every existing caller (ga tools, ai_level_comparison.js, any script invoking
  // this one directly without the new 7th arg) is completely unaffected. >1 spins up that many
  // tools/ai_data_report_worker.js threads instead, each playing one game at a time and posting its full
  // result back for processGameResult to aggregate exactly as the sequential path always has -- game
  // order becomes non-deterministic (whichever worker finishes first), but every game's own seed is still
  // uniquely derived from runId+its own index, same as before, so this doesn't affect reproducibility of
  // any INDIVIDUAL game, only the order results arrive in.
  const concurrency = process.argv[7] !== undefined ? Number(process.argv[7]) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`Invalid concurrency "${process.argv[7]}" -- expected a positive integer`);
    process.exit(1);
  }

  if (concurrency <= 1) {
    for (let i = 0; i < n; i++) {
      const seed = `data-report-${runId}-${i}`;
      let state;
      let historyByPlayerId;
      let roundDetailByPlayerId;
      let activationCounts;
      try {
        ({ state, historyByPlayerId, roundDetailByPlayerId, activationCounts } = playGame(seed, PLAYER_NAMES, index, evalTable, aiOptions, moveGeneratorOptions, evaluatorOptions, undefined, resourceCardPicker, synergyTable2));
      } catch (e) {
        console.error(`Game ${i + 1}/${n} (seed=${seed}) crashed: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
      }
      processGameResult(seed, state, historyByPlayerId, roundDetailByPlayerId, activationCounts);
      if ((i + 1) % 10 === 0 || i + 1 === n) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`${i + 1}/${n} games done (${elapsed}s elapsed)`);
        // Incremental checkpoint (2026-08-04, per user feedback after watching a long LV2 run: they asked
        // to see interim results and to be able to redirect to a smaller N mid-run) -- overwrites the same
        // outputPath every 10 games with whatever's accumulated so far, gamesRun reflecting the ACTUAL
        // count completed so far (not the target n). Without this, killing a long run early (e.g. to
        // switch to a smaller N, or just to see progress) meant losing every game's data -- this script
        // only ever wrote its output once, at the very end of the full loop. Cheap enough to do every 10
        // games (the aggregation itself, not the games, is what's slow) that there's no reason to gate it
        // further.
        writeReport(i + 1);
      }
    }
  } else {
    await runParallel();
  }

  writeReport(n);

  /** concurrency>1 path -- see concurrency's own doc above. A worker-pool dispatch identical in shape to
   * tools/ga_train.js's own runJobsOnPool, except results are processed (via processGameResult) and
   * checkpointed AS THEY STREAM IN rather than collected into one array and handled afterward, so a long
   * parallel run gets the exact same "see progress / can redirect mid-run" checkpointing the sequential
   * path already had. */
  function runParallel() {
    const { Worker } = require('worker_threads');
    const WORKER_SCRIPT = path.join(__dirname, 'ai_data_report_worker.js');
    const workerCount = Math.min(concurrency, n);
    const pool = Array.from({ length: workerCount }, () => new Worker(WORKER_SCRIPT));
    let nextIndex = 0;
    let completedCount = 0;
    return new Promise((resolve, reject) => {
      const assignNext = (worker) => {
        if (nextIndex >= n) return;
        const seed = `data-report-${runId}-${nextIndex}`;
        worker.postMessage({ jobId: nextIndex, seed, aiLevel });
        nextIndex++;
      };
      const finish = () => {
        for (const worker of pool) worker.terminate();
        resolve();
      };
      for (const worker of pool) {
        worker.on('message', (msg) => {
          if (msg.error) {
            console.error(`Game (seed=${msg.seed}) crashed in worker: ${msg.error}`);
            console.error(msg.stack);
            for (const w of pool) w.terminate();
            process.exit(1);
          }
          processGameResult(msg.seed, msg.state, msg.historyByPlayerId, msg.roundDetailByPlayerId, msg.activationCounts);
          completedCount++;
          if (completedCount % 10 === 0 || completedCount === n) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`${completedCount}/${n} games done (${elapsed}s elapsed)`);
            writeReport(completedCount);
          }
          if (completedCount === n) { finish(); return; }
          assignNext(worker);
        });
        worker.on('error', reject);
        assignNext(worker);
      }
    });
  }

  function writeReport(gamesRun) {
    const report = aggregate.report(gamesRun, aiLevel);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 1));
    console.log(`Wrote aggregate report (${gamesRun} games at ${aiLevel}, ${report.conjob.length} CON x JOB combos, ${Object.keys(report.abcm).length} ABCM rows with data, ${Object.keys(report.job).length} JOB rows with data, ${Object.keys(report.con).length} CON rows with data, ${Object.keys(report.conVpPenalty).length} CON VP-penalty rows with data, ${report.highScoreRows.length} high-score (>=${highScoreThreshold}) player-rows) to ${outputPath}`);
    // Also pushes straight into AI.DATA.xlsx itself at every checkpoint (2026-08-04, per user feedback:
    // "10戦ごとにAIDATAに上書きしていってください"), not just this intermediate JSON -- same
    // tools/ai_data_write.py this project already used for the final write, just invoked automatically
    // now instead of as a separate manual step. Failure here (e.g. the workbook is open elsewhere and
    // locked) must NOT kill the still-running game loop -- it's a nice-to-have refresh, not something
    // worth losing hours of AI-vs-AI progress over -- so it's caught and just logged.
    try {
      // PYTHONIOENCODING forces python's stdout to actual UTF-8 bytes regardless of the console's own
      // codepage (defaults to the Japanese system codepage/cp932 otherwise) -- without it, the bytes
      // python emits don't match the 'utf8' decode below, and console.log prints mojibake (2026-10-20,
      // per user report: "見慣れない文字が出ていますが").
      const out = execFileSync('python', [XLSX_WRITE_SCRIPT, outputPath, XLSX_PATH], {
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      console.log(out.trim());
    } catch (e) {
      console.error(`AI.DATA.xlsx auto-write failed (will retry at the next checkpoint): ${e.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
