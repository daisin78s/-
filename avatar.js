/* アバター (2026-11-15, per user「ストーリーでキャラクターがしゃべっているのをプレイヤーのアバターとして」) --
 * plain classic script (story.js/bug-board.jsと同じ)。main.js・story.jsの関数を呼ぶ(実行時に呼ぶだけなので読み込み順は
 * main.js/story.jsの後ならよい)。
 *
 * 決まり(per user回答):
 * ・好きなキャラクターを1人選ぶ(プロフィールのように)。選べるのは アレク・パトラ・スパル・セネカ・ネロ。第2章で
 *   「心配性な研究者セネカ」を解禁していればそれも。
 * ・解禁: ウィークリーで10位以内に入ったら、次の週の1週間。判定は「この端末から登録したウィークリーの記録が、先週の
 *   10位以内にあるか」(ログインが無いので端末ごと)。解禁されていない時はアバター無し。
 * ・同じキャラクターは選べない。ローカルは人間の席みんなが選べる(かぶりは不可)。オンラインは部屋の画面で、先に
 *   選んだ人が優先。AIがキャラクターになる時(main.jsのapplyStoryCharacterNames)、だれかのアバターとかぶるなら
 *   AIはそのキャラクターにならない。
 * ・出し方: 名前の欄に顔を足すだけ。名前・性格・ジョブは実際のまま。オンラインでは相手の画面にも出る(GameStateの
 *   player.avatar)。ランキングの行にも登録した時の顔。
 * ・セリフ: 第4章(4人対戦)の台本の「○○が△△に行く/カードを獲得する/…を使う」のセリフを、そのアバターの人が同じ
 *   行動をした時に、ストーリーと同じ形(下のセリフ欄と立ち絵)で少しだけ出す(ゲームは止めない)。1ラウンド目は
 *   1R用、2ラウンド目からは2R用。アレクの行動のセリフはまだ無いので、それまではセネカのセリフ。心配性なセネカも
 *   セネカのセリフ。設定「速度」がアニメーションONの時だけ。出ている間はオンラインの持ち時間は減らない
 *   (main.jsのlocalBlockingAnimationActive)。
 * ・どの行動をしたかは、進捗の記録(main.jsのnoteProgressがSTATE.progressLogに足すもの、オンラインでも全員に届く)
 *   から読む。 */

const AVATAR_DEFS = [
  { id: 'alek', name: 'アレク', img: 'assets/story-alek.webp', lines: 'セネカ' }, // アレクのセリフが書かれるまではセネカ
  { id: 'patra', name: 'パトラ', img: 'assets/story-patra.webp', lines: 'パトラ' },
  { id: 'spal', name: 'スパル', img: 'assets/story-spal.webp', lines: 'スパル' },
  { id: 'seneca', name: 'セネカ', img: 'assets/story-seneca.webp', lines: 'セネカ' },
  { id: 'senecaWorried', name: '心配性な研究者セネカ', character: 'セネカ', img: 'assets/story-seneca-worried.webp', lines: 'セネカ', needs: 'senecaWorried' },
  { id: 'nero', name: 'ネロ', img: 'assets/story-nero.webp', lines: 'ネロ' },
];
const AVATAR_TOP_N = 10;
const AVATAR_MY_WEEKLY_KEY = 'diceWpMyWeeklyEntries'; // この端末から登録したウィークリーの記録 [{id, weekId}]
const AVATAR_UNLOCK_CACHE_KEY = 'diceWpAvatarUnlock'; // { week: 今週のid, unlocked: bool } (週に1回だけ調べる)

let avatarUnlocked = false;

function avatarDef(id) { return AVATAR_DEFS.find((d) => d.id === id) || null; }
/** 同じ人かどうかの比べ方(セネカと心配性なセネカは同じ人)。 */
function avatarCharacterName(id) { const d = avatarDef(id); return d ? (d.character || d.name) : null; }

/** 今この端末で選べるアバター(心配性なセネカは第2章で解禁していれば)。 */
function avatarSelectableDefs() {
  return AVATAR_DEFS.filter((d) => d.needs !== 'senecaWorried' || (typeof storySenecaWorriedUnlocked === 'function' && storySenecaWorriedUnlocked()));
}

/* ---------- 解禁 ---------- */

