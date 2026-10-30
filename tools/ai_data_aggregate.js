/**
 * AI.DATA.xlsx's aggregation (CONJOB / ABCM / HighScores), shared by tools/ai_data_report.js (AI対戦) and
 * the 進化AI (tools/ga_worker.js + tools/ga_hillclimb.js, 2026-10-30, per user request: "進化AIを進めると
 * 自動で生成" -- see tools/ga_ai_data.js). Moved here verbatim from tools/ai_data_report.js's main(); see
 * that file's own top-of-file doc for what every sheet/column means.
 *
 * createAggregate(index, highScoreThreshold, saved?) -> {
 *   addGame(seed, state, historyByPlayerId, roundDetailByPlayerId, activationCounts) -- one game, as
 *     returned by game-runner's playGame (or playGameForFitness with recordHistory),
 *   merge(otherAggregate.toJSON()) -- adds another aggregate's sums in (the 進化AI's workers each aggregate
 *     their own one game and post just that, instead of the whole GameState),
 *   toJSON() -- plain sums, safe to save and to pass back in as `saved`,
 *   report(gamesRun, aiLevel) -- the JSON tools/ai_data_write.py reads,
 * }
 */

'use strict';

const { getCardRow } = require('../src/data-loader');
const { AREA_CARD_BY_MAP } = require('../src/ai/game-runner');
const executor = require('../src/executor');
const scoring = require('../src/scoring');

/** CON faces whose own PASSIVE (real or bespoke) applies a VP penalty (2026-08-15, per user request:
 * "VPペナルティがあるものは、その平均も出るようにしてください") -- 狂信(CON003A)/強欲(CON002B) via the
 * generic VP_PENALTY_IF_BELOW command, 潔癖(CON002A) via VP_PENALTY_PER, 裏切(CON006A)/嫉妬(CON004B)/
 * 傲慢(CON004A) via scoring.js's bespoke QST-rank logic (see that module's own doc on why those three
 * can't be real PASSIVE data). Tracked as a simple average over every game where that CON face was
 * actually held, via scoring.conCardOwnVpEffect -- isolated to just that one face's own contribution,
 * not the player's combined total. IDs updated 2026-08-17 when the user reorganized game.xlsx's CON
 * sheet by START_ORDER -- 裏切 CON001B->CON006B, 潔癖 CON005A->CON002A, 強欲 CON005B->CON002B; 狂信
 * (CON003A) and 嫉妬(CON004B) happened to stay put. 傲慢(CON004A) added 2026-08-22 alongside its new
 * "最多AREAが必要　足りない１個につき-1VP" rule. 2026-09-26: 裏切/暴食 swapped which face of CON006 is
 * 表/裏 again -- 裏切 now CON006A (see scoring.js's own doc). */
const CON_VP_PENALTY_FACES = new Set(['CON006A', 'CON003A', 'CON004B', 'CON002A', 'CON002B', 'CON004A']);

/** The 8 A-deck AREA-ownership faces (see AREA_CARD_BY_MAP's own doc) -- usage = fee collected via their
 * AREA, tracked separately from the generic TAP-count path below since it isn't TAP-driven at all. */
const AREA_FEE_FACES = new Set(Object.values(AREA_CARD_BY_MAP));

/** faceId's tier-A<->tier-B sibling (A/B/C decks only ever have these two tiers -- see main.js's own
 * siblingFaceId, same A<->B swap-the-last-letter logic, duplicated here rather than shared since main.js
 * is a browser-only classic script, not a requireable module). */
function siblingFaceId(faceId) {
  return faceId.replace(/[AB]$/, (m) => (m === 'A' ? 'B' : 'A'));
}

