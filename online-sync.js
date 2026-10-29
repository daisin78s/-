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

var MAX_ENTRIES = 50; // same cap ranking.js's old localStorage version enforced (2026-09-07: 20->50 per user request, to keep more replays available for AI training)
// 3-way ranking split (2026-09-07, per user spec -- see main.js's usedDebugOrTestGameThisGame doc): each
// category gets its OWN Firestore collection (and therefore its own independent MAX_ENTRIES eviction --
// a single shared collection+cap would let one category's higher scores silently starve another's out of
// the list entirely). 'ultimate' keeps the original collection name so every pre-existing entry (saved
// before this split existed, with no category field at all) stays exactly where it already was, with no
// migration needed. 'weekly' has no writer yet (ウィークリーチャレンジ isn't built) -- reserved for it.
// 'achievement' (2026-10-08, per user request: "実績解除の得点 非公開でランキング作れますか" ->
// "誰かの得点が増えたら 総得点だけ記録して ランキングを作る" + "ただし非公開"): main.jsのachievement
// TotalPoints(実績記録の合計点数)専用。他カテゴリと違い1ゲームごとの記録ではなく、プレイヤー1人につき
// 1件だけ(記録IDをブラウザごとの固定idにして上書き保存、main.jsのsyncAchievementTotalIfIncreased参照)。
// 非公開(見るのに既存のRANKING_RESET_PASSWORD_HASHと同じパスワードが要る)はmain.js側のUIゲートのみで
// 実現しており、Firestore側の読み取り自体はこのアプリの他コレクションと同じく制限していない(このアプリに
// 認証機構が無いため -- このファイル冒頭own doc参照)。
var RANKING_COLLECTIONS = { ultimate: 'ranking', standard: 'ranking_standard', weekly: 'ranking_weekly', achievement: 'ranking_achievement' };
function rankingCollectionName(category) { return RANKING_COLLECTIONS[category] || RANKING_COLLECTIONS.ultimate; }
var REPLAY_STORAGE_PREFIX = 'replays/'; // shared across every category -- ids are globally-unique UUIDs, no collision risk

function db() { return firebase.firestore(); }
function storage() { return firebase.storage(); }

/** @param {string} [weekId] - 2026-09-14, per user request "ウィークリーランキングを毎週リセットしたい,
 *   先週・先々週にも戻れるように": when given, restricts to docs whose own weekId field matches (client-
 *   side filter, not a Firestore .where() -- see this function's own note below on why). Meaningless for
 *   category !=='weekly' (those entries never have a weekId field at all) -- callers only ever pass it
 *   alongside 'weekly'.
 * @returns {Promise<{playerId,name,rawScore,qstScore,totalScore,conFaceId,jobCardId,opponents,playerColor,savedAt,hasReplay,id}[]>}
 *   sorted totalScore descending, capped at MAX_ENTRIES.
 *   Deliberately NOT `.where('weekId','==',weekId).orderBy('totalScore','desc')` -- combining an equality
 *   filter on one field with orderBy on a DIFFERENT field needs a Firestore composite index that doesn't
 *   exist for this collection and can't be created from client code (only via a console link a developer
 *   would have to click once, which would leave the ranking silently broken -- "an index is required for
 *   this query" -- until someone did). Fetching the whole (small: MAX_ENTRIES-per-week-capped, see save()'s
 *   own per-week eviction) collection with just `.orderBy('totalScore','desc')` and filtering/limiting in
 *   JS avoids that entirely at negligible cost. */
function listRanking(category, weekId) {
  var query = db().collection(rankingCollectionName(category)).orderBy('totalScore', 'desc');
  // Only 'weekly' ever passes weekId -- ultimate/standard keep the original server-side .limit(), cheaper
  // for the two categories actually queried on every ranking-overlay open. 'weekly' can't limit server-side
  // once a weekId filter is layered on top (see this function's own doc on why the filter itself is
  // client-side), so it fetches the whole collection and slices after filtering instead.
  if (weekId === undefined) query = query.limit(MAX_ENTRIES);
  return query.get().then(function (snapshot) {
    var entries = snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    if (weekId !== undefined) entries = entries.filter(function (e) { return e.weekId === weekId; }).slice(0, MAX_ENTRIES);
    return entries;
  });
}

/** Saves entry (Firestore doc, id as the document key) -- caller (ranking.js) is responsible for
 * eviction (deleteRankingEntry for whichever entries fall outside the top MAX_ENTRIES), same division
 * of responsibility as the old save()/writeList() split. */
function saveRankingEntry(id, entryWithoutId, category) {
  return db().collection(rankingCollectionName(category)).doc(id).set(entryWithoutId);
}

function deleteRankingEntry(id, category) {
  return db().collection(rankingCollectionName(category)).doc(id).delete();
}