function avatarLoadMyWeekly() {
  try { const v = JSON.parse(localStorage.getItem(AVATAR_MY_WEEKLY_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (err) { return []; }
}

/** main.jsのランキング登録(ウィークリー)から: この端末の記録として覚える。 */
function avatarRecordMyWeeklyEntry(entry) {
  if (!entry || !entry.id || !entry.weekId) return;
  const list = avatarLoadMyWeekly().filter((e) => e && e.id !== entry.id);
  list.push({ id: entry.id, weekId: entry.weekId });
  try { localStorage.setItem(AVATAR_MY_WEEKLY_KEY, JSON.stringify(list.slice(-40))); } catch (err) { /* 書けなくても続ける */ }
}

/** 先週のウィークリーの10位以内に、この端末の記録があるか。結果は今週の間だけ覚えておく。 */
function avatarRefreshUnlock() {
  const thisWeek = currentWeeklyChallengeId();
  const lastWeek = weeklyRankingIdForOffset(1);
  try {
    const cached = JSON.parse(localStorage.getItem(AVATAR_UNLOCK_CACHE_KEY) || 'null');
    if (cached && cached.week === thisWeek && cached.unlocked) { avatarUnlocked = true; return Promise.resolve(true); }
  } catch (err) { /* 読めなければ調べ直す */ }
  const mine = avatarLoadMyWeekly().filter((e) => e.weekId === lastWeek).map((e) => e.id);
  if (!mine.length || typeof RankingStorage === 'undefined') { avatarUnlocked = false; return Promise.resolve(false); }
  return RankingStorage.list('weekly', lastWeek).then((entries) => {
    const unlocked = entries.slice(0, AVATAR_TOP_N).some((e) => mine.includes(e.id));
    avatarUnlocked = unlocked;
    try { localStorage.setItem(AVATAR_UNLOCK_CACHE_KEY, JSON.stringify({ week: thisWeek, unlocked })); } catch (err) { /* ignore */ }
    if (unlocked) render(STATE);
    return unlocked;
  }).catch(() => false);
}

/* ---------- 名前の欄の顔・選ぶ画面 ---------- */

function avatarFaceImg(id, className) {
  const def = avatarDef(id);
  if (!def) return null;
  const img = document.createElement('img');
  img.className = className || 'avatar-face';
  img.src = def.img;
  img.alt = def.name;
  img.title = def.name;
  return img;
}

/** ローカル対戦で、この席のアバターを選べるか(オンラインは部屋の画面で選ぶ)。 */
function avatarCanPickLocal(state, player) {
  return avatarUnlocked && !onlineRoomCode && !replayMode && !tutorialModeActive
    && !(typeof storyRun !== 'undefined' && storyRun) && !isAiPlayer(player.id) && state.phase !== 'GAME_END';
}

/** renderPlayersから: 名前の欄の頭に顔(選べる時は押すと選ぶ画面)。 */
function avatarDecorateName(nameEl, state, player) {
  if (!nameEl || !player) return;
  const canPick = avatarCanPickLocal(state, player);
  if (!player.avatar && !canPick) return;
  let face = player.avatar ? avatarFaceImg(player.avatar, 'avatar-face avatar-face--panel') : null;
  if (!face) {
    face = el('span', 'avatar-face avatar-face--panel avatar-face--empty', '＋');
    face.title = 'アバターを選ぶ';
  }
  if (canPick) {
    face.classList.add('avatar-face--pickable');
    face.addEventListener('click', (e) => {
      e.stopPropagation();
      avatarOpenPicker({
        current: player.avatar || null,
        takenNames: avatarTakenNamesLocal(state, player.id),
        onPick: (id) => {
          if (id) player.avatar = id; else delete player.avatar;
          render(STATE);
        },
      });
    });
  }
  nameEl.insertBefore(face, nameEl.firstChild);
}

/** ローカル: ほかの席のアバターと、もうキャラクターになっているAIの名前(同じ人は選べない)。 */
function avatarTakenNamesLocal(state, playerId) {
  const names = new Set();
  for (const p of state.players) {
    if (p.id === playerId) continue;
    if (p.avatar) names.add(avatarCharacterName(p.avatar));
    else if (isAiPlayer(p.id) && AVATAR_DEFS.some((d) => d.name === p.name)) names.add(p.name);
  }
  return names;
}

/** 選ぶ画面。takenNames: ほかの人が使っている人(押せない)。onPick(id|null)。 */
function avatarOpenPicker({ current, takenNames, onPick }) {
  const old = document.getElementById('avatar-picker');
  if (old) old.remove();
  const overlay = el('div', 'avatar-picker');
  overlay.id = 'avatar-picker';
  const modal = el('div', 'avatar-picker__modal');
  modal.appendChild(el('div', 'avatar-picker__title', 'アバターを選ぶ'));
  const grid = el('div', 'avatar-picker__grid');
  const close = () => overlay.remove();
  for (const def of avatarSelectableDefs()) {
    const taken = takenNames.has(def.character || def.name);
    const btn = el('button', 'avatar-picker__item');
    btn.type = 'button';
    if (def.id === current) btn.classList.add('avatar-picker__item--current');
    btn.disabled = taken;
    btn.appendChild(avatarFaceImg(def.id, 'avatar-picker__img'));
    btn.appendChild(el('span', 'avatar-picker__name', def.name));
    if (taken) btn.appendChild(el('span', 'avatar-picker__taken', '使用中'));
    btn.addEventListener('click', () => { close(); onPick(def.id); });
    grid.appendChild(btn);
  }
  modal.appendChild(grid);
  const buttons = el('div', 'avatar-picker__buttons');
  const none = el('button', 'undo-button', 'アバターなし');
  none.type = 'button';
  none.addEventListener('click', () => { close(); onPick(null); });
  const cancel = el('button', 'undo-button', '閉じる');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  buttons.append(none, cancel);
  modal.appendChild(buttons);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

/** オンラインの部屋の画面(待ち合い)から: 自分の席のアバターを選ぶボタンの行。 */
function avatarAppendLobbyRow(body, roomData) {
  if (!avatarUnlocked || !roomData || !roomData.seats || !localSeatId || onlineSpectator) return;
  const mine = roomData.seats[localSeatId];
  if (!mine) return;
  const row = el('div', 'avatar-lobby-row');
  row.appendChild(el('span', 'ranking-row__opponents', 'アバター:'));
  const face = mine.avatar ? avatarFaceImg(mine.avatar, 'avatar-face avatar-face--lobby') : null;
  if (face) row.appendChild(face);
  const btn = el('button', 'undo-button', mine.avatar ? '変える' : '選ぶ');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    const taken = new Set();
    for (const [seatId, seat] of Object.entries(roomData.seats)) {
      if (seatId !== localSeatId && seat && seat.avatar) taken.add(avatarCharacterName(seat.avatar));
    }
    avatarOpenPicker({
      current: mine.avatar || null,
      takenNames: taken,
      onPick: (id) => {
        OnlineSync.setSeatAvatar(onlineRoomCode, localSeatId, id).catch((err) => {
          window.alert(err && err.message === 'AVATAR_TAKEN' ? 'ほかの人が先にそのキャラクターを選びました。ほかのキャラクターを選んでください' : `アバターを変えられませんでした: ${(err && err.message) || err}`);
        });
      },
    });
  });
  row.appendChild(btn);
  body.appendChild(row);
}

/* ---------- プレイ中のセリフ ---------- */

let avatarActionSegs = null; // { 1: [...], 2: [...] } 第4章の台本の行動のセリフ(ch4ActionSegments)
function avatarActions(round) {
  if (!avatarActionSegs) {
    avatarActionSegs = { 1: [], 2: [] };
    try {
      const rows = (window.STORY_CH4_SCRIPT || []).map((row, index) => ({ ...row, index }));
      const segs = ch4IntroSegments(rows, 0);
      avatarActionSegs = { 1: segs.actions || [], 2: segs.actions2 || [] };
    } catch (err) { /* 台本が読めなければセリフ無し */ }
  }
  // 3・4ラウンド目は、台本に書かれるまで2ラウンド目のセリフ(per user)。
  return round <= 1 ? avatarActionSegs[1] : avatarActionSegs[2];
}

/** 第4章のch4FindActionLineと同じ当てはめ方: info = { areaName, key(獲得/LVアップしたカード), upgrade, usedName }。 */
function avatarFindLines(linesName, round, info) {
  const actions = avatarActions(round).filter((a) => a.name === linesName);
  if (!actions.length) return null;
  const areaNameText = String(info.areaName || '').replace(/LV\d+$/, '');
  const key = info.key || null;
  const usedName = String(info.usedName || '').replace(/LV\d+$/, '');
  let cardName = '';
  try { cardName = key ? String(dataLoaderMod.getCardRow(INDEX, key).NAME || '') : ''; } catch (err) { cardName = ''; }
  const kind = key ? { A: '領地', B: '学問', C: '人材' }[key[0]] : null;
  const hit = actions.find((a) => {
    const others = /^(.+)以外のエリアに行く/.exec(a.event);
    if (others) return !!areaNameText && !key && !others[1].split(/[、,，]/).map((x) => x.trim()).includes(areaNameText);
    const go = /^(.+)に行く/.exec(a.event);
    if (go) return !!areaNameText && areaNameText === go[1].trim();
    const get = /(領地|学問|人材)カードを(獲得か[LV]{2}UP|獲得|[LV]{2}UP)/.exec(a.event);
    if (get) {
      if (kind !== get[1]) return false;
      if (/UP/.test(get[2]) && /獲得/.test(get[2])) return true;
      return /UP/.test(get[2]) ? !!info.upgrade : !info.upgrade;
    }
    const use = /^(.+)を使う/.exec(a.event);
    return !!use && !!usedName && usedName === use[1].trim();
  });
  if (!hit || !hit.rows.length) return null;
  const fill = (text) => text
    .replace(/獲得したエリア名/g, cardName.replace(/の支配.*$/, ''))
    .replace(/獲得したカード名/g, cardName.replace(/LV\d+$/, ''))
    .replace(/行ったエリア名/g, areaNameText)
    .replace(/使ったカード名/g, usedName);
  return hit.rows.map((r) => fill(r.text)).filter(Boolean);
}

let avatarLogSeen = null; // 読み終えた進捗の記録の長さ
let avatarLineQueue = [];
let avatarLineBusy = false;

function avatarLinesEnabled() {
  return aiPacingMode === 'anim' && !replayMode && !tutorialModeActive && !(typeof storyRun !== 'undefined' && storyRun);
}

/** render()の最後から: 増えた進捗の記録のうち、アバターのある人の行動からセリフを出す。 */
function avatarOnRender(state) {
  const log = (state && state.progressLog) || [];
  if (avatarLogSeen === null || log.length < avatarLogSeen || !avatarLinesEnabled()) { avatarLogSeen = log.length; return; }
  if (log.length === avatarLogSeen) return;
  const fresh = log.slice(avatarLogSeen);
  avatarLogSeen = log.length;
  // 人ごとに、行ったエリアと獲得したカードをまとめて1つの行動にする(第4章でAIの1手をまとめて見るのと同じ)。
  const byPlayer = new Map();
  for (const e of fresh) {
    const player = state.players.find((p) => p.id === e.p);
    if (!player || !avatarSpeakerDef(player)) continue;
    const info = byPlayer.get(player) || { round: e.r || state.round };
    if (e.a && !info.areaName) info.areaName = e.a;
    if (e.f && !info.key) { info.key = e.f; info.upgrade = !!e.u; if (e.v) info.usedName = e.v; }
    byPlayer.set(player, info);
  }
  for (const [player, info] of byPlayer) {
    const def = avatarSpeakerDef(player);
    if (!def) continue;
    const lines = avatarFindLines(def.lines, info.round, info);
    if (lines && lines.length) avatarLineQueue.push({ def, playerName: player.name, lines });
  }
  avatarPlayNext();
}

/** セリフを言う人: アバターのある人と、たまたまキャラクターになったAI(main.jsのapplyStoryCharacterNamesで名前が
 * キャラクターに変わったAI、2026-11-15 per user「AIがたまたまキャラになったときもセリフを言うように」)。
 * アレク・心配性なセネカのセリフはセネカ(アバターと同じ)。 */
function avatarSpeakerDef(player) {
  if (player.avatar) return avatarDef(player.avatar);
  if (!isAiPlayer(player.id) || !player.conPhysicalId || !player.conFace || !player.jobCardId) return null;
  const character = STORY_CHARACTER_BY_TITLE[rankingConJobTitle(`${player.conPhysicalId}${player.conFace}`, player.jobCardId)];
  if (!character || player.name !== character.name) return null;
  return { name: character.name, img: character.img, lines: character.name === 'アレク' ? 'セネカ' : character.name };
}

function avatarLineActive() { return avatarLineBusy; }

function avatarPlayNext() {
  if (avatarLineBusy || !avatarLineQueue.length) return;
  avatarLineBusy = true;
  const { def, playerName, lines } = avatarLineQueue.shift();
  const root = el('div', 'story-overlay avatar-line-overlay');
  const portrait = document.createElement('img');
  portrait.className = 'story-alek';
  portrait.src = def.img;
  portrait.alt = '';
  const dialog = el('div', 'story-dialog');
  dialog.appendChild(el('div', 'story-dialog__name', playerName));
  const text = el('div', 'story-dialog__text');
  dialog.appendChild(text);
  root.append(portrait, dialog);
  document.body.appendChild(root);
  portrait.animate([{ opacity: 0, transform: 'translateX(-30px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 250, easing: 'ease-out' });
  let i = 0;
  const showLine = () => {
    const line = lines[i];
    text.textContent = '';
    if (typeof storyIconize === 'function' && typeof storyLineFragment === 'function') text.appendChild(storyLineFragment(storyIconize(line)));
    else text.textContent = line;
    // 言ってすぐに消える(per user「セリフを言ってすぐに消え」): 長さに合わせて1〜2.4秒ほど。
    const ms = Math.min(2400, 900 + line.length * 70);
    setTimeout(() => {
      i += 1;
      if (i < lines.length) { showLine(); return; }
      root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).onfinish = () => {
        root.remove();
        avatarLineBusy = false;
        avatarPlayNext();
      };
    }, ms);
  };
  showLine();
}

/* ---------- 読み込み時 ---------- */
try { avatarRefreshUnlock(); } catch (err) { /* オフラインなどでは解禁なしのまま */ }
