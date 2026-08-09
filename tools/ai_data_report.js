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
 * Writes one JSON file (default output/ai_data_report.json) that tools/ai_data_write.py then loads and
 * writes into AI.DATA.xlsx's existing cell layout -- kept as two steps (Node aggregates, Python writes
 * xlsx) since this project has no xlsx-writing library in Node, only openpyxl in Python (same split
 * tools/xlsx_to_json.py already uses in the other direction).
 *
 * Usage: node tools/ai_data_report.js <N> [outputJsonPath] [aiLevel] [xlsxOutputPath] [highScoreThreshold]
 *   aiLevel: "LV1" (default, no lookahead -- fast, ~10s/game), "LV2" (1-turn lookahead, same as main.js's
 *   AI LV2 -- measurably slower, ~60-70s/game per 2026-08-03's measurement, budget accordingly for a
 *   large N), or "LV3" (2026-08-09, same lookahead as LV2 plus main.js's aiMoveGeneratorLv3 monument-
 *   focus policy from round 3 onward -- same speed budget as LV2).
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
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { playGame, AREA_CARD_BY_MAP } = require('../src/ai/game-runner');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'output', 'ai_data_report.json');
const XLSX_WRITE_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ai_data_write.py');
const DEFAULT_XLSX_PATH = path.join(PROJECT_ROOT, 'AI.DATA.xlsx');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

/** The 8 A-deck AREA-ownership faces (see AREA_CARD_BY_MAP's own doc) -- usage = fee collected via their
 * AREA, tracked separately from the generic TAP-count path below since it isn't TAP-driven at all. */
const AREA_FEE_FACES = new Set(Object.values(AREA_CARD_BY_MAP));

/** faceId's tier-A<->tier-B sibling (A/B/C decks only ever have these two tiers -- see main.js's own
 * siblingFaceId, same A<->B swap-the-last-letter logic, duplicated here rather than shared since main.js
 * is a browser-only classic script, not a requireable module). */
function siblingFaceId(faceId) {
  return faceId.replace(/[AB]$/, (m) => (m === 'A' ? 'B' : 'A'));
}

/** Which ABCM rows the new "使用回数" column (2026-08-07, per user spec) actually applies to, and what
 * "usage" means for each:
 *  - The 8 A-deck cards (AREA_FEE_FACES): usage fee collected via their AREA (accumulated separately,
 *    see areaFeeByRoundAndCard's own doc in game-runner.js).
 *  - B008A: wD granted at build time (b008aWhiteDiceGained).
 *  - Every other B/C-deck face WITH a real TAP field (data-driven check below -- B004A/B/B008A/B all have
 *    an empty TAP, confirmed via data/game.json, so this naturally excludes them without a hardcoded
 *    list): TAP count, from activationCounts. A tier-A face's own count is a *cumulative* total including
 *    whatever its tier-B sibling racked up after upgrading (2026-08-07, per user spec: "グレードアップ
 *    するカードはグレードアップ後にTAPした回数も含みます" -- e.g. C001A taps 3 times before upgrading,
 *    then (as C001B) 2 more times after -- C001A's row shows 5, C001B's row shows its own 2, not double-
 *    counted). A/M cards have no TAP field at all, so they fall through to "not eligible" here regardless
 *    (their own usage, if any, already came from the fee/B008A branches above).
 * isUsageEligible/usageAmount are checked/computed at write time (see writeReport below) and at
 * accumulation time (the build loop below) respectively -- an entry's usageSum simply never gets touched
 * for an ineligible id, so eligibility only decides whether a real (possibly zero) sum gets reported as
 * an average or suppressed as inapplicable (per user spec: "B008Bは空欄でOK", "Dも空欄でOK", and by the
 * same logic every TAP-less B/C face too). */
