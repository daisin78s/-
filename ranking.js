/** Persistence layer for the all-time human-player ranking (2026-08-16, per user request: "ランキング
 * とは人間対AIで歴代の得点を最高得点順に並べるもの"). Plain classic <script> like main.js -- not run
 * through the CommonJS shim and not loaded under Node tests, since localStorage/IndexedDB don't exist
 * there; this file is browser-only and knows nothing about GameState/DSL/etc, only about storing and
 * retrieving plain data main.js hands it. Exposes window.RankingStorage.
 *
 * Two storage engines on purpose: the ranking list itself (name/score breakdown/CON/JOB/opponents) is
 * tiny and needs synchronous-feeling reads for rendering, so it lives in localStorage. A full replay
 * (one structuredClone'd GameState per move, easily 100+ entries for a 4-round game) can run into the
 * multi-MB range -- localStorage's ~5-10MB origin quota would only hold a couple of those, so replay
 * blobs go in IndexedDB instead, keyed by the same id as their ranking entry. */
(function () {
'use strict';

var LIST_KEY = 'dicewp.ranking.v1';
var MAX_ENTRIES = 20;
var DB_NAME = 'dicewp-ranking';
var DB_VERSION = 1;
var STORE_NAME = 'replays';

function readList() {
  try {
    var raw = window.localStorage.getItem(LIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function writeList(list) {
  window.localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

/** @returns {{playerId,name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor,savedAt}[]}
 *   sorted totalScore descending (ties keep insertion/localStorage order, matching JSON.stringify's
 *   own stable array order). */
function list() {
  return readList().sort(function (a, b) { return b.totalScore - a.totalScore; });
}

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function putReplay(id, replayHistory) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(replayHistory, id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function deleteReplay(id) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

/** @returns {Promise<object[]|null>} the saved replayHistory array, or null if unavailable (e.g. the
 *   IndexedDB write for this entry failed at save time -- see save()'s own doc). */
function loadReplay(id) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

/** Saves a new ranking entry plus its full replay, evicting the lowest-scoring entry once the list
 * would exceed MAX_ENTRIES (2026-08-16, per user: "上位20件"). The IndexedDB write is best-effort: if
 * it fails (e.g. private browsing), the localStorage entry is still saved with hasReplay:false so the
 * ranking list itself never gets lost over a replay-storage hiccup.
 * @param {object} entryWithoutId - {name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor}
 * @param {object[]} replayHistory
 * @returns {Promise<object>} the saved entry (with id/savedAt/hasReplay filled in)
 */
function save(entryWithoutId, replayHistory) {
  var entry = Object.assign({}, entryWithoutId, {
    id: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2),
    savedAt: new Date().toISOString(),
    hasReplay: true,
  });
  return putReplay(entry.id, replayHistory).catch(function () {
    entry.hasReplay = false;
  }).then(function () {
    var current = readList();
    current.push(entry);
    current.sort(function (a, b) { return b.totalScore - a.totalScore; });
    var evicted = current.splice(MAX_ENTRIES);
    writeList(current);
    return Promise.all(evicted.map(function (e) { return deleteReplay(e.id).catch(function () {}); })).then(function () {
      return entry;
    });
  });
}

/** Wipes every saved ranking entry and its replay (2026-08-18, per user request: "データが一新された
 * のでランキングを一度リセットしてください" -- old entries saved before a physical-id reorg (e.g. the
 * CON sheet reshuffle) reference card ids that mean something different, or nothing at all, under the
 * current data.json, so their replays render garbled/broken -- see main.js's renderReplayFrame try/
 * catch for the defensive side of the same issue). Clears the whole IndexedDB object store rather than
 * deleting entries one at a time. */
function clearAll() {
  writeList([]);
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

window.RankingStorage = { list: list, save: save, loadReplay: loadReplay, clearAll: clearAll };
})();