/** Merges { outdated: true } into an existing entry rather than replacing the whole document (2026-09-07,
 * per user request: 選択した項目を削除 now offers "印をつける" as an alternative to actually deleting --
 * flags a replay whose game rules are no longer current so it's never fed into AI-training data by
 * mistake, without losing the ranking record/replay itself). Firestore's own .update() (not .set()) is
 * what makes this a merge rather than a full overwrite. */
function markRankingEntryOutdated(id, category) {
  return db().collection(rankingCollectionName(category)).doc(id).update({ outdated: true });
}

/** Every entry currently in the collection, sorted totalScore descending, NOT capped at MAX_ENTRIES --
 * used by ranking.js's own save() to find which entries (if any) now fall outside the top MAX_ENTRIES
 * after adding a new one (same role the old localStorage save()'s `current.splice(MAX_ENTRIES)` played),
 * and by clearAllRanking below.
 * @param {string} [weekId] - 2026-09-14: when given (only ever alongside category 'weekly'), restricts to
 *   that week's own entries first -- see save()'s own doc on why eviction must be scoped per-week rather
 *   than across the whole 'weekly' collection at once (otherwise an old week's top scores could get pushed
 *   out purely by a newer week's activity, once the collection's total across every week ever played
 *   passed MAX_ENTRIES). Client-side filter, same rationale as listRanking's own doc. */
function listAllRankingSorted(category, weekId) {
  return db().collection(rankingCollectionName(category)).orderBy('totalScore', 'desc').get().then(function (snapshot) {
    var entries = snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    return weekId === undefined ? entries : entries.filter(function (e) { return e.weekId === weekId; });
  });
}

/** Deletes every ranking entry AND its replay blob (2026-08-18 policy, "データが一新されたので..." -- see
 * ranking.js's own doc). deleteReplay is best-effort per entry (an entry with hasReplay:false never had
 * one to begin with, and a stray Storage 404 shouldn't block clearing the rest of the list). Not wired to
 * any UI button any more (per-entry 選択削除 replaced the old "reset everything" button) -- kept working,
 * category-aware, purely so it doesn't bit-rot into a broken call if ever reused. */
function clearAllRanking(category) {
  return listAllRankingSorted(category).then(function (entries) {
    return Promise.all(entries.map(function (e) {
      return deleteRankingEntry(e.id, category).then(function () { return deleteReplay(e.id).catch(function () {}); });
    }));
  });
}

/** Uploads replayHistory (a plain array) as one JSON file, "replays/{id}.json". putString's 'raw' format
 * takes a plain string, so replayHistory is JSON.stringify'd first -- Storage itself is opaque-blob
 * storage, it doesn't parse JSON. */
function saveReplay(id, replayHistory) {
  return storage().ref(REPLAY_STORAGE_PREFIX + id + '.json')
    .putString(JSON.stringify(replayHistory), 'raw', { contentType: 'application/json' })
    .then(function (result) {
      // 最後の場面だけの小さなファイルも一緒に(失敗してもリプレイ本体の保存は成功扱い -- 人生ボタンは
      // 無ければリプレイ本体を読むので困らない)。
      var last = replayHistory && replayHistory[replayHistory.length - 1];
      if (!last) return result;
      return saveReplayFinal(id, last).catch(function () {}).then(function () { return result; });
    });
}

// リプレイの最後の場面(ゲーム終了時の盤面1つ)だけを別に保存する (2026-10-28, per user report: "ランキングで
// 人生を見るとき結構重い") -- ランキングの「人生」ボタンが使うのは最後の場面だけなのに、全部の手の入った
// リプレイ(8〜13MB)を丸ごと読んでいた。こちらは数十KB。置き場はリプレイと同じreplays/で、名前は
// "{id}-final.json"(replays/の外の新しい置き場はFirebase Storageの許可設定で書き込めなかったため)。
function replayFinalRef(id) {
  return storage().ref(REPLAY_STORAGE_PREFIX + id + '-final.json');
}

function saveReplayFinal(id, finalState) {
  return replayFinalRef(id)
    .putString(JSON.stringify(finalState), 'raw', { contentType: 'application/json' });
}

/** @returns {Promise<object|null>} 最後の場面。この仕組みより前の記録などで無ければnull。 */
function loadReplayFinal(id) {
  return replayFinalRef(id).getDownloadURL()
    .then(function (url) { return fetch(url); })
    .then(function (res) { return res.json(); })
    .catch(function () { return null; });
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
  // 最後の場面のファイルも一緒に消す(無いこともあるので失敗は無視)。
  replayFinalRef(id).delete().catch(function () {});
  return storage().ref(REPLAY_STORAGE_PREFIX + id + '.json').delete();
}

