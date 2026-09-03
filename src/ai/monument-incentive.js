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

/** Stacking 2+ die-boosting TAPs onto the SAME die (2026-09-03, per user request: "大いなる導きLV2 や
 * 運命の導きLV1 2 宮廷人 などの複合でもAIが判断できるように" -- e.g. 宮廷人's own +3 plus 運命の導きLV2's
 * own +4 turning a real die=6 into 13, reaching 天空の塔/M403's DICE>=13, which no single ability above
 * gets remotely close to alone). Unlike SINGLE_DIE_ROWS above (one row per owning-card+target pair, since
 * the user wanted that fine-grained control there), this is one row PER TARGET only (per user decision,
 * prioritizing easy maintenance if a card's own bonus changes again later, over per-card tuning) --
 * DELTA_ABILITIES/SET_ABILITIES below list every known die-boosting TAP once, so a future new one only
 * needs an entry there, not a new row per target it might combo into.
 *
 * DELTA_ABILITIES adds a fixed amount to whatever a die already shows (CHANGE_DIE_VALUE/
 * MONUMENT_CHANGE_DIE_VALUE); every owned+untapped one sums together (deltaSum), since using one card's
 * TAP doesn't consume or block another's. SET_ABILITIES instead picks one of 2 fixed values regardless of
 * the die's current value (SET_DIE_VALUE) -- only the single BEST owned+untapped one is used (there's no
 * benefit stacking 2 SET abilities on one die; whichever is applied last just overwrites the other), taken
 * as its higher of the 2 choices being the interesting one for reaching a threshold.
 *
 * A combo only counts once at least 2 of these sources are actually owned+untapped together (totalSources
 * check in monumentIncentiveScore below) -- exactly 1 source is already SINGLE_DIE_ROWS' own territory, so
 * this must not also fire for that case (would double-count the same real scenario under 2 different
 * names).
 *
 * Only the single highest-priority reachable target below credits anything (same "break after first
 * match" reasoning ENTERTAINMENT_DISTRICT_ROWS' own doc already explains) -- a SET ability only fixes ONE
 * real die to ONE of its 2 choices, so a case where e.g. both 宮殿 and 凱旋門 look simultaneously
 * "reachable" (one via the SET's low choice, the other via its high choice) can still only actually be
 * finished as ONE of them, not both -- listed here in descending target-value order so the credited one is
 * whichever the player would actually pursue. */
const DELTA_ABILITIES = [
  { faceId: 'JOB007', delta: 3 },
  { faceId: 'B003A', delta: 2 },
  { faceId: 'B003B', delta: 4 },
];
const SET_ABILITIES = [
  { faceId: 'B001A', values: [1, 2] },
  { faceId: 'B001B', values: [1, 2] },
  { faceId: 'B002A', values: [5, 6] },
  { faceId: 'B002B', values: [6, 7] },
];
const COMBO_TARGETS = [
  { name: '複合ダイス強化で天空の塔を獲得', targetFaceId: 'M403' },
  { name: '複合ダイス強化で凱旋門を獲得', targetFaceId: 'M004' },
  { name: '複合ダイス強化で騎士像を獲得', targetFaceId: 'M003' },
  { name: '複合ダイス強化で鐘楼を獲得', targetFaceId: 'M002' },
  { name: '複合ダイス強化で宮殿を獲得', targetFaceId: 'M005' },
  { name: '複合ダイス強化で施療院を獲得', targetFaceId: 'M006' },
];

/** True if player holds any own unplaced/not-passed die at all, regardless of its current value -- used
 * for a SET_DIE_VALUE-based combo, where the die's starting value doesn't matter (it gets overwritten). */
function hasAnyQualifyingDie(player) {
  return player.dice.some((d) => d.placedMapId === null && !d.passed);
}

/** The single owned+untapped SET_ABILITIES entry with the highest top value, or null. Comparing by top
 * value only (not literally "best for every target") is good enough here -- a higher SET range always
 * reaches everything a lower one does, minus the low end, which DELTA_ABILITIES' own sum can usually make
 * up for anyway. */
function bestOwnedSetAbility(state, player) {
  let best = null;
  for (const ability of SET_ABILITIES) {
    const inst = findOwnedCardInstance(state, player, ability.faceId);
    if (!inst || inst.tapped) continue;
    if (!best || Math.max(...ability.values) > Math.max(...best.values)) best = ability;
  }
  return best;
}

/** @returns {{sum:number, count:number}} total delta and how many DELTA_ABILITIES entries contributed to
 * it (owned + untapped only). */
function ownedDeltaSum(state, player) {
  let sum = 0;
  let count = 0;
  for (const ability of DELTA_ABILITIES) {
    const inst = findOwnedCardInstance(state, player, ability.faceId);
    if (!inst || inst.tapped) continue;
    sum += ability.delta;
    count += 1;
  }
  return { sum, count };
}

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

  const setAbility = bestOwnedSetAbility(state, player);
  const { sum: deltaSum, count: deltaCount } = ownedDeltaSum(state, player);
  const totalDieBoostSources = deltaCount + (setAbility ? 1 : 0);
  if (totalDieBoostSources >= 2) {
    for (const { name, targetFaceId } of COMBO_TARGETS) {
      if (!isMonumentUnclaimed(state, targetFaceId)) continue;
      const threshold = parseMonumentThreshold(getCardRow(index, targetFaceId).DICE);
      if (threshold === null) continue;
      let reachable = false;
      if (deltaSum > 0) {
        const requiredDieValue = threshold - deltaSum;
        reachable = requiredDieValue >= 1 && requiredDieValue <= 6 && hasQualifyingDie(player, requiredDieValue);
      }
      if (!reachable && setAbility && hasAnyQualifyingDie(player)) {
        reachable = setAbility.values.some((v) => v + deltaSum === threshold);
      }
      if (reachable) {
        total += incentiveValue(table, name, round);
        break; // only the single highest-priority reachable target credits anything -- see COMBO_TARGETS' own doc
      }
    }
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