/** Which ABCM rows the "使用回数" column (2026-08-07, per user spec) actually applies to, and what
 * "usage" means for each:
 *  - The 8 A-deck cards (AREA_FEE_FACES): usage fee collected via their AREA (accumulated separately,
 *    see areaFeeByRoundAndCard's own doc in game-runner.js).
 *  - B301A (renamed from B008A by the 2026-08-24 SHOP201-203 rework's card renumbering; still 栄光の証):
 *    LVUP success rate -- fraction of B301A-build games where that player's card actually got upgraded
 *    into B301B by GAME_END (2026-08-12, per user spec: "B008AはLVUPできたときの割合 10回中8回LVUPで0.8"
 *    -- supersedes the old "wD granted at build time" meaning from when B301A's ONCE still scaled with
 *    天 emblems; that scaling moved to B301B's PASSIVE, see the commit that made it a persistent effect).
 *  - B301B (renamed from B008B, still 栄光の証LV2): max(天,地,人) emblem count at GAME_END, for whichever
 *    player owns it (2026-08-12, per user spec: "B008Bはゲーム終了時のエンブレム天の数" -- supersedes the
 *    old "空欄でOK"/not-tracked state, now that B301B's own PASSIVE makes that count directly meaningful;
 *    2026-08-17, per user request ("最多エンブレムの数*VPにしたい"), the PASSIVE itself changed from
 *    VP_MODIFIER(COUNT(天)) to VP_MODIFIER(MAX_EMBLEM_COUNT), so this usage metric follows suit).
 *  - Every other B/C-deck face WITH a real TAP field (data-driven check below -- B004A/B/B301A/B all have
 *    an empty TAP, confirmed via data/game.json, so this naturally excludes them without a hardcoded
 *    list): TAP count, from activationCounts. A tier-A face's own count is a *cumulative* total including
 *    whatever its tier-B sibling racked up after upgrading (2026-08-07, per user spec: "グレードアップ
 *    するカードはグレードアップ後にTAPした回数も含みます" -- e.g. C001A taps 3 times before upgrading,
 *    then (as C001B) 2 more times after -- C001A's row shows 5, C001B's row shows its own 2, not double-
 *    counted). A/M cards have no TAP field at all, so they fall through to "not eligible" here regardless
 *    (their own usage, if any, already came from the fee/B301A/B301B branches above).
 * isUsageEligible/usageAmount are checked/computed at write time (see writeReport below) and at
 * accumulation time (the build loop below) respectively -- an entry's usageSum simply never gets touched
 * for an ineligible id, so eligibility only decides whether a real (possibly zero) sum gets reported as
 * an average or suppressed as inapplicable (per user spec: "Dも空欄でOK", and by the same logic every
 * TAP-less B/C face too). */
function isUsageEligible(index, id) {
  if (AREA_FEE_FACES.has(id) || id === 'B301A' || id === 'B301B') return true;
  if (!/^[BC]\d{3}[AB]$/.test(id)) return false; // only B/C-deck faces can reach the TAP-field check
  return !!getCardRow(index, id).TAP;
}

/** One row per player who actually crossed the threshold themselves (2026-09-02, per user request --
 * supersedes the original 2026-08-04 "4人とも記録 それぞれの得点も" behavior of recording all 4 players
 * of any game containing a high score; the other players' own sub-threshold scores are no longer
 * included here at all). Deliberately limited to "score-relevant actions" (per user feedback: "JOB CON
 * 初期資源 建築/改築など「スコアに直結する行動」だけに絞ります") -- NOT a full move-by-move log (no die
 * placements, free actions, TAP reactions, etc.). The initial RESOURCE cards aren't in
 * historyByPlayerId/roundDetailByPlayerId at all, but don't need new tracking in game-runner.js either --
 * setup.chooseResourceCards already leaves them as permanent (if UI-hidden) entries in
 * ownedCardPhysicalIds (confirmed 2026-07-31), so they're recovered here straight from the final `state`
 * by their "R" ID prefix. Player/CON/JOB/Resources/Builds are all reported by their Japanese card NAME
 * rather than face ID (2026-09-02, per user request), via cardName() below. */
function collectHighScoreRows(state, index, seed, historyByPlayerId, roundDetailByPlayerId, highScoreThreshold) {
  const cardName = (faceId) => getCardRow(index, faceId).NAME;
  return state.players
    .filter((player) => historyByPlayerId[player.id].finalScore >= highScoreThreshold)
    .map((player) => {
      const h = historyByPlayerId[player.id];
      const resources = player.ownedCardPhysicalIds
        .filter((physicalId) => physicalId.startsWith('R'))
        .map((physicalId) => cardName(state.cards[physicalId].currentFaceId));
      const buildsByRound = roundDetailByPlayerId[player.id].buildsByRound;
      return {
        seed,
        playerName: player.name,
        score: h.finalScore,
        con: cardName(h.conFaceId),
        job: cardName(h.jobFaceId),
        resources,
        builds1: buildsByRound[1].map(cardName),
        builds2: buildsByRound[2].map(cardName),
        builds3: buildsByRound[3].map(cardName),
        builds4: buildsByRound[4].map(cardName),
      };
    });
}