/** Deletes the replay BLOB (Storage) for every 'weekly' entry older than `cutoffWeekId`, but keeps the
 * ranking ENTRY itself (Firestore doc, just flipped to hasReplay:false) -- 2026-09-14, per user request
 * ("ランキングが増えると容量オーバーしない？" -- see main.js's own KEEP_REPLAY_WEEKS doc): once weekly
 * rankings reset every week and never evict across weeks (see save()'s own per-week eviction doc), a full
 * game replay (multi-MB, see ranking.js's own doc on why replays are Storage blobs not Firestore fields)
 * getting kept forever for EVERY week's top 50 would grow Storage usage unboundedly. Score-history rows
 * (name/score/CON/JOB/opponents) stay tiny and harmless to keep forever -- only the big blob is pruned.
 * ISO week ids (YYYY-Www, zero-padded week) sort correctly as plain strings even across a year boundary
 * (e.g. "2026-W52" < "2027-W01"), so a plain `<` comparison is enough; an entry saved before this feature
 * added weekId has weekId===undefined, and `undefined < anything` is always false in JS, so those are
 * safely left untouched here (nothing to prune them TO -- they predate per-week accounting entirely).
 * Best-effort per entry, same as every other eviction path here -- one stray Storage 404 (e.g. an entry
 * whose upload already failed at save time) must never block pruning the rest. */
function pruneOldWeeklyReplays(cutoffWeekId) {
  return db().collection(rankingCollectionName('weekly')).where('hasReplay', '==', true).get().then(function (snapshot) {
    var stale = snapshot.docs.filter(function (doc) { return doc.data().weekId < cutoffWeekId; });
    return Promise.all(stale.map(function (doc) {
      return deleteReplay(doc.id).catch(function () {}).then(function () { return doc.ref.update({ hasReplay: false }); });
    }));
  });
}

var WEEKLY_EVAL_SNAPSHOT_COLLECTION = 'weekly_eval_snapshots';

/** Get-or-create this week's frozen AI LV4 評価値 table (2026-09-08, per user spec -- see main.js's own
 * doc on aiPlayerLv4Weekly for the full "why"): the first attempt of a new week freezes whatever
 * currentEvalTable is AT THAT MOMENT into "weekly_eval_snapshots/{weekId}"; every later attempt (any
 * device, any player) during the same week reads that same saved snapshot back unchanged, so every
 * attempt within one week plays against an identical AI LV4 regardless of how much tuning happens to the
 * live table in between weeks. A transaction (same pattern joinRoom already uses) makes "read, and only
 * write if absent" atomic -- two devices racing to be the very first attempt of a brand new week can never
 * each save a different snapshot; whichever transaction commits first wins, and the other's tx.get just
 * sees that doc already exists and returns it instead.
 * @returns {Promise<Object>} the eval-table (this week's own, whether just created or already existing) */
function getOrCreateWeeklyEvalTable(weekId, currentEvalTable) {
  var ref = db().collection(WEEKLY_EVAL_SNAPSHOT_COLLECTION).doc(weekId);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      if (snap.exists) return snap.data().evalTable;
      tx.set(ref, { evalTable: currentEvalTable, createdAt: Date.now() });
      return currentEvalTable;
    });
  });
}

var ROOM_COLLECTION = 'rooms';
var SEAT_IDS = ['P1', 'P2', 'P3', 'P4'];
var ROOM_CODE_CHARS = '0123456789'; // 2026-08-30, per user request: "部屋番号　数字4桁にして"