function isUsageEligible(index, id) {
  if (AREA_FEE_FACES.has(id) || id === 'B008A') return true;
  if (!/^[BC]\d{3}[AB]$/.test(id)) return false; // only B/C-deck faces can reach the TAP-field check
  return !!getCardRow(index, id).TAP;
}

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
  if (aiLevel !== 'LV1' && aiLevel !== 'LV2' && aiLevel !== 'LV3') {
    console.error(`Unknown aiLevel "${aiLevel}" -- expected LV1, LV2, or LV3`);
    process.exit(1);
  }
  const XLSX_PATH = process.argv[5] ? path.resolve(process.argv[5]) : DEFAULT_XLSX_PATH;
  const highScoreThreshold = process.argv[6] !== undefined ? Number(process.argv[6]) : 20;
  if (!Number.isFinite(highScoreThreshold)) {
    console.error(`Invalid highScoreThreshold "${process.argv[6]}" -- expected a number`);
    process.exit(1);
  }
  // LV3 shares LV2's lookahead and additionally gets main.js's aiMoveGeneratorLv3 monument-focus
  // policy (see game-runner.js's playGame doc for moveGeneratorOptions).
  const aiOptions = (aiLevel === 'LV2' || aiLevel === 'LV3') ? { lookaheadExtraTurns: 1 } : undefined;
  const moveGeneratorOptions = aiLevel === 'LV3' ? { monumentFocusFromRound: 3 } : undefined;

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);

  // conjob["CON001A\tJOB001"] = { count, scoreSum, qstScoreSum }. scoreSum (2026-08-09, per user
  // request: "AIDATA 平均得点は QSTカードなしの今までの得点で平均を出してください") now excludes QST's
  // rank-based reward VP -- i.e. it's finalScore minus qstScore, matching the metric's original,
  // pre-QST-auto-reward meaning -- while qstScoreSum tracks QST's own contribution separately, for the
  // new "QST平均得点" table (see writeReport's avgQstScore below).
  const conjob = new Map();
  // abcm["A001A"][1] = { count, scoreSum, qstScoreSum, usageSum } -- 1-4 for rounds, plus the "D" row
  // for colored-die gains. usageSum (2026-08-07) only ever gets added to for isUsageEligible ids -- see
  // that function's own doc. scoreSum/qstScoreSum split the same way as conjob's own, above.
  const abcm = new Map();
  function abcmEntry(id, round) {
    if (!abcm.has(id)) {
      abcm.set(id, {
        1: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0 },
        2: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0 },
        3: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0 },
        4: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0 },
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
      ({ state, historyByPlayerId, roundDetailByPlayerId, activationCounts } = playGame(seed, PLAYER_NAMES, index, evalTable, aiOptions, moveGeneratorOptions));
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
      const detail = roundDetailByPlayerId[playerId];
      const key = `${h.conFaceId}\t${h.jobFaceId}`;
      if (!conjob.has(key)) conjob.set(key, { con: h.conFaceId, job: h.jobFaceId, count: 0, scoreSum: 0, qstScoreSum: 0 });
      const entry = conjob.get(key);
      entry.count++;
      entry.scoreSum += detail.finalScore - detail.qstScore;
      entry.qstScoreSum += detail.qstScore;

      for (const round of [1, 2, 3, 4]) {
        for (const faceId of detail.buildsByRound[round]) {
          const e = abcmEntry(faceId, round);
          e.count++;
          e.scoreSum += detail.finalScore - detail.qstScore;
          e.qstScoreSum += detail.qstScore;
          // "使用回数" (2026-08-07, per user spec) -- see isUsageEligible's own doc; exactly one of
          // these three branches can ever apply to a given faceId (B008A / an A-deck fee card / a
          // TAP-bearing B or C face are mutually exclusive sets).
          if (faceId === 'B008A' && detail.b008aWhiteDiceGained !== null) e.usageSum += detail.b008aWhiteDiceGained;
          const feeForThisCard = (detail.areaFeeByRoundAndCard[round] || {})[faceId];
          if (feeForThisCard !== undefined) e.usageSum += feeForThisCard;
          if (!AREA_FEE_FACES.has(faceId) && faceId !== 'B008A' && /^[BC]\d{3}[AB]$/.test(faceId) && getCardRow(index, faceId).TAP) {
            const ownTaps = activationCounts[faceId] || 0;
            const upgradeBonus = faceId.endsWith('A') ? (activationCounts[siblingFaceId(faceId)] || 0) : 0;
            e.usageSum += ownTaps + upgradeBonus;
          }
        }
        if (detail.colorDiceGainedByRound[round] > 0) {
          const e = abcmEntry('D', round);
          e.count++;
          e.scoreSum += detail.finalScore - detail.qstScore;
          e.qstScoreSum += detail.qstScore;
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
    const conjobOut = [...conjob.values()].map((e) => ({ con: e.con, job: e.job, count: e.count, avgScore: e.scoreSum / e.count, avgQstScore: e.qstScoreSum / e.count }));
    const abcmOut = {};
    for (const [id, byRound] of abcm) {
      abcmOut[id] = {};
      const usageEligible = isUsageEligible(index, id);
      for (const round of [1, 2, 3, 4]) {
        const e = byRound[round];
        abcmOut[id][round] = {
          count: e.count,
          avgScore: e.count > 0 ? e.scoreSum / e.count : null,
          avgQstScore: e.count > 0 ? e.qstScoreSum / e.count : null,
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