/** Adds every number in `from` into `into` (same shape, nested objects), creating missing keys. */
function addSums(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === 'number') into[k] = (into[k] || 0) + v;
    else if (v && typeof v === 'object') addSums(into[k] || (into[k] = {}), v);
    else if (!(k in into)) into[k] = v;
  }
}

function createAggregate(index, highScoreThreshold, saved) {
  // conjob["CON001A\tJOB001"] = { count, scoreSum, qstScoreSum, rankSum }. scoreSum (2026-08-09, per user
  // request: "AIDATA 平均得点は QSTカードなしの今までの得点で平均を出してください") now excludes QST's
  // rank-based reward VP -- i.e. it's finalScore minus qstScore, matching the metric's original,
  // pre-QST-auto-reward meaning -- while qstScoreSum tracks QST's own contribution separately, for the
  // new "QST平均得点" table (see writeReport's avgQstScore below). rankSum (2026-08-20, per user request:
  // "これを参考に平均順位を書き出すようにしてほしい") sums each player-game's final placement (1-4, from
  // game-runner.js's historyByPlayerId.rank -- see that field's own doc for the ranking rule reused, same
  // one the real in-game UI's own standings/GAME_END screens use) for the new "平均順位" table.
  const conjob = new Map(Object.entries((saved && saved.conjob) || {}));
  // abcm["A001A"][1] = { count, scoreSum, qstScoreSum, usageSum, orphanageVpSum, rankSum } -- 1-4 for
  // rounds, plus the "D" row for colored-die gains. usageSum (2026-08-07) only ever gets added to for
  // isUsageEligible ids -- see that function's own doc. orphanageVpSum (2026-08-28, per user request --
  // see game-runner.js's roundDetailByPlayerId.orphanageVpGained doc) is a separate accumulator only ever
  // touched for A201A/A201B ("孤児院の支配LV1/LV2" in the ABCM sheet's own ID column) -- see the build loop
  // below. Kept separate from usageSum rather than reusing it, since A201A already has a real, different
  // usageSum meaning (usage-fee collected via its own AREA -- see isUsageEligible's own doc) that this
  // must not be mixed into; ai_data_write.py writes this into the SAME "使用回数2/3/4" columns as usageSum
  // for these two rows specifically, per user request ("これはAIDATAの使用回数に表示してほしいという意味
  // でした"). scoreSum/qstScoreSum/rankSum split the same way as conjob's own, above.
  const abcm = new Map(Object.entries((saved && saved.abcm) || {}));
  function abcmEntry(id, round) {
    if (!abcm.has(id)) {
      abcm.set(id, {
        1: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0, orphanageVpSum: 0, rankSum: 0 },
        2: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0, orphanageVpSum: 0, rankSum: 0 },
        3: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0, orphanageVpSum: 0, rankSum: 0 },
        4: { count: 0, scoreSum: 0, qstScoreSum: 0, usageSum: 0, orphanageVpSum: 0, rankSum: 0 },
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
  // job008BonusVp, NOT activationCounts -- this "使用回数" column means *how much bonus VP was earned*
  // for JOB008 specifically, not *how many times the ability fired*, which activationCounts alone
  // couldn't distinguish (2026-08-17: JOB008 does call notifyActivation too now, same as JOB009-011, but
  // that only records a firing happened, not how many VP units it granted in one catch-up jump -- see
  // JOB010 (2026-08-22, per user request: "K35のセル革命家の使用回数は革命の兆しの使用回数の平均を出して")
  // is the same kind of exception as JOB008 -- JOB010 itself has no TAP/PASSIVE ability of its own
  // (its only effect is the one-time onboarding "革命の兆しを獲得する" bonus, see
  // setup.grantRevolutionaryBonusIfEarned), so activationCounts['JOB010'] would always be 0. This
  // column instead reports B005(革命の兆し; renamed from B007 by the 2026-08-24 SHOP201-203 rework's
  // card renumbering)'s own TAP usage -- both tiers combined (activationCounts is keyed per face, and a
  // physical B005 card upgrades A->B over the course of a game, same ownTaps+upgradeBonus combining
  // pattern the B/C TAP-usage branch above already uses) -- since the whole point of JOB010 is granting
  // access to that card.
  // turn-flow.grantBardBonusIfEarned's own doc).
  // scoreSum/qstScoreSum/rankSum (2026-08-20, per user request) -- a TRUE per-JOB weighted average
  // (this sum divided by this same count), not the "average of the 12 per-CON averages"
  // AI.DATA.xlsx's own CONJOB rows 31/51/69 used to compute via a plain =AVERAGE(...) of already-averaged
  // cells. That unweighted approach silently over-weights a CON+JOB combo with very few trials (high
  // variance) exactly as much as one with many -- the user's own question ("実際の平均とずれると思います")
  // confirmed this is a real, not-always-negligible bias. ai_data_write.py now writes this value as a
  // plain number directly into those rows instead of relying on the sheet's own AVERAGE formula.
  const job = new Map(Object.entries((saved && saved.job) || {}));
  function jobEntry(jobFaceId) {
    if (!job.has(jobFaceId)) job.set(jobFaceId, { count: 0, usageSum: 0, scoreSum: 0, qstScoreSum: 0, rankSum: 0 });
    return job.get(jobFaceId);
  }
  // con["CON001A"] = {count, scoreSum, qstScoreSum, rankSum} -- same TRUE weighted-average idea as job/
  // jobEntry above, but aggregated across every JOB a CON face was ever paired with instead of across
  // every CON a JOB was paired with. Feeds CONJOB's own per-CON marginal column N (2026-08-31, per user
  // report: column N's own "=AVERAGE(11 already-averaged per-JOB cells)" formula has the exact same
  // unweighted-average-of-averages bias jobEntry's own doc already explains for the JOB-axis rows this
  // fixed on 2026-08-20 -- this is the CON-axis counterpart of that same fix).
  const con = new Map(Object.entries((saved && saved.con) || {}));
  function conEntry(conFaceId) {
    if (!con.has(conFaceId)) con.set(conFaceId, { count: 0, scoreSum: 0, qstScoreSum: 0, rankSum: 0 });
    return con.get(conFaceId);
  }
  // conVpPenalty["CON003A"] = { count, sum } -- see CON_VP_PENALTY_FACES' own doc. count is how many
  // player-games actually held that face (not every game, since not every player draws every CON), sum
  // is the total of conCardOwnVpEffect across those.
  const conVpPenalty = new Map(Object.entries((saved && saved.conVpPenalty) || {}));
  function conVpPenaltyEntry(faceId) {
    if (!conVpPenalty.has(faceId)) conVpPenalty.set(faceId, { count: 0, sum: 0 });
    return conVpPenalty.get(faceId);
  }
  // One row per player in any game where at least one player's score reached highScoreThreshold (see
  // collectHighScoreRows's own doc).
  const highScoreRows = (saved && saved.highScoreRows) || [];

  // One game's worth of aggregation (2026-09-16, factored out of the old inline loop body so
  // tools/ai_data_report_worker.js's own parallel results can feed the exact same logic the sequential
  // path always has; moved here from tools/ai_data_report.js 2026-10-30 so the 進化AI shares it too) -- see concurrency's own doc below). Mutates the outer conjob/abcm/job/con/
  // conVpPenalty/highScoreRows closures, same as before.
  function addGame(seed, state, historyByPlayerId, roundDetailByPlayerId, activationCounts) {
    if (Object.values(historyByPlayerId).some((h) => h.finalScore >= highScoreThreshold)) {
      highScoreRows.push(...collectHighScoreRows(state, index, seed, historyByPlayerId, roundDetailByPlayerId, highScoreThreshold));
    }

    for (const playerId of Object.keys(historyByPlayerId)) {
      const h = historyByPlayerId[playerId];
      const detail = roundDetailByPlayerId[playerId];
      const key = `${h.conFaceId}\t${h.jobFaceId}`;
      if (!conjob.has(key)) conjob.set(key, { con: h.conFaceId, job: h.jobFaceId, count: 0, scoreSum: 0, qstScoreSum: 0, rankSum: 0 });
      const entry = conjob.get(key);
      entry.count++;
      entry.scoreSum += detail.finalScore - detail.qstScore;
      entry.qstScoreSum += detail.qstScore;
      entry.rankSum += h.rank;

      if (CON_VP_PENALTY_FACES.has(h.conFaceId)) {
        const vpEntry = conVpPenaltyEntry(h.conFaceId);
        vpEntry.count++;
        vpEntry.sum += scoring.conCardOwnVpEffect(state, index, playerId, h.conFaceId);
      }

      for (const round of [1, 2, 3, 4]) {
        for (const faceId of detail.buildsByRound[round]) {
          const e = abcmEntry(faceId, round);
          e.count++;
          e.scoreSum += detail.finalScore - detail.qstScore;
          e.qstScoreSum += detail.qstScore;
          e.rankSum += h.rank;
          // "使用回数" (2026-08-07, per user spec) -- see isUsageEligible's own doc; exactly one of
          // these four branches can ever apply to a given faceId (B301A / B301B / an A-deck fee card /
          // a TAP-bearing B or C face are mutually exclusive sets).
          // B301A (renamed from B008A by the 2026-08-24 SHOP201-203 rework's card renumbering; still
          // 栄光の証) (2026-08-12): LVUP success rate -- a physical B301 card can only ever reach B301B by
          // upgrading from B301A, and only once, so "did 'B301B' ever appear anywhere in this player's
          // buildsByRound" is exactly "did this B301A LVUP succeed" -- no separate tracking needed.
          if (faceId === 'B301A') {
            const lvupSucceeded = Object.values(detail.buildsByRound).some((facesThisRound) => facesThisRound.includes('B301B'));
            e.usageSum += lvupSucceeded ? 1 : 0;
          }
          // B301B (renamed from B008B, still 栄光の証LV2) (2026-08-12; metric changed 2026-08-17):
          // max(天,地,人) emblem count at GAME_END for the player who owns it -- read straight off the
          // final `state` rather than anything game-runner.js tracks, since it's just a live metric query
          // (same MAX_EMBLEM_COUNT B301B's own PASSIVE uses, see executor.collectVpModifiers).
          if (faceId === 'B301B') {
            e.usageSum += executor.evalMetric(state, index, playerId, { name: 'MAX_EMBLEM_COUNT', args: [] });
          }
          // 孤児院の支配LV1/LV2 (A201A/A201B) (2026-08-28, per user request): this player's own cumulative
          // VP from 孤児院's CHANGE(...,VP,...) ACTION, whole game -- see orphanageVpSum's own doc above.
          // Building A201A upgrades MAP010 to AREA010B, A201B to AREA010C; a player who upgrades further
          // in a LATER round still only appears in buildsByRound[round] for A201A in THIS (earlier) round
          // -- their eventual A201B build (if any) gets counted separately, in whichever later round that
          // happens, under A201B's own row.
          if (faceId === 'A201A' || faceId === 'A201B') {
            e.orphanageVpSum += detail.orphanageVpGained;
          }
          const feeForThisCard = (detail.areaFeeByRoundAndCard[round] || {})[faceId];
          if (feeForThisCard !== undefined) e.usageSum += feeForThisCard;
          if (!AREA_FEE_FACES.has(faceId) && faceId !== 'B301A' && faceId !== 'B301B' && /^[BC]\d{3}[AB]$/.test(faceId) && getCardRow(index, faceId).TAP) {
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
          e.rankSum += h.rank;
        }
      }

      // JOB "使用回数" (2026-08-07, per user spec) -- see jobEntry's own doc on what "usage" means per
      // JOB face.
      const jobFaceId = h.jobFaceId;
      const usage = jobFaceId === 'JOB008' ? (detail.job008BonusVp || 0)
        : jobFaceId === 'JOB010' ? ((activationCounts['B005A'] || 0) + (activationCounts['B005B'] || 0))
        : (activationCounts[jobFaceId] || 0);
      const je = jobEntry(jobFaceId);
      je.count++;
      je.usageSum += usage;
      je.scoreSum += detail.finalScore - detail.qstScore;
      je.qstScoreSum += detail.qstScore;
      je.rankSum += h.rank;

      // CON's own TRUE weighted average across every JOB it was paired with (see conEntry's own doc).
      const ce = conEntry(h.conFaceId);
      ce.count++;
      ce.scoreSum += detail.finalScore - detail.qstScore;
      ce.qstScoreSum += detail.qstScore;
      ce.rankSum += h.rank;
    }
  }

  function merge(part) {
    const maps = { conjob, abcm, job, con, conVpPenalty };
    for (const [name, map] of Object.entries(maps)) {
      for (const [key, value] of Object.entries(part[name] || {})) {
        if (!map.has(key)) map.set(key, JSON.parse(JSON.stringify(value)));
        else addSums(map.get(key), value);
      }
    }
    highScoreRows.push(...(part.highScoreRows || []));
  }

  function toJSON() {
    return {
      conjob: Object.fromEntries(conjob), abcm: Object.fromEntries(abcm), job: Object.fromEntries(job),
      con: Object.fromEntries(con), conVpPenalty: Object.fromEntries(conVpPenalty), highScoreRows,
    };
  }

  function report(gamesRun, aiLevel) {
    const conjobOut = [...conjob.values()].map((e) => ({ con: e.con, job: e.job, count: e.count, avgScore: e.scoreSum / e.count, avgQstScore: e.qstScoreSum / e.count, avgRank: e.rankSum / e.count }));
    const abcmOut = {};
    for (const [id, byRound] of abcm) {
      abcmOut[id] = {};
      const usageEligible = isUsageEligible(index, id);
      let totalCount = 0;
      let totalRankSum = 0;
      for (const round of [1, 2, 3, 4]) {
        const e = byRound[round];
        abcmOut[id][round] = {
          count: e.count,
          avgScore: e.count > 0 ? e.scoreSum / e.count : null,
          avgQstScore: e.count > 0 ? e.qstScoreSum / e.count : null,
          avgUsage: usageEligible && e.count > 0 ? e.usageSum / e.count : null,
          // 孤児院の支配LV1/LV2 only (2026-08-28) -- see orphanageVpSum's own doc above. null (blank) for
          // every other id, and for round 1 (孤児院 can't structurally be reached that early -- confirmed
          // with the user), same as e.count simply staying 0 there.
          avgOrphanageVp: (id === 'A201A' || id === 'A201B') && e.count > 0 ? e.orphanageVpSum / e.count : null,
          // Per-round average rank (2026-08-20, per user request: "AI.DATA平均順位1R-4Rを追加しました" --
          // added alongside the overall avgRank below, once the user added matching 平均順位{r}R columns
          // to the sheet).
          avgRank: e.count > 0 ? e.rankSum / e.count : null,
        };
        totalCount += e.count;
        totalRankSum += e.rankSum;
      }
      // Overall (not per-round) average rank, still kept alongside the per-round ones above -- see this
      // file's own top-of-file doc for the original single "平均順位" column this feeds.
      abcmOut[id].avgRank = totalCount > 0 ? totalRankSum / totalCount : null;
    }
    // job["JOB001"] = {count, avgUsage, avgScore, avgQstScore, avgRank} -- see jobEntry's own doc.
    // avgUsage written into CONJOB row30 (B30:I30); avgScore/avgQstScore/avgRank (2026-08-20) written as
    // plain values directly into rows 31/51/69, replacing the sheet's own unweighted
    // =AVERAGE(already-averaged-per-CON-cells) formula there -- see jobEntry's own doc on why.
    const jobOut = {};
    for (const [jobFaceId, e] of job) {
      jobOut[jobFaceId] = {
        count: e.count,
        avgUsage: e.count > 0 ? e.usageSum / e.count : null,
        avgScore: e.count > 0 ? e.scoreSum / e.count : null,
        avgQstScore: e.count > 0 ? e.qstScoreSum / e.count : null,
        avgRank: e.count > 0 ? e.rankSum / e.count : null,
      };
    }
    // con["CON001A"] = {count, avgScore, avgQstScore, avgRank} -- see conEntry's own doc. Written as
    // plain values directly into CONJOB's per-CON marginal column N (all three tables), replacing the
    // sheet's own unweighted =AVERAGE(already-averaged-per-JOB-cells) formula there.
    const conOut = {};
    for (const [conFaceId, e] of con) {
      conOut[conFaceId] = {
        count: e.count,
        avgScore: e.count > 0 ? e.scoreSum / e.count : null,
        avgQstScore: e.count > 0 ? e.qstScoreSum / e.count : null,
        avgRank: e.count > 0 ? e.rankSum / e.count : null,
      };
    }
    // conVpPenalty["CON003A"] = {count, avgVpPenalty} -- see CON_VP_PENALTY_FACES' own doc. Written into
    // CONJOB's own "VPペナルティ平均" column by ai_data_write.py, alongside the existing per-CON marginal
    // average column -- one value per CON face, independent of which JOB it was paired with.
    const conVpPenaltyOut = {};
    for (const [faceId, e] of conVpPenalty) {
      conVpPenaltyOut[faceId] = { count: e.count, avgVpPenalty: e.count > 0 ? e.sum / e.count : null };
    }
    return { gamesRun, aiLevel, conjob: conjobOut, abcm: abcmOut, job: jobOut, con: conOut, conVpPenalty: conVpPenaltyOut, highScoreThreshold, highScoreRows };
  }

  return { addGame, merge, toJSON, report };
}

module.exports = { createAggregate, CON_VP_PENALTY_FACES, isUsageEligible };