function randomRoomCode() {
  var code = '';
  for (var i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}

/** Generates a fresh 4-char code, retrying on the extremely unlikely chance it's already taken, creates
 * "rooms/{code}" with P1 (the creator) as the only occupied seat, and returns it.
 * @returns {Promise<{code:string, seatId:'P1'}>} */
// appVersion (2026-10-23, per user request「バージョンが違う場合対戦できないように」) -- 部屋を作った端末の
// バージョン(例 "Ver.1.285")を部屋に記録し、joinRoomで参加する端末のバージョンと比べる。
// extraFields (2026-10-29): 公開部屋(isPublic)など、作る時に一緒に書く欄。
// profile (2026-10-29, per user request: "P1 参加済み ではなくプレイヤーネームを表示 それから実績ポイントも表示"):
// 席に一緒に書く {name, points}(待ち合い画面に出す)。
function seatEntry(profile) {
  var entry = { joinedAt: Date.now() };
  if (profile) { entry.name = profile.name || null; entry.points = typeof profile.points === 'number' ? profile.points : null; }
  return entry;
}
function createRoom(appVersion, extraFields, profile) {
  var ref = db().collection(ROOM_COLLECTION).doc(randomRoomCode());
  return ref.get().then(function (snap) {
    if (snap.exists) return createRoom(appVersion, extraFields, profile); // collision (rare) -- just try a new random code
    var seats = {};
    SEAT_IDS.forEach(function (id) { seats[id] = null; });
    seats.P1 = seatEntry(profile);
    var data = Object.assign({ hostSeatId: 'P1', seats: seats, phase: 'lobby', createdAt: Date.now(), appVersion: appVersion || null }, extraFields || {});
    return ref.set(data).then(function () {
      return { code: ref.id, seatId: 'P1' };
    });
  });
}

/** Claims the first open seat (P2/P3/P4 -- P1 is always the creator) in "rooms/{code}" inside a
 * transaction, so two people joining at the exact same moment can never both claim the same seat.
 * @returns {Promise<{code:string, seatId:string}>}
 * @throws {Error} with .message one of ROOM_NOT_FOUND / ROOM_ALREADY_STARTED / ROOM_FULL */
function joinRoom(code, appVersion, profile) {
  var normalizedCode = code.trim();
  var ref = db().collection(ROOM_COLLECTION).doc(normalizedCode);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      if (!snap.exists) throw new Error('ROOM_NOT_FOUND');
      var data = snap.data();
      // バージョンが違えば参加させない(部屋にバージョンの記録が無い古い部屋は従来通り)。
      if (data.appVersion && appVersion && data.appVersion !== appVersion) {
        var err = new Error('VERSION_MISMATCH');
        err.roomVersion = data.appVersion;
        throw err;
      }
      if (data.phase !== 'lobby') throw new Error('ROOM_ALREADY_STARTED');
      var openSeatId = null;
      for (var i = 0; i < SEAT_IDS.length; i++) {
        if (!data.seats[SEAT_IDS[i]]) { openSeatId = SEAT_IDS[i]; break; }
      }
      if (!openSeatId) throw new Error('ROOM_FULL');
      var seats = Object.assign({}, data.seats);
      seats[openSeatId] = seatEntry(profile);
      tx.update(ref, { seats: seats });
      return openSeatId;
    });
  }).then(function (seatId) {
    return { code: normalizedCode, seatId: seatId };
  });
}

/** ランダムマッチ (2026-10-29, per user request: "部屋を作る以外に誰でもはいれる対戦を実装したい" + 回答: 開始は部屋を
 * 作った人が開始ボタン / 持ち時間は部屋を作った人が決める / 観戦OK、続けて "部屋を作る前に設定(時間など)を決めて
 * それが外から見えるように それでOKなら部屋に入って いやなら自分で部屋を作れる") --
 * 待っている公開部屋の合言葉は rooms/PUBLIC_LOBBY_DOC の rooms 欄に並べておく(部屋の一覧を検索で読むことは
 * Firestoreのルールで許されていないため、合言葉が分かっている1つの記録を読む形)。一覧からは30分より古いものを消す。 */
var PUBLIC_LOBBY_DOC = 'PUBLIC_LOBBY';
var PUBLIC_LOBBY_KEEP_MS = 30 * 60 * 1000;

/** 入れる公開部屋: 開始前で同じバージョン、空席があり、部屋を作った人(ホスト)が今もつながっている(60秒以内に
 * 合図がある)部屋。人の多い順。
 * @returns {Promise<{code:string, occupied:number, timeControl:Object|null, spectatorsAllowed:boolean}[]>} */
function listPublicRooms(appVersion) {
  var lobbyRef = db().collection(ROOM_COLLECTION).doc(PUBLIC_LOBBY_DOC);
  return lobbyRef.get().then(function (lobbySnap) {
    var listed = (lobbySnap.exists && lobbySnap.data().rooms) || [];
    var fresh = listed.filter(function (r) { return r && r.code && Date.now() - (r.at || 0) < PUBLIC_LOBBY_KEEP_MS; });
    return Promise.all(fresh.map(function (r) {
      return db().collection(ROOM_COLLECTION).doc(r.code).get().then(function (snap) { return snap.exists ? { code: r.code, data: snap.data() } : null; }).catch(function () { return null; });
    }));
  }).then(function (rooms) {
    var now = Date.now();
    var result = [];
    rooms.forEach(function (room) {
      if (!room) return;
      var data = room.data;
      if (!data.isPublic || data.phase !== 'lobby') return;
      var seats = data.seats || {};
      var occupied = SEAT_IDS.filter(function (id) { return !!seats[id]; }).length;
      if (occupied >= SEAT_IDS.length) return;
      var hostBeat = data.presence && data.presence[data.hostSeatId || 'P1'];
      var hostMs = hostBeat && typeof hostBeat.toMillis === 'function' ? hostBeat.toMillis() : 0;
      if (now - hostMs > 60000) return; // 部屋を作った人がもういない
      // バージョンが違う部屋も「入れない部屋」として返す(一覧に出して理由を見せる)。
      var otherVersion = (data.appVersion || null) !== (appVersion || null) ? (data.appVersion || '?') : null;
      result.push({ code: room.code, occupied: occupied, createdAt: data.createdAt || 0, timeControl: data.timeControl || null, spectatorsAllowed: !!data.spectatorsAllowed, otherVersion: otherVersion });
    });
    result.sort(function (a, b) { return (a.otherVersion ? 1 : 0) - (b.otherVersion ? 1 : 0) || b.occupied - a.occupied || a.createdAt - b.createdAt; });
    return result;
  });
}

