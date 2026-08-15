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

function lowerChangeDieValue(node) {
  const target = node.args[0];
  // '±N' means the player picks one of +N or -N, same "player picks one of these" shape as
  // SET_DIE_VALUE's pipe-separated choices -- reuse the 'choices' field for that reason.
  return { type: 'CHANGE_DIE_VALUE', scope: identLikeName(target), choices: [target.plusMinus, -target.plusMinus] };
}

function lowerCall(node) {
  switch (node.name) {
    case 'ADD':
      return { type: 'ADD', items: node.args.flatMap(lowerResourceList) };
    case 'CHANGE':
      return lowerChange(node.args);
    case 'BUILD':
      return lowerBuild(node);
    case 'UNTAP':
      return { type: 'UNTAP' };
    case 'UNTAP_ALL':
      return { type: 'UNTAP_ALL', scope: identLikeName(node.args[0]) };
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
