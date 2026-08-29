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
 * Room/live-game-state sync (2026-08-29, step 3 of the same plan -- per user request: 2〜4人の友人同士で
 * オンライン対戦がしたい、合言葉/ルームコードで合流): one Firestore document per room, "rooms/{code}"
 * (code is the room's own document id, a short human-typeable string -- no separate id field needed).
 * {hostSeatId, seats: {P1:{joinedAt}|null, P2:..., P3:..., P4:...}, phase: 'lobby'|'playing',
 * seatIsHuman: {P1:bool,...} (set once, at start), state: <the current GameState, JSON.stringify'd -- see
 * main.js's own doc on why "overwrite the whole state" rather than broadcasting individual moves>}. Every
 * device subscribes via onSnapshot; whichever device's own local action just changed STATE pushes the new
 * JSON back to the same field. No authentication in this app at all -- the room CODE itself is the only
 * access control (see the plan's own Firestore Security Rules note: reads/writes need the exact document
 * id, but the collection can't be listed), same trust model as a physical board game's own house rules. */
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

var ROOM_COLLECTION = 'rooms';
var SEAT_IDS = ['P1', 'P2', 'P3', 'P4'];
var ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L -- easy to read aloud/type

function randomRoomCode() {
  var code = '';
  for (var i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}

/** Generates a fresh 4-char code, retrying on the extremely unlikely chance it's already taken, creates
 * "rooms/{code}" with P1 (the creator) as the only occupied seat, and returns it.
 * @returns {Promise<{code:string, seatId:'P1'}>} */
function createRoom() {
  var ref = db().collection(ROOM_COLLECTION).doc(randomRoomCode());
  return ref.get().then(function (snap) {
    if (snap.exists) return createRoom(); // collision (rare) -- just try a new random code
    var seats = {};
    SEAT_IDS.forEach(function (id) { seats[id] = null; });
    seats.P1 = { joinedAt: Date.now() };
    return ref.set({ hostSeatId: 'P1', seats: seats, phase: 'lobby', createdAt: Date.now() }).then(function () {
      return { code: ref.id, seatId: 'P1' };
    });
  });
}

/** Claims the first open seat (P2/P3/P4 -- P1 is always the creator) in "rooms/{code}" inside a
 * transaction, so two people joining at the exact same moment can never both claim the same seat.
 * @returns {Promise<{code:string, seatId:string}>}
 * @throws {Error} with .message one of ROOM_NOT_FOUND / ROOM_ALREADY_STARTED / ROOM_FULL */
function joinRoom(code) {
  var normalizedCode = code.toUpperCase();
  var ref = db().collection(ROOM_COLLECTION).doc(normalizedCode);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      if (!snap.exists) throw new Error('ROOM_NOT_FOUND');
      var data = snap.data();
      if (data.phase !== 'lobby') throw new Error('ROOM_ALREADY_STARTED');
      var openSeatId = null;
      for (var i = 0; i < SEAT_IDS.length; i++) {
        if (!data.seats[SEAT_IDS[i]]) { openSeatId = SEAT_IDS[i]; break; }
      }
      if (!openSeatId) throw new Error('ROOM_FULL');
      var seats = Object.assign({}, data.seats);
      seats[openSeatId] = { joinedAt: Date.now() };
      tx.update(ref, { seats: seats });
      return openSeatId;
    });
  }).then(function (seatId) {
    return { code: normalizedCode, seatId: seatId };
  });
}

/** Subscribes to "rooms/{code}", calling onUpdate(roomData) on the initial read and every change
 * thereafter (roomData is null if the room doc doesn't exist -- e.g. never created, or somehow deleted).
 * @returns {function()} unsubscribe */
function subscribeToRoom(code, onUpdate) {
  return db().collection(ROOM_COLLECTION).doc(code).onSnapshot(function (snap) {
    onUpdate(snap.exists ? snap.data() : null);
  });
}

/** Host-only: marks the room "playing", fixes which seats are human (the rest default to AI on every
 * device -- see main.js's own doc on why a <4-human room still needs exactly 4 seats), and pushes the
 * freshly-created initial GameState. Every subscribed device (including the host's own) picks this up
 * via the same onSnapshot callback as any later in-game update. */
function startRoom(code, initialStateJson, seatIsHuman) {
  return db().collection(ROOM_COLLECTION).doc(code).update({
    phase: 'playing',
    seatIsHuman: seatIsHuman,
    state: initialStateJson,
  });
}

/** Overwrites the room's current state (2026-08-29, "state まるごと同期方式" -- see the plan's own doc on
 * why: real GameState JSON is ~27KB even at round 4, comfortably inside Firestore's 1MiB/doc cap, so
 * broadcasting the whole thing after every move is simpler and more robust than reconstructing individual
 * Move objects from main.js's ~20 scattered human-action handlers). */
function pushRoomState(code, stateJson) {
  return db().collection(ROOM_COLLECTION).doc(code).update({ state: stateJson });
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
  createRoom: createRoom,
  joinRoom: joinRoom,
  subscribeToRoom: subscribeToRoom,
  startRoom: startRoom,
  pushRoomState: pushRoomState,
};
})();