/** 設定(持ち時間・観戦)を決めた公開部屋を作り、一覧に載せる。
 * @returns {Promise<{code:string, seatId:'P1'}>} */
function createPublicRoom(appVersion, settings, profile) {
  var lobbyRef = db().collection(ROOM_COLLECTION).doc(PUBLIC_LOBBY_DOC);
  var extra = { isPublic: true, spectatorsAllowed: !!(settings && settings.spectatorsAllowed), timeControl: (settings && settings.timeControl) || null };
  return createRoom(appVersion, extra, profile).then(function (r) {
    return db().runTransaction(function (tx) {
      return tx.get(lobbyRef).then(function (snap) {
        var list = ((snap.exists && snap.data().rooms) || []).filter(function (x) { return x && Date.now() - (x.at || 0) < PUBLIC_LOBBY_KEEP_MS; });
        list.push({ code: r.code, at: Date.now() });
        tx.set(lobbyRef, { rooms: list.slice(-30) });
      });
    }).then(function () { return r; });
  });
}

/** 開始前の部屋から出る (2026-10-29, per user report: スマホで部屋から出て、もう一度ランダムマッチを見ると部屋が
 * 無い -- それまで「出る」仕組みが無く、閉じても席を取ったままだった) -- 自分の席を空ける。部屋を作った人(ホスト)
 * が出た時は部屋を閉じる(phase 'closed'、一覧にも出なくなる)。開始後の部屋は何もしない。 */
function leaveRoom(code, seatId) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      if (!snap.exists) return;
      var data = snap.data();
      if (data.phase !== 'lobby') return;
      var update = {};
      update['seats.' + seatId] = null;
      if ((data.hostSeatId || 'P1') === seatId) update.phase = 'closed';
      tx.update(ref, update);
    });
  });
}

/** Subscribes to "rooms/{code}", calling onUpdate(roomData) on the initial read and every change
 * thereafter (roomData is null if the room doc doesn't exist -- e.g. never created, or somehow deleted).
 * @returns {function()} unsubscribe */
function subscribeToRoom(code, onUpdate) {
  return db().collection(ROOM_COLLECTION).doc(code).onSnapshot(function (snap) {
    if (!snap.exists) { onUpdate(null); return; }
    // presence(接続の合図、heartbeat参照)はサーバーの時刻(Timestamp)で入っているので、比べやすいようミリ秒の数に
    // 直して渡す。自分が書いた直後でまだサーバーの時刻が決まっていない時は推定値('estimate')。
    var data = snap.data({ serverTimestamps: 'estimate' });
    ['presence', 'animating'].forEach(function (field) {
      if (!data[field]) return;
      var converted = {};
      Object.keys(data[field]).forEach(function (seatId) {
        var v = data[field][seatId];
        converted[seatId] = v && typeof v.toMillis === 'function' ? v.toMillis() : v;
      });
      data[field] = converted;
    });
    data.__hasPendingWrites = snap.metadata.hasPendingWrites;
    onUpdate(data);
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
    stateRev: 1,
  });
}

/** Overwrites the room's current state (2026-08-29, "state まるごと同期方式" -- see the plan's own doc on
 * why: real GameState JSON is ~27KB even at round 4, comfortably inside Firestore's 1MiB/doc cap, so
 * broadcasting the whole thing after every move is simpler and more robust than reconstructing individual
 * Move objects from main.js's ~20 scattered human-action handlers). */
/** 通し番号 (2026-10-27, per user request -- 同期ミスへの備え「古い状態での上書きを受け付けない」): 部屋の
 * stateRevが、この端末が元にした状態の番号(baseRev)と同じ時だけ書き、番号を1つ進める(トランザクション)。
 * 違えば(=その間にほかの端末が新しい状態を書いていた)書かずに、Error('STALE_STATE')で今の部屋の状態を返す。
 * stateRevの無い古い部屋は0扱い。
 * @returns {Promise<number>} 書いた状態の番号 */
