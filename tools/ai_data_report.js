/**
 * Runs N full AI-vs-AI games and aggregates the results into the exact shape AI.DATA.xlsx's two sheets
 * need (see the user's 2026-08-03 spec):
 *   - CONJOB sheet: for every (CON face, JOB face) combination that occurred, the number of games and
 *     the average final score of the player holding that combination.
 *   - ABCM sheet: for every card face (A001A..M012) plus "D", for each round 1-4, the number of
 *     player-games where that face was built (or, for "D", where the player gained at least one new
 *     colored die) in that round, and the average final score across those player-games.
 *
 * Writes one JSON file (default output/ai_data_report.json) that tools/ai_data_write.py then loads and
 * writes into AI.DATA.xlsx's existing cell layout -- kept as two steps (Node aggregates, Python writes
 * xlsx) since this project has no xlsx-writing library in Node, only openpyxl in Python (same split
 * tools/xlsx_to_json.py already uses in the other direction).
 *
 * Usage: node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath] [highScoreThreshold]
 *   aiLevel: "LV1" (default, no lookahead -- fast, ~10s/game) or "LV2" (1-turn lookahead, same as
 *   main.js's AI LV2 -- measurably slower, ~60-70s/game per 2026-08-03's measurement, budget accordingly
 *   for a large N).
 *   xlsxOutputPath: which .xlsx the every-10-games checkpoint (see writeReport) writes into -- defaults
 *   to AI.DATA.xlsx itself (the original behavior), but tools/run_ai_battle.js passes a fresh dated copy
 *   instead (2026-08-04, per user feedback: "同じフォルダにAIDATA20260802-1のような名前でエクセルを生成
 *   して") so a self-service battle run never touches the main AI.DATA.xlsx.
 *   highScoreThreshold: default 20 (2026-08-04, per user feedback: "20点以上の点数があった時 その得点を
 *   取ったAIが何をしたのか確認できるように"). Any game where at least one player's finalScore reaches
 *   this records all 4 players' score/CON/JOB/initial-RESOURCE/builds-by-round as rows in a "HighScores"
 *   sheet inside the SAME xlsxOutputPath workbook (per user feedback: "ログは一つのエクセルファイルに
 *   まとめる" -- one row per player, not a separate file) -- see collectHighScoreRows's own doc for
 *   exactly what's captured and why (JOB/CON/initial RESOURCE/builds only, not full move-by-move detail).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame, AREA_CARD_BY_MAP } = require('../src/ai/game-runner');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'ai_data_report.json');
const XLSX_WRITE_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ai_data_write.py');
const DEFAULT_XLSX_PATH = path.join(PROJECT_ROOT, 'AI.DATA.xlsx');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

/** Which ABCM rows the new "使用回数" column (2026-08-07, per user spec) actually applies to: the 8
 * A-deck cards (usage = usage fee collected via their AREA, see AREA_CARD_BY_MAP) and B008A (usage = wD
 * granted at build time). Every other row (B/C decks besides B008A, M001-M012, "D") has no such concept
 * -- per user spec, those stay blank ("B008Bは空欄でOK", "Dも空欄でOK") rather than showing a misleading
 * 0. Checked at write time (see writeReport below), not during accumulation -- an entry's usageSum simply
 * never gets touched for an ineligible id, so this only decides whether a real (possibly zero) sum gets
 * reported as an average or suppressed as inapplicable. */
const USAGE_ELIGIBLE_ABCM_FACES = new Set([...Object.values(AREA_CARD_BY_MAP), 'B008A']);

/** One row per player (all 4, not just whoever crossed the threshold -- per user feedback: "4人とも記録
 * それぞれの得点も") for a game that had at least one high score. Deliberately limited to "score-relevant
 * actions" (per user feedback: "JOB CON 初期資源 建築/改築など「スコアに直結する行動」だけに絞ります") --
 * NOT a full move-by-move log (no die placements, free actions, TAP reactions, etc.). The initial
 * RESOURCE cards aren't in historyByPlayerId/roundDetailByPlayerId at all, but don't need new tracking
 * in game-runner.js either -- setup.chooseResourceCards already leaves them as permanent (if UI-hidden)
 * entries in ownedCardPhysicalIds (confirmed 2026-07-31), so they're recovered here straight from the
 * final `state` by their "R" ID prefix. */
function collectHighScoreRows(state, seed, historyByPlayerId, roundDetailByPlayerId) {
  return state.players.map((player) => {
    const h = historyByPlayerId[player.id];
    const resources = player.ownedCardPhysicalIds
      .filter((physicalId) => physicalId.startsWith('R'))
      .map((physicalId) => state.cards[physicalId].currentFaceId);
    const buildsByRound = roundDetailByPlayerId[player.id].buildsByRound;
    return {
      seed,
      playerId: player.id,
      score: h.finalScore,
      con: h.conFaceId,
      job: h.jobFaceId,
      resources,
      builds1: buildsByRound[1],
      builds2: buildsByRound[2],
      builds3: buildsByRound[3],
      builds4: buildsByRound[4],
    };
  });
}

