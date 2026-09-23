(function () {
'use strict';

/**
 * Evaluator: scores a GameState from playerId's own perspective -- higher is better. This is the
 * *only* piece that knows about the "評価値" sheet (see eval-table.js); MoveGenerator/Simulator never
 * touch it, so swapping in a different Evaluator (e.g. one driven by a genetic-algorithm-tuned table,
 * or a learned value function) never requires touching either of them.
 *
 * Key design point (2026-08-01, confirmed with the user across the whole "評価値" chat): this scores
 * the *resulting* state directly (resources on hand, dice on hand, cards owned) rather than trying to
 * separately parse "what did this move just grant". Since Simulator always hands back the state
 * *after* a move's ONCE/PASSIVE effects have already run, everything the move granted (resources,
 * dice, a MAP tier flip's downstream effect on future AREA actions) is already reflected in the
 * numbers being summed here -- so printed VP/COST/ONCE-granted resources never need separate handling,
 * exactly the "don't duplicate what the data already expresses" principle the eval-table sheet itself
 * follows. A card's own eval-table entry is reserved for what genuinely can't be derived this way
 * (PASSIVE/TAP ongoing worth, emblem synergy, a board-altering ONCE like a MAP tier flip).
 */

const { getCardRow, getQstRow } = require('../data-loader');
const { lowerCostList, lowerProgram } = require('../command-builder');
const { parse } = require('../dsl-parser');
const executor = require('../executor');
const board = require('../board');
const qst = require('../qst');
const { evalValue } = require('./eval-table');
const conBuildSynergy = require('./con-build-synergy');
const monumentIncentive = require('./monument-incentive');

/** Same regex board.js's own (unexported) parseMonumentThreshold uses, e.g. ">=12" -> 12. Duplicated
 * rather than exported from board.js purely for this one line -- see monumentAtRiskFromOpponents. */
function parseMonumentThreshold(diceString) {
  const match = /^>=(\d+)$/.exec(diceString);
  return match ? Number(match[1]) : null;
}

/** Every 導き/兆し(B001-B006,B202) and C-card(C001-C006,C201) face -- i.e. every B/C-tier card whose own
 * TAP ability does NOT self-untap -- the user's own "ラウンドタップ" category (see score()'s own doc on
 * the 聖女/王女 synergy bonus this feeds). Excludes 聖女/王女(C202/C301, scored separately) and B301/栄光
 * の証(no TAP field at all). */
const UNTAP_SYNERGY_FACE_IDS = new Set([
  'B001A', 'B001B', 'B002A', 'B002B', 'B003A', 'B003B',
  'B004A', 'B004B', 'B005A', 'B005B', 'B006A', 'B006B', 'B202A', 'B202B',
  'C001A', 'C001B', 'C002A', 'C002B', 'C003A', 'C003B',
  'C004A', 'C004B', 'C005A', 'C005B', 'C006A', 'C006B', 'C201A', 'C201B',
]);

/** 小麦畑/農園の支配(A004/A005) + 農夫(C201), either tier -- the user's own K-stockpiling-economy group
 * feeding the 晩餐会(M401) synergy bonus in score(). */
const FARM_SYNERGY_FACE_IDS = new Set(['A004A', 'A004B', 'A005A', 'A005B', 'C201A', 'C201B']);

/** 導き(B001-B003, either tier) + 双星の加護(B201, either tier) + JOB002/実業家 + JOB006/育成者 +
 * JOB007/宮廷人 -- the user's own 元老院の支配(A301) synergy group (2026-09-07: "元老院はただとっても
 * それなりに強いが、導きや双星をすでに獲得していたりJOBが実業家、宮廷人、育成者だったりすると尚いい"),
 * each reaching 元老院's own BUILD() usefulness via a different mechanism -- 導き boosts the die value
 * placed there, 双星(ONCE=ADD(2wD)) grants extra dice to spend there, 実業家(TAP=ON(BUILD(),ADD(K)))/
 * 育成者(PASSIVE=ON(GET(D),ADD(Z,VP));ON(GET(wD),ADD(K))) turn the resulting BUILD/dice-gain events into
 * more resources, 宮廷人 boosts the die value for a MONUMENT candidate specifically (see
 * monument-incentive.js's own DELTA_ABILITIES for that narrower, already-existing mechanism -- this row
 * is a separate, broader "元老院 ownership is generally more valuable" credit, not a duplicate of it).
 * JOBs have no tier (physicalId===faceId). */
const SENATE_SYNERGY_FACE_IDS = new Set([
  'B001A', 'B001B', 'B002A', 'B002B', 'B003A', 'B003B',
  'B201A', 'B201B', 'JOB002', 'JOB006', 'JOB007',
]);

/** Same-role redundancy penalty groups (2026-09-14, per user report: watching a 3Rから replay, the AI
 * kept acquiring multiple cards that do "the same job" -- e.g. both 小麦畑 and 農園's支配 (A004/A005), or
 * both 代官 and 修道士 (C001/C002) -- since the evolved eval-table only knows each card's OWN standalone
 * value, with no notion of "I already have one of these." Two overlapping groups, split by the user's own
 * COST-shape distinction: SAME_ROLE_GROUP_A (2A,B-cost 支配 cards) and SAME_ROLE_GROUP_B (2A-cost 支配
 * cards + the C-deck K-converters, same "convert K into one specific resource, capped at 7" shape). Keyed
 * by physicalId (a card's own base ID, e.g. "A004" -- see game-state.js's splitCardId), not faceId: owning
 * either tier (LV1 or LV2) of the same physical card is still just ONE card, never two, since upgrading
 * never changes which "slot" it occupies. 歓楽街(A006) deliberately sits in BOTH groups (user confirmed:
 * "歓楽街は両方です") -- its own penalty can stack from both independently. 訓練場/孤児院/元老院
 * (A202/A201/A301) are deliberately excluded from both -- each already has its own dedicated
 * synergy/domination-style logic elsewhere in this file (see TRAINING_GROUND_* above and
 * FARM_SYNERGY_FACE_IDS/SENATE_SYNERGY_FACE_IDS). penaltyId names a per-round evolvable 評価値-sheet row
 * (2026-09-14, per user follow-up request: "評価値の家族補正も進化で変動するようにしたい") instead of a
 * hardcoded JS constant -- same pattern this file already uses for 晩餐会食料生産相性/聖女王女ラウンドタッ
 * プ相性/元老院支配拡張相性 (see score()'s own `v()` lookups for those): self-play can now tune how harshly
 * each group's redundancy is actually punished, same as every other weight here, rather than being frozen
 * at whatever number a human picked. Seeded at -50/-30 (this feature's own original hand-chosen values) in
 * game.xlsx, one flat number across all 4 rounds -- nothing stops evolution from diverging that per round
 * once training resumes. See score()'s own use of these for the actual penalty math. */
const SAME_ROLE_GROUP_A = { ids: new Set(['A004', 'A005', 'A006']), penaltyId: '小麦畑農園歓楽街重複ペナルティ' };
const SAME_ROLE_GROUP_B = { ids: new Set(['A001', 'A002', 'A003', 'A006', 'C001', 'C002', 'C003']), penaltyId: '城下町大聖堂ギルド重複ペナルティ' };
// 兆し(B004-B006) redundancy penalty (2026-09-18, per user request: same "does the same job" shape as
// SAME_ROLE_GROUP_A/B above, applied to 始まりの兆し/革命の兆し/移ろいの兆し). 終わりの兆し(B202) is
// deliberately excluded -- it's a SHOP201-203 special-shop card on a different round-gate/tier entirely,
// not part of the regular B-deck 兆し family the user named. Seeded at -30 (flat across all 4 rounds) in
// game.xlsx, same evolvable-per-round-value pattern as the other two groups (see their own doc above for
// why penaltyId is a 評価値-sheet row, not a hardcoded constant).
const SAME_ROLE_GROUP_C = { ids: new Set(['B004', 'B005', 'B006']), penaltyId: '兆し重複ペナルティ' };

/** Unclaimed-fee-opportunity bonus groups (2026-09-14, per user follow-up to the redundancy penalty
 * above, worked through across several messages -- see the exact wording in that day's chat for the full
 * back-and-forth): narrower than SAME_ROLE_GROUP_A/B on purpose -- these two groups are about whether
 * OPPONENTS will actually generate usage-fee traffic (map.feeOwnerId, see executor.js's own doc), not
 * about "same shape" redundancy, so 歓楽街 and the C-deck converters (no map/fee of their own at all) are
 * deliberately left out here even though they're part of the redundancy groups above for an unrelated
 * reason. User's own worked example: "すでに小麦畑が支配されていたら、農園を獲得しても誰もSLOTに置かない
 * 使用料が取れない。まだ両方出ていなければ、みんなslotに置くので使用料がもらえる" -- i.e. these AREAs
 * offer opponents an interchangeable-enough benefit that once ANY one sibling is already dominated by
 * ANYONE (their own placement need already satisfied there), the others largely stop attracting real
 * placement traffic. FEE_OPPORTUNITY_GROUP_A: 小麦畑/農園 (A004/A005, MAP001/MAP002). FEE_OPPORTUNITY_
 * GROUP_B: 城下町/大聖堂/ギルド (A001/A002/A003, MAP003/MAP004/MAP005). See score()'s own use of these:
 * for each member the scored player OWNS, if EVERY OTHER member's own map is still unclaimed by anyone
 * (feeOwnerId null -- checked regardless of who would eventually claim it, not just opponents, since the
 * scored player owning a 2nd sibling itself also closes this same window, correctly yielding no bonus
 * either, consistent with the redundancy penalty above), add this group's own bonusId value once for that
 * owned card. bonusId, like SAME_ROLE_GROUP_A/B's penaltyId above, names an evolvable 評価値-sheet row
 * (2026-09-14, same "評価値の家族補正も進化で変動するようにしたい" request) rather than a hardcoded 20 --
 * seeded at 20 (this feature's own original value) in game.xlsx. */
const FEE_OPPORTUNITY_GROUP_A = { members: [{ id: 'A004', mapId: 'MAP001' }, { id: 'A005', mapId: 'MAP002' }], bonusId: '小麦畑農園未支配ボーナス' };
const FEE_OPPORTUNITY_GROUP_B = { members: [{ id: 'A001', mapId: 'MAP003' }, { id: 'A002', mapId: 'MAP004' }, { id: 'A003', mapId: 'MAP005' }], bonusId: '城下町大聖堂ギルド未支配ボーナス' };

/** How much VP rewardText would grant, read via the real DSL parser rather than executed (2026-08-10,
 * QST awareness -- see Evaluator's own qstAware policy doc). Every QST REWARD field today is a plain
 * ADD(nVP) (see qst.js's own doc on resolveEndGameRewards), so this sums every literal-count VP item
 * across any ADD commands in rewardText and ignores everything else (a dynamic-count VP grant, or a
 * reward that doesn't touch VP at all, contributes 0 -- a safe, non-crashing estimate rather than an
 * error, since this is a heuristic nudge, not a source of truth). */
function estimateRewardVp(rewardText) {
  if (!rewardText) return 0;
  let vp = 0;
  for (const cmd of lowerProgram(parse(rewardText))) {
    if (cmd.type !== 'ADD') continue;
    for (const item of cmd.items) {
      if (item.resource === 'VP' && item.count.kind === 'literal') vp += item.count.value;
    }
  }
  return vp;
}

/** Whether `player` already has, right now, both a qualifying unplaced color die and enough resources to
 * build a monument needing `threshold` DICE and `costItems` (lowerCostList's own shape) -- shared by
 * monumentAtRiskFromOpponents (checking every OPPONENT) and monumentSecurableByPlayer (checking the
 * scored player themselves) below, so both read the exact same "could grab this right now" definition.
 * Deliberately ignores free actions (e.g. A->K) or JOB abilities that could let a player convert toward
 * affording it -- just raw held resources and raw die values right now (2026-08-04, per user feedback,
 * see monumentAtRiskFromOpponents' own original doc). Only checks the die-value threshold (not e.g. the
 * castle's own same-value-stacking accumulation), matching the common case of a monument reachable via a
 * normal AREA's own die value. */
function playerQualifiesForMonument(player, threshold, costItems) {
  const hasQualifyingDie = player.dice.some((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed && d.value !== null && d.value >= threshold);
  if (!hasQualifyingDie) return false;
  return costItems.every((item) => (player.resources[item.resource] || 0) >= item.count);
}

/** Whether some OTHER player already qualifies (playerQualifiesForMonument) to build monumentFaceId right
 * now (2026-08-04, per user feedback: "そのモニュメントとられるかもは相手のダイスと資源が今足りているか
 * で判断するようにしてください フリーアクションやJOBは現在は考慮しなくていいです") -- a cheap
 * current-state-only snapshot, never simulates an opponent's future turns. */
function monumentAtRiskFromOpponents(state, index, playerId, monumentFaceId) {
  const row = getCardRow(index, monumentFaceId);
  const threshold = parseMonumentThreshold(row.DICE);
  if (threshold === null) return false;
  const costItems = lowerCostList(row.COST);
  return state.players.some((opponent) => opponent.id !== playerId && playerQualifiesForMonument(opponent, threshold, costItems));
}

/** Whether playerId THEMSELVES already qualifies (playerQualifiesForMonument) to build monumentFaceId
 * right now (2026-09-06, per user report: "本来モニュメントを獲得しに行かなければいけないラウンドで拡大
 * 再生産用のカードを獲得しに行っている" -- see this file's own score() doc on the "exclusive monument-
 * securing bonus" this feeds, right below monumentAtRiskFromOpponents' matching opponent-side check). */
function monumentSecurableByPlayer(state, index, playerId, monumentFaceId) {
  const row = getCardRow(index, monumentFaceId);
  const threshold = parseMonumentThreshold(row.DICE);
  if (threshold === null) return false;
  const costItems = lowerCostList(row.COST);
  const player = state.players.find((p) => p.id === playerId);
  return !!player && playerQualifiesForMonument(player, threshold, costItems);
}

class Evaluator {
  /** @param {DataIndex} index @param {Object} evalTable - see eval-table.js's buildEvalTable()
   *  @param {{qstAware?: boolean, conBuildAware?: boolean, monumentIncentiveAware?: boolean}} [policy] -
   *   optional strategy knobs.
   *   qstAware (2026-08-10, "AI LV3": per user request "AI LV3はQSTカードに対応してVPを稼ぐようにした
   *   い"). Default {} (qstAware unset/falsy) -- LV1/LV2 keep using an Evaluator built with no policy, so
   *   their behavior is byte-for-byte unchanged; LV3 gets its own instance constructed with qstAware:true
   *   (see main.js's aiEvaluatorLv3). See score()'s own QST block for what this actually adds.
   *   conBuildAware (2026-08-28, "AI LV4" only, per user bug report -- see con-build-synergy.js's own
   *   doc for the motivating incident): builds a game.xlsx 評価値_CON lookup table once here (from
   *   index.raw) and applies it in score()'s own per-owned-card loop and color-dice section -- see those
   *   blocks' own comments. Default false -- every other level's Evaluator instance leaves this unset,
   *   so score() stays byte-for-byte unchanged for them. main.js's aiEvaluatorLv4 is the one instance
   *   that sets this true (a separate instance from aiEvaluatorLv3, precisely so LV3 stays unaffected).
   *   monumentIncentiveAware (2026-08-29, "AI LV4" only, per user report that expensive multi-color-COST
   *   monuments are almost never acquired before round 4 -- see monument-incentive.js's own doc): builds
   *   a game.xlsx 評価値_戦略 lookup table once here and applies it in score()'s own dedicated block
   *   below. Default false, same isolation pattern as conBuildAware. */
  constructor(index, evalTable, policy) {
    this.index = index;
    this.evalTable = evalTable;
    this.policy = policy || {};
    this.conBuildSynergyTable = this.policy.conBuildAware ? conBuildSynergy.buildConBuildSynergyTable(index.raw) : null;
    this.monumentIncentiveTable = this.policy.monumentIncentiveAware ? monumentIncentive.buildMonumentIncentiveTable(index.raw) : null;
  }

  /** @returns {number} playerId's position score in state, at state's current round. */
  score(state, playerId) {
    const round = state.round || 1;
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return 0;
    const v = (id) => evalValue(this.evalTable, round, id);

    let total = 0;

    // RESOURCE_LIMIT-aware resource scoring (2026-08-10, per user request: "K MAX7の時 1K+7Kで8Kになる
    // のは 減らして7Kとして評価" -- a resource held past an owned card's RESOURCE_LIMIT cap (e.g. 暴食/
    // CON006A's K MAX7) is worth exactly its true post-TURNEND value, not its raw current count.
    // 2026-09-14 correction (per user request: "暴食の7Kを超えたKターン終了時に1Kだけ減らすように変更"
    // -- applyTurnEnd only ever subtracts 1 from an over-limit resource, it doesn't clamp straight to the
    // limit; this used to assume the old clamp-to-limit behavior via Math.min(have, limit), understating
    // a big overshoot's true value (e.g. 10K with a cap-7 card is really still worth 9 next turn, not 7).
    const resourceLimits = executor.activeResourceLimits(state, this.index, playerId);
    for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ']) {
      const have = player.resources[resource] || 0;
      const limit = resourceLimits[resource];
      const effective = limit !== undefined && have > limit ? have - 1 : have;
      total += effective * v(resource);
    }
    total += (player.resources.VP || 0) * v('VP');

    // A passed die (2026-08-03, see board.passDie) is scored separately from a genuinely-still-
    // placeable one -- found via a real game trace (AI chose PASS_DIE 13 times vs PLACE_DIE once in a
    // single round 1): the full 'D' weight (round-1 value, 40 originally/50 as of 2026-08-21) represents
    // the *option value* of a die that can still be placed for whatever an AREA grants, but a passed die
    // has already given that up for this round -- its only remaining guaranteed value is turn-flow.
    // endRound's "unused color die -> 3K" rule (v('K')*3), which is far below 'D''s weight. Leaving
    // passed dice at the full 'D' value made passing score *better* than almost any real placement
    // (since most single-AREA gains are worth less than 'D'), so the AI passed by default instead of
    // playing. White dice have no such guaranteed round-end conversion (only color dice do), so passed
    // wD keeps the normal 'wD' weight.
    const unplacedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed).length;
    const passedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && d.passed).length;
    const unplacedWhite = player.dice.filter((d) => d.kind === 'WHITE' && d.placedMapId === null).length;
    total += unplacedColor * v('D');
    total += passedColor * v('K') * 3;
    total += unplacedWhite * v('wD');

    // 訓練場の支配 (A202A/A202B) -- color-dice-count-conditioned valuation (2026-08-26, per user spec:
    // "色ダイス3個（置いたのも含む）なら訓練場の支配を取りに行く+1000くらい 逆に色ダイス4個なら一切取り
    // に行かない"; the +1000 "go get it" bonus half was removed 2026-09-14, per user request, once the
    // -100 timing tax below turned out to be the more targeted fix for the actual problem it caused --
    // see that constant's own doc): the -1000 "don't bother" penalty stays, since this card's main value
    // is lifting CON005A(怠惰)'s "色ダイス上限3個" -- see board.js's TRAINING_GROUND_COLOR_DIE_CAP doc --
    // which is already worthless (no cap left to lift) once past 3, independent of any timing concern.
    // Total color dice (in hand AND currently placed) matches board.js's own established "TOTAL color
    // dice" counting convention, not just unplaced ones.
    //
    // 2026-09-17 fix (per user bug report watching AI LV5): this used to re-check the player's CURRENT
    // total color-dice count on every single evaluation, not just the acquisition decision -- so once a
    // player who acquired this while under the threshold actually went and placed on 訓練場 to raise
    // their own dice count past it (literally the card's entire purpose), that resulting state now also
    // read as "past the threshold" and got the exact same -1000, making the card's own intended payoff
    // look like a mistake the AI's search would then avoid. Now uses player.trainingGroundDominationOk
    // (see PlayerState's own doc) instead -- a watermark set ONCE, at the real moment of acquisition
    // (board.resolveBuildNew), never re-derived from a later dice count.
    const TRAINING_GROUND_DOMINATION_PENALTY = 1000;
    // Timing tax (2026-09-14, per user report: watching a replay, the AI grabbed 訓練場の支配 in round 2
    // with its very last die of the round, unable to place on the newly-unlocked AREA007 slot at all that
    // round -- the real payoff beyond CON005A/怠惰's cap-lift, which is a genuine one-time permanent effect
    // and stays worth getting even at the buzzer, per the user's own confirmation). Scoped to A202 only,
    // per user request -- other 支配 cards (城下町/ギルド/小麦畑/農園) have the exact same "ONCE flips a
    // MAP's AREA, real value needs a later die placed there" shape, but this deliberately doesn't touch
    // them yet.
    const TRAINING_GROUND_UNUSABLE_THIS_ROUND_PENALTY = 100;
    const totalColorDiceCount = player.dice.filter((d) => d.kind === 'COLOR').length;
    const hasNoDiceLeftThisRound = player.dice.every((d) => d.placedMapId !== null || d.passed);

    // Same-role redundancy penalty (see SAME_ROLE_GROUP_A/B's own doc above) -- counted once per group,
    // not per owned card, since what matters is how many DISTINCT family members are owned in total, not
    // which specific one "is" the redundant one. v(group.penaltyId) is already negative in the sheet (seeded
    // -50/-30), so ADDING it (not subtracting) is what actually applies the penalty.
    for (const group of [SAME_ROLE_GROUP_A, SAME_ROLE_GROUP_B, SAME_ROLE_GROUP_C]) {
      const ownedInGroup = player.ownedCardPhysicalIds.filter((id) => group.ids.has(id)).length;
      if (ownedInGroup > 1) total += (ownedInGroup - 1) * v(group.penaltyId);
    }

    // Unclaimed-fee-opportunity bonus (see FEE_OPPORTUNITY_GROUP_A/B's own doc above) -- per owned member,
    // not once per group: with a 3-member group, owning one while the OTHER two are still both unclaimed
    // is exactly as good regardless of the group's total size, so this doesn't scale down just because the
    // group happens to have more members.
    for (const group of [FEE_OPPORTUNITY_GROUP_A, FEE_OPPORTUNITY_GROUP_B]) {
      for (const member of group.members) {
        if (!player.ownedCardPhysicalIds.includes(member.id)) continue;
        const othersAllUnclaimed = group.members.every((other) => other === member || !state.maps[other.mapId] || state.maps[other.mapId].feeOwnerId === null);
        if (othersAllUnclaimed) total += v(group.bonusId);
      }
    }

    // conBuildAware (2026-08-28, "AI LV4" only -- see this class's own constructor doc and
    // con-build-synergy.js's doc for the motivating bug report): the player's own chosen CON face's
    // NAME (e.g. "憤怒"), looked up once here rather than per owned card below. null whenever the
    // policy is off, or CON hasn't been chosen yet (conPhysicalId/conFace still unset, e.g. mid-onboarding).
    let conBuildFaceName = null;
    if (this.conBuildSynergyTable && player.conPhysicalId && player.conFace) {
      try { conBuildFaceName = getCardRow(this.index, `${player.conPhysicalId}${player.conFace}`).NAME; } catch (e) { conBuildFaceName = null; }
    }
    if (conBuildFaceName) {
      // "色ダイス" row (2026-08-28, per user clarification: "色ダイスは追加色ダイスのことです" -- 訓練場
      // (AREA007)'s own ADD(D)/CHANGE(...,D) actions raising a player's color-die count past the normal
      // 5-die baseline, not their total color-die count outright; confirmed no per-die acquisition
      // tracking is needed -- "何で得た分か追跡不要です" -- so any color die beyond 5, from any source,
      // counts the same): a per-extra-color-die bonus/penalty specific to this CON face.
      const ADDITIONAL_COLOR_DICE_BASELINE = 5;
      const additionalColorDiceCount = Math.max(0, totalColorDiceCount - ADDITIONAL_COLOR_DICE_BASELINE);
      total += additionalColorDiceCount * conBuildSynergy.synergyValue(this.conBuildSynergyTable, conBuildSynergy.COLOR_DICE_ROW_NAME, conBuildFaceName);
    }

    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState) continue;
      let row;
      try { row = getCardRow(this.index, cardState.currentFaceId); } catch (e) { continue; }
      total += v(cardState.currentFaceId);
      // RESOURCE cards (physicalId starting with 'R') excluded here (2026-09-23, see setup.
      // receiveInitialResources' own doc): their printed VP is now granted live into resources.VP
      // (already reflected via player.resources.VP elsewhere in this function), not counted as printed-
      // card VP -- counting it here too would double it.
      if (typeof row.VP === 'number' && !physicalId.startsWith('R')) total += row.VP * v('VP');
      if (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B') {
        if (player.trainingGroundDominationOk === false) total -= TRAINING_GROUND_DOMINATION_PENALTY;
        if (hasNoDiceLeftThisRound) total -= TRAINING_GROUND_UNUSABLE_THIS_ROUND_PENALTY;
      }
      // 評価値_CON card-row synergy (2026-08-28): an LV2 upgrade still matches its base card's own LV1 row
      // (see con-build-synergy.js's normalizeToLv1Name) -- e.g. 憤怒 owning either tier of 双星の加護
      // (ADD(2wD), immediately lost to WHITE_DICE_CAP(0)) gets the same penalty either way.
      if (conBuildFaceName) {
        total += conBuildSynergy.synergyValue(this.conBuildSynergyTable, conBuildSynergy.normalizeToLv1Name(row.NAME), conBuildFaceName);
      }
    }

    total += executor.collectVpModifiers(state, this.index, playerId) * v('VP');
    // 2026-09-01, M401/晩餐会's own "ゲーム終了時持っている2Kにつき1VP(MAX10VP)" -- see
    // executor.collectFinalOnlyVpModifiers's own doc for why this is a separate call from
    // collectVpModifiers just above: it's 0 for every state until state.phase is actually 'GAME_END',
    // so it never rewards hoarding toward this bonus mid-game, but a round-4 rollout's own lookahead
    // (see this class's own doc) still correctly credits it once it actually reaches the true end.
    total += executor.collectFinalOnlyVpModifiers(state, this.index, playerId) * v('VP');

    // Turn-end lockout risk (2026-08-10, per user report: a greedy AI holding CON005B
    // (TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7)) would convert a big pile of K into A/B/C -- A/B/C's
    // higher per-unit eval-table weight than K (5 vs 3, constant across rounds) makes this look like a
    // straightforward gain -- with no notion that free actions can only claw back 1 unit of A/B/C EACH,
    // once per round (game-state's per-freeActionId once-per-round tap), so overshooting the limit by
    // more than a couple of units effectively strands the player unable to end their turn for the rest
    // of the round: real repeated AI-battle behavior was "convert a huge pile, get stuck, keep
    // re-evaluating the same trap every subsequent move". Reuses the exact same executor.canEndTurn(...)
    // check MoveGenerator already calls to decide whether free actions need offering at all, so this
    // stays in sync with whatever TURNEND rules actually block ending a turn (any RESOURCE_TOTAL_LIMIT
    // card, not hardcoded to CON005B, plus the same unpaid-USAGE_FEE case) rather than re-deriving that
    // logic here. LOCKOUT_PENALTY is a deliberately large flat constant, not scaled to how far over the
    // limit -- a resulting state that currently can't end its turn is simply worth much less than one
    // that can, hard enough to always dominate the marginal per-unit resource-weight gain that led into
    // it. Start big and tune down via AI battle results if this turns out overcautious, same workflow as
    // eval-table's own weight tuning (e.g. BZ's 5->4).
    const LOCKOUT_PENALTY = 1000;
    if (!executor.canEndTurn(state, this.index, playerId).ok) total -= LOCKOUT_PENALTY;

    // QST awareness (2026-08-10, opt-in via policy.qstAware -- "AI LV3" only, per user request "AI LV3
    // はQSTカードに対応してVPを稼ぐようにしたい"): for each currently-revealed QST card, if this player
    // is CURRENTLY ranked to earn a reward (rank 1-3, competition ranking -- see
    // qst.rankPlayersForQuest), credit the VP that reward would grant if the game ended right now.
    // rankPlayersForQuest is a pure/read-only function safe to call on any state (the exact same one
    // main.js's QST card UI uses for its own live standings preview), so this needs no new persistent
    // tracking and naturally reflects whichever move actually improved (or didn't) this player's
    // standing on the resulting state being scored -- no separate "is this move good for my QST rank"
    // logic anywhere else, the normal 1-ply-score-the-resulting-state pattern already covers it. A tie
    // for a reward rank credits every tied player in full (matches resolveEndGameRewards' own real
    // behavior, not a split). Deliberately a plain current-snapshot estimate, no discount for how many
    // rounds remain or how likely the ranking is to hold -- same risk-tolerance as the existing
    // monument-sniping-risk heuristic just below, not a probabilistic forecast.
    if (this.policy.qstAware && state.quests) {
      for (const questFaceId of Object.keys(state.quests)) {
        const entry = qst.rankPlayersForQuest(state, this.index, questFaceId).find((e) => e.playerId === playerId);
        if (!entry || entry.rank > qst.REWARD_FIELDS.length) continue;
        const row = getQstRow(this.index, questFaceId);
        total += estimateRewardVp(row[qst.REWARD_FIELDS[entry.rank - 1]]) * v('VP');
      }
    }

    // Monument-sniping risk (2026-08-04, per user feedback -- see monumentAtRiskFromOpponents' own
    // doc): for each monument still sitting in the M shop, if it's "at risk" (some opponent already has
    // what it takes to grab it right now), subtract the value it *would* have contributed if owned
    // (same eval-table-value + VP*VP-weight formula as an owned card, just as a penalty instead of a
    // credit). This discourages the AI's lookahead from banking toward, or passively leaving unclaimed,
    // a monument someone else could take first -- and rewards a path where THIS player claims it
    // instead, since claiming it removes it from the shop and the penalty stops applying.
    if (state.shops && state.shops.M) {
      for (const faceId of Object.values(state.shops.M.slots)) {
        if (!faceId) continue;
        if (monumentAtRiskFromOpponents(state, this.index, playerId, faceId)) {
          const row = getCardRow(this.index, faceId);
          const vp = typeof row.VP === 'number' ? row.VP : 0;
          total -= v(faceId) + vp * v('VP');
        }
      }
    }

    // Exclusive monument-securing bonus (2026-09-06, per user report: "本来モニュメントを獲得しに行かな
    // ければいけないラウンドで拡大再生産用のカードを獲得しに行っている" -- the sniping-risk penalty just
    // above only creates urgency when some OPPONENT could also grab a monument right now; when nobody
    // else can, there's no time pressure at all, so a shallow-lookahead AI has no reason to actually go
    // get it instead of continuing to build economy engines -- even though building it would obviously
    // score more, eventually. Round 3+ only (per user spec: "3-4R" -- round 1-2 monuments are essentially
    // never actually reachable yet, so this would just be dead weight before then). Credits a new,
    // GA-tunable eval-table value (id 'モニュメント確保ボーナス', seeded at 0 in every round -- see
    // src/ai/ga.js's mutateGenomePercent zero-escape step for how training discovers a nonzero value from
    // here) for EVERY M-shop monument this player could already build right now
    // (monumentSecurableByPlayer) that no opponent could also grab (!monumentAtRiskFromOpponents) --
    // summed across every such monument, not just the best one, since a state with several
    // simultaneously-grabbable exclusive monuments really is that much more valuable than one with just
    // one.
    if (round >= 3 && state.shops && state.shops.M) {
      for (const faceId of Object.values(state.shops.M.slots)) {
        if (!faceId) continue;
        if (monumentAtRiskFromOpponents(state, this.index, playerId, faceId)) continue;
        if (monumentSecurableByPlayer(state, this.index, playerId, faceId)) {
          total += v('モニュメント確保ボーナス');
        }
      }
    }

    // Owned-card synergy bonuses (2026-09-07, per user report: "このゲームはすでに獲得されているカードとの
    // 相性で獲得点数の最大効率も変わります" -- e.g. 聖女/王女(ONCE=UNTAP_CHOICE(SELF,3), fired once per
    // acquisition/LVUP) are only as good as the「ラウンドタップ」cards already on hand to untap-and-reuse
    // (user's own term, confirmed 2026-09-07: "タップするカードで毎ターン使えないカードをラウンドタップと
    // 呼びます" -- every 導き/兆し(B001-B006,B202) and C-card(C001-C006,C201) qualifies, since none of
    // their own TAP abilities self-untap), and 晩餐会(M401, final-VP-per-K) is only worth chasing with a
    // K-stockpiling economy already in place. Two new GA-tunable eval-table values (seeded at 0 in every
    // round, same "zero-escape" discovery mechanism as モニュメント確保ボーナス above -- see
    // src/ai/ga.js's mutateGenomePercent), unconditional like that row (harmless no-op until training
    // discovers a nonzero value). Deliberately named/enumerated combos (per user decision, confirmed
    // 2026-09-07: "決め打ち列挙" over a generic owned-card-tag system), matching monument-incentive.js's
    // own established convention for this kind of thing.
    {
      // Only a CURRENTLY TAPPED ラウンドタップ card benefits from being untapped (an untapped one can
      // already be used normally) -- per user's own worked example: "聖女はできれば獲得する前にラウンド
      // タップが1枚、LVアップする前にLV2のラウンドタップが2枚はあったほうがいい(最後の1枚のアンタップは
      // 聖女自身なので)、王女も獲得する時にラウンドタップが3枚ある状態で獲得できると強い" -- describes the
      // value of having several ラウンドタップ cards already TAPPED (used up) at the moment 聖女/王女 is
      // acquired/upgraded, not merely owned.
      let ownsFairyOrPrincess = false;
      let tappedUntapSynergyCount = 0;
      for (const pid of player.ownedCardPhysicalIds) {
        const inst = state.cards[pid];
        if (!inst) continue;
        const faceId = inst.currentFaceId;
        if (faceId === 'C202A' || faceId === 'C202B' || faceId === 'C301A' || faceId === 'C301B') {
          ownsFairyOrPrincess = true;
        } else if (inst.tapped && UNTAP_SYNERGY_FACE_IDS.has(faceId)) {
          tappedUntapSynergyCount++;
        }
      }
      if (ownsFairyOrPrincess) {
        total += tappedUntapSynergyCount * v('聖女王女ラウンドタップ相性');
      }
      // 農園/小麦畑/農夫(A004/A005/C201, either tier) x 晩餐会(M401, COST=10K, final VP_MODIFIER per K
      // held): a K-stockpiling economy already in place makes 晩餐会 both easier to afford and more
      // valuable once owned -- credited once while 晩餐会 is still unclaimed by anyone (same
      // isMonumentUnclaimed convention monument-incentive.js's own FARM_ROW_NAME check uses).
      const ownsFarmSynergy = player.ownedCardPhysicalIds.some((pid) => {
        const inst = state.cards[pid];
        return inst && FARM_SYNERGY_FACE_IDS.has(inst.currentFaceId);
      });
      const banquetHallInst = state.cards['M401'];
      const banquetHallUnclaimed = !banquetHallInst || banquetHallInst.ownerId === null;
      if (ownsFarmSynergy && banquetHallUnclaimed) {
        total += v('晩餐会食料生産相性');
      }
      // 元老院の支配(A301, either tier) x SENATE_SYNERGY_FACE_IDS (see that const's own doc): credited
      // once per qualifying card actually owned -- unlike the 聖女/王女 bonus above, ownership alone is
      // enough here (no tapped-state gating; 双星's dice grant/実業家's per-BUILD K/育成者's per-die-gain
      // resources/導き・宮廷人's die-value boosts are all standing benefits, not one-time untap fodder).
      const ownsSenate = player.ownedCardPhysicalIds.some((pid) => {
        const inst = state.cards[pid];
        return inst && (inst.currentFaceId === 'A301A' || inst.currentFaceId === 'A301B');
      });
      if (ownsSenate) {
        const senateSynergyCount = player.ownedCardPhysicalIds.reduce((n, pid) => {
          const inst = state.cards[pid];
          return inst && SENATE_SYNERGY_FACE_IDS.has(inst.currentFaceId) ? n + 1 : n;
        }, 0);
        total += senateSynergyCount * v('元老院支配拡張相性');
      }
    }

    // Monument-acquisition incentive (2026-08-29, opt-in via policy.monumentIncentiveAware -- "AI LV4"
    // only, see monument-incentive.js's own doc): credits a handful of concrete "close to affording a
    // heavy multi-color-COST monument" patterns per the game.xlsx 評価値_戦略 sheet, so the AI's shallow
    // lookahead has a reason to hold resources back for one instead of always spending on whatever's
    // cheap and immediate.
    if (this.policy.monumentIncentiveAware) {
      total += monumentIncentive.monumentIncentiveScore(state, this.index, playerId, this.monumentIncentiveTable);
    }

    // SHOP201-203 next-round availability credit (2026-08-27, per user report: "新しく2R 3R 4Rから獲得
    // できるカードができた AIはラウンド終了までよむため ラウンド終了時で資源を使い切ってしまうため 新し
    // いカードを獲得することができない" -- since the AI's own lookahead never sees past the current
    // round, it has no reason to hold resources back for a card that only becomes purchasable next round
    // (see board.specialShopMinRound's own doc on the round-gating -- such a card can already be sitting
    // visibly in a SPECIAL shop slot well before its own round arrives), so it always prefers spending
    // everything on whatever's reachable THIS round instead. Confirmed simplification with the user:
    // no need to actually verify the build would succeed next round (BZ discounts, exact affordability
    // enumeration, real dice/turn-order timing, etc.) -- a plain COST-vs-currently-held-resources check
    // is enough, credited the same value an OWNED card would get NEXT round (v(faceId)+VP*v('VP')
    // evaluated at round+1, not the current round -- these cards' own 評価値 entries are deliberately
    // blank/0 before their own round arrives, per eval-table.js's own doc, so reading them at the
    // current round would always credit 0), so holding onto those resources scores at least as well as
    // spending them on a lesser immediate option. Only the single best such candidate is credited, not
    // summed across every affordable slot at once -- the same resources can't buy more than one.
    if (state.shops && state.shops.SPECIAL) {
      let bestNextRoundCredit = 0;
      for (const faceId of Object.values(state.shops.SPECIAL.slots)) {
        if (!faceId) continue;
        if (board.specialShopMinRound(faceId) !== round + 1) continue;
        const row = getCardRow(this.index, faceId);
        const costItems = lowerCostList(row.COST);
        const affordable = costItems.every((item) => (player.resources[item.resource] || 0) >= item.count);
        if (!affordable) continue;
        const vp = typeof row.VP === 'number' ? row.VP : 0;
        const nextRoundValue = evalValue(this.evalTable, round + 1, faceId) + vp * evalValue(this.evalTable, round + 1, 'VP');
        bestNextRoundCredit = Math.max(bestNextRoundCredit, nextRoundValue);
      }
      total += bestNextRoundCredit;
    }

    return total;
  }
}

module.exports = { Evaluator };

})();