function pushRoomState(code, stateJson, baseRev) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var data = snap.data() || {};
      var rev = data.stateRev || 0;
      if (rev !== (baseRev || 0)) {
        var err = new Error('STALE_STATE');
        err.current = { state: data.state || null, stateRev: rev, lastRewindId: (data.lastRewind && data.lastRewind.id) || null };
        throw err;
      }
      tx.update(ref, { state: stateJson, stateRev: rev + 1 });
      return rev + 1;
    });
  });
}

/** 回線が落ちたらAI (2026-10-27, per user request: "回線が落ちたらAI最高レベルがプレイの続きをして再接続したら
 * プレイに戻れるように" + 回答: 30秒、ホストが落ちたら別の人が引き継ぐ) -- main.jsのupdateOnlineHostAndTakeover参照。
 * heartbeat: 席ごとの「今つながっている」合図(サーバーの時刻)。10秒ごとに書く。 */
function heartbeat(code, seatId) {
  var update = {};
  update['presence.' + seatId] = firebase.firestore.FieldValue.serverTimestamp();
  return db().collection(ROOM_COLLECTION).doc(code).update(update);
}
/** その席を今AIが代わりにプレイしているか(全端末がこれを見て、その席をAI扱いにする)。書くのはホストだけ。 */
function setAiTakeover(code, seatId, on) {
  var update = {};
  update['aiTakeover.' + seatId] = !!on;
  return db().collection(ROOM_COLLECTION).doc(code).update(update);
}
/** ホスト(AIを動かす・初期資源の選択を反映する端末)の引き継ぎ。 */
function setHostSeat(code, seatId) {
  return db().collection(ROOM_COLLECTION).doc(code).update({ hostSeatId: seatId });
}

/** 観戦モード (2026-10-27, per user request: "観戦モードが欲しい 部屋のオーナーがOK NG選べて 第三者が
 * プレイを観戦できるように" + 回答「部屋の設定で決める」) -- 部屋の作成者が待ち合い画面で切り替える。 */
function setSpectatorsAllowed(code, allowed) {
  return db().collection(ROOM_COLLECTION).doc(code).update({ spectatorsAllowed: !!allowed });
}

/** 持ち時間 (2026-10-29, per user request: "オンライン対戦 持ち時間を設定したい 部屋を作った人が設定できて
 * 入る人は先に見れる") -- timeControl: 部屋の作成者が待ち合い画面で決める設定
 *   { initialSec, earlySec(ターン1〜3の加算), lateSec(ターン4〜の加算), start('game'|'onePick'|'allPicked'|'turn2') }、
 *   時間制限なしはnull。clock: 対局中の残り時間(書くのはホストだけ、main.jsのupdateOnlineClock参照)。 */
function setTimeControl(code, timeControl) {
  return db().collection(ROOM_COLLECTION).doc(code).update({ timeControl: timeControl || null });
}
function setClock(code, clock) {
  return db().collection(ROOM_COLLECTION).doc(code).update({ clock: clock });
}
/** その席の端末が今アニメーション中か (2026-10-29, per user request: "プレイヤーのターンになってもアニメーションが
 * 動いているうちは時間が減らないように") -- 中の間はサーバーの時刻(始まった時刻)、終わったらnull。 */
function setAnimating(code, seatId, on) {
  var update = {};
  update['animating.' + seatId] = on ? firebase.firestore.FieldValue.serverTimestamp() : null;
  return db().collection(ROOM_COLLECTION).doc(code).update(update);
}

/** 部屋の今の中身を1回だけ読む(無ければnull)。「ゲームに戻る」で、保存してある部屋がまだ続いているかの確認用。 */
function getRoom(code) {
  return db().collection(ROOM_COLLECTION).doc(code).get().then(function (snap) { return snap.exists ? snap.data() : null; });
}

/** 観戦できる部屋か確かめる(席は取らない)。
 * @throws {Error} .message: ROOM_NOT_FOUND / VERSION_MISMATCH / SPECTATE_NOT_ALLOWED */
function spectateRoom(code, appVersion) {
  var normalizedCode = code.trim();
  return db().collection(ROOM_COLLECTION).doc(normalizedCode).get().then(function (snap) {
    if (!snap.exists) throw new Error('ROOM_NOT_FOUND');
    var data = snap.data();
    if (data.appVersion && appVersion && data.appVersion !== appVersion) {
      var err = new Error('VERSION_MISMATCH');
      err.roomVersion = data.appVersion;
      throw err;
    }
    if (!data.spectatorsAllowed) throw new Error('SPECTATE_NOT_ALLOWED');
    return { code: normalizedCode, phase: data.phase };
  });
}

/** オンライン対戦の初期資源の選択を送る (2026-10-27、全員同時に選ぶため -- main.jsの
 * applyOnlineResourcePicks参照)。盤面の状態(state)ではなく、席ごとの別の欄(resourcePicks.P2 等)に書くので、
 * 何人が同時に送っても互いに消し合わない。反映するのはホストの端末。 */