function main() {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1) {
    console.error('Usage: node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath]');
    process.exit(1);
  }
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const aiLevel = (process.argv[4] || 'LV1').toUpperCase();
  if (aiLevel !== 'LV1' && aiLevel !== 'LV2') {
    console.error(`Unknown aiLevel "${aiLevel}" -- expected LV1 or LV2`);
    process.exit(1);
  }
  const XLSX_PATH = process.argv[5] ? path.resolve(process.argv[5]) : DEFAULT_XLSX_PATH;
  const highScoreThreshold = process.argv[6] !== undefined ? Number(process.argv[6]) : 20;
  if (!Number.isFinite(highScoreThreshold)) {
    console.error(`Invalid highScoreThreshold "${process.argv[6]}" -- expected a number`);
    process.exit(1);
  }
  const aiOptions = aiLevel === 'LV2' ? { lookaheadExtraTurns: 1 } : undefined;

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);

  // conjob["CON001A\tJOB001"] = { count, scoreSum }
  const conjob = new Map();
  // abcm["A001A"][1] = { count, scoreSum, usageSum } -- 1-4 for rounds, plus the "D" row for colored-die
  // gains. usageSum (2026-08-07) only ever gets added to for USAGE_ELIGIBLE_ABCM_FACES ids -- see that
  // set's own doc.
  const abcm = new Map();
  function abcmEntry(id, round) {
    if (!abcm.has(id)) {
      abcm.set(id, {
        1: { count: 0, scoreSum: 0, usageSum: 0 },
        2: { count: 0, scoreSum: 0, usageSum: 0 },
        3: { count: 0, scoreSum: 0, usageSum: 0 },
        4: { count: 0, scoreSum: 0, usageSum: 0 },
      });
    }
    return abcm.get(id)[round];
  }
  // job["JOB001"] = { count, usageSum } -- one row per JOB face, no per-round breakdown (2026-08-07, per
  // user spec: written as a single aggregate into CONJOB row30, B30:I30, not ABCM-style per-round
  // columns). "usage" means different things per JOB: TAP count for JOB001/002/003/004/005/007 (all from
  // activationCounts -- the listener doesn't distinguish AUTO/MANUAL/bare, it only cares the TAP fired
  // for real), PASSIVE-fire count for JOB006 (same activationCounts, since ON(GET(...),...) firings are
  // tracked identically to TAP firings there), and JOB008's own bonus VP (roundDetailByPlayerId's
  // job008BonusVp, NOT activationCounts -- JOB008's IF(...)-based PASSIVE has no ON(...) wrapper at all,
  // so the listener never fires for it, see executor.emit's own findOnHandlers filter).
  const job = new Map();
  function jobEntry(jobFaceId) {
    if (!job.has(jobFaceId)) job.set(jobFaceId, { count: 0, usageSum: 0 });
    return job.get(jobFaceId);
  }
  // One row per player in any game where at least one player's score reached highScoreThreshold (see
  // collectHighScoreRows's own doc).
  const highScoreRows = [];

  const runId = Date.now();
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const seed = `data-report-${runId}-${i}`;
    let state;
    let historyByPlayerId;
    let roundDetailByPlayerId;
    let activationCounts;
    try {
      ({ state, historyByPlayerId, roundDetailByPlayerId, activationCounts } = playGame(seed, PLAYER_NAMES, index, evalTable, aiOptions));
    } catch (e) {
      console.error(`Game ${i + 1}/${n} (seed=${seed}) crashed: ${e.message}`);
      console.error(e.stack);
      process.exit(1);
    }

    if (Object.values(historyByPlayerId).some((h) => h.finalScore >= highScoreThreshold)) {
      highScoreRows.push(...collectHighScoreRows(state, seed, historyByPlayerId, roundDetailByPlayerId));
    }

    for (const playerId of Object.keys(historyByPlayerId)) {
      const h = historyByPlayerId[playerId];
      const key = `${h.conFaceId}\t${h.jobFaceId}`;
      if (!conjob.has(key)) conjob.set(key, { con: h.conFaceId, job: h.jobFaceId, count: 0, scoreSum: 0 });
      const entry = conjob.get(key);
      entry.count++;
      entry.scoreSum += h.finalScore;

      const detail = roundDetailByPlayerId[playerId];
      for (const round of [1, 2, 3, 4]) {
        for (const faceId of detail.buildsByRound[round]) {
          const e = abcmEntry(faceId, round);
          e.count++;
          e.scoreSum += detail.finalScore;
          // "使用回数" (2026-08-07, per user spec) -- only meaningful for B008A (wD granted at build
          // time) and the A-deck's 8 fee-generating cards (see USAGE_ELIGIBLE_ABCM_FACES's own doc); at
          // most one of these two conditions can ever apply to a given faceId.
          if (faceId === 'B008A' && detail.b008aWhiteDiceGained !== null) e.usageSum += detail.b008aWhiteDiceGained;
          const feeForThisCard = (detail.areaFeeByRoundAndCard[round] || {})[faceId];
          if (feeForThisCard !== undefined) e.usageSum += feeForThisCard;
        }
        if (detail.colorDiceGainedByRound[round] > 0) {
          const e = abcmEntry('D', round);
          e.count++;
          e.scoreSum += detail.finalScore;
        }
      }

      // JOB "使用回数" (2026-08-07, per user spec) -- see jobEntry's own doc on what "usage" means per
      // JOB face.
      const jobFaceId = h.jobFaceId;
      const usage = jobFaceId === 'JOB008' ? (detail.job008BonusVp || 0) : (activationCounts[jobFaceId] || 0);
      const je = jobEntry(jobFaceId);
      je.count++;
      je.usageSum += usage;
    }

    if ((i + 1) % 10 === 0 || i + 1 === n) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${i + 1}/${n} games done (${elapsed}s elapsed)`);
      // Incremental checkpoint (2026-08-04, per user feedback after watching a long LV2 run: they asked
      // to see interim results and to be able to redirect to a smaller N mid-run) -- overwrites the same
      // outputPath every 10 games with whatever's accumulated so far, gamesRun reflecting the ACTUAL
      // count completed so far (not the target n). Without this, killing a long run early (e.g. to switch
      // to a smaller N, or just to see progress) meant losing every game's data -- this script only ever
      // wrote its output once, at the very end of the full loop. Cheap enough to do every 10 games (the
      // aggregation itself, not the games, is what's slow) that there's no reason to gate it further.
      writeReport(i + 1);
    }
  }

  writeReport(n);

  function writeReport(gamesRun) {
    const conjobOut = [...conjob.values()].map((e) => ({ con: e.con, job: e.job, count: e.count, avgScore: e.scoreSum / e.count }));
    const abcmOut = {};
    for (const [id, byRound] of abcm) {
      abcmOut[id] = {};
      const usageEligible = USAGE_ELIGIBLE_ABCM_FACES.has(id);
      for (const round of [1, 2, 3, 4]) {
        const e = byRound[round];
        abcmOut[id][round] = {
          count: e.count,
          avgScore: e.count > 0 ? e.scoreSum / e.count : null,
          avgUsage: usageEligible && e.count > 0 ? e.usageSum / e.count : null,
        };
      }
    }
    // job["JOB001"] = {count, avgUsage} -- see jobEntry's own doc. Written into CONJOB row30 (B30:I30) by
    // ai_data_write.py, one aggregate value per JOB, not per-round.
    const jobOut = {};
    for (const [jobFaceId, e] of job) {
      jobOut[jobFaceId] = { count: e.count, avgUsage: e.count > 0 ? e.usageSum / e.count : null };
    }
    fs.writeFileSync(outputPath, JSON.stringify({ gamesRun, aiLevel, conjob: conjobOut, abcm: abcmOut, job: jobOut, highScoreThreshold, highScoreRows }, null, 1));
    console.log(`Wrote aggregate report (${gamesRun} games at ${aiLevel}, ${conjobOut.length} CON x JOB combos, ${abcm.size} ABCM rows with data, ${job.size} JOB rows with data, ${highScoreRows.length} high-score (>=${highScoreThreshold}) player-rows) to ${outputPath}`);
    // Also pushes straight into AI.DATA.xlsx itself at every checkpoint (2026-08-04, per user feedback:
    // "10戦ごとにAIDATAに上書きしていってください"), not just this intermediate JSON -- same
    // tools/ai_data_write.py this project already used for the final write, just invoked automatically
    // now instead of as a separate manual step. Failure here (e.g. the workbook is open elsewhere and
    // locked) must NOT kill the still-running game loop -- it's a nice-to-have refresh, not something
    // worth losing hours of AI-vs-AI progress over -- so it's caught and just logged.
    try {
      const out = execFileSync('python', [XLSX_WRITE_SCRIPT, outputPath, XLSX_PATH], { encoding: 'utf8' });
      console.log(out.trim());
    } catch (e) {
      console.error(`AI.DATA.xlsx auto-write failed (will retry at the next checkpoint): ${e.message}`);
    }
  }
}

main();
