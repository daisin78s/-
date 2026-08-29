/** Firebase-backed persistence for the all-time ranking + replays (2026-08-29, step 2 of the "オンライン
 *対戦 + ランキング/リプレイのクラウド共有" plan -- per user request: PC/iPad等、端末をまたいで同じランキ
 * ング/リプレイを見られるようにする). Plain classic <script> like ranking.js/main.js -- not run through
 * the CommonJS shim and not loaded under Node tests (firebase/window don't exist there); browser-only,
 * knows nothing about GameState/DSL/etc, only about storing and retrieving plain data ranking.js hands
 * it. Exposes window.OnlineSync. Loaded after firebase-config.js/the Firebase compat SDK <script> tags
 * (see index.html), before ranking.js.
 *
 * Two Firebase products on purpose, same split ranking.js's own old localStorage/IndexedDB split used:
 * the ranking list itself (name/score breakdown/CON/JOB/opponents) is tiny structured data that
 * benefits from Firestore's query/sort/limit -- one document per entry in the "ranking" collection,
 * keyed by the entry's own id. A full replay (one structuredClone'd GameState per move, easily 100+
 * entries for a 4-round game, multi-MB range -- see ranking.js's own old doc) is a large opaque blob,
 * better suited to Firebase Storage (one JSON file per entry, same id, under "replays/") than a
 * Firestore document (1MiB per-document cap).
 *
 * Room/live-game-state sync (createRoom/joinRoom/pushState/subscribeToRoom) is a LATER step of the same
 * plan and does not exist here yet -- this file only covers ranking/replay for now. */
(function () {
'use strict';

// firebase-config.js (loaded just before this file, see index.html) only sets window.FIREBASE_CONFIG --
// this is the one place that actually calls firebase.initializeApp, since this is the one file that
// actually talks to Firebase. Every other file (ranking.js, main.js) only ever calls into
// window.OnlineSync, never firebase.* directly.
firebase.initializeApp(window.FIREBASE_CONFIG);

var MAX_ENTRIES = 20; // same cap ranking.js's old localStorage version enforced
var RANKING_COLLECTION = 'ranking';
var REPLAY_STORAGE_PREFIX = 'replays/';

function db() { return firebase.firestore(); }
function storage() { return firebase.storage(); }

/** @returns {Promise<{playerId,name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor,savedAt,hasReplay,id}[]>}
 *   sorted totalScore descending -- Firestore's own orderBy/limit does the sort+cap server-side, same
 *   result shape ranking.js's old readList().sort(...) produced. */
function listRanking() {
  return db().collection(RANKING_COLLECTION)
    .orderBy('totalScore', 'desc')
    .limit(MAX_ENTRIES)
    .get()
    .then(function (snapshot) {
      return snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    });
}

/** Saves entry (Firestore doc, id as the document key) -- caller (ranking.js) is responsible for
 * eviction (deleteRankingEntry for whichever entries fall outside the top MAX_ENTRIES), same division
 * of responsibility as the old save()/writeList() split. */
function saveRankingEntry(id, entryWithoutId) {
  return db().collection(RANKING_COLLECTION).doc(id).set(entryWithoutId);
}

function deleteRankingEntry(id) {
  return db().collection(RANKING_COLLECTION).doc(id).delete();
}

/** Every entry currently in the collection, sorted totalScore descending, NOT capped at MAX_ENTRIES --
 * used by ranking.js's own save() to find which entries (if any) now fall outside the top MAX_ENTRIES
 * after adding a new one (same role the old localStorage save()'s `current.splice(MAX_ENTRIES)` played),
 * and by clearAllRanking below. */
function listAllRankingSorted() {
  return db().collection(RANKING_COLLECTION).orderBy('totalScore', 'desc').get().then(function (snapshot) {
    return snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  });
}

/** Deletes every ranking entry AND its replay blob (2026-08-18 policy, "データが一新されたので..." -- see
 * ranking.js's own doc). deleteReplay is best-effort per entry (an entry with hasReplay:false never had
 * one to begin with, and a stray Storage 404 shouldn't block clearing the rest of the list). */
function clearAllRanking() {
  return listAllRankingSorted().then(function (entries) {
    return Promise.all(entries.map(function (e) {
      return deleteRankingEntry(e.id).then(function () { return deleteReplay(e.id).catch(function () {}); });
    }));
  });
}

/** Uploads replayHistory (a plain array) as one JSON file, "replays/{id}.json". putString's 'raw' format
 * takes a plain string, so replayHistory is JSON.stringify'd first -- Storage itself is opaque-blob
 * storage, it doesn't parse JSON. */
function saveReplay(id, replayHistory) {
  return storage().ref(REPLAY_STORAGE_PREFIX + id + '.json')
    .putString(JSON.stringify(replayHistory), 'raw', { contentType: 'application/json' });
}

/** @returns {Promise<object[]|null>} the saved replayHistory array, or null if unavailable (missing, or
 *   the upload failed at save time -- see ranking.js's save()). Storage has no "read as string" call in
 *   the compat SDK -- getDownloadURL() + fetch() is the standard browser-side pattern. */
function loadReplay(id) {
  var ref = storage().ref(REPLAY_STORAGE_PREFIX + id + '.json');
  return ref.getDownloadURL()
    .then(function (url) { return fetch(url); })
    .then(function (res) { return res.json(); })
    .catch(function () { return null; });
}

function deleteReplay(id) {
  return storage().ref(REPLAY_STORAGE_PREFIX + id + '.json').delete();
}

window.OnlineSync = {
  listRanking: listRanking,
  saveRankingEntry: saveRankingEntry,
  deleteRankingEntry: deleteRankingEntry,
  listAllRankingSorted: listAllRankingSorted,
  clearAllRanking: clearAllRanking,
  saveReplay: saveReplay,
  loadReplay: loadReplay,
  deleteReplay: deleteReplay,
};
})();
