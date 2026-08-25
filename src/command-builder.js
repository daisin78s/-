(function () {
/**
 * Lowers a dsl-parser AST (see src/dsl-parser.js) into flat "Command" objects
 * the Executor can run without re-inspecting AST shapes. One DSL field (e.g.
 * a card's ONCE text) parses to a Program with several statements; each
 * statement lowers to one Command via lowerStatement().
 *
 * This module only restructures data -- it never touches GameState and never
 * validates game-rule legality (insufficient resources, tap state, etc.);
 * that is the Executor's job.
 */

'use strict';

const { parseArgList } = require('./dsl-parser');

class CommandBuildError extends Error {}

function identLikeName(node) {
  if (node.type === 'Ident') return node.name;
  throw new CommandBuildError(`Expected a plain identifier, got ${node.type}`);
}

function numberValue(node) {
  if (node.type === 'Number') return node.value;
  throw new CommandBuildError(`Expected a number, got ${node.type}`);
}

/** Number node -> {kind:'literal', value}; anything else -> {kind:'expr', node} (evaluated at run time, e.g. COUNT(天)*wD). */
function lowerCount(node) {
  if (!node) return { kind: 'literal', value: 1 };
  if (node.type === 'Number') return { kind: 'literal', value: node.value };
  return { kind: 'expr', node };
}

/** Group/Quantity/Ident -> flat list of {resource, count}. Used by ADD items and CHANGE's pay/gain sides. */
function lowerResourceList(node) {
  if (node.type === 'Group') return node.items.flatMap(lowerResourceList);
  if (node.type === 'Quantity') return [{ resource: identLikeName(node.resource), count: lowerCount(node.count) }];
  if (node.type === 'Ident') return [{ resource: node.name, count: { kind: 'literal', value: 1 } }];
  throw new CommandBuildError(`Cannot use ${node.type} as a resource reference`);
}

function isAllIdent(node) {
  return node.type === 'Ident' && node.name === 'ALL' && !node.choices && node.plusMinus === undefined;
}

/** Group -> names of its items; single Ident -> [name]. */
function lowerNameList(node) {
  if (node.type === 'Group') return node.items.map(identLikeName);
  return [identLikeName(node)];
}

/** IF's left-hand side: a bare metric name (CARD_COUNT) or a call (LEVEL_COUNT(1), COUNT(天)). */
function lowerMetric(node) {
  if (node.type === 'Ident') return { name: node.name, args: [] };
  if (node.type === 'Call') {
    return {
      name: node.name,
      args: node.args.map((a) => (a.type === 'Number' ? a.value : identLikeName(a))),
    };
  }
  throw new CommandBuildError(`Cannot use ${node.type} as a condition metric`);
}

function lowerCondition(node) {
  if (node.type !== 'Comparison') {
    throw new CommandBuildError(`IF condition must be a comparison, got ${node.type}`);
  }
  return { metric: lowerMetric(node.left), op: node.op, value: numberValue(node.right) };
}

function lowerChange(args) {
  const [payNode, gainNode, timesNode] = args;
  const pay = lowerResourceList(payNode);
  const gain = lowerResourceList(gainNode);
  let times;
  if (!timesNode) times = { kind: 'literal', value: 1 };
  else if (isAllIdent(timesNode)) times = { kind: 'all' };
  // An explicit numeric third argument (e.g. CHANGE(K,A,2), C001A's TAP) is 'capped', not 'literal'
  // (2026-08-11, see executor.js's runChange for the full rationale): it executes up to that many times,
  // scaled down to whatever's affordable, rather than requiring the full amount or doing nothing at all.
  // 'literal' (value always 1) is reserved for CHANGE's implicit no-third-argument default.
  else times = { kind: 'capped', value: numberValue(timesNode) };
  return { type: 'CHANGE', pay, gain, times };
}

function lowerOn(node) {
  const [eventNode, effectNode] = node.args;
  if (eventNode.type !== 'Call') {
    throw new CommandBuildError(`ON's first argument must be an event call, got ${eventNode.type}`);
  }
  const event = { name: eventNode.name, args: eventNode.args.map(identLikeName) };
  const effect = lowerCall(effectNode);
  return { type: 'ON', event, effect };
}

function lowerBuild(node) {
  const [categoriesNode, buildValueNode] = node.args;
  const categories = categoriesNode ? lowerNameList(categoriesNode) : ['A', 'B', 'C', 'U', 'M'];
  const buildValue = buildValueNode ? numberValue(buildValueNode) : null;
  return { type: 'BUILD', categories, buildValue };
}

function lowerSetDieValue(node) {
  const target = node.args[0];
  return { type: 'SET_DIE_VALUE', scope: identLikeName(target), choices: target.choices || [] };
}

/** Extracts {scope, delta} from a bare 'SELF+N'/'SELF-N' argument node -- dsl-parser has no direct
 * "IDENT+NUMBER" suffix grammar (only 'IDENT2|3' pipe-lists and 'IDENT±N', see ident_suffix in this
 * file's own header doc), so this instead parses via the general arith_tail rule into a
 * BinaryOp(op:'+'|'-', left:Ident, right:Number), same as e.g. "COUNT(天)-1" elsewhere. Shared by
 * lowerChangeDieValue's own bare-delta branch (2026-08-25, per user edit to 運命の導き: dropped its old
 * ±1 choice for a fixed +2) and lowerMonumentChangeDieValue (2026-08-24, JOB007/宮廷人's TAP). */
function identPlusOffset(target, fnName) {
  if (target.type !== 'BinaryOp' || target.left.type !== 'Ident') {
    throw new CommandBuildError(`${fnName} expects SELF±N or SELF+N/SELF-N, got a ${target.type}`);
  }
  const magnitude = numberValue(target.right);
  return { scope: identLikeName(target.left), delta: target.op === '-' ? -magnitude : magnitude };
}

function lowerChangeDieValue(node) {
  const target = node.args[0];
  // '±N' means the player picks one of +N or -N, same "player picks one of these" shape as
  // SET_DIE_VALUE's pipe-separated choices -- reuse the 'choices' field for that reason.
  if (target.plusMinus !== undefined) {
    return { type: 'CHANGE_DIE_VALUE', scope: identLikeName(target), choices: [target.plusMinus, -target.plusMinus] };
  }
  // Bare 'SELF+N'/'SELF-N' (2026-08-25) -- a single FIXED delta, no player choice of sign/magnitude at
  // all (unlike '±N', where it's genuinely a 2-way pick). Reuses the same 'choices' shape as the ±N case
  // but with exactly one element, so every existing consumer (executor.runChangeDieValue/
  // runChangeCardBuildValue's own cmd.choices.includes check, and main.js's value-picker UI, which
  // already renders one button per choice) keeps working unchanged -- a "choice" of exactly one option
  // is still a valid choice, just with nothing else to pick alongside it.
  const { scope, delta } = identPlusOffset(target, 'CHANGE_DIE_VALUE');
  return { type: 'CHANGE_DIE_VALUE', scope, choices: [delta] };
}

/** MONUMENT_CHANGE_DIE_VALUE(SELF+2) (2026-08-24, JOB007/宮廷人's revised TAP, replacing
 * MONUMENT_DICE_DISCOUNT entirely: "このターン自分のダイス目1個を+2する"). Same underlying mechanic as
 * CHANGE_DIE_VALUE (executor.runMonumentChangeDieValue reuses runChangeDieValue's own no-wrap math and
 * markDieValueChanged/applyTurnEnd revert-if-unplaced behavior, confirmed with the user), but the delta
 * is a single FIXED signed number, not a player-chosen ±N pair -- so unlike CHANGE_DIE_VALUE's `choices`
 * array, this only ever needs context.chosenDieId, never a chosenDelta choice. See identPlusOffset's own
 * doc for how the bare "SELF+N" argument shape is parsed. */
function lowerMonumentChangeDieValue(node) {
  const { scope, delta } = identPlusOffset(node.args[0], 'MONUMENT_CHANGE_DIE_VALUE');
  return { type: 'MONUMENT_CHANGE_DIE_VALUE', scope, delta };
}

function lowerCall(node) {
  switch (node.name) {
    case 'ADD':
      return { type: 'ADD', items: node.args.flatMap(lowerResourceList) };
    // PAY(2K) (2026-08-17, per user spec, JOB010/革命家: "TAPして2〇を支払い、カードを１枚選んでLVアップ
    // する") -- a flat cost with no gain side, unlike CHANGE which always pays into something. Added
    // specifically so a TAP field can gate a BUILD(...) behind an extra flat cost (e.g.
    // "PAY(2K);BUILD(U)") while leaving the built/upgraded card's own COST to be paid normally and
    // separately -- see board.resolveProgramOrBuild's own doc for how a leading PAY is run immediately,
    // before the BUILD candidate list is even computed.
    case 'PAY':
      return { type: 'PAY', items: node.args.flatMap(lowerResourceList) };
    case 'CHANGE':
      return lowerChange(node.args);
    case 'BUILD':
      return lowerBuild(node);
    case 'UNTAP':
      return { type: 'UNTAP' };
    case 'UNTAP_ALL':
      return { type: 'UNTAP_ALL', scope: identLikeName(node.args[0]) };
    // UNTAP_CHOICE(SELF,3) (2026-08-15, per user spec, added to what were then C004B/C005B/C006B/C007B/
    // C008A/C008B -- "すべてをアンタップにするを、自分のカード3枚をアンタップにするに変更"): untaps up to
    // `count` of the player's own currently-tapped cards. No card in the current data carries this DSL
    // any more -- the 2026-08-24 "C card ability rework" + "C008A/C008B revert to UNTAP_ALL(SELF)"
    // commits moved every one of those cards off it (back to UNTAP_ALL(SELF) or a different ability
    // entirely) -- but the parser support stays for whenever a future card wants it again. If they have
    // `count` or
    // fewer tapped cards, all of them untap automatically (see executor.runUntapChoice) -- no choice to
    // make. If they have more than `count`, the player manually picks exactly `count` of them (a new
    // UNTAP_CHOICE pendingChoice, resolved via executor.resolveUntapChoice, same shape as setup.
    // chooseResourceCards' SELECT_RESOURCE_CARDS choice). scope is always SELF in the current data but
    // kept as an explicit arg (matching UNTAP_ALL's own shape) rather than hardcoded, in case a future
    // card ever wants this to reach beyond the player's own cards.
    case 'UNTAP_CHOICE':
      return { type: 'UNTAP_CHOICE', scope: identLikeName(node.args[0]), count: numberValue(node.args[1]) };
    case 'REPLACE_ADD':
      return { type: 'REPLACE_ADD', from: identLikeName(node.args[0]), to: identLikeName(node.args[1]) };
    case 'RESOURCE_LIMIT':
      return { type: 'RESOURCE_LIMIT', resource: identLikeName(node.args[0]), limit: numberValue(node.args[1]) };
    case 'RESOURCE_TOTAL_LIMIT':
      return {
        type: 'RESOURCE_TOTAL_LIMIT',
        resources: lowerNameList(node.args[0]),
        limit: numberValue(node.args[1]),
      };
    case 'FORCE_CONVERT':
      return {
        type: 'FORCE_CONVERT',
        from: identLikeName(node.args[0]),
        to: identLikeName(node.args[1]),
        count: numberValue(node.args[2]),
      };
    case 'VP_MODIFIER':
      // count supports a dynamic expression (e.g. VP_MODIFIER(COUNT(天)), confirmed 2026-08-12) same
      // as ADD's item counts -- see lowerCount's own doc. A literal like VP_MODIFIER(-2) still lowers
      // to {kind:'literal', value:-2} exactly as before.
      return { type: 'VP_MODIFIER', count: lowerCount(node.args[0]) };
    // VP_PENALTY_IF_BELOW(metric,threshold) -- the general "○○が必要" shortfall rule (2026-08-15, per
    // user spec: "ゲーム終了時○○が必要　足りない１個につき-1VP"): -1VP per unit metric falls short of
    // threshold, 0 once at/above it (see executor.collectVpModifiers). metric reuses the same bare-
    // metric grammar IF's own condition uses (see lowerMetric), so any existing/future evalMetric case
    // (RESOURCE(A,B,C,Z), EMBLEM_COUNT(天,M), ...) works here with no extra plumbing.
    case 'VP_PENALTY_IF_BELOW':
      return { type: 'VP_PENALTY_IF_BELOW', metric: lowerMetric(node.args[0]), threshold: numberValue(node.args[1]) };
    // VP_PENALTY_PER(metric) -- a flat per-unit penalty (2026-08-15, per user spec on CON005A: "LV1の
    // カード１枚につき-1VP", correcting the card's original flat IF(LEVEL_COUNT(1)>=1,VP_MODIFIER(-2))
    // "any at all -> -2" threshold shape to scale with the count instead): -1VP for every unit of
    // metric, 0 if metric is 0. No threshold arg, unlike VP_PENALTY_IF_BELOW -- every unit counts, not
    // just the ones short of some minimum.
    case 'VP_PENALTY_PER':
      return { type: 'VP_PENALTY_PER', metric: lowerMetric(node.args[0]) };
    case 'CONVERT_LIMIT':
      return { type: 'CONVERT_LIMIT', scope: identLikeName(node.args[0]), limit: numberValue(node.args[1]) };
    case 'UPGRADE_LIMIT':
      return { type: 'UPGRADE_LIMIT', limit: numberValue(node.args[0]) };
    // BLOCK_UPGRADE_UNLESS_QST_RANK(questFaceId,rank) -- CON004A (2026-08-13, per user spec: "QSTカード
    // Q004Aで1位でなければLVUPできない"): always checked against questFaceId's GOAL, whether or not that
    // exact face is actually revealed this game (see board.isUpgradeBlockedByQstRank), so PASSIVE just
    // carries the raw face id + required rank -- no state-dependent branching belongs at lowering time.
    case 'BLOCK_UPGRADE_UNLESS_QST_RANK':
      return { type: 'BLOCK_UPGRADE_UNLESS_QST_RANK', questFaceId: identLikeName(node.args[0]), rank: numberValue(node.args[1]) };
    // BLOCK_COLOR_DIE_REUSE() -- CON006A (2026-08-15, per user spec: "自分のカラーDが置かれているAREAには
    // 別のカラーDを配置できない"): once this player already has one of their own COLOR dice (not wD) sitting
    // on a map/AREA from an earlier placement action, they can't place another COLOR die there. Confirmed
    // scope: a single group-placement action (board.placeDiceGroup, e.g. stacking multiple own COLOR dice
    // at 王宮/AREA009 to sum values) is exempt -- the rule only looks at what was already on the map
    // *before* the current action started, never at dice this same action is placing. Also waived by
    // GRANT_PLACE_ANYWHERE (placeAnywhereThisTurn), unlike DUPLICATE_VALUE_IN_AREA which is never waived --
    // confirmed distinct from that rule on purpose. No args -- always evaluated against "this player's own
    // COLOR dice on this map", nothing to parameterize. CON006A's original second restriction
    // ("自発的なパスができない", can't voluntarily pass) was deferred and has since been replaced entirely
    // by PASS_COLOR_DIE_BONUS below (2026-08-15 card-text revision) -- not implemented at all now.
    case 'BLOCK_COLOR_DIE_REUSE':
      return { type: 'BLOCK_COLOR_DIE_REUSE' };
    // WILDCARD_DICE() -- JOB003 (2026-08-19, replacing its old SET_DICE_ANY TAP ability entirely, per
    // user spec): while owned, ALL of this player's dice (COLOR and WHITE alike) become "☆" wildcard
    // dice -- ignore a slot's numbered/ANY value requirement, auto-placed by the engine (left-packed
    // into empty non-EX slots, falling back to stacking under the leftmost slot when all non-EX slots
    // are full -- see board.placeWildcardDie), exempt from DUPLICATE_VALUE_IN_AREA and from
    // BLOCK_COLOR_DIE_REUSE (CON005B/憤怒). No args -- purely an on/off flag, like BLOCK_COLOR_DIE_REUSE
    // above.
    case 'WILDCARD_DICE':
      return { type: 'WILDCARD_DICE' };
    // PASS_COLOR_DIE_BONUS(amount) -- CON006A's revised second restriction. Originally a flat block
    // (2026-08-15: "パスをしたとき色Dから3K得られない", 0 instead of the normal 3), corrected after
    // playtesting to a reduced amount instead of a full block (2026-08-16: "パスをしたとき色Dから2Kしか
    // 得られない" -- "ラウンドパスでもらえるKを0→2に変更"): turn-flow.endRound's own "unused color die ->
    // 3K" grant (every still-unplaced COLOR die at round end, whether truly untouched or explicitly
    // passed -- see board.passDie's own doc for why those two cases are already unified under
    // placedMapId===null) uses `amount` instead of 3 for this player. Takes the override amount as an
    // explicit arg (rather than a bare on/off flag) precisely because this number has already been
    // retuned once after real play -- 0 still works the same way (amount=0), no special-casing needed.
    case 'PASS_COLOR_DIE_BONUS':
      return { type: 'PASS_COLOR_DIE_BONUS', amount: numberValue(node.args[0]) };
    // WHITE_DICE_CAP(n) (2026-08-18, CON005B/憤怒's revised second restriction, replacing
    // PASS_COLOR_DIE_BONUS(2) after further playtesting: "パスをしたときカラーダイスから2Kしか得られない"
    // -> "ｗDの上限0　上限を超えたｗDは2Kになる") -- overrides this player's own whiteDiceCap (normally a
    // fixed 5 for everyone, see game-state.js's own doc on why that field is never literally mutated) for
    // executor.grantOneDie's WHITE-kind overflow check ("count < cap ? real wD : +2K"), same dynamically-
    // queried PASSIVE-rule pattern as REPLACE_ADD/PASS_COLOR_DIE_BONUS rather than a one-time field write.
    // n=0 means every wD grant overflows to 2K unconditionally (0 is never > an in-hand count of >=0), but
    // takes an explicit amount (not a bare flag) in case a future card needs a smaller-than-5, non-zero cap.
    case 'WHITE_DICE_CAP':
      return { type: 'WHITE_DICE_CAP', amount: numberValue(node.args[0]) };
    case 'MODIFY_CONVERT_VALUE':
      return {
        type: 'MODIFY_CONVERT_VALUE',
        scope1: identLikeName(node.args[0]),
        scope2: identLikeName(node.args[1]),
        delta: numberValue(node.args[2]),
      };
    case 'IF':
      return { type: 'IF', condition: lowerCondition(node.args[0]), effect: lowerCall(node.args[1]) };
    case 'ON':
      return lowerOn(node);
    case 'SET_DICE_ANY':
      return { type: 'SET_DICE_ANY' };
    case 'SET_DIE_VALUE':
      return lowerSetDieValue(node);
    case 'CHANGE_DIE_VALUE':
      return lowerChangeDieValue(node);
    case 'MONUMENT_CHANGE_DIE_VALUE':
      return lowerMonumentChangeDieValue(node);
    case 'GRANT_PLACE_ANYWHERE':
      return {
        type: 'GRANT_PLACE_ANYWHERE',
        target: identLikeName(node.args[0]),
        duration: identLikeName(node.args[1]),
      };
    case 'BLOCK_BUILD':
      return {
        type: 'BLOCK_BUILD',
        category: identLikeName(node.args[0]),
        duration: identLikeName(node.args[1]),
      };
    // MONUMENT_DICE_DISCOUNT(n,THIS_TURN) (2026-08-18, JOB007/密使's revised TAP, per user request: add
    // "モニュメントの必要ダイスを2下げる" as a new middle line between the existing BZ grant and the
    // A/B/C build block). Only THIS_TURN scope exists today, same as BLOCK_BUILD -- see
    // executor.runMonumentDiceDiscount's own doc for how the amount is applied/cleared.
    case 'MONUMENT_DICE_DISCOUNT':
      return {
        type: 'MONUMENT_DICE_DISCOUNT',
        amount: numberValue(node.args[0]),
        duration: identLikeName(node.args[1]),
      };
    default:
      throw new CommandBuildError(`Unknown DSL function: ${node.name}`);
  }
}

/** Lowers one top-level statement (Call or Assignment) from a Program's statements array. */
function lowerStatement(node) {
  if (node.type === 'Assignment') {
    return { type: 'SET_CURRENT_AREA', mapId: node.path[0], value: node.value };
  }
  if (node.type === 'Call') return lowerCall(node);
  throw new CommandBuildError(`Cannot lower top-level statement of type ${node.type}`);
}

/** @param {{type:'Program', statements:Object[]}} program */
function lowerProgram(program) {
  return program.statements.map(lowerStatement);
}

/**
 * Lowers a data-sheet COST column string (e.g. "2A,2B,2C") into a flat
 * {resource, count} list with plain numeric counts. Unlike ADD/CHANGE items,
 * COST never contains a dynamic expression count (no "COUNT(x)*wD" form in
 * any COST cell), so this unwraps straight to a number rather than the
 * {kind,value} shape lowerResourceList produces -- payCostList expects
 * plain numbers.
 */
function lowerCostList(costString) {
  if (!costString) return [];
  return parseArgList(costString)
    .flatMap(lowerResourceList)
    .map((item) => {
      if (item.count.kind !== 'literal') {
        throw new CommandBuildError(`COST column cannot use a dynamic count: "${costString}"`);
      }
      return { resource: item.resource, count: item.count.value };
    });
}

module.exports = {
  CommandBuildError,
  lowerProgram,
  lowerStatement,
  lowerCall,
  lowerCondition,
  lowerMetric,
  lowerCostList,
};

})();
