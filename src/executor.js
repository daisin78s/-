(function () {
/**
 * Executor: applies lowered Commands (see src/command-builder.js) to a
 * GameState (see src/game-state.js). This module is the only place that
 * mutates GameState directly.
 *
 * Scope: resource/dice grants (which roll new dice immediately and record
 * an undo checkpoint first -- see grantOneDie), CHANGE, UNTAP(_ALL),
 * PASSIVE-rule queries (REPLACE_ADD/VP_MODIFIER/CONVERT_LIMIT/
 * UPGRADE_LIMIT/MODIFY_CONVERT_VALUE), IF condition evaluation, TURNEND
 * rules (RESOURCE_LIMIT/RESOURCE_TOTAL_LIMIT/FORCE_CONVERT), MAP.CURRENT_AREA
 * assignment (which also records who owns that map's usage fee), the
 * ON(event,effect) dispatch bus, the dice-value DSLs (SET_DICE_ANY/
 * SET_DIE_VALUE/CHANGE_DIE_VALUE/GRANT_PLACE_ANYWHERE), and the free-action
 * mechanic (tryFreeAction/collectUsageFee/resetFreeActionsForNewRound) --
 * see the block below. BUILD/PLACE_DICE resolution lives in board.js
 * instead (runCommand() throws NotImplementedError for bare BUILD, since it
 * needs shop state runCommand's simple synchronous model can't express).
 *
 * Known simplifications, flagged for follow-up once turn-flow/UI exists:
 *  - WARNING confirmation ("いいえ" cancels the triggering action) is a UI
 *    concern layered above this module; applyTurnEnd() always takes the
 *    "はい" path (RESOURCE_LIMIT auto-discards down to the limit).
 *  - FORCE_CONVERT(from,to,count)'s "count" is treated as an execution count
 *    like CHANGE's third argument (1:1 ratio, `count` times, clamped to what
 *    the player actually has) -- the DSL spec confirms the 0-balance no-op
 *    case but not the exact ratio, so this is an assumption to revisit.
 *  - CHANGE(...,ALL) picks the max affordable execution count unless the
 *    caller passes context.chosenTimes, further capped by any active
 *    CONVERT_LIMIT(ALL,n) PASSIVE rule. That cap is PER CHANGE and applies to
 *    every ALL-based CHANGE (corrected 2026-08-11 -- see runChange's own doc
 *    for the two things this replaced: a whole-game cumulative counter, and
 *    an AREA003/004/005-only scope).
 */

'use strict';

const { parse } = require('./dsl-parser');
const { lowerProgram, lowerCall, lowerCostList } = require('./command-builder');
const { getCardRow, getAreaRow, findCardFace, getCardAutoDefault } = require('./data-loader');
const { splitCardId, createDie, INITIAL_COLOR_DICE } = require('./game-state');
const { rollDie } = require('./rng');

class NotImplementedError extends Error {}
class ExecutionError extends Error {}

const DICE_KIND_BY_RESOURCE = { D: 'COLOR', wD: 'WHITE' };
const CARD_COUNT_SHEETS = new Set(['A', 'B', 'C', 'M']); // CARD_COUNT excludes JOB/CON

// Z is a universal substitute for any of A/B/C when paying a cost (confirmed 2026-07-31): by default
// real A/B/C is always drained first and Z only covers a shortfall, automatically, for every player.
// CON002B specifically grants the *choice* to prefer Z instead (e.g. to spend it down before its own
// TURNEND=FORCE_CONVERT(Z,K,1) claims it anyway) -- see resolvePayment/hasPaymentChoiceAbility below.
const COLOR_RESOURCES = new Set(['A', 'B', 'C']);
// Bespoke, explicitly-confirmed exception to "the engine only interprets DSL, never card IDs" --
// same precedent as board.js's CASTLE_MAP_ID. CON002B's payment-choice ability has no DSL
// representation of its own (its only real DSL is TURNEND=FORCE_CONVERT(Z,K,1); "you may choose to
// pay with Z instead" is WARNING/INST flavor text, never parsed).
const PAYMENT_CHOICE_CON_FACE_ID = 'CON002B';

// ---------------------------------------------------------------------------
// Small state accessors
// ---------------------------------------------------------------------------

function getPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new ExecutionError(`Unknown player: ${playerId}`);
  return player;
}

/** Cards currently owned by playerId, as {physicalId, cardInstance, row}. */
function ownedCardRows(state, index, playerId) {
  const out = [];
  for (const physicalId of Object.keys(state.cards)) {
    const inst = state.cards[physicalId];
    if (inst.ownerId !== playerId) continue;
    out.push({ physicalId, inst, row: getCardRow(index, inst.currentFaceId) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dice / resource grant + payment primitives
// ---------------------------------------------------------------------------

function colorDiceCount(player) {
  return player.dice.filter((d) => d.kind === 'COLOR').length;
}
function whiteDiceCount(player) {
  return player.dice.filter((d) => d.kind === 'WHITE').length;
}

/**
 * Grants one die, applying the overflow-conversion chain (color -> white -> 2K).
 * Confirmed 2026-07-29: a die is rolled exactly once, immediately when gained
 * -- white dice are never rerolled again after that; color dice are (in bulk,
 * separately) at round end.
 *
 * Does NOT record its own undo checkpoint (corrected 2026-08-02: it used to, but that call was
 * superseded by main.js's render()-driven "checkpoint once at the start of each player's TURN"
 * mechanism added 2026-07-30, and the two conflicted -- a mid-round die grant triggered from inside an
 * already-in-progress placement (e.g. AREA007's CHANGE((A,B,C),D)) would overwrite the turn-start
 * checkpoint with a snapshot where the *triggering* die was already placed, so Undo could no longer
 * revert the whole placement. The 3 real checkpoint moments (initial roll, round-start reroll,
 * turn-start) each already take their own checkpoint one level up -- see setup.rollInitialColorDice,
 * turn-flow.startRound, and main.js's render() respectively -- so this leaf function doesn't need to.
 */
function grantOneDie(state, player, kind, dieIdFactory) {
  if (kind === 'COLOR') {
    if (colorDiceCount(player) < player.colorDiceCap) {
      const die = createDie(dieIdFactory(), 'COLOR');
      die.value = rollDie(state.rng);
      player.dice.push(die);
    } else {
      grantOneDie(state, player, 'WHITE', dieIdFactory);
    }
    return;
  }
  // kind === 'WHITE'
  if (whiteDiceCount(player) < player.whiteDiceCap) {
    const die = createDie(dieIdFactory(), 'WHITE');
    die.value = rollDie(state.rng);
    player.dice.push(die);
  } else {
    player.resources.K += 2;
    // Recorded for main.js's warning banner (2026-08-11, per user request) -- see
    // GameState.whiteOverflowEvents' own doc. Not read anywhere else in the engine.
    state.whiteOverflowEvents.push(player.id);
  }
}

let dieIdCounter = 0;
function nextDieId() {
  dieIdCounter += 1;
  return `d${dieIdCounter}`;
}

/** Applies a REPLACE_ADD PASSIVE rule (forced substitution) if one is active for `resource`. */
function applyReplaceAdd(state, index, playerId, resource) {
  const rules = getPassiveRules(state, index, playerId, 'REPLACE_ADD');
  const rule = rules.find((r) => r.from === resource);
  return rule ? rule.to : resource;
}

/**
 * Grants `count` of `resource` to playerId. Dice resources (D/wD) become new
 * Die objects (with overflow conversion); everything else is a resources[]
 * counter increment. REPLACE_ADD is applied before granting.
 */
function grantResource(state, index, playerId, resource, count) {
  const player = getPlayer(state, playerId);
  const effectiveResource = applyReplaceAdd(state, index, playerId, resource);
  const dieKind = DICE_KIND_BY_RESOURCE[effectiveResource];
  if (dieKind) {
    for (let i = 0; i < count; i++) grantOneDie(state, player, dieKind, nextDieId);
  } else {
    player.resources[effectiveResource] = (player.resources[effectiveResource] || 0) + count;
  }
  return effectiveResource;
}

/** Returns true and pays if affordable; returns false and leaves state untouched otherwise. */
function tryPay(state, playerId, resource, count) {
  const player = getPlayer(state, playerId);
  const dieKind = DICE_KIND_BY_RESOURCE[resource];
  if (dieKind) {
    const have = player.dice.filter((d) => d.kind === dieKind).length;
    if (have < count) return false;
    let remaining = count;
    player.dice = player.dice.filter((d) => {
      if (d.kind === dieKind && remaining > 0) {
        remaining -= 1;
        return false;
      }
      return true;
    });
    return true;
  }
  if ((player.resources[resource] || 0) < count) return false;
  player.resources[resource] -= count;
  return true;
}

/** Whether playerId owns a card currently showing PAYMENT_CHOICE_CON_FACE_ID (CON002B) -- see the
 * const's own comment for why this is a deliberate card-ID exception. */
function hasPaymentChoiceAbility(state, playerId) {
  const player = getPlayer(state, playerId);
  return player.ownedCardPhysicalIds.some((physicalId) => state.cards[physicalId].currentFaceId === PAYMENT_CHOICE_CON_FACE_ID);
}

/**
 * Resolves a flat {resource,count} cost list against playerId's actual resources, substituting Z for
 * any A/B/C item per COLOR_RESOURCES' comment above. colorPreference is an optional {A,B,C: 'Z'|
 * anything} map -- 'Z' drains Z first for that resource (real makes up any shortfall); anything else
 * (including omitted) is the default: real first, Z only as a fallback for whatever's left. Either
 * way affordability is identical (real+Z combined must cover the count) -- preference only changes
 * *which* is drained first, never whether the payment succeeds. colorPreference is silently ignored
 * (treated as all-default) unless the player actually has hasPaymentChoiceAbility, so a UI bug can't
 * grant the choice to a player who doesn't own CON002B.
 * @returns {{ok:true, items:{resource:string,count:number}[]}|{ok:false, resource:string}}
 */
function resolvePayment(state, playerId, items, colorPreference) {
  const player = getPlayer(state, playerId);
  const preference = colorPreference && hasPaymentChoiceAbility(state, playerId) ? colorPreference : null;
  let zPool = player.resources.Z || 0;
  const resolved = [];
  for (const item of items) {
    if (COLOR_RESOURCES.has(item.resource)) {
      const haveReal = player.resources[item.resource] || 0;
      const preferZ = preference && preference[item.resource] === 'Z';
      let realUsed;
      let zUsed;
      if (preferZ) {
        zUsed = Math.min(zPool, item.count);
        realUsed = item.count - zUsed;
      } else {
        realUsed = Math.min(haveReal, item.count);
        zUsed = item.count - realUsed;
      }
      if (realUsed > haveReal || zUsed > zPool) return { ok: false, resource: item.resource };
      zPool -= zUsed;
      if (realUsed > 0) resolved.push({ resource: item.resource, count: realUsed });
      if (zUsed > 0) resolved.push({ resource: 'Z', count: zUsed });
      continue;
    }
    const dieKind = DICE_KIND_BY_RESOURCE[item.resource];
    const have = dieKind
      ? player.dice.filter((d) => d.kind === dieKind).length
      : item.resource === 'Z' ? zPool : (player.resources[item.resource] || 0);
    if (have < item.count) return { ok: false, resource: item.resource };
    if (item.resource === 'Z') zPool -= item.count;
    resolved.push(item);
  }
  return { ok: true, items: resolved };
}

/**
 * Atomically pays a flat {resource,count} list (e.g. a lowered COST column
 * from command-builder's lowerCostList) -- all items must be affordable or
 * nothing is paid. Used by board.js for BUILD/UPGRADE costs. colorPreference:
 * see resolvePayment.
 */
function payCostList(state, playerId, items, colorPreference) {
  const resolution = resolvePayment(state, playerId, items, colorPreference);
  if (!resolution.ok) return { success: false, reason: 'INSUFFICIENT_RESOURCES', resource: resolution.resource };
  for (const item of resolution.items) tryPay(state, playerId, item.resource, item.count);
  return { success: true };
}

/**
 * Reduces a flat {resource,count} cost list by a BZ discount -- 1 BZ token skips paying 1 unit of any
 * resource in the list, the player's choice of which (bzDiscount: {resource: n}, units to skip per
 * resource; undefined/omitted entries mean 0). BUILD and UPGRADE alike (2026-08-06, per user feedback)
 * -- board.js's resolveBuildNew and resolveUpgrade both call this against their own candidate's COST.
 * Pure data transform, no state access: the caller folds the returned
 * bzUsed into a plain {resource:'BZ', count:bzUsed} item appended to the *same* payCostList call, so
 * the discounted cost and the BZ spend succeed or fail together atomically (payCostList's own
 * affordability check covers whether the player actually has that much BZ). A bzDiscount entry for a
 * resource not present in items is simply never read (silently contributes nothing) rather than
 * erroring -- e.g. the player configured a discount for a resource a *different* candidate needed.
 * @returns {{items:{resource:string,count:number}[], bzUsed:number}|null} null if some entry asks to
 *   discount more of a resource than the cost actually requires (can't discount below 0).
 */
function applyBzDiscount(items, bzDiscount) {
  if (!bzDiscount) return { items, bzUsed: 0 };
  let bzUsed = 0;
  const discounted = [];
  for (const item of items) {
    const discount = bzDiscount[item.resource] || 0;
    if (discount > item.count) return null;
    bzUsed += discount;
    const remaining = item.count - discount;
    if (remaining > 0) discounted.push({ resource: item.resource, count: remaining });
  }
  return { items: discounted, bzUsed };
}

/**
 * Auto-BZ (2026-08-04, per user feedback: "デフォルトでBZを使って建築するようにして" -- the old flow
 * made the player manually dial in a per-resource BZ stepper *before* any candidate even showed up as
 * affordable, which was confusing enough that a real bug report turned out to just be this). Since BZ
 * has no use outside discounting a BUILD's COST ([[project-dice-wp-dsl-spec]]), always spending the max
 * usable amount (min(bzAvailable, the cost's total unit count)) is strictly at least as good as spending
 * less -- so there's no reason to ever offer "spend fewer BZ" as a choice (confirmed).
 *
 * What *can* still need a real choice: with 2+ distinct resource types in the cost, there's often more
 * than one way to distribute that fixed BZ total across them (e.g. cost 2A+1B, 2 BZ available: cover
 * both A's and pay the B for real, or cover one A + the B and pay the other A for real). This function
 * enumerates every such distribution, resolves payment for each (real-first-then-Z, exactly like a
 * normal cost), and keeps only the ones that actually succeed. It then dedupes by the *resolved* payment
 * (the real {resource,count} list actually spent), not by the raw BZ distribution -- two distributions
 * that end up spending identical resources (e.g. both fall back to 1 Z because the player has neither
 * real A nor real B on hand) are not a meaningful choice to a player, only ones that actually spend
 * different real resources are. That's what turns the user's worked example ("1A・1Bどちらか片方しか持っ
 * ていなければ自動でそのまま建築、両方持っていれば選ばせる") into a general rule instead of a special
 * case for exactly-one-remaining-unit costs.
 * @returns {{bzDiscount:Object<string,number>, resolvedItems:{resource:string,count:number}[]}[]}
 *   One entry per distinct affordable outcome. Empty array means unaffordable (no valid distribution
 *   the player can actually pay for) -- same meaning as candidateAffordable's old false.
 */
function enumerateBzOutcomes(state, playerId, items, bzAvailable, colorPreference) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const maxBz = Math.max(0, Math.min(bzAvailable, total));
  const distributions = [];
  const current = {};
  (function backtrack(idx, remaining) {
    if (idx === items.length) {
      if (remaining === 0) distributions.push({ ...current });
      return;
    }
    const item = items[idx];
    const maxHere = Math.min(item.count, remaining);
    for (let n = 0; n <= maxHere; n += 1) {
      if (n > 0) current[item.resource] = n;
      backtrack(idx + 1, remaining - n);
    }
    delete current[item.resource];
  })(0, maxBz);

  const seen = new Map();
  for (const bzDiscount of distributions) {
    const discount = applyBzDiscount(items, bzDiscount);
    if (!discount) continue; // pragma: shouldn't happen, distributions are already capped per-item
    const payItems = discount.bzUsed > 0 ? [...discount.items, { resource: 'BZ', count: discount.bzUsed }] : discount.items;
    const resolution = resolvePayment(state, playerId, payItems, colorPreference);
    if (!resolution.ok) continue;
    const key = resolution.items.map((i) => `${i.resource}:${i.count}`).sort().join(',');
    if (!seen.has(key)) seen.set(key, { bzDiscount, resolvedItems: resolution.items });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Dynamic count expressions (e.g. "COUNT(天)*wD")
// ---------------------------------------------------------------------------

/** Recursive because a parenthesized arithmetic offset like "(COUNT(天)-1)" lowers to a Group
 * wrapping one BinaryOp item (the parens are needed so '*wD' outside them binds to the whole
 * offset expression, not just the "1") -- see dsl-parser.js's arith_tail grammar note. */
function evalCountExprNode(state, index, playerId, node) {
  if (node.type === 'Call') {
    return evalMetric(state, index, playerId, { name: node.name, args: node.args.map((a) => (a.type === 'Number' ? a.value : a.name)) });
  }
  if (node.type === 'Number') return node.value;
  if (node.type === 'Group' && node.items.length === 1) return evalCountExprNode(state, index, playerId, node.items[0]);
  if (node.type === 'BinaryOp') {
    const left = evalCountExprNode(state, index, playerId, node.left);
    const right = evalCountExprNode(state, index, playerId, node.right);
    const result = node.op === '+' ? left + right : left - right;
    // A count can't go negative (e.g. COUNT(天)=0 with a "-1" nerf just means "grant nothing", not
    // a debt) -- clamp here rather than relying on callers to guard against it.
    return Math.max(0, result);
  }
  throw new NotImplementedError(`Cannot evaluate dynamic count expression of type ${node.type}`);
}

function evalCountNode(state, index, playerId, countSpec) {
  if (countSpec.kind === 'literal') return countSpec.value;
  // countSpec.kind === 'expr' -- currently COUNT(x)/EMBLEM_COUNT(x) style calls, optionally offset
  // by arithmetic (e.g. "(COUNT(天)-1)*wD").
  return evalCountExprNode(state, index, playerId, countSpec.node);
}

/** A/B/C decks carry a single emblem in their own EMBLEM column (e.g. {地: 1}). Monuments (2026-07-30:
 * game.xlsx's M sheet split EMBLEM into per-type EMBLEM_A/EMBLEM_B/EMBLEM_C count columns, same A=地/
 * B=天/C=人 letter convention as the decks) can carry 0-3, one card contributing to multiple emblem
 * types at once. JOB/CON/RESOURCE have neither populated, so return {} for those. */
function emblemCountsForRow(row) {
  if (row.EMBLEM) return { [row.EMBLEM]: 1 };
  const counts = {};
  if (row.EMBLEM_A) counts['地'] = row.EMBLEM_A;
  if (row.EMBLEM_B) counts['天'] = row.EMBLEM_B;
  if (row.EMBLEM_C) counts['人'] = row.EMBLEM_C;
  return counts;
}

/** {天, 地, 人} totals across every owned card (shared by EMBLEM_SET_COUNT/MAX_EMBLEM_COUNT/
 * TOTAL_EMBLEM_COUNT below, added 2026-07-30 for QST GOAL conditions -- see [[project-dice-wp-qst-spec]]). */
function emblemTotalsByType(owned) {
  const totals = { 天: 0, 地: 0, 人: 0 };
  for (const e of ['天', '地', '人']) {
    totals[e] = owned.reduce((sum, c) => sum + (emblemCountsForRow(c.row)[e] || 0), 0);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// IF condition metrics
// ---------------------------------------------------------------------------

function evalMetric(state, index, playerId, metric) {
  const owned = ownedCardRows(state, index, playerId);
  switch (metric.name) {
    case 'CARD_COUNT': {
      // Bare CARD_COUNT (no args) keeps its original meaning: every buildable-category card
      // (A/B/C/M). CARD_COUNT(M) etc. (confirmed 2026-07-30, added for QST GOAL conditions -- see
      // src/qst.js) scopes to one or more sheets; still bounded by CARD_COUNT_SHEETS so e.g.
      // CARD_COUNT(JOB) can't be used to sidestep "JOB/CON don't count" via this path.
      // Multi-sheet form (2026-08-09, QST's new rank-based GOAL: "CARD_COUNT(A,B,C)" = every A/B/C
      // card, i.e. everything CARD_COUNT already counts *except* M) -- any number of sheet args is a
      // union, not just the original single-sheet case.
      const scopeSheets = metric.args.length > 0 ? new Set(metric.args) : null;
      return owned.filter((c) => {
        const sheet = index.byId.get(c.row.ID).sheet;
        return scopeSheets ? scopeSheets.has(sheet) && CARD_COUNT_SHEETS.has(sheet) : CARD_COUNT_SHEETS.has(sheet);
      }).length;
    }
    // "所有AREA数"/"所有LV2AREA数" (2026-08-09, QST's new rank-based GOAL): how many of the 8
    // AREA-ownership cards (A001-A008) this player owns -- each A-deck card ties to exactly one
    // AREA/MAP (see its own ONCE, "MAP{n}.CURRENT_AREA=..."), so owning the card IS owning that area.
    // Bare AREA_COUNT = any tier; AREA_COUNT(2) = LEVEL 2 only (i.e. tier-B A-cards like A001B/A005B,
    // "所有LV2AREA数" -- an optional level filter on the same metric, not a separate LEVEL_COUNT
    // variant, since both questions are really "how many AREAs", just filtered differently).
    case 'AREA_COUNT': {
      const level = metric.args[0];
      return owned.filter((c) => index.byId.get(c.row.ID).sheet === 'A' && (level === undefined || c.row.LEVEL === level)).length;
    }
    case 'LEVEL_COUNT': {
      const level = metric.args[0];
      return owned.filter((c) => c.row.LEVEL === level).length;
    }
    case 'EMBLEM_COUNT':
    case 'COUNT': {
      const emblem = metric.args[0];
      // Bare EMBLEM_COUNT (2026-08-09, QST's new rank-based GOAL "EMBLEM_COUNT" with no argument --
      // confirmed with the user: "EMBLEM総数です　天地人すべてのEMBLEMの足した数です") -- same
      // computation as TOTAL_EMBLEM_COUNT below, kept as a separate case (rather than aliasing the
      // switch label itself) since EMBLEM_COUNT(x)/COUNT(x) with an argument is a completely different,
      // already-established metric (a single emblem type's count).
      if (!emblem) {
        const totals = emblemTotalsByType(owned);
        return totals.天 + totals.地 + totals.人;
      }
      return owned.reduce((sum, c) => sum + (emblemCountsForRow(c.row)[emblem] || 0), 0);
    }
    case 'EMBLEM_SET_COUNT': {
      const totals = emblemTotalsByType(owned);
      return Math.min(totals.天, totals.地, totals.人);
    }
    // Added 2026-07-30 for QST GOAL conditions (see [[project-dice-wp-qst-spec]]): "最大EMBLEM数"
    // (whichever of 天/地/人 you have the most of) and "EMBLEMの合計数" (all three added together).
    case 'MAX_EMBLEM_COUNT': {
      const totals = emblemTotalsByType(owned);
      return Math.max(totals.天, totals.地, totals.人);
    }
    case 'TOTAL_EMBLEM_COUNT': {
      const totals = emblemTotalsByType(owned);
      return totals.天 + totals.地 + totals.人;
    }
    // "今建築されているカードの資源合計" (confirmed 2026-07-30): sum of every owned card's printed
    // COST, across every resource type. Deliberately reads the *current* owned-card COSTs rather than
    // tracking a running "resources spent" counter -- built cards are never lost, so the two are
    // equivalent, and this needs no new persistent state (see [[project-dice-wp-qst-spec]]). BZ isn't
    // itself a COST entry on any card, so a build paid for (partly) with BZ still counts at the
    // card's full face-value COST here, matching the "資源(BZ含む)" wording.
    case 'COST_TOTAL':
      return owned.reduce((sum, c) => sum + lowerCostList(c.row.COST).reduce((s, item) => s + item.count, 0), 0);
    // Confirmed 2026-07-30 for QST GOAL conditions: reads a raw player resource (e.g. RESOURCE(VP))
    // directly, rather than counting owned cards like every other metric above -- the only metric
    // that looks at PlayerState.resources instead of ownedCardRows.
    case 'RESOURCE':
      return getPlayer(state, playerId).resources[metric.args[0]] || 0;
    // "ABC建築数+追加色ダイス" (Q001B GOAL, 2026-08-11): CARD_COUNT(A,B,C) plus the player's *additional*
    // color dice -- how many they've gained BEYOND their starting hand, i.e. colorDiceCount minus
    // INITIAL_COLOR_DICE, floored at 0. Range 0..2 (starting 3, colorDiceCap 5).
    //
    // Replaces 2026-08-10's D_PLUS_ABC_COUNT, which counted ALL color dice and so started every game at 3
    // while every other QST goal started at 0 (per user: "QSTの初期状態をすべて０にするため"). Floored
    // rather than allowed negative because a QST goal is a "how much have you achieved" count, and nothing
    // in the game removes a color die anyway (only WHITE dice are disposable -- see turn-flow's endRound),
    // so the floor is purely defensive.
    //
    // Counts placed/passed dice too, not just unplaced ones (confirmed with the user when this metric was
    // first added): a color die stays in player.dice for the whole round wherever it sits. Delegates the
    // ABC half to CARD_COUNT(A,B,C) rather than re-deriving its filter, so the two can't drift.
    case 'EXTRA_D_PLUS_ABC_COUNT': {
      const colorDiceCount = getPlayer(state, playerId).dice.filter((d) => d.kind === 'COLOR').length;
      const extraColorDice = Math.max(0, colorDiceCount - INITIAL_COLOR_DICE);
      return extraColorDice + evalMetric(state, index, playerId, { name: 'CARD_COUNT', args: ['A', 'B', 'C'] });
    }
    default:
      throw new NotImplementedError(`Unknown condition metric: ${metric.name}`);
  }
}

function compare(value, op, target) {
  switch (op) {
    case '<=': return value <= target;
    case '>=': return value >= target;
    case '<': return value < target;
    case '>': return value > target;
    case '==': return value === target;
    case '!=': return value !== target;
    default: throw new ExecutionError(`Unknown comparator: ${op}`);
  }
}

function evalCondition(state, index, playerId, conditionSpec) {
  const value = evalMetric(state, index, playerId, conditionSpec.metric);
  return compare(value, conditionSpec.op, conditionSpec.value);
}

// ---------------------------------------------------------------------------
// PASSIVE rule queries
// ---------------------------------------------------------------------------

/** Parses one card's PASSIVE field into lowered top-level commands (IF unwrapped when the condition holds). */
function activePassiveCommands(state, index, playerId, row) {
  if (!row.PASSIVE) return [];
  const commands = lowerProgram(parse(row.PASSIVE));
  const out = [];
  for (const cmd of commands) {
    if (cmd.type === 'IF') {
      if (evalCondition(state, index, playerId, cmd.condition)) out.push(cmd.effect);
    } else {
      out.push(cmd);
    }
  }
  return out;
}

/** All currently-active PASSIVE commands of a given type, across every card the player owns. */
function getPassiveRules(state, index, playerId, type) {
  const owned = ownedCardRows(state, index, playerId);
  const out = [];
  for (const { row } of owned) {
    for (const cmd of activePassiveCommands(state, index, playerId, row)) {
      if (cmd.type === type) out.push(cmd);
    }
  }
  return out;
}

/** Sum of every active VP_MODIFIER, for final scoring. */
function collectVpModifiers(state, index, playerId) {
  return getPassiveRules(state, index, playerId, 'VP_MODIFIER').reduce((sum, r) => sum + r.amount, 0);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function runAdd(state, index, context, cmd) {
  for (const item of cmd.items) {
    const count = evalCountNode(state, index, context.playerId, item.count);
    grantResourceAndEmitGet(state, index, context, item.resource, count);
  }
  return { success: true };
}

function runChange(state, index, context, cmd) {
  const player = getPlayer(state, context.playerId);
  const pay = cmd.pay.map((item) => ({ resource: item.resource, count: evalCountNode(state, index, context.playerId, item.count) }));
  const gain = cmd.gain.map((item) => ({ resource: item.resource, count: evalCountNode(state, index, context.playerId, item.count) }));

  // Deliberately not Z-aware for A/B/C pay items in the 'all'/'capped' branches below (unlike the
  // 'literal' one-shot case, whose exact fixed amount goes through resolvePayment's own Z substitution
  // further down) -- no current data combines ALL/capped-mode with colored pay (the only such CHANGEs pay
  // K), and estimating a shared Z pool's contribution across multiple simultaneous items here would need
  // real combinatorial care to avoid over-counting the same Z twice.
  const maxAffordable = () => Math.min(
    ...pay.map((item) => {
      const dieKind = DICE_KIND_BY_RESOURCE[item.resource];
      const have = dieKind
        ? player.dice.filter((d) => d.kind === dieKind).length
        : player.resources[item.resource] || 0;
      return Math.floor(have / item.count);
    })
  );

  let times;
  if (cmd.times.kind === 'literal') {
    // The true "exactly N, all-or-nothing" case -- always N=1 in practice (command-builder.js's
    // lowerChange only ever produces this kind for CHANGE's implicit default, i.e. no third argument at
    // all, e.g. JOB004's CHANGE(3K,2BZ)); resolvePayment further down fails the whole command if that
    // exact amount isn't affordable, no partial execution.
    const limitRules = getPassiveRules(state, index, context.playerId, 'MODIFY_CONVERT_VALUE');
    times = cmd.times.value + limitRules.reduce((sum, r) => sum + r.delta, 0);
  } else if (cmd.times.kind === 'capped') {
    // An explicit numeric third argument, e.g. C001A's TAP=CHANGE(K,A,2) (2026-08-11, per user request:
    // "1Kしか持ってないときにTAPしたら1K→1Aになるように" -- C001A/002A/003A used to be a flat
    // CHANGE(2K,2A), which needed the full 2K or did nothing at all). Unlike 'literal' above, this
    // executes as many times as affordable UP TO the given number, so a player short of the full amount
    // still gets a scaled-down conversion instead of none. Deliberately NOT subject to CONVERT_LIMIT (see
    // the 'all' branch below) -- that PASSIVE only reads 'all'-kind CHANGEs, and this cap is already
    // explicit and self-contained in the DSL string itself, so there's no gap for CONVERT_LIMIT to close.
    const limitRules = getPassiveRules(state, index, context.playerId, 'MODIFY_CONVERT_VALUE');
    const requested = cmd.times.value + limitRules.reduce((sum, r) => sum + r.delta, 0);
    times = Math.min(Math.max(0, requested), maxAffordable());
  } else {
    // 'all': max executions the player can currently afford, capped by context.chosenTimes if given.
    times = context.chosenTimes !== undefined ? Math.min(context.chosenTimes, maxAffordable()) : maxAffordable();

    // CONVERT_LIMIT(ALL,n) (CON003B: "資源を交換するときの上限4個"): a PASSIVE cap on how many times a
    // single ALL-based CHANGE may execute -- PER CHANGE, with nothing carried between them.
    //
    // Corrected 2026-08-11, per the user restating the intended rule ("意図した制限は一回のCHANGEでMAX4個
    // までしか交換できない"): this used to subtract a whole-game cumulative counter
    // (state.passiveCounters), so a player's FIRST ALL-CHANGE spent the entire allowance and every later
    // one in the game was capped at 0. Two separate changes fixed it:
    //  1. No counter at all -- each CHANGE is measured on its own, so the user's own example works:
    //     10K, same turn, C001B's TAP and a die on AREA003A -> 4 each (8 K converted overall).
    //  2. No longer gated on context.convertLimitEligible, which board.js only set for MAP003/004/005.
    //     That scoping dates from when those AREAs held the only ALL-CHANGEs in the data; C001B/C002B/
    //     C003B's TAPs became CHANGE(K,x,ALL) on 2026-08-05 and were therefore uncapped, contradicting
    //     the same example. The flag is gone entirely -- every ALL-based CHANGE is capped now.
    // 'literal'/'capped'-kind CHANGEs and the built-in free actions remain unaffected: this PASSIVE only
    // ever reads the 'all' branch (see this rule's own loop, right here), never runs for the other two.
    for (const rule of getPassiveRules(state, index, context.playerId, 'CONVERT_LIMIT')) {
      times = Math.min(times, Math.max(0, rule.limit));
    }
  }

  if (times <= 0) return { success: true, timesExecuted: 0 };

  // Substitutes Z for any A/B/C item per resolvePayment (context.colorPreference: see its own doc).
  const scaledPay = pay.map((item) => ({ resource: item.resource, count: item.count * times }));
  const resolution = resolvePayment(state, context.playerId, scaledPay, context.colorPreference);
  if (!resolution.ok) return { success: false, reason: 'INSUFFICIENT_RESOURCES', resource: resolution.resource };
  for (const item of resolution.items) {
    const ok = tryPay(state, context.playerId, item.resource, item.count);
    if (!ok) throw new ExecutionError('Payment failed after affordability check passed (bug)');
  }
  for (const item of gain) {
    // grantResourceAndEmitGet, same as runAdd (reverted 2026-08-04, per user feedback: JOB006's
    // ON(GET(D),ADD(Z)) should fire when AREA007's CHANGE((A,B,C),D) grants D). The 2026-08-03 fix that
    // made this a plain grantResource was scoped too broadly -- the actual complaint was specifically
    // about the 6 built-in free actions (A->K etc., see tryFreeAction below) firing GET via their own
    // conversion, not about genuine CHANGE(...) DSL commands on cards/AREAs. Confirmed safe to revert
    // here: no CHANGE(...) anywhere in the data grants K (the resource JOB005A's ON(GET(K),CHANGE(K,Z))
    // reacts to), so this can't reintroduce that bug -- only tryFreeAction's own K grants can, and that
    // fix (below) is untouched.
    grantResourceAndEmitGet(state, index, context, item.resource, item.count * times);
  }
  // (No CONVERT_LIMIT bookkeeping here any more -- the cap is per-CHANGE, so there's nothing to carry
  // forward. See the cap itself above.)
  return { success: true, timesExecuted: times };
}

function runUntap(state, context, cmd) {
  if (!context.sourcePhysicalId) throw new ExecutionError('UNTAP requires context.sourcePhysicalId');
  state.cards[context.sourcePhysicalId].tapped = false;
  return { success: true };
}

function runUntapAll(state, context, cmd) {
  for (const physicalId of Object.keys(state.cards)) {
    if (state.cards[physicalId].ownerId === context.playerId) state.cards[physicalId].tapped = false;
  }
  return { success: true };
}

/** SLOT1-6 columns that aren't "NONE" for areaRow, in order -- the same filter setup.js's prepareMaps
 * uses to size a fresh MapState.slots at game start. Duplicated here (not imported from board.js) to
 * avoid a require cycle, same rationale as evaluator.js's own duplicated parseMonumentThreshold. */
function activeSlotCount(areaRow) {
  return ['SLOT1', 'SLOT2', 'SLOT3', 'SLOT4', 'SLOT5', 'SLOT6'].filter((key) => areaRow[key] !== 'NONE').length;
}

function runSetCurrentArea(state, index, context, cmd) {
  if (!state.maps[cmd.mapId]) throw new ExecutionError(`Unknown map in state: ${cmd.mapId}`);
  const map = state.maps[cmd.mapId];
  map.currentAreaId = cmd.value;
  // Every "MAP{n}.CURRENT_AREA=..." assignment in the data is a tier upgrade (A->B or B->C)
  // triggered by the card the acting player just built/upgraded, so they become the fee owner.
  map.feeOwnerId = context.playerId;
  // Bug fix (2026-08-04, per user report: "A001 002などすべて 建築したりアップグレードしたときに
  // おかれているダイスがそのままでSLOTが空きません", contrasted against MAP001's own A->B flip which
  // *did* visibly free its slots) -- map.slots was left completely untouched here, still sized/filled
  // for the OLD area's SLOT1-6 layout even though the area itself just changed to a DIFFERENT layout
  // (different non-NONE columns/count, e.g. AREA003A -> AREA003B). Depending on whether the new area
  // happened to have fewer or more active slots than the old one, this either silently orphaned a
  // die (looked "freed" by accident) or, worse, left slot indices whose old occupant now blocked a
  // slot position that means something totally different under the new area's own rules. Any die
  // sitting in the old slots already did its job for the round (its PLACE/ONCE effects already ran --
  // turn-flow only ever checks die.placedMapId, never map.slots), so resetting this array to fresh
  // empty slots matching the new area is safe: it doesn't un-spend anything, it just retires a board
  // section that no longer exists in this shape (same fresh-array construction setup.prepareMaps uses).
  map.slots = Array.from({ length: activeSlotCount(getAreaRow(index, cmd.value)) }, () => []);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Dice-value DSLs (SET_DICE_ANY / SET_DIE_VALUE / CHANGE_DIE_VALUE /
// GRANT_PLACE_ANYWHERE). All target "SELF" in every real card seen so far --
// there's no other scope to resolve. These are genuine player choices (which
// die, which of the offered values), so the choice must arrive via context
// (context.chosenDieId, and context.chosenValue / context.chosenDelta) --
// there is no default to fall back on. Successfully-targeted commands record
// context.lastTargetedDieId so a following GRANT_PLACE_ANYWHERE(THIS_DICE,...)
// in the same DSL field (e.g. B001A's "SET_DIE_VALUE(...);GRANT_PLACE_ANYWHERE(THIS_DICE,...)")
// can find the die without the caller repeating the id.
// ---------------------------------------------------------------------------

function requireOwnDie(state, context, dieId) {
  const player = getPlayer(state, context.playerId);
  const die = player.dice.find((d) => d.id === dieId);
  if (!die) throw new ExecutionError(`${context.playerId} has no die with id ${dieId}`);
  return die;
}

function runSetDiceAny(state, context) {
  if (context.chosenDieId === undefined || context.chosenValue === undefined) {
    return { success: false, reason: 'CHOICE_REQUIRED', need: ['chosenDieId', 'chosenValue (1-6)'] };
  }
  const die = requireOwnDie(state, context, context.chosenDieId);
  die.value = context.chosenValue;
  context.lastTargetedDieId = die.id;
  return { success: true };
}

function runSetDieValue(state, context, cmd) {
  if (context.chosenDieId === undefined || context.chosenValue === undefined) {
    return { success: false, reason: 'CHOICE_REQUIRED', need: ['chosenDieId', `chosenValue (one of ${cmd.choices})`] };
  }
  if (!cmd.choices.includes(context.chosenValue)) {
    return { success: false, reason: 'INVALID_CHOICE', allowed: cmd.choices };
  }
  const die = requireOwnDie(state, context, context.chosenDieId);
  die.value = context.chosenValue;
  context.lastTargetedDieId = die.id;
  return { success: true };
}

function runChangeDieValue(state, context, cmd) {
  if (context.chosenDieId === undefined || context.chosenDelta === undefined) {
    return { success: false, reason: 'CHOICE_REQUIRED', need: ['chosenDieId', `chosenDelta (one of ${cmd.choices})`] };
  }
  if (!cmd.choices.includes(context.chosenDelta)) {
    return { success: false, reason: 'INVALID_CHOICE', allowed: cmd.choices };
  }
  const die = requireOwnDie(state, context, context.chosenDieId);
  die.value = (((die.value - 1 + context.chosenDelta) % 6) + 6) % 6 + 1; // wraps 1..6 (spec: dice values cycle)
  context.lastTargetedDieId = die.id;
  return { success: true };
}

function runGrantPlaceAnywhere(state, context, cmd) {
  const dieId = cmd.target === 'THIS_DICE' ? context.lastTargetedDieId : undefined;
  if (!dieId) return { success: false, reason: 'NO_TARGET_DICE' };
  const die = requireOwnDie(state, context, dieId);
  die.placeAnywhereThisTurn = true;
  return { success: true };
}

/** BLOCK_BUILD(category,THIS_TURN) -- confirmed 2026-08-04: using JOB004's TAP (CHANGE(3K,2BZ)) blocks
 * that player from building a monument for the rest of the turn. Only THIS_TURN scope exists today;
 * board.getBuildCandidates is the single choke point that reads this list, so every BUILD(M) path
 * (AREA action, bare TAP, QST reward) is blocked uniformly with no per-path special-casing. */
function runBlockBuild(state, context, cmd) {
  const player = getPlayer(state, context.playerId);
  if (!player.blockedBuildCategoriesThisTurn.includes(cmd.category)) {
    player.blockedBuildCategoriesThisTurn.push(cmd.category);
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Free actions (confirmed 2026-07-29, corrected 2026-08-02, [[project-dice-wp-dsl-spec]]): A/B/C/Z->K
// and usage-fee collection are NOT DSL/card effects -- they're a fixed mechanic every player can use,
// independent of CONVERT_LIMIT. A/B/C/Z->K have NO usage limit at all (confirmed by the user 2026-08-02:
// "A→K B→K C→K Z→K wD→Kに回数制限ありません", back when wD->2K still existed as a 5th one of these --
// see below) -- repeatable any number of times during the player's own turn, limited only by having the
// resource to pay each time. Usage-fee collection has no limit either (2026-08-06, reversing its earlier
// once-per-round-shared-tap rule -- see collectUsageFee's own doc), gated purely by each map's own
// accumulatedFee instead.
// Their gain side uses grantResource, not grantResourceAndEmitGet (corrected 2026-08-03, per user
// feedback: "JOB ON(GET(K),CHANGE(K,Z)) フリーアクションのA→K等に反応してしまいます...ADD(K)やADD(K,A)
// などにのみ反応するように") -- these free actions specifically don't trigger ON(GET(...),...)
// reactions (otherwise JOB005A's K->Z reaction fired every time a player used the A->K free action, an
// effectively-free extra Z the user judged far too strong). NOTE this narrower scope (2026-08-04): this
// used to also apply to every CHANGE(...) DSL command (see runChange), but that was reverted -- genuine
// CHANGE commands on cards/AREAs (e.g. AREA007's CHANGE((A,B,C),D)) DO fire GET again, only these
// built-in free actions stay silent.
// wD->2K was abolished (2026-08-07, per user request: "wD→２Kのフリーアクション廃止します コードも削除
// してください") -- white dice have no free-action conversion to K anymore (they're still spent via
// card/AREA effects, and still auto-overflow to 2K past the 5-die cap via grantOneDie, an unrelated
// always-on rule this removal doesn't touch).
// ---------------------------------------------------------------------------

const FREE_ACTION_DEFS = {
  A_K: { pay: 'A', payCount: 1, gain: 'K', gainCount: 1 },
  B_K: { pay: 'B', payCount: 1, gain: 'K', gainCount: 1 },
  C_K: { pay: 'C', payCount: 1, gain: 'K', gainCount: 1 },
  Z_K: { pay: 'Z', payCount: 1, gain: 'K', gainCount: 1 },
};

/** @param {string} freeActionId - one of game-state's FREE_ACTION_IDS (fee collection is separate, see collectUsageFee below) */
function tryFreeAction(state, index, playerId, freeActionId) {
  const def = FREE_ACTION_DEFS[freeActionId];
  if (!def) throw new ExecutionError(`Unknown free action: ${freeActionId}`);
  if (!tryPay(state, playerId, def.pay, def.payCount)) {
    return { success: false, reason: 'INSUFFICIENT_RESOURCES' };
  }
  // grantResource, not grantResourceAndEmitGet -- see runChange's matching comment on why free actions
  // (pay-X-get-Y conversions, same as CHANGE) don't trigger ON(GET(...),...) reactions.
  grantResource(state, index, playerId, def.gain, def.gainCount);
  return { success: true };
}

/** Collects a map's accumulated K fee for its owner, as the FEE_COLLECT free action. Unlike the other 5
 * free actions (tryFreeAction, deliberately silent -- see FREE_ACTION_DEFS' comment on JOB005A), fee
 * collection DOES emit GET(K) (corrected 2026-08-04, per user feedback: "使用料回収のフリーアクションで
 * JOB005が反応しなくなりました...これはフリーアクションですが反応するように" -- the user wants this one
 * free action, specifically, to still trigger ON(GET(K),...) reactions like JOB005A's K->Z). No tap/round
 * limit at all (2026-08-06, per user feedback: "使用料回収は未回収の使用料がある限り何回でも使えるように
 * かえてください" -- reverses the previous "once per round, shared across every map" rule; a player who
 * owns 2+ tiered-up AREAs, or whose one AREA re-accrues fee from another placement later the same round,
 * can now collect from each of those in turn). The map.accumulatedFee<=0 check below is what naturally
 * prevents collecting the same not-yet-replenished fee twice, without any separate tap bookkeeping. Needs
 * index/context (not just playerId) purely to reach grantResourceAndEmitGet/emitAndResolve's event-chain
 * machinery -- context only needs playerId, same shape as every other engine entry point. */
function collectUsageFee(state, index, context, mapId) {
  const map = state.maps[mapId];
  if (!map) throw new ExecutionError(`Unknown map: ${mapId}`);
  if (map.feeOwnerId !== context.playerId) return { success: false, reason: 'NOT_FEE_OWNER' };
  if (map.accumulatedFee <= 0) return { success: false, reason: 'NO_FEE_TO_COLLECT' };
  const amount = map.accumulatedFee;
  map.accumulatedFee = 0;
  grantResourceAndEmitGet(state, index, context, 'K', amount);
  return { success: true, amount };
}

/** Untaps every free action for every player. Call once at ROUND end (not per-turn). */
function resetFreeActionsForNewRound(state) {
  for (const player of state.players) {
    for (const id of Object.keys(player.freeActionTaps)) player.freeActionTaps[id] = false;
  }
}

// ---------------------------------------------------------------------------
// Auto/manual mode (confirmed 2026-07-29): current setting only -- the
// auto-fire trigger condition itself is not yet designed, see
// [[project-dice-wp-flow-spec]]. Nothing calls these two yet.
// ---------------------------------------------------------------------------

function isFreeActionAutoMode(state, playerId, freeActionId) {
  return getPlayer(state, playerId).freeActionAutoMode[freeActionId];
}

function setFreeActionAutoMode(state, playerId, freeActionId, isAuto) {
  getPlayer(state, playerId).freeActionAutoMode[freeActionId] = isAuto;
}

/** Card TAP-ability auto/manual: player override if set, else the card's data-sheet AUTO default. */
function isCardAutoMode(state, index, playerId, physicalId) {
  const player = getPlayer(state, playerId);
  if (physicalId in player.cardAutoModeOverrides) return player.cardAutoModeOverrides[physicalId];
  const row = getCardRow(index, state.cards[physicalId].currentFaceId);
  return getCardAutoDefault(row);
}

function setCardAutoMode(state, playerId, physicalId, isAuto) {
  getPlayer(state, playerId).cardAutoModeOverrides[physicalId] = isAuto;
}

const NOT_IMPLEMENTED_TYPES = new Set(['BUILD']);

// Command types that only describe standing PASSIVE/TURNEND rules; they are
// never "run" directly through runCommand -- they're read by
// getPassiveRules()/applyTurnEnd() instead. Reaching here means a caller
// tried to execute one as if it were an immediate action.
const RULE_ONLY_TYPES = new Set([
  'REPLACE_ADD',
  'VP_MODIFIER',
  'CONVERT_LIMIT',
  'UPGRADE_LIMIT',
  'MODIFY_CONVERT_VALUE',
  'RESOURCE_LIMIT',
  'RESOURCE_TOTAL_LIMIT',
  'FORCE_CONVERT',
  'ON',
]);

/**
 * Executes one lowered Command immediately. Use for ONCE effects, TAP
 * activations (plain, non-ON content), and ON-handler effects fired via
 * emit(). Not atomic by itself -- callers running multiple statements from
 * one DSL field should use runProgram(), which snapshots/restores on failure.
 */
function runCommand(state, index, context, cmd) {
  switch (cmd.type) {
    case 'ADD': return runAdd(state, index, context, cmd);
    case 'CHANGE': return runChange(state, index, context, cmd);
    case 'UNTAP': return runUntap(state, context, cmd);
    case 'UNTAP_ALL': return runUntapAll(state, context, cmd);
    case 'SET_CURRENT_AREA': return runSetCurrentArea(state, index, context, cmd);
    case 'SET_DICE_ANY': return runSetDiceAny(state, context);
    case 'SET_DIE_VALUE': return runSetDieValue(state, context, cmd);
    case 'CHANGE_DIE_VALUE': return runChangeDieValue(state, context, cmd);
    case 'GRANT_PLACE_ANYWHERE': return runGrantPlaceAnywhere(state, context, cmd);
    case 'BLOCK_BUILD': return runBlockBuild(state, context, cmd);
    case 'IF':
      return evalCondition(state, index, context.playerId, cmd.condition)
        ? runCommand(state, index, context, cmd.effect)
        : { success: true, skipped: true };
    default:
      if (NOT_IMPLEMENTED_TYPES.has(cmd.type)) {
        throw new NotImplementedError(`${cmd.type} is not implemented yet (needs the board/shop system)`);
      }
      if (RULE_ONLY_TYPES.has(cmd.type)) {
        throw new ExecutionError(`${cmd.type} is a standing rule, not a directly-runnable command`);
      }
      throw new ExecutionError(`Unknown command type: ${cmd.type}`);
  }
}

/**
 * Parses+lowers+runs every statement in a DSL field, atomically: if any
 * statement fails, the whole field's effect is rolled back (checkpoint via
 * structuredClone, mutate the live object back in place).
 *
 * CAUTION: on rollback, state's nested objects (state.players, state.cards,
 * every die, ...) are replaced wholesale with fresh clones -- the top-level
 * `state` reference stays valid, but any reference you grabbed into it
 * beforehand (a `player` or `die` variable, say) goes stale and silently
 * stops reflecting reality. Always re-look-up by id from `state` *after*
 * calling runProgram(), never hold a nested reference across the call.
 */
function runProgram(state, index, context, dslText) {
  if (!dslText) return { success: true };
  const before = structuredClone(state);
  const commands = lowerProgram(parse(dslText));
  for (const cmd of commands) {
    const result = runCommand(state, index, context, cmd);
    if (!result.success) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, before);
      return result;
    }
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// TURNEND
// ---------------------------------------------------------------------------

/** Every currently-active RESOURCE_LIMIT cap this player is under, from their owned cards' TURNEND
 * rules -- {resource: limit}, the MINIMUM limit per resource if more than one owned card caps the same
 * resource (matches applyTurnEnd's own sequential clamping below: applying several RESOURCE_LIMIT rules
 * to the same resource leaves it at whichever limit is smallest, regardless of application order).
 * Read-only, no mutation -- added 2026-08-10 for the AI Evaluator (per user request: "K MAX7の時 1K+7K
 * で8Kになるのは 減らして7Kとして評価" -- score a RESOURCE_LIMIT-capped resource at its true
 * post-TURNEND value, not its raw current count, since the excess is worthless -- it'll just get
 * auto-discarded before the player ever "keeps" it). */
function activeResourceLimits(state, index, playerId) {
  const limits = {};
  for (const { row } of ownedCardRows(state, index, playerId)) {
    if (!row.TURNEND) continue;
    for (const cmd of lowerProgram(parse(row.TURNEND))) {
      if (cmd.type !== 'RESOURCE_LIMIT') continue;
      if (limits[cmd.resource] === undefined || cmd.limit < limits[cmd.resource]) limits[cmd.resource] = cmd.limit;
    }
  }
  return limits;
}

/** Pre-check: RESOURCE_TOTAL_LIMIT rules, and an unpaid usage fee (see PlayerState.pendingFee in
 * game-state.js), block TURNEND entirely until satisfied. */
function canEndTurn(state, index, playerId) {
  const player = getPlayer(state, playerId);
  const violations = [];
  for (const { row } of ownedCardRows(state, index, playerId)) {
    if (!row.TURNEND) continue;
    for (const cmd of lowerProgram(parse(row.TURNEND))) {
      if (cmd.type !== 'RESOURCE_TOTAL_LIMIT') continue;
      const total = cmd.resources.reduce((sum, r) => sum + (player.resources[r] || 0), 0);
      if (total > cmd.limit) violations.push(cmd);
    }
  }
  if (player.pendingFee && (player.resources.K || 0) < player.pendingFee.amount) {
    violations.push({ type: 'USAGE_FEE', ...player.pendingFee });
  }
  return { ok: violations.length === 0, violations };
}

/** Applies RESOURCE_LIMIT (auto-discard) and FORCE_CONVERT rules. Call after canEndTurn().ok is true. */
function applyTurnEnd(state, index, playerId) {
  const player = getPlayer(state, playerId);
  // Usage fee first, before RESOURCE_LIMIT/FORCE_CONVERT below (2026-08-11, per user report on CON001A:
  // "現在　上限7K→使用料を払う　になっています　使用料を払う→上限7K　に直してください"). Paying the fee
  // out of K before RESOURCE_LIMIT auto-discards down to a cap spends that K productively; discarding
  // first (the old order) wasted it instead -- e.g. 10K with CON001A's cap-7 and a 2K fee owed used to
  // discard 3K down to the cap first, then pay the fee out of what was left (7-2=5K final); paying first
  // instead spends 2K toward the fee (10-2=8K), and only then discards down to the cap (8-1=7K final) --
  // 2K less needlessly lost to the discard. canEndTurn() already guaranteed affordability before this
  // ever runs, so this is just the mutation half of that gate-then-mutate pair (same contract as
  // RESOURCE_TOTAL_LIMIT/RESOURCE_LIMIT below).
  if (player.pendingFee) {
    player.resources.K -= player.pendingFee.amount;
    state.maps[player.pendingFee.mapId].accumulatedFee += player.pendingFee.amount;
    player.pendingFee = null;
  }
  for (const { row } of ownedCardRows(state, index, playerId)) {
    if (!row.TURNEND) continue;
    for (const cmd of lowerProgram(parse(row.TURNEND))) {
      if (cmd.type === 'RESOURCE_LIMIT') {
        const have = player.resources[cmd.resource] || 0;
        if (have > cmd.limit) player.resources[cmd.resource] = cmd.limit;
      } else if (cmd.type === 'FORCE_CONVERT') {
        const have = player.resources[cmd.from] || 0;
        if (have <= 0) continue;
        const n = Math.min(cmd.count, have);
        player.resources[cmd.from] -= n;
        player.resources[cmd.to] = (player.resources[cmd.to] || 0) + n;
      } else if (cmd.type === 'RESOURCE_TOTAL_LIMIT' || cmd.type === 'UNTAP') {
        // RESOURCE_TOTAL_LIMIT: handled by canEndTurn() as a gate, not a mutation.
        // UNTAP as TURNEND content (e.g. JOB005A) unconditionally untaps that one card.
        if (cmd.type === 'UNTAP') {
          const physicalId = splitCardId(row.ID).physicalId;
          state.cards[physicalId].tapped = false;
        }
      }
    }
  }
  // GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)'s flag is turn-scoped.
  for (const die of player.dice) die.placeAnywhereThisTurn = false;
  // BZ is turn-scoped too (confirmed: "BZはターン終了時に無くなります") -- any left unspent when this
  // turn ends (e.g. generated via JOB004A's CHANGE(3K,2BZ) but never put toward a BUILD before ending
  // the turn) is lost, not carried into the next turn/round. Not a card-DSL rule (no BZ-granting card's
  // TURNEND says this), so this is a standing rule enforced here directly, same as the
  // GRANT_PLACE_ANYWHERE reset just above.
  player.resources.BZ = 0;
  // BLOCK_BUILD(category,THIS_TURN) is turn-scoped too (see runBlockBuild).
  player.blockedBuildCategoriesThisTurn = [];
}

// ---------------------------------------------------------------------------
// Event bus (ON handlers)
// ---------------------------------------------------------------------------

/** Whether an emitted event's actualValue satisfies an ON(EVENT(args),...)'s own args list. Empty args
 * (e.g. ON(BUILD(),ADD(K)), 2026-08-04 -- JOB002's new TAP, the only card using this so far) means
 * "match any value", the same "categories omitted = all of them" convention BUILD() itself already uses
 * for its own first argument ([[project-dice-wp-dsl-spec]]'s "BUILD()（カテゴリ省略時、確定）") --
 * extended here to event *matching* rather than requiring every card to spell out every category
 * (ON(BUILD(A,B,C,U,M),...)) just to mean "any build". A non-empty args list still requires an exact
 * membership match, unchanged (e.g. ON(BUILD(A,B,C,U),...) still only matches those 4 categories). */
function eventArgsMatch(eventArgs, actualValue) {
  return eventArgs.length === 0 || eventArgs.includes(actualValue);
}

/** Handlers found on a card's TAP/PASSIVE field whose ON(event,...) matches eventName. */
function findOnHandlers(row, fieldName, eventName) {
  const field = row[fieldName];
  if (!field) return [];
  return lowerProgram(parse(field))
    .filter((cmd) => cmd.type === 'ON' && cmd.event.name === eventName);
}

/**
 * Fires eventName for playerId's own cards only (job/passive abilities react
 * to their owner's actions in every example seen so far -- see
 * [[project-dice-wp-dsl-spec]]). PASSIVE-column matches auto-execute
 * immediately; TAP-column matches are returned as available (optional)
 * reactions, gated on the card being untapped, for the caller to offer to
 * the player rather than auto-firing (tapping is a cost the player chooses
 * to pay).
 *
 * @param {string} eventName - e.g. "GET", "PLACE", "BUILD"
 * @param {string} actualValue - the single value that occurred, e.g. "K" for GET(K)
 * @returns {{fired: Object[], availableReactions: {physicalId:string, effect:Object}[]}}
 */
function emit(state, index, playerId, eventName, actualValue, context) {
  const fired = [];
  const availableReactions = [];
  for (const { physicalId, inst, row } of ownedCardRows(state, index, playerId)) {
    for (const cmd of findOnHandlers(row, 'PASSIVE', eventName)) {
      if (!eventArgsMatch(cmd.event.args, actualValue)) continue;
      const result = runCommand(state, index, context, cmd.effect);
      fired.push({ physicalId, cmd, result });
      notifyActivation(state, playerId, physicalId, inst.currentFaceId, 'PASSIVE');
    }
    if (!inst.tapped) {
      for (const cmd of findOnHandlers(row, 'TAP', eventName)) {
        if (!eventArgsMatch(cmd.event.args, actualValue)) continue;
        availableReactions.push({ physicalId, effect: cmd.effect });
      }
    }
  }
  return { fired, availableReactions };
}

// ---------------------------------------------------------------------------
// Activation listener (2026-08-07, for tools/ai_data_report.js's "使用回数" stat only -- see the user's
// spec: "使用回数はTAPがあるJOB ABCカードはTAPした回数です JOB006は発動した回数") -- an optional, opt-in
// hook the AI batch-report tooling registers once per game to count how many times each card's
// PASSIVE/TAP actually fired. Neither is otherwise observable from outside this module: a PASSIVE
// reaction resolves silently inside emit() with no corresponding Move at all (see game-runner.js's
// movesTaken, which only records player-chosen Moves), and a TAP reaction resolved in AUTO mode (see
// emitAndResolve below) likewise produces no discrete Move -- only a player-driven BARE_TAP/TAP_REACTION
// move does, which tools/ai_data_report.js can already read straight off movesTaken without this. Left
// unset (null) by every other caller, including the live human game in main.js (a separate module
// instance entirely, loaded browser-side -- see that file's own doc) -- zero cost, zero behavior change
// when unused.
//
// `state` is passed through to the listener (2026-08-07, corrected after an initial version wildly
// overcounted -- e.g. JOB005 showing 2000+ activations in a single 4-round game): AIPlayer/Simulator
// evaluate candidate moves by running this exact same code against throwaway `cloneState(state)` clones
// (see ai/move-generator.js, ai/simulator.js) purely to score them, then discard the clone -- every one
// of those speculative, never-committed runs was firing this listener too, since emit()/
// resolveTapReaction/useBareTapAbility have no notion of "real vs. simulated". The registered listener
// is expected to compare `state` against the one real GameState object it captured at game start (never
// replaced by reference across a whole game -- even placeDice's own fee-rollback mutates the same object
// in place rather than swapping it, see that function's own doc) and ignore any other. */
let activationListener = null;
function setActivationListener(fn) {
  activationListener = fn;
}
/** @param {'PASSIVE'|'TAP'} kind */
function notifyActivation(state, playerId, physicalId, faceId, kind) {
  if (activationListener) activationListener(state, playerId, physicalId, faceId, kind);
}

/** Player elects to tap physicalId to resolve a previously-offered TAP reaction (see emit()). */
function resolveTapReaction(state, index, context, physicalId, effect) {
  const inst = state.cards[physicalId];
  if (inst.tapped) return { success: false, reason: 'ALREADY_TAPPED' };
  const result = runCommand(state, index, { ...context, sourcePhysicalId: physicalId }, effect);
  if (result.success) {
    inst.tapped = true;
    notifyActivation(state, context.playerId, physicalId, inst.currentFaceId, 'TAP');
  }
  return result;
}

const MAX_EVENT_CHAIN_DEPTH = 8;
let pendingChoiceCounter = 0;
function nextPendingChoiceId() {
  pendingChoiceCounter += 1;
  return `pending${pendingChoiceCounter}`;
}

/**
 * emit() + automatic resolution: PASSIVE matches already auto-fire inside
 * emit(). For TAP matches, this additionally resolves auto-mode reactions
 * immediately (isCardAutoMode) and queues manual-mode ones as a
 * TAP_REACTION_AVAILABLE pendingChoice for the player/UI to resolve later
 * via resolveTapReaction(). Guards against DSL cycles (e.g. a hypothetical
 * ON(GET(K),ADD(K))) with a depth cap, since auto-resolution can itself
 * grant resources that emit further events.
 */
function emitAndResolve(state, index, context, eventName, actualValue) {
  const depth = context.emitDepth || 0;
  if (depth > MAX_EVENT_CHAIN_DEPTH) {
    throw new ExecutionError(`Event chain too deep while emitting ${eventName}(${actualValue}) -- possible DSL cycle`);
  }
  const childContext = { ...context, emitDepth: depth + 1 };
  const { fired, availableReactions } = emit(state, index, context.playerId, eventName, actualValue, childContext);
  for (const reaction of availableReactions) {
    if (isCardAutoMode(state, index, context.playerId, reaction.physicalId)) {
      resolveTapReaction(state, index, childContext, reaction.physicalId, reaction.effect);
    } else {
      state.pendingChoices.push({
        id: nextPendingChoiceId(),
        playerId: context.playerId,
        kind: 'TAP_REACTION_AVAILABLE',
        context: { physicalId: reaction.physicalId, effect: reaction.effect, eventName, actualValue },
      });
    }
  }
  return { fired, availableReactions };
}

/** grantResource() + automatically emits/resolves the resulting GET event (see emitAndResolve). Dice
 * (D/wD) emit one GET *per die* rather than once for the whole grant (2026-08-06, per user report:
 * JOB006's ON(GET(D),ADD(Z));ON(GET(wD),ADD(K)) only fired once when e.g. B004A's ONCE=ADD(2wD) granted
 * 2 dice at once, instead of twice -- "それぞれ発動...2回発動するようにしてください"). Each die is
 * already its own discrete object internally (grantResource's own dice loop rolls each one separately),
 * so this just extends that same "one per die" treatment to the event it triggers -- mirrors
 * board.placeDiceGroup's own PLACE(mapId), which likewise emits once per die in a multi-die placement
 * rather than once for the whole group. Plain resources (K/A/B/C/Z/VP/BZ) are unaffected -- still one
 * GET regardless of count, matching every other card that reacts to those (e.g. JOB005A's
 * ON(GET(K),CHANGE(K,Z))), which was never part of this report. */
function grantResourceAndEmitGet(state, index, context, resource, count) {
  const effectiveResource = grantResource(state, index, context.playerId, resource, count);
  if (count > 0) {
    if (DICE_KIND_BY_RESOURCE[effectiveResource]) {
      for (let i = 0; i < count; i++) emitAndResolve(state, index, context, 'GET', effectiveResource);
    } else {
      emitAndResolve(state, index, context, 'GET', effectiveResource);
    }
  }
  return effectiveResource;
}

module.exports = {
  NotImplementedError,
  ExecutionError,
  runCommand,
  runProgram,
  evalCondition,
  evalMetric,
  getPassiveRules,
  activePassiveCommands,
  collectVpModifiers,
  activeResourceLimits,
  canEndTurn,
  applyTurnEnd,
  emit,
  emitAndResolve,
  resolveTapReaction,
  setActivationListener,
  notifyActivation,
  grantResource,
  grantResourceAndEmitGet,
  payCostList,
  applyBzDiscount,
  enumerateBzOutcomes,
  resolvePayment,
  hasPaymentChoiceAbility,
  ownedCardRows,
  tryFreeAction,
  collectUsageFee,
  resetFreeActionsForNewRound,
  isFreeActionAutoMode,
  setFreeActionAutoMode,
  isCardAutoMode,
  setCardAutoMode,
};

})();