function submitResourcePick(code, seatId, faceIds) {
  var update = {};
  update['resourcePicks.' + seatId] = faceIds;
  return db().collection(ROOM_COLLECTION).doc(code).update(update);
}

/** オンライン対戦の巻き戻し (2026-10-28, per user request: 設定の「巻き戻しOK/NG」を「すべての人間が巻き戻しOKだと
 * 巻き戻しできるようになる」+ オンラインは「戻す前に全員の同意」) -- main.jsのrequestOnlineRewind等を参照。
 * rewindOk.{席}: その席の設定(OK=true)。rewindRequest: 今出ている巻き戻しのお願い(1つだけ)
 *   { id, fromSeat, label, key:{round,playerId,nth}, state(戻す先の状態JSON), votes:{席:'ok'|'ng'}, createdAt }。
 * lastRewind: 最後に行った巻き戻し { id, fromSeat, label, key } -- 各端末はこれが変わったのを見て、届いた状態を
 * 相手の手番の再生なしで、すぐ反映する。 */
function setRewindOk(code, seatId, ok) {
  var update = {};
  update['rewindOk.' + seatId] = !!ok;
  return db().collection(ROOM_COLLECTION).doc(code).update(update);
}
/** @throws {Error} REWIND_BUSY (ほかのお願いがもう出ている) */
function requestRewind(code, request) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var data = snap.data() || {};
      if (data.rewindRequest) throw new Error('REWIND_BUSY');
      tx.update(ref, { rewindRequest: request });
    });
  });
}
function voteRewind(code, requestId, seatId, vote) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var data = snap.data() || {};
      if (!data.rewindRequest || data.rewindRequest.id !== requestId) return;
      var update = {};
      update['rewindRequest.votes.' + seatId] = vote;
      tx.update(ref, update);
    });
  });
}
function cancelRewind(code, requestId) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var data = snap.data() || {};
      if (!data.rewindRequest || data.rewindRequest.id !== requestId) return;
      tx.update(ref, { rewindRequest: null });
    });
  });
}
/** お願いした端末が、全員のOKを確認してから呼ぶ: 部屋の状態を戻す先の状態にし(番号を1つ進める)、お願いを消して
 * lastRewindに記録する。お願いが既に無い/別のものなら何もしない(null)。
 * @returns {Promise<number|null>} 書いた状態の番号 */
function applyRewind(code, requestId) {
  var ref = db().collection(ROOM_COLLECTION).doc(code);
  return db().runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var data = snap.data() || {};
      var req = data.rewindRequest;
      if (!req || req.id !== requestId) return null;
      var rev = (data.stateRev || 0) + 1;
      tx.update(ref, {
        state: req.state,
        stateRev: rev,
        rewindRequest: null,
        lastRewind: { id: req.id, fromSeat: req.fromSeat, label: req.label, key: req.key },
      });
      return rev;
    });
  });
}

// 実績バックアップ (2026-10-12, per user request: "実績解除のポイントをリセットするにはどうすればいい？"
// -> 「逆にうっかり消さないようにするには」-> 名前+パスワードでの復元案に発展)。プレイヤー自身が決めた
// 名前をドキュメントidとして1件だけ保存/上書きする(ランキングのような複数件の一覧ではない) -- このアプリに
// 認証機構が無い(このファイル冒頭own doc参照)のと同じ事情で、パスワードはmain.js側でのクライアント側
// ハッシュ比較のみ(RANKING_RESET_PASSWORD_HASHと同じ「カジュアルな誤操作防止」の脅威モデル、本物のアクセス
// 制御ではない)。ドキュメント自体にもpasswordHashを保存しておき、復元/改名時にmain.js側で突き合わせる。
var ACHIEVEMENT_BACKUP_COLLECTION = 'achievement_backup';

/** @returns {Promise<{passwordHash:string, achievements:object, updatedAt:string}|null>} null if no
 *   backup exists yet under this name. */
function loadAchievementBackup(name) {
  return db().collection(ACHIEVEMENT_BACKUP_COLLECTION).doc(name).get().then(function (doc) {
    return doc.exists ? doc.data() : null;
  });
}

/** Overwrites (or creates) the backup doc for `name` with the device's current achievements store --
 * called both for first-time setup and for every later auto-sync (main.js's
 * syncAchievementBackupIfIncreased, same "increase only" trigger as the existing achievement-ranking
 * total sync just above). */
function saveAchievementBackup(name, passwordHash, achievements) {
  return db().collection(ACHIEVEMENT_BACKUP_COLLECTION).doc(name).set({
    passwordHash: passwordHash,
    achievements: achievements,
    updatedAt: new Date().toISOString(),
  });
}

