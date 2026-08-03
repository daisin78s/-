(function () {
/**
 * Loads the normalized runtime data (data/game.json) and indexes it by card
 * ID for fast lookup. This is a minimal stand-in for the eventual
 * IDataProvider abstraction (JsonDataProvider) described in the project
 * architecture notes -- swapping the source format later should only mean
 * writing a different loadGameData(), not touching callers.
 */

'use strict';

const { splitCardId } = require('./game-state');

const CARD_SHEETS = ['A', 'B', 'C', 'CON', 'JOB', 'M', 'RESOURCE'];

/**
 * Node (tests/tools): pass a file path, read via fs. Browser (main.js, confirmed 2026-07-30): pass
 * the already-parsed data object directly (e.g. window.GAME_DATA, embedded by
 * tools/xlsx_to_json.py's data/game.data.js output -- fs/fetch aren't usable from a file:// page).
 * 'fs' is required lazily, only on the Node path, so this file has no top-level Node-only dependency
 * and can load under the browser's require() shim without needing to know about 'fs' at all.
 * @param {string|Object} source - file path (Node) or pre-parsed data (browser)
 * @returns {Object} raw sheet-name -> row[] data, as produced by tools/xlsx_to_json.py
 */
function loadGameData(source) {
  if (typeof source === 'object' && source !== null) return source;
  const fs = require('fs');
  return JSON.parse(fs.readFileSync(source, 'utf-8'));
}

/**
 * @typedef {Object} DataIndex
 * @property {Object} raw               - the raw sheet data (data/game.json contents)
 * @property {Map<string, {sheet:string, row:Object}>} byId - every card-bearing row, keyed by its ID column
 */

/**
 * @param {Object} rawData
 * @returns {DataIndex}
 */
function buildDataIndex(rawData) {
  const byId = new Map();
  for (const sheet of CARD_SHEETS) {
    for (const row of rawData[sheet] || []) {
      byId.set(row.ID, { sheet, row });
    }
  }
  return { raw: rawData, byId };
}

/**
 * @param {DataIndex} index
 * @param {string} cardId - a face ID, e.g. "A001A"
 * @returns {Object} the data-sheet row
 */
function getCardRow(index, cardId) {
  const entry = index.byId.get(cardId);
  if (!entry) throw new Error(`Unknown card ID: ${cardId}`);
  return entry.row;
}

/**
 * Finds the sibling row for the given tier of the same physical card, or
 * null if it doesn't exist (e.g. tier 'B' of a card that has no back side).
 * @param {DataIndex} index
 * @param {string} physicalId - e.g. "A001"
 * @param {string} tier       - e.g. "B"
 * @returns {Object|null}
 */
function findCardFace(index, physicalId, tier) {
  const entry = index.byId.get(`${physicalId}${tier}`);
  return entry ? entry.row : null;
}

/**
 * The data-sheet default for a card's TAP-ability auto/manual setting
 * (game.xlsx's AUTO column, confirmed 2026-07-29). Returns null for cards
 * with no TAP ability at all (AUTO column absent or blank), in which case
 * the question doesn't apply.
 * @param {Object} row - a card data-sheet row
 * @returns {boolean|null}
 */
function getCardAutoDefault(row) {
  if (row.AUTO === 'A') return true;
  if (row.AUTO === 'M') return false;
  return null;
}

/**
 * @param {DataIndex} index
 * @param {string} mapId - e.g. "MAP003"
 * @returns {Object}
 */
function getMapRow(index, mapId) {
  const row = (index.raw.MAP || []).find((r) => r.ID === mapId);
  if (!row) throw new Error(`Unknown map ID: ${mapId}`);
  return row;
}

/**
 * @param {DataIndex} index
 * @param {string} areaId - e.g. "AREA003B"
 * @returns {Object}
 */
function getAreaRow(index, areaId) {
  const row = (index.raw.AREA || []).find((r) => r.ID === areaId);
  if (!row) throw new Error(`Unknown area ID: ${areaId}`);
  return row;
}

/**
 * @param {DataIndex} index
 * @param {string} shopId - a SHOP-sheet position ID, e.g. "SHOP101"
 * @returns {Object}
 */
function getShopRow(index, shopId) {
  const row = (index.raw.SHOP || []).find((r) => r.ID === shopId);
  if (!row) throw new Error(`Unknown shop position ID: ${shopId}`);
  return row;
}

/**
 * QST rows aren't in byId (confirmed 2026-07-30): unlike A/B/C/CON/JOB/M, a QST card is never
 * "owned" via GameState.cards -- it's revealed board state (see GameState.quests), same category as
 * MAP/AREA/SHOP rows, so it gets its own lookup rather than sharing the card-ownership index.
 * @param {DataIndex} index
 * @param {string} qstId - a QST-sheet face ID, e.g. "Q002B"
 * @returns {Object}
 */
function getQstRow(index, qstId) {
  const row = (index.raw.QST || []).find((r) => r.ID === qstId);
  if (!row) throw new Error(`Unknown QST ID: ${qstId}`);
  return row;
}

module.exports = {
  loadGameData,
  buildDataIndex,
  getCardRow,
  findCardFace,
  getCardAutoDefault,
  getMapRow,
  getAreaRow,
  getShopRow,
  getQstRow,
  splitCardId,
};

})();
