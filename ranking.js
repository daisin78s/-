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

var MAX_ENTRIES = 50; // 2026-09-07: 20->50 per user request, to keep more replays available for AI training

/** @param {string} [category] - 'ultimate' (default)|'standard'|'weekly' -- 3-way split (2026-09-07, per
 *   user spec, see main.js's usedDebugOrTestGameThisGame doc), each backed by its own OnlineSync
 *   collection so one category's scores can never evict another's out of the list.
 * @param {string} [weekId] - 2026-09-14, per user request "毎週変わるようにしてほしい...先週、先々週と戻っ
 *   てみることができる": only meaningful for category 'weekly' (ignored otherwise) -- restricts the list
 *   to entries whose own stored weekId matches (see main.js's weeklyRankingIdForOffset for how a caller
 *   picks which week). Omitted/undefined for 'weekly' shows every week's entries pooled together (not
 *   currently used by any caller -- main.js's ranking overlay always passes an explicit week).
 * @returns {Promise<{playerId,name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor,savedAt,hasReplay,id}[]>}
 *   sorted totalScore descending (OnlineSync.listRanking already sorts+caps). */
function list(category, weekId) {
  return window.OnlineSync.listRanking(category, weekId);
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
 * @param {object} entryWithoutId - {name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,
 *   playerColor,category?,weekId?} -- category ('ultimate'|'standard'|'weekly', defaults to 'ultimate' if
 *   omitted) picks which collection (and therefore which independent MAX_ENTRIES eviction pool) this
 *   entry lands in -- see online-sync.js's own rankingCollectionName doc. weekId (2026-09-14, only ever
 *   set by main.js for category:'weekly') further scopes that eviction pool to just the SAME week's
 *   entries, so an old week's top scores can never get pushed out by a newer week's -- each week is its
 *   own independent top-MAX_ENTRIES pool, not one pool shared across every week ever played.
 * @param {object[]} replayHistory
 * @returns {Promise<object>} the saved entry (with id/savedAt/hasReplay filled in)
 */
function save(entryWithoutId, replayHistory) {
  var category = entryWithoutId.category || 'ultimate';
  var weekId = entryWithoutId.weekId; // undefined for ultimate/standard -- see this function's own doc
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
    return window.OnlineSync.saveRankingEntry(entry.id, toSave, category);
  }).then(function () {
    return window.OnlineSync.listAllRankingSorted(category, weekId);
  }).then(function (current) {
    var evicted = current.slice(MAX_ENTRIES);
    return Promise.all(evicted.map(function (e) {
      return window.OnlineSync.deleteRankingEntry(e.id, category).catch(function () {})
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
 * catch for the defensive side of the same issue). Not wired to any UI button any more -- see
 * online-sync.js's own clearAllRanking doc. */
function clearAll(category) {
  return window.OnlineSync.clearAllRanking(category);
}

/** Deletes a single ranking entry (and its replay, if any) rather than clearAll's whole-list wipe
 * (2026-09-03, per user request: "今あるランキングをリセットするとき すべてリセットするのではなく え
 * らんでリセットするようにできますか") -- reuses the same OnlineSync.deleteRankingEntry/deleteReplay
 * calls save()'s own MAX_ENTRIES eviction already made internally, just exposed here for a real button
 * (main.js's handleRankingEntryDeleteClick) instead of only ever firing automatically. deleteReplay
 * failing (e.g. no replay was ever saved for this entry, hasReplay:false) is swallowed the same way
 * save()'s eviction already does -- the ranking entry itself is still gone either way.
 * @param {string} id
 * @param {string} [category] - which collection id lives in -- see list()'s own doc; the caller (main.js)
 *   always knows this already, since it's whichever tab is currently showing. */
function deleteOne(id, category) {
  return window.OnlineSync.deleteRankingEntry(id, category).then(function () {
    return window.OnlineSync.deleteReplay(id).catch(function () {});
  });
}

/** Flags a single ranking entry as outdated instead of deleting it (2026-09-07, per user request: an
 * alternative offered alongside 削除 after the same password prompt -- see main.js's
 * handleRankingDeleteOrMarkChoice) -- "この〇は最新版でないリプレイデータを間違えて学習させないためのもの
 * です". The entry (and its replay) stays exactly as-is otherwise, just gains outdated:true.
 * @param {string} id
 * @param {string} [category] - see list()'s own doc. */
function markOutdated(id, category) {
  return window.OnlineSync.markRankingEntryOutdated(id, category);
}

/** Deletes the replay BLOB (not the ranking entry/score row) for every 'weekly' entry older than
 * cutoffWeekId (2026-09-14, per user request "ランキングが増えると容量オーバーしない？" -- see main.js's
 * own KEEP_REPLAY_WEEKS doc for why this exists and online-sync.js's pruneOldWeeklyReplays for exactly
 * what it does). Fire-and-forget from main.js's openRankingOverlay -- callers should swallow errors
 * themselves, same as this file's other best-effort eviction calls.
 * @param {string} cutoffWeekId */
function pruneOldWeeklyReplays(cutoffWeekId) {
  return window.OnlineSync.pruneOldWeeklyReplays(cutoffWeekId);
}

window.RankingStorage = { list: list, save: save, loadReplay: loadReplay, clearAll: clearAll, deleteOne: deleteOne, markOutdated: markOutdated, pruneOldWeeklyReplays: pruneOldWeeklyReplays };
})();