/** Used by the rename flow (main.js's handleAchievementBackupChangeClick): the new name's doc is written
 * first (via saveAchievementBackup), then the old one is deleted -- same data, new key. */
function deleteAchievementBackup(name) {
  return db().collection(ACHIEVEMENT_BACKUP_COLLECTION).doc(name).delete();
}

// バグ自動検知レポート (2026-10-16, per user request: AIの自動進行が異常(不正な手の選択/ターン内の異常な
// 手数/オンボーディングの異常な再突入)を検知して止まった時、ランキング用のreplays/とは別の専用置き場に
// 自動保存してほしい -- "バグ用のリプレイ置き場を作り そこに保存する"). Same 2-part split as ranking
// entries (small structured doc in Firestore + the big replay blob in Storage), just under its own
// collection/prefix so these never mix with (or get pruned alongside) ordinary ranking replays. See
// main.js's reportDetectedBugAndFreeze for the one place that calls both of these together.
var BUG_REPORT_COLLECTION = 'bugReports';
var BUG_REPLAY_STORAGE_PREFIX = 'bugReplays/';

/** Saves one bug-report's own diagnostic metadata (reason/playerId/round/resources/etc -- NOT the replay
 * itself, see saveBugReplay) as its own Firestore doc, keyed by the same id the replay blob uses. */
function saveBugReport(id, reportWithoutId) {
  return db().collection(BUG_REPORT_COLLECTION).doc(id).set(reportWithoutId);
}

/** Uploads replayHistory for a detected-bug incident -- same shape/format as saveReplay, just a separate
 * Storage prefix (bugReplays/ instead of replays/) so these never collide with or get swept up in
 * ranking-replay eviction/pruning. */
function saveBugReplay(id, replayHistory) {
  return storage().ref(BUG_REPLAY_STORAGE_PREFIX + id + '.json')
    .putString(JSON.stringify(replayHistory), 'raw', { contentType: 'application/json' });
}

/** バグ報告の掲示板 (2026-10-27、bug-board.js参照) -- 手で書いた報告と自動の報告を、新しい順に最大50件。
 * 自動の報告(main.jsのbuildAiBugReportInfo)も手で書いた報告もdetectedAt(ISO文字列)を持つので、それで並べる。 */
function listBugReports() {
  return db().collection(BUG_REPORT_COLLECTION).orderBy('detectedAt', 'desc').limit(50).get().then(function (snapshot) {
    return snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  });
}

/** @returns {Promise<object[]|null>} 報告に付いているリプレイ(無ければnull) -- loadReplayと同じ読み方。 */
function loadBugReplay(id) {
  var ref = storage().ref(BUG_REPLAY_STORAGE_PREFIX + id + '.json');
  return ref.getDownloadURL()
    .then(function (url) { return fetch(url); })
    .then(function (res) { return res.json(); })
    .catch(function () { return null; });
}

window.OnlineSync = {
  listRanking: listRanking,
  saveRankingEntry: saveRankingEntry,
  deleteRankingEntry: deleteRankingEntry,
  markRankingEntryOutdated: markRankingEntryOutdated,
  listAllRankingSorted: listAllRankingSorted,
  clearAllRanking: clearAllRanking,
  getOrCreateWeeklyEvalTable: getOrCreateWeeklyEvalTable,
  saveReplay: saveReplay,
  loadReplay: loadReplay,
  deleteReplay: deleteReplay,
  saveReplayFinal: saveReplayFinal,
  loadReplayFinal: loadReplayFinal,
  pruneOldWeeklyReplays: pruneOldWeeklyReplays,
  createRoom: createRoom,
  joinRoom: joinRoom,
  subscribeToRoom: subscribeToRoom,
  startRoom: startRoom,
  pushRoomState: pushRoomState,
  submitResourcePick: submitResourcePick,
  setSpectatorsAllowed: setSpectatorsAllowed,
  setTimeControl: setTimeControl,
  getRoom: getRoom,
  listPublicRooms: listPublicRooms,
  leaveRoom: leaveRoom,
  createPublicRoom: createPublicRoom,
  setClock: setClock,
  setAnimating: setAnimating,
  setRewindOk: setRewindOk,
  requestRewind: requestRewind,
  voteRewind: voteRewind,
  cancelRewind: cancelRewind,
  applyRewind: applyRewind,
  heartbeat: heartbeat,
  setAiTakeover: setAiTakeover,
  setHostSeat: setHostSeat,
  spectateRoom: spectateRoom,
  loadAchievementBackup: loadAchievementBackup,
  saveAchievementBackup: saveAchievementBackup,
  deleteAchievementBackup: deleteAchievementBackup,
  saveBugReport: saveBugReport,
  saveBugReplay: saveBugReplay,
  listBugReports: listBugReports,
  loadBugReplay: loadBugReplay,
};
})();
