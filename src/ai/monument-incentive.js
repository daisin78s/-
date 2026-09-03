(function () {
'use strict';

/**
 * Synergy lookup + scoring for game.xlsx's 評価値_戦略 sheet (added 2026-08-29 as 評価値_5, renamed
 * 2026-08-29, "AI LV4" only -- per user report: AI LV4's score keeps rising but monuments needing DICE<=6
 * yet a HEAVY multi-color COST (中央広場/聖王城/円形闘技場/凱旋門/大城塞/聖域/大交易所) are almost never
 * acquired before round 4, because the AI's shallow 1-3R lookahead never sees the value of holding
 * resources back for a purchase several turns away -- it spends on whatever's cheap and immediate
 * instead. This module recognizes a handful of concrete "close to affording something big" patterns
 * (single-die + a die-boosting card TAP; 歓楽街の支配LV2's K->(A,B,C,Z) conversion; 農園/小麦畑's own K
 * stockpiling) and credits the resulting state accordingly, using this sheet's own per-round weight for
 * each pattern (same NAME + 1R/2R/3R/4R shape as eval-table.js's main 評価値 sheet). Rows are named
 * narrowly enough (e.g. "宮廷人が+1能力で施療院を獲得", not just "宮廷人x施療院") that each one maps to
 * exactly one condition below -- confirmed with the user this granularity matters: a flat "owns 宮廷人 x
 * building 施療院" credit would also fire when 施療院 was reached some *other* way (e.g. a natural 2-dice
 * group sum), which isn't the scenario this sheet is meant to reward.
 */

const { getCardRow } = require('../data-loader');
const { lowerCostList } = require('../command-builder');

const SHEET_NAME = '評価値_戦略';

/** Same regex board.js's own (unexported) parseMonumentThreshold / evaluator.js's own copy use, e.g.
 * ">=12" -> 12. Duplicated rather than shared purely for this one line, same convention as those. */
function parseMonumentThreshold(diceString) {
  const match = /^>=(\d+)$/.exec(diceString);
  return match ? Number(match[1]) : null;
}

function buildMonumentIncentiveTable(rawData) {
  const rows = rawData[SHEET_NAME] || [];
  const table = {};
  for (const row of rows) {
    const name = row.NAME;
    if (!name) continue;
    const byRound = {};
    for (const round of [1, 2, 3, 4]) {
      const raw = row[`${round}R`];
      byRound[round] = typeof raw === 'number' ? raw : 0;
    }
    table[name] = byRound;
  }
  return table;
}

/** Looks up name's incentive value at `round` (clamped to 1..4). Missing names or blank cells both
 * resolve to 0, same convention as eval-table.js's own evalValue. */
function incentiveValue(table, name, round) {
  const row = table[name];
  if (!row) return 0;
  const clamped = Math.max(1, Math.min(4, round));
  return row[clamped] || 0;
}

/** True if faceId (an M-family monument, physicalId===faceId since monuments have no tier) has not yet
 * been built by anyone. Every monument face -- including M401-403, held in state.extraMonumentPool until
 * revealed -- has a state.cards entry from setup.prepareShops' own registerCardPool calls, so this never
 * needs a null-instance fallback. */
function isMonumentUnclaimed(state, faceId) {
  const inst = state.cards[faceId];
  return !inst || inst.ownerId === null;
}

/** The owned CardInstance whose currentFaceId is exactly faceId, or null. Works uniformly for a JOB
 * (physicalId===faceId, e.g. "JOB007") and an A/B-tiered card (physicalId is the untiered id, e.g. "B003"
 * for both "B003A" and "B003B") since it matches on currentFaceId, not physicalId -- an LV2-upgraded
 * card's own row never separately matches its LV1 name here, unlike con-build-synergy's
 * normalizeToLv1Name, since every row below already names a specific tier explicitly (LV1 vs LV2). */
function findOwnedCardInstance(state, player, faceId) {
  const physicalId = player.ownedCardPhysicalIds.find((pid) => {
    const inst = state.cards[pid];
    return inst && inst.currentFaceId === faceId;
  });
  return physicalId ? state.cards[physicalId] : null;
}

/** True if player holds an own die (COLOR or WHITE, either is fine -- confirmed with the user this is
 * only about "1 die + ability" vs "2 dice combined", not about die kind), not yet placed or passed this
 * round, showing exactly `value`. */
function hasQualifyingDie(player, value) {
  return player.dice.some((d) => d.placedMapId === null && !d.passed && d.value === value);
}

/** True if player owns a card whose currentFaceId is any of faceIds. */
function ownsAnyFace(state, player, faceIds) {
  return faceIds.some((faceId) => findOwnedCardInstance(state, player, faceId) !== null);
}

/** Whether some OTHER player already has, right now, both a qualifying unplaced color die and enough
 * resources to build monumentFaceId. Duplicated from evaluator.js's own monumentAtRiskFromOpponents
 * (2026-08-04) rather than shared, same "small enough to just copy" convention as parseMonumentThreshold
 * above -- confirmed with the user this exact existing heuristic is fine as-is for gating the 歓楽街LV2
 * rows below: "他プレイヤーの動向を見る" resolves to "don't credit holding resources for a monument
 * someone else could already just take". */
function monumentAtRiskFromOpponents(state, index, playerId, monumentFaceId) {
  const row = getCardRow(index, monumentFaceId);
  const threshold = parseMonumentThreshold(row.DICE);
  if (threshold === null) return false;
  const costItems = lowerCostList(row.COST);
  for (const opponent of state.players) {
    if (opponent.id === playerId) continue;
    const hasQualifyingDie = opponent.dice.some((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed && d.value !== null && d.value >= threshold);
    if (!hasQualifyingDie) continue;
    const canAfford = costItems.every((item) => (opponent.resources[item.resource] || 0) >= item.count);
    if (canAfford) return true;
  }
  return false;
}

/** Single-die + a die-boosting card TAP: requiredDieValue = target's own DICE threshold minus the TAP's
 * own bonus (confirmed with the user: only the "1 die + ability reaches it exactly" scenario counts, not
 * a 2-dice group that happens to reach the same threshold -- a group placement never goes through this
 * exact-value single-die check at all). */
// bonus values matched to each card's own TAP delta (2026-09-02 audit: 宮廷人/JOB007 was still 1 here
// long after its TAP grew to +3, and 運命の導きLV2/B003B was still 3 here after its own TAP grew to +4 --
// both silently understated how close a held die really was to a target's threshold, since
// requiredDieValue = threshold - bonus overstates the die value actually needed whenever bonus is too
// low). Row *names* still say "+1"/"+3" (the old values) since they're 評価値_戦略's own sheet-authored
// labels, not live-computed -- cosmetic only, doesn't affect scoring.
const SINGLE_DIE_ROWS = [
  { name: '宮廷人が+1能力で施療院を獲得', ownedFaceId: 'JOB007', bonus: 3, targetFaceId: 'M006' },
  { name: '運命の導きLV1が+2能力で施療院を獲得', ownedFaceId: 'B003A', bonus: 2, targetFaceId: 'M006' },
  { name: '運命の導きLV1が+2能力で宮殿を獲得', ownedFaceId: 'B003A', bonus: 2, targetFaceId: 'M005' },
  { name: '運命の導きLV2が+3能力で施療院を獲得', ownedFaceId: 'B003B', bonus: 4, targetFaceId: 'M006' },
  { name: '運命の導きLV2が+3能力で宮殿を獲得', ownedFaceId: 'B003B', bonus: 4, targetFaceId: 'M005' },
  { name: '運命の導きLV2が+3能力で凱旋門を獲得', ownedFaceId: 'B003B', bonus: 4, targetFaceId: 'M004' },
];

/** 歓楽街の支配LV2 (A006B)'s own CHANGE(2K,(A,B,C,Z)) converts 2K into 1 unit of any chosen color, so the
 * K needed to fully fund a target's COST is 2x its total unit count (confirmed by the same ratio the
 * user's own "農園または小麦畑の支配で13Kいじょうためる" row uses for 大交易所's COST=13C via a 1:1
 * ALL-conversion area instead -- see FARM_K_THRESHOLD below). Per user spec, in strict priority order
 * (王都建設 > 中央広場 > 凱旋門 > 聖王城 > 円形闘技場: "左が最優先で資源をためて取りに行く（見えている場
 * 合） そうでなければとれるものをとる") -- ONLY the single highest-priority currently-reachable target
 * credits anything (see the `break` in the loop below): held K commonly clears more than one target's
 * threshold at once (e.g. 30K clears all 5), and awarding every one of those simultaneously would credit
 * a pile of K as if it could fund all 5 monuments at once, when in reality spending it funds only one.
 * "他プレイヤーの動向も見るようにしたい" applies to exactly this group of 5 -- see monumentAtRiskFromOpponents. */
const ENTERTAINMENT_DISTRICT_FACE_ID = 'A006B';
const ENTERTAINMENT_DISTRICT_ROWS = [
  { name: '歓楽街の支配LV2で王都建設を獲得(3R以降)', targetFaceId: 'M402' },
  { name: '歓楽街の支配LV2で中央広場を獲得(3R以降)', targetFaceId: 'M007' },
  { name: '歓楽街の支配LV2で凱旋門を獲得(3R以降)', targetFaceId: 'M004' },
  { name: '歓楽街の支配LV2で聖王城を獲得(3R以降)', targetFaceId: 'M008' },
  { name: '歓楽街の支配LV2で円形闘技場を獲得(3R以降)', targetFaceId: 'M009' },
];

/** 農園/小麦畑の支配 (either tier, either card -- "小麦畑も農園と同じ扱い" per user spec): a flat "held
 * enough K to fully fund 大交易所 (COST=13C, the heaviest of its 3 reachable targets -- 大城塞/聖域 need
 * less) via 城下町/大聖堂/ギルド's own 1:1 ALL-conversion" check, rather than 3 separate per-target rows
 * (simplified by the user from the original per-target design). */
const FARM_ROW_NAME = '農園または小麦畑の支配で13Kいじょうためる';
const FARM_FACE_IDS = ['A005A', 'A005B', 'A004A', 'A004B'];
const FARM_K_THRESHOLD = 13;

/** @returns {number} the total 評価値_戦略 incentive bonus for playerId in state, at state's current round. */
function monumentIncentiveScore(state, index, playerId, table) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 0;
  const round = state.round || 1;
  let total = 0;

  for (const { name, ownedFaceId, bonus, targetFaceId } of SINGLE_DIE_ROWS) {
    const cardInst = findOwnedCardInstance(state, player, ownedFaceId);
    if (!cardInst || cardInst.tapped) continue;
    if (!isMonumentUnclaimed(state, targetFaceId)) continue;
    const threshold = parseMonumentThreshold(getCardRow(index, targetFaceId).DICE);
    if (threshold === null) continue;
    const requiredDieValue = threshold - bonus;
    if (requiredDieValue < 1 || requiredDieValue > 6) continue;
    if (!hasQualifyingDie(player, requiredDieValue)) continue;
    total += incentiveValue(table, name, round);
  }

  if (findOwnedCardInstance(state, player, ENTERTAINMENT_DISTRICT_FACE_ID)) {
    const heldK = player.resources.K || 0;
    for (const { name, targetFaceId } of ENTERTAINMENT_DISTRICT_ROWS) {
      if (!isMonumentUnclaimed(state, targetFaceId)) continue;
      const unitCount = lowerCostList(getCardRow(index, targetFaceId).COST).reduce((sum, item) => sum + item.count, 0);
      if (heldK < unitCount * 2) continue;
      if (monumentAtRiskFromOpponents(state, index, playerId, targetFaceId)) continue;
      total += incentiveValue(table, name, round);
      break; // only the single highest-priority reachable target credits anything -- see this const's own doc
    }
  }

  if (ownsAnyFace(state, player, FARM_FACE_IDS) && (player.resources.K || 0) >= FARM_K_THRESHOLD) {
    total += incentiveValue(table, FARM_ROW_NAME, round);
  }

  return total;
}

module.exports = { buildMonumentIncentiveTable, incentiveValue, monumentIncentiveScore };

})();
