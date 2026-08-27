(function () {
'use strict';

/**
 * "AI LV4" smart onboarding policy -- hand-authored domain knowledge (game.xlsx's 評価値_2/評価値_3
 * sheets) driving the onboarding decisions the ordinary random-onboarding AI (LV1-3, see
 * game-runner.js's own doc on why RESOURCE/CON/JOB stay random there) never bothered with. Only
 * resource-card selection is implemented so far (2026-08-27); CON/JOB selection are a planned follow-up
 * -- see this file's own git history once added.
 *
 * Design (agreed with the user, 2026-08-27): "基本的には資源カードは数字の大きい2枚をとります ただし
 * 自分の持っているCONの片面と相性の悪い初期資源はマイナス評価します 逆に自分の持っているCONや見えている
 * JOBと相性のいいカードはプラス評価します" -- the "数字" is each RESOURCE card's own START_ORDER (a
 * plain data field, not a computed eval-table score -- confirmed 2026-08-27), adjusted by summing
 * 評価値_3's synergy value for every name relevant to this pick: both faces of the player's own dealt CON
 * (confirmed: a penalty applies if EITHER face clashes, not just the one that ends up chosen later) plus
 * every JOB currently visible in state.jobPool. The adjustment is added directly onto START_ORDER itself
 * (confirmed via a worked example: "先行順6のカードが-2だったら4扱い"), not treated as a mere tie-break,
 * so a strong enough synergy can outrank a card that would otherwise win on raw START_ORDER alone. Ties
 * (equal effective order) fall back to ascending numeric ID, matching the original random-pick code's own
 * tie-shape (deterministic, not random) now that this path is no longer randomized at all.
 *
 * Requires state.jobPool to already be populated (setup.dealJobPool) -- per user confirmation, real
 * physical play already reveals the JOB pool before resource cards are chosen (main.js's own setup order
 * already does this correctly; only game-runner.js's Node-only AI driver had this backwards -- see its
 * own fix alongside this file).
 */

const { getCardRow } = require('../data-loader');
const { synergyValue } = require('./resource-card-synergy');

function numericIdSuffix(id) {
  return Number(String(id).replace(/^[A-Z]+/, ''));
}

/**
 * @param {string[]} candidateIds - the 5 dealt RESOURCE card ids for this player.
 * @param {GameState} state - state.jobPool must already be populated.
 * @param {DataIndex} index
 * @param {Object} synergyTable - see resource-card-synergy.js's buildResourceSynergyTable.
 * @param {string} conPhysicalId - the player's own dealt CON card (e.g. "CON002").
 * @returns {string[]} the 2 ids to keep, best-first.
 */
function pickResourceCards(candidateIds, state, index, synergyTable, conPhysicalId) {
  const conFaceNames = ['A', 'B']
    .map((face) => {
      try { return getCardRow(index, `${conPhysicalId}${face}`).NAME; } catch (e) { return null; }
    })
    .filter(Boolean);
  const jobNames = (state.jobPool || []).map((jobId) => getCardRow(index, jobId).NAME);
  const relevantNames = [...conFaceNames, ...jobNames];

  const scored = candidateIds.map((id) => {
    const row = getCardRow(index, id);
    const synergy = relevantNames.reduce((sum, name) => sum + synergyValue(synergyTable, name, row.ONCE), 0);
    const baseOrder = typeof row.START_ORDER === 'number' ? row.START_ORDER : 0;
    return { id, effectiveOrder: baseOrder + synergy };
  });

  scored.sort((a, b) => b.effectiveOrder - a.effectiveOrder || numericIdSuffix(a.id) - numericIdSuffix(b.id));
  return scored.slice(0, 2).map((s) => s.id);
}

module.exports = { pickResourceCards };

})();
