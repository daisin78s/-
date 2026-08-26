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
const qst = require('../qst');
const { evalValue } = require('./eval-table');

/** Same regex board.js's own (unexported) parseMonumentThreshold uses, e.g. ">=12" -> 12. Duplicated
 * rather than exported from board.js purely for this one line -- see monumentAtRiskFromOpponents. */
function parseMonumentThreshold(diceString) {
  const match = /^>=(\d+)$/.exec(diceString);
  return match ? Number(match[1]) : null;
}

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

/** Whether some OTHER player already has, right now, both a qualifying unplaced color die and enough
 * resources to build monumentFaceId (2026-08-04, per user feedback: "そのモニュメントとられるかもは
 * 相手のダイスと資源が今足りているかで判断するようにしてください フリーアクションやJOBは現在は考慮
 * しなくていいです") -- a cheap current-state-only snapshot: never simulates an opponent's future
 * turns, and deliberately ignores free actions (e.g. A->K) or JOB abilities that could let them convert
 * toward affording it -- just their raw held resources and raw die values right now. Only checks the
 * die-value threshold (not e.g. the castle's own same-value-stacking accumulation), matching the common
 * case of a monument reachable via a normal AREA's own die value. */
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

class Evaluator {
  /** @param {DataIndex} index @param {Object} evalTable - see eval-table.js's buildEvalTable()
   *  @param {{qstAware?: boolean}} [policy] - optional strategy knob (2026-08-10, "AI LV3": per user
   *   request "AI LV3はQSTカードに対応してVPを稼ぐようにしたい"). Default {} (qstAware unset/falsy) --
   *   LV1/LV2 keep using an Evaluator built with no policy, so their behavior is byte-for-byte unchanged;
   *   LV3 gets its own instance constructed with qstAware:true (see main.js's aiEvaluatorLv3). See
   *   score()'s own QST block for what this actually adds. */
  constructor(index, evalTable, policy) {
    this.index = index;
    this.evalTable = evalTable;
    this.policy = policy || {};
  }

  /** @returns {number} playerId's position score in state, at state's current round. */
  score(state, playerId) {
    const round = state.round || 1;
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return 0;
    const v = (id) => evalValue(this.evalTable, round, id);

    let total = 0;

    // RESOURCE_LIMIT-aware resource scoring (2026-08-10, per user request: "K MAX7の時 1K+7Kで8Kになる
    // のは 減らして7Kとして評価" -- a resource held past an owned card's RESOURCE_LIMIT cap (e.g.
    // CON001A's K MAX7) is worth exactly its post-TURNEND-clamp amount, not its raw current count, since
    // the excess is auto-discarded at TURNEND and never actually kept (see executor.applyTurnEnd). Using
    // the clamped amount still correctly favors a bigger-but-overshooting gain over a smaller-but-safe
    // one whenever the clamped amount is itself larger (e.g. 1K+7K clamped to 7 still beats 1K+3K's 4),
    // it just no longer overstates the overshooting gain by the wasted excess.
    const resourceLimits = executor.activeResourceLimits(state, this.index, playerId);
    for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ']) {
      const have = player.resources[resource] || 0;
      const limit = resourceLimits[resource];
      total += (limit !== undefined ? Math.min(have, limit) : have) * v(resource);
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
    // に行かない"): this card's main value is lifting CON005A(怠惰)'s "色ダイス上限3個" -- see
    // board.js's TRAINING_GROUND_COLOR_DIE_CAP doc -- so it's a sharp, non-monotonic value curve (great
    // exactly when stuck at 3, worthless once already past it) that the flat per-round 評価値 number
    // can't express on its own; this state-dependent term lives here in code instead. Total color dice
    // (in hand AND currently placed) matches board.js's own established "TOTAL color dice" counting
    // convention, not just unplaced ones.
    const TRAINING_GROUND_DOMINATION_BONUS = 1000;
    const TRAINING_GROUND_DOMINATION_PENALTY = 1000;
    const totalColorDiceCount = player.dice.filter((d) => d.kind === 'COLOR').length;

    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState) continue;
      let row;
      try { row = getCardRow(this.index, cardState.currentFaceId); } catch (e) { continue; }
      total += v(cardState.currentFaceId);
      if (typeof row.VP === 'number') total += row.VP * v('VP');
      if (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B') {
        if (totalColorDiceCount === 3) total += TRAINING_GROUND_DOMINATION_BONUS;
        else if (totalColorDiceCount >= 4) total -= TRAINING_GROUND_DOMINATION_PENALTY;
      }
    }

    total += executor.collectVpModifiers(state, this.index, playerId) * v('VP');

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

    return total;
  }
}

module.exports = { Evaluator };

})();
