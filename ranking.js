/** Persistence layer for the all-time human-player ranking (2026-08-16, per user request: "ランキング
 * とは人間対AIで歴代の得点を最高得点順に並べるもの"). Plain classic <script> like main.js -- not run
 * through the CommonJS shim and not loaded under Node tests, since window.OnlineSync doesn't exist
 * there; this file is browser-only and knows nothing about GameState/DSL/etc, only about storing and
 * retrieving plain data main.js hands it. Exposes window.RankingStorage.
 *
 * 2026-08-29 rework (per user request: "PCでプレイした記録をiPadで見たい" -- see the "オンライン対戦 +
 * ランキング/リプレイのクラウド共有" plan): storage moved from localStorage/IndexedDB (per-browser, never
 * synced) to Firebase (Firestore for the ranking list, Storage for replay blobs -- see online-sync.js's
 * own doc for why the split). Every function here now just delegates to window.OnlineSync -- this file's
 * own job is purely the ranking-specific POLICY (MAX_ENTRIES eviction, id/savedAt/hasReplay bookkeeping),
 * not talking to Firebase directly. **Public API (list/save/loadReplay/clearAll names+shapes) intentionally
 * unchanged from the old version, EXCEPT list() is now async (a Promise) since Firestore reads are --
 * see main.js's renderRankingList/renderRankingOverlay/openRankingOverlay, updated to await it.** */
(function () {
'use strict';

var MAX_ENTRIES = 20;

/** @returns {Promise<{playerId,name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor,savedAt,hasReplay,id}[]>}
 *   sorted totalScore descending (OnlineSync.listRanking already sorts+caps server-side). */
function list() {
  return window.OnlineSync.listRanking();
}

/** @returns {Promise<object[]|null>} the saved replayHistory array, or null if unavailable (e.g. the
 *   Storage upload for this entry failed at save time -- see save()'s own doc). */
function loadReplay(id) {
  return window.OnlineSync.loadReplay(id);
}

/** Saves a new ranking entry plus its full replay, evicting the lowest-scoring entry once the list
 * would exceed MAX_ENTRIES (2026-08-16, per user: "上位20件"). The replay upload is best-effort: if it
 * fails (e.g. offline), the ranking entry is still saved with hasReplay:false so the ranking list itself
 * never gets lost over a replay-storage hiccup.
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
  return window.OnlineSync.saveReplay(entry.id, replayHistory).catch(function () {
    entry.hasReplay = false;
  }).then(function () {
    var toSave = Object.assign({}, entry);
    delete toSave.id; // the id is the Firestore document key, not a field within it
    return window.OnlineSync.saveRankingEntry(entry.id, toSave);
  }).then(function () {
    return window.OnlineSync.listAllRankingSorted();
  }).then(function (current) {
    var evicted = current.slice(MAX_ENTRIES);
    return Promise.all(evicted.map(function (e) {
      return window.OnlineSync.deleteRankingEntry(e.id).catch(function () {})
        .then(function () { return window.OnlineSync.deleteReplay(e.id).catch(function () {}); });
    }));
  }).then(function () {
    return entry;
  });
}

/** Wipes every saved ranking entry and its replay (2026-08-18, per user request: "データが一新された
 * のでランキングを一度リセットしてください" -- old entries saved before a physical-id reorg (e.g. the
 * CON sheet reshuffle) reference card ids that mean something different, or nothing at all, under the
 * current data.json, so their replays render garbled/broken -- see main.js's renderReplayFrame try/
 * catch for the defensive side of the same issue). */
function clearAll() {
  return window.OnlineSync.clearAllRanking();
}

/** Deletes a single ranking entry (and its replay, if any) rather than clearAll's whole-list wipe
 * (2026-09-03, per user request: "今あるランキングをリセットするとき すべてリセットするのではなく え
 * らんでリセットするようにできますか") -- reuses the same OnlineSync.deleteRankingEntry/deleteReplay
 * calls save()'s own MAX_ENTRIES eviction already made internally, just exposed here for a real button
 * (main.js's handleRankingEntryDeleteClick) instead of only ever firing automatically. deleteReplay
 * failing (e.g. no replay was ever saved for this entry, hasReplay:false) is swallowed the same way
 * save()'s eviction already does -- the ranking entry itself is still gone either way.
 * @param {string} id */
function deleteOne(id) {
  return window.OnlineSync.deleteRankingEntry(id).then(function () {
    return window.OnlineSync.deleteReplay(id).catch(function () {});
  });
}

window.RankingStorage = { list: list, save: save, loadReplay: loadReplay, clearAll: clearAll, deleteOne: deleteOne };
})();
