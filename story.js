/* ストーリーモード (2026-10-23, per user request: "ストーリーモードを実装したい ... スマホだとチュートリアルが
 * ほぼできない そのためスマホに特化したストーリーモードを作る PCやタブレットは後で対応させる" + 回答:
 * 入口の「デザイナーズノート」ボタンを「ストーリー」に、セリフはストーリー専用の表示(立ち絵+名前付きの
 * 会話ウインドウ)、全体の形は「小さな場面の連続」、ファンファーレは見た目だけ、"セリフは基本的にボタンを
 * 押さずに自動で進む")。
 *
 * 台本: data/story.data.js (window.STORY_SCRIPT)。2026-11-14から再びデスクトップのストーリー.xlsxの1枚目のシート
 * (怠惰なローマ市民アレク)が元(per user「エクセルです」、tools/story_xlsx_to_js.pyで変換。2026-10-27〜11-13はTwine)。S001などのパッセージ番号で引く。
 * デスクトップのストーリー.xlsxの光る/メモ列の指示は、このファイルの場面ごとの関数にコードとして書く。
 *
 * 画面はローカル対戦の本物のエリア画面を使う (2026-10-23, per user request: "基本的にローカル対戦のエリア
 * 画面を使ってください エリアの農園の位置 右側もダイス置き場と同じ 他のエリアは枠だけ見えてそれ以外は
 * 見えない") -- 練習用のGameStateを作ってSTATEと入れ替え、普段のrender()で描く(ダイスの選択・スロットへの
 * 配置・資源の増加・カードの獲得・使用料・フリーアクションは本物のゲームの処理そのまま)。その上に透明な
 * オーバーレイ(立ち絵・会話ウインドウ・今やること・ログ・✖)を重ねる。見せないもの(他のエリアの中身、
 * ターン終了ボタン等)はbody.story-modeのCSSで隠し、タブは場面ごとに許したものだけ押せる/スワイプできる
 * (storyTabAllowed、main.jsのタブ切り替えから呼ばれる)。描き直されるたびにmain.jsのrender()から
 * storyAfterRender()が呼ばれ、光る演出などを付け直す。練習用の盤面は「進行中のゲーム」として保存しない
 * (saveGameSessionIfApplicable参照)。AIは自動では動かさない(aiPacingMode='manual')-- パトラ(P2)の手は
 * この台本が本物のゲームの処理を直接呼んで進める。✖/トップに戻るは再読み込みでトップ画面へ。
 * main.jsの後に読み込む。 */

const STORY_TYPE_MS_PER_CHAR = 37; // 1文字ずつ出る速さ (2026-10-23 per user "セリフの表示速度1.5倍に": 55ms→37ms)
const STORY_HOLD_BASE_MS = 930; // 全文出てから次へ進むまでの待ち(+文字数ぶん) (2026-10-23 per user "それも1.5倍に": 1400→930、1文字45→30ms)
const STORY_HOLD_PER_CHAR_MS = 30;
// 「次へ」(2026-11-01, per user「次へ ボタンを押すと 次に進むように 次へを押しっぱなしで 高速スキップ」):
// セリフ枠のどこをタップしても次へ(右下に小さく「次へ▷」)。1文字ずつ出ている途中なら、まず全文を出す。
// STORY_SKIP_HOLD_MS押し続けると高速スキップ(離すまでSTORY_SKIP_STEP_MSごとに次のセリフへ)。
const STORY_SKIP_HOLD_MS = 400;
const STORY_SKIP_STEP_MS = 90;
const STORY_HINT_IDLE_MS = 5000; // 何もしない場合5秒ごとに出る
const STORY_HINT_SHOW_MS = 2600; // 出てすぐ消える(全文が出てからこの時間で消える)

const STORY_SPEAKERS = {
  alek: { name: 'アレク', img: 'assets/story-alek.webp' },
  unknown: { name: '？？？', img: null },
  patra: { name: 'パトラ', img: 'assets/story-patra.webp' },
  nero: { name: 'ネロ', img: 'assets/story-nero.webp' },
  spal: { name: 'スパル', img: 'assets/story-spal.webp' },
  seneca: { name: 'セネカ', img: 'assets/story-seneca.webp' },
  spalAway: { name: 'スパル', img: null }, // 第2章: スパルが立ち去っている間(立ち絵を消す)
  senecaAway: { name: 'セネカ', img: null }, // セネカの章: ショップの一番左を光らせている間(スマホでは立ち絵が重なるので消す)
  system: { name: '', img: null }, // お知らせ(強制パスなど): 名前も立ち絵も無し
};

let storyRun = null; // 実行中の場面。nullなら閉じている。

function storyLine(id) {
  const script = window.STORY_SCRIPT || {};
  return script[id] || { text: '' };
}
/** そのパッセージの最初の選択肢の文言(上に出す「今やること」に使う)。「次へ」は使わない。 */
function storyGoalOf(id) {
  const choice = (storyLine(id).choices || []).find((c) => c.label !== '次へ' && !/秒経過/.test(c.label));
  return choice ? choice.label : '';
}

/* ---------- 時間待ち(会話ログを開いている間は止まる) ---------- */

function storyLater(fn, ms) {
  if (!storyRun) return null;
  const run = storyRun;
  const token = { fn, remaining: ms, due: 0, handle: null };
  run.timers.add(token);
  if (!run.paused) storyStartTimer(run, token);
  return token;
}
function storyStartTimer(run, token) {
  token.due = performance.now() + token.remaining;
  token.handle = setTimeout(() => {
    run.timers.delete(token);
    if (storyRun === run) token.fn();
  }, token.remaining);
}
function storyCancel(token) {
  if (!token || !storyRun) return;
  clearTimeout(token.handle);
  storyRun.timers.delete(token);
}
function storyPause() {
  const run = storyRun;
  if (!run || run.paused) return;
  run.paused = true;
  const now = performance.now();
  run.timers.forEach((token) => {
    clearTimeout(token.handle);
    token.remaining = Math.max(0, token.due - now);
  });
}
function storyResume() {
  const run = storyRun;
  if (!run || !run.paused) return;
  run.paused = false;
  run.timers.forEach((token) => storyStartTimer(run, token));
}

function storyHoldMs(text) {
  return STORY_HOLD_BASE_MS + text.length * STORY_HOLD_PER_CHAR_MS;
}

/* ---------- 会話ウインドウ・立ち絵 ---------- */

/** 話している人を変える(名前と立ち絵)。立ち絵が変わる時は、今の絵が消えて新しい絵が下から出てくる。 */
function storySetSpeaker(key) {
  const run = storyRun;
  if (!run || run.speaker === key) return;
  run.speaker = key;
  const speaker = STORY_SPEAKERS[key];
  run.dom.dialogName.textContent = speaker.name;
  const portrait = run.dom.portrait;
  const currentSrc = portrait.dataset.src || '';
  const nextSrc = speaker.img || '';
  if (currentSrc === nextSrc) return;
  portrait.dataset.src = nextSrc;
  const show = () => {
    if (!nextSrc) { portrait.hidden = true; return; }
    portrait.src = nextSrc;
    portrait.alt = speaker.name;
    portrait.hidden = false;
    portrait.animate([{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  };
  if (portrait.hidden || !currentSrc) { show(); return; }
  const a = portrait.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: 'ease-in', fill: 'forwards' });
  a.onfinish = () => { a.cancel(); show(); };
}

/* セリフの中の資源の文字 A/B/C/Z/K は資源のアイコンで出す (2026-10-31, per user「これから ABCZKは そのアイコンを
 * 表示するように」)。前後に英字が続く所(ANY、LVなど)はそのまま。1文字ずつ出す時にアイコン1個を1文字として
 * 数えるよう、先に私用文字(+番号)に置き換えておき、表示の時にアイコンへ戻す。 */
const STORY_ICON_RESOURCES = ['A', 'B', 'C', 'Z', 'K'];
function storyIconize(text) {
  // 食料の意味の〇もアイコンで (2026-11-13, per user「基本 食料 という意味で 〇 となっていたら アイコンで」)。
  // 数字を入れる所の〇(「〇VP」「〇枚」「合計は〇だね」)は、その前に数字に置き換わっているのでそのまま。
  text = text.replace(/〇(?!\s*(VP|枚|だね))/g, 'K');
  return text.replace(/(?<![A-Za-z])[ABCZK](?![A-Za-z])/g, (ch) => String.fromCharCode(0xE000 + STORY_ICON_RESOURCES.indexOf(ch)));
}
/** storyIconizeした文章 -> 資源アイコン + 性格・ジョブの名前に色を付けた文章。 */
// 強調(赤字)の始まり/終わりの印 (第3章「…を強調して赤字で」、story2DoEvent参照)。
const STORY_EMPH_START = '';
const STORY_EMPH_END = '';
function storyLineFragment(text) {
  const frag = document.createDocumentFragment();
  let target = frag;
  let plain = '';
  const flush = () => { if (plain) { target.appendChild(conJobColoredFragment(plain)); plain = ''; } };
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xE000;
    if (ch === STORY_EMPH_START) {
      flush();
      target = el('span', 'story-emph');
      frag.appendChild(target);
    } else if (ch === STORY_EMPH_END) {
      flush();
      target = frag;
    } else if (code >= 0 && code < STORY_ICON_RESOURCES.length) {
      flush();
      target.appendChild(actionDot(STORY_ICON_RESOURCES[code]));
    } else {
      plain += ch;
    }
  }
  flush();
  return frag;
}

/** 会話ウインドウにセリフを1文字ずつ出す。全部出たらonTyped()。textを渡すとそちらを出す(差し込みあり等)。 */
function storySay(id, onTyped, textOverride, waitsForNext) {
  const run = storyRun;
  if (!run) return;
  run.waitingNext = null;
  run.typeFinish = null;
  run.dom.nextHint.hidden = true;
  const text = textOverride !== undefined ? textOverride : storyLine(id).text;
  // 会話ログ用に記録(5秒ごとに出るヒントなど、同じセリフは1回だけ)。
  if (text && !run.log.some((e) => e.id === id)) run.log.push({ id, text: text.replace(/[]/g, ''), speaker: STORY_SPEAKERS[run.speaker].name });
  if (!text) { if (onTyped) onTyped(text); return; }
  const box = run.dom.dialog;
  const body = run.dom.dialogText;
  run.dialogSeq = (run.dialogSeq || 0) + 1; // 隠している途中の storyHideDialog に「また出した」と知らせる
  box.hidden = false;
  box.dataset.lineId = id;
  // 「次へ」で進むセリフだけタップを受ける(やることを指示するセリフは、下の盤面を押せるよう素通しのまま)。
  box.classList.toggle('story-dialog--tappable', !!waitsForNext);
  body.textContent = '';
  storyCancel(run.typeTimer);
  let i = 0;
  const shown = storyIconize(text);
  const step = () => {
    i = run.skipping ? shown.length : i + 1; // 高速スキップ中は全文を一度に
    body.textContent = '';
    body.appendChild(storyLineFragment(shown.slice(0, i))); // 資源はアイコン、性格・ジョブの名前は色付き
    if (i < shown.length) run.typeTimer = storyLater(step, STORY_TYPE_MS_PER_CHAR);
    else { run.typeTimer = null; run.typeFinish = null; if (onTyped) onTyped(text); }
  };
  // 途中で「次へ」を押したら全文を出す(per user「全文を一気に出す」)。
  run.typeFinish = waitsForNext ? () => { storyCancel(run.typeTimer); i = shown.length - 1; step(); } : null;
  box.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 220, easing: 'ease-out' });
  run.typeTimer = storyLater(step, 120);
}

/** セリフを出して、「次へ」(セリフ枠のタップ)でnext()。extraMsは昔の自動送りの待ちの延長で、今は使わない。 */
function storySayThen(id, next, extraMs, textOverride) {
  storySay(id, (text) => (text ? storyWaitNext(next) : next()), textOverride, true);
}

/** 全文が出たセリフで「次へ」を待つ。高速スキップ中はすぐ進む。 */
function storyWaitNext(next) {
  const run = storyRun;
  if (!run) return;
  run.waitingNext = next;
  run.dom.nextHint.hidden = false;
  if (run.skipping) storyLater(storyAdvance, STORY_SKIP_STEP_MS);
}

/** 「次へ」: 1文字ずつ出ている途中なら全文を出す。出終わっていれば次へ。 */
function storyAdvance() {
  const run = storyRun;
  if (!run || run.paused) return;
  if (run.typeFinish) { run.typeFinish(); return; }
  const next = run.waitingNext;
  if (!next) return;
  run.waitingNext = null;
  run.dom.nextHint.hidden = true;
  next();
}

/** セリフ枠: タップで次へ、押し続けると離すまで高速スキップ。 */
function storySetupNextTap(box) {
  let holdTimer = null;
  let down = false;
  const release = (tap) => {
    if (!down || !storyRun) return;
    down = false;
    clearTimeout(holdTimer);
    if (storyRun.skipping) storyRun.skipping = false;
    else if (tap) storyAdvance();
  };
  box.addEventListener('pointerdown', (e) => {
    if (!storyRun || !box.classList.contains('story-dialog--tappable')) return;
    e.preventDefault();
    down = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!down || !storyRun) return;
      storyRun.skipping = true;
      storyAdvance();
    }, STORY_SKIP_HOLD_MS);
  });
  box.addEventListener('pointerup', () => release(true));
  box.addEventListener('pointercancel', () => release(false));
  box.addEventListener('pointerleave', () => release(false));
  box.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しのメニューを出さない
}

/** 続けて出すセリフを順番に。最後にnext()。 */
function storySaySeq(ids, next) {
  if (ids.length === 0) { next(); return; }
  storySayThen(ids[0], () => storySaySeq(ids.slice(1), next));
}

function storyHideDialog() {
  if (!storyRun) return;
  const box = storyRun.dom.dialog;
  if (box.hidden) return;
  storyCancel(storyRun.typeTimer);
  const seq = storyRun.dialogSeq;
  const a = box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in' });
  // 消している途中に次のセリフが出たら(storySay)、そのセリフは消さない。
  a.onfinish = () => { if (storyRun && storyRun.dialogSeq === seq) box.hidden = true; };
}

/** 画面上部に、今やること(台本の選択肢の文言)を左から流して出す。空文字で消す。 */
function storyShowGoal(text) {
  if (!storyRun) return;
  const goal = storyRun.dom.goal;
  goal.hidden = !text;
  goal.textContent = text || '';
  if (text) {
    goal.animate([{ transform: 'translateX(-110%)' }, { transform: 'translateX(0)' }],
      { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  }
}

/* ---------- 本物の画面との橋渡し ---------- */

/** 練習用のGameStateを作る: あなた(P1)と、後で登場するパトラ(P2)。P2〜P4のダイスはパス済みにして手番が
 * 来ないようにしておく(パトラは登場時に戻す)。JOB/制約は効果の少ないものを持たせ、資源は0から。 */
/** cons: 性格の山札 {P1, P2}(省略時は第1章: あなた=怠惰、パトラ=幸運)。 */
function storyBuildState(diceValues, cons) {
  const state = gameStateMod.createEmptyGameState('story-fixed-1');
  // あなたの名前: ランキング登録で使った名前があればそれ、無ければ「あなた」 (2026-10-31, per user)。
  setupMod.createPlayers(state, [(loadRememberedRankingName() || '').trim() || 'あなた', 'パトラ', 'Carol', 'Dan']);
  setupMod.prepareMaps(state, INDEX);
  setupMod.prepareShops(state, INDEX);
  // ショップに並ぶのは「ローマ市街の支配LV1」(A001A)だけ、他は無し (2026-10-24, per user: "ローマ市街の支配"
  // "他はなし")。モニュメント・SHOP201〜203・山札・追加モニュメントも空にする。
  for (const shop of Object.values(state.shops)) {
    Object.keys(shop.slots).forEach((slotId) => { shop.slots[slotId] = null; });
    shop.drawPile = [];
  }
  state.shops.NORMAL.slots.SHOP101 = 'A001A';
  state.extraMonumentPool = [];
  setupMod.rollInitialColorDice(state, { P1: diceValues });
  // パトラは「心配性な巫女」(2026-11-02, per user) -- 心配(CON006A)+巫女(JOB002)。
  setupMod.dealConCards(state, cons || { P1: 'CON005', P2: 'CON006' });
  state.jobPool = ['JOB001', 'JOB002'];
  setupMod.chooseJob(state, INDEX, 'P1', 'JOB001');
  setupMod.chooseJob(state, INDEX, 'P2', 'JOB002');
  // 2026-11-02の性格の並び替えで、怠惰はCON005A -> CON005Bへ移った(CON005Aは今は憤怒)。ストーリーの動きを変えない
  // よう、CON005は怠惰の面を使う。
  const storyConFace = (playerId) => (state.players.find((p) => p.id === playerId).conPhysicalId === 'CON005' ? 'B' : 'A');
  setupMod.chooseConFace(state, INDEX, 'P1', storyConFace('P1'));
  setupMod.chooseConFace(state, INDEX, 'P2', storyConFace('P2'));
  // 第1章のパトラ(心配性な巫女)は、心配の能力(ターン終了時〇0で-1VP)を止める (2026-11-02, per user「第１章では 能力止めて」)。
  const patra = state.players.find((p) => p.id === 'P2');
  if (patra.conPhysicalId === 'CON006') patra.worryAbilityDisabled = true;
  // 第1章のパトラの初期ダイスは色ダイス3個だけ、白ダイスは無し (2026-11-07, per user) -- 心配の獲得時(ONCE)の白ダイスを取り除く。
  if (!cons) patra.dice = patra.dice.filter((d) => d.kind !== 'WHITE');
  // パトラの所有カード「基礎学問LV1」(Excel S041メモ)。ONCE(白ダイス)は使わず持っているだけ。
  state.cards.B001.ownerId = 'P2';
  state.players.find((p) => p.id === 'P2').ownedCardPhysicalIds.push('B001');
  qstMod.setupQuests(state);
  for (const player of state.players) {
    Object.keys(player.resources).forEach((r) => { player.resources[r] = 0; });
    if (player.id !== 'P1') player.dice.forEach((d) => { d.passed = true; });
  }
  state.turnOrder = state.players.map((p) => p.id);
  state.currentPlayerIndex = 0;
  turnFlowMod.startRound(state);
  return state;
}

function storyUseState(state) {
  Object.keys(STATE).forEach((k) => delete STATE[k]);
  Object.assign(STATE, state);
  selectedDieIds = [];
  turnActionTaken = false;
  // カード獲得などの演出の比較の基準を作り直す(トップ画面の空の状態と比べて「獲得した」と出ないように)。
  lastAiCardFaces = null;
  lastHumanTapped = null;
}

function storyPlayer(id) {
  return STATE.players.find((p) => p.id === id);
}

/** 手元のダイス置き場(スマホは画面右)にある、そのプレイヤーのダイスの要素。 */
function storyHandDiceNodes(playerId) {
  const id = playerId || 'P1';
  return [...document.querySelectorAll(`#mobile-own-row .die[data-die-key^="${id}:"], #players .player-panel[data-player-id="${id}"] .die`)]
    .filter((n) => n.getBoundingClientRect().width > 0);
}
function storyTileNode(mapId) {
  return document.querySelector(`#board .map-tile[data-map-id="${mapId}"]`);
}
function storyTileSelector(mapId, inner) {
  return `#board .map-tile[data-map-id="${mapId}"]${inner ? ` ${inner}` : ''}`;
}

/** main.jsのrender()から毎回呼ばれる: 描き直された画面に、場面の演出(ダイスを隠す/光らせる等)を付け直し、
 * 場面の進行条件(ダイスが置かれた等)を確かめる。 */
function storyAfterRender(state) {
  const run = storyRun;
  if (!run) return;
  document.body.classList.toggle('story-hide-dice', !run.diceShown);
  // 先に進行条件を確かめる(置き終わった瞬間に残りのダイスの光を消すため)。
  if (run.onRender) run.onRender(state);
  if (run.glowDieValues.length > 0) {
    for (const node of storyHandDiceNodes('P1')) {
      if (run.glowDieValues.includes(Number(node.textContent.trim()))) node.classList.add('change-highlight');
    }
  }
  if (run.shopOverrides) storyApplyShopOverrides(run.shopOverrides);
  // 第3章のモニュメントのラウンド(スマホ): ショップはモニュメントの段だけ。下の段(空きの通常カード欄・ラウンドと
  // 順位)は隠して、背の低い画面でも一番上の段が見切れないように(2026-11-12, per user「下部分いらない情報なので
  // 一番上も見えるように」)。
  if (run.chapter2 && run.chapter2.monumentRound && isMobileLayout()) {
    const grid = document.getElementById('shop-combined-slots');
    if (grid) for (const node of grid.children) if (node.style.gridRow && node.style.gridRow !== '1') node.style.display = 'none';
  }
  if (run.chapter2) story2SoloStandings();
  storyApplyGlow();
  if (run.resourceOverride) storyApplyResourceOverride(run.resourceOverride);
}

/** 第2章の順位表は「1位 あなた」だけ (per user「１位あなた ２位以下消す」): ほかの人の欄を消し、自分を1位に。 */
function story2SoloStandings() {
  document.querySelectorAll('.standings-panel__cell').forEach((cell) => {
    if (cell.dataset.playerId !== 'P1') { cell.remove(); return; }
    const place = cell.querySelector('.standings-panel__place');
    if (place) place.textContent = '1位';
  });
}

/** 第2章のショップの見た目 (story2DoEventの「次のラウンドから」「SHOP201、202、203見えなくする」): 描き直す
 * たびにショップの1段目(SHOP001-006)を裏向き+文字に、3段目(SHOP201-203とその残り枚数)を隠す。見た目だけ。 */
function storyApplyShopOverrides(overrides) {
  const grid = document.getElementById('shop-combined-slots');
  if (!grid) return;
  for (const node of grid.children) {
    const row = node.style.gridRow;
    if (overrides.monumentLabel && row === '1' && node.classList.contains('shop-slot')) {
      const card = node.querySelector('.shop-slot__card');
      card.innerHTML = '';
      const facedown = el('div', 'shop-card shop-card--facedown');
      facedown.appendChild(el('span', null, overrides.monumentLabel));
      card.appendChild(facedown);
      node.querySelector('.shop-slot__req').textContent = '';
    }
    if (overrides.hideSpecial && row === '3' && (node.classList.contains('shop-slot') || node.classList.contains('shop-remaining-count'))) {
      node.style.visibility = 'hidden';
    }
  }
}

/** 「ターン2」「ターン3」 (2026-10-31, per user: 普段の対戦と同じ演出、ラウンドごとに1から。2026-11-11, per user
 * 回答「全章でターン1も出す」: ターン1も出す)。
 * 2026-11-11, per user「ダイスが置けるようになったときに ターン〇 と出るようにしてほしい」「それ以外はでない」
 * (全部の章): 置いた直後に次の手番を出すのをやめ、あなたのダイスが置けるようになった時(storyWaitForPlacement)
 * だけ出す。相手の手番には出さない。普段の対戦の手番の表示(main.jsのplayPendingTurnBanner)はストーリーでは
 * 出さない。何個目のダイスを置く番か(置いた/パスしたダイスの数+1)。同じ表示は一度だけ(巻き戻すと数え直す)。 */
function storyTurnBannerWhenPlaceable(state) {
  const run = storyRun;
  if (!run.diceShown || state.phase === 'GAME_END') return;
  const player = state.players.find((p) => p.id === 'P1');
  // 置けるダイスがない時(ダイスを使い切ってカードのタップで続ける時など)は出さない(2026-11-12, per user)。
  if (!player.dice.some((d) => !d.placedMapId && !d.passed && storyPlaceableSlots('P1', d.id, run.visibleMapIds).length > 0)) return;
  // 何番目の手番か: ダイスの数ではなく置いた回数で数える(2個まとめて置いてモニュメントを獲得しても1回、
  // 2026-11-12 per user「ダイスを２個使ってモニュメントを獲得するとターン1からターン3に飛びます」)。前に見た時より
  // 置いたダイスが増えていれば1回分。ラウンドが替わった・巻き戻して減った時は、置いた数から数え直す。
  const used = player.dice.filter((d) => d.placedMapId || d.passed).length;
  const tc = run.turnCounter;
  if (!tc || tc.round !== state.round || used < tc.used) run.turnCounter = { round: state.round, used, nth: used + 1 };
  else if (used > tc.used) run.turnCounter = { round: state.round, used, nth: tc.nth + 1 };
  const nth = run.turnCounter.nth;
  const key = `${state.round}/${player.id}/${nth}`;
  run.turnBannerKeys = run.turnBannerKeys || new Set();
  if (run.turnBannerKeys.has(key)) return;
  run.turnBannerKeys.add(key);
  const conFaceId = player.conPhysicalId && player.conFace ? `${player.conPhysicalId}${player.conFace}` : null;
  const title = conFaceId && player.jobCardId ? rankingConJobTitle(conFaceId, player.jobCardId) : '';
  playRoundBanner(state.round, `${title && title !== '—' ? title : ''}${player.name} ターン${nth}`, 'round-banner--turn');
}

/** 光らせる場所(CSSセレクタ)を決める。描き直されても付け直す。 */
function storySetGlow(selectors) {
  const run = storyRun;
  if (!run) return;
  document.querySelectorAll('.story-glow').forEach((n) => n.classList.remove('story-glow', 'change-highlight'));
  run.glowSelectors = selectors || [];
  storyApplyGlow();
}
function storyApplyGlow() {
  const run = storyRun;
  if (!run) return;
  for (const selector of run.glowSelectors) {
    document.querySelectorAll(selector).forEach((n) => n.classList.add('story-glow', 'change-highlight'));
  }
}

/** 押せる(スワイプで行ける)タブを決める。それ以外のタブは薄く表示され押せない。 */
function storySetAllowedTabs(tabs) {
  const run = storyRun;
  if (!run) return;
  run.allowedTabs = new Set(tabs);
  document.querySelectorAll('.mobile-tab-switcher__btn').forEach((btn) => {
    btn.classList.toggle('story-tab-allowed', run.allowedTabs.has(btn.dataset.tabTarget));
  });
}
/** main.jsのタブ切り替え(ボタン/スワイプ)から呼ばれる。ストーリー中は許したタブにしか行けない。 */
function storyTabAllowed(tab) {
  return !storyRun || storyRun.normalGame || storyRun.allowedTabs.has(tab);
}

/** ダイスをその場で振る演出(回転しながら跳ねる、目がくるくる変わって決まった目で止まる)。 */
function storyRollHandDice(onDone, playerId) {
  storyRun.diceShown = true;
  document.body.classList.remove('story-hide-dice');
  const nodes = storyHandDiceNodes(playerId);
  const ROLL_MS = 900;
  nodes.forEach((node, i) => {
    const valueEl = node.querySelector('.die__value');
    const finalText = valueEl.textContent;
    const spin = (i % 2 ? -1 : 1) * 720;
    const duration = ROLL_MS + i * 120;
    node.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: `translateY(-26px) rotate(${spin * 0.35}deg)`, offset: 0.25 },
      { transform: `translateY(0) rotate(${spin * 0.6}deg)`, offset: 0.5 },
      { transform: `translateY(-10px) rotate(${spin * 0.85}deg)`, offset: 0.72 },
      { transform: `translateY(0) rotate(${spin}deg)` },
    ], { duration, easing: 'ease-out' });
    for (let t = 0; t < duration - 90; t += 90) {
      storyLater(() => { valueEl.textContent = String(1 + Math.floor(Math.random() * 6)); }, t);
    }
    storyLater(() => { valueEl.textContent = finalText; }, duration);
  });
  storyLater(onDone, ROLL_MS + Math.max(0, nodes.length - 1) * 120 + 150);
}

/** ファンファーレ(見た目だけ): エリアが光り、もらえる物(アクションのアイコン)がエリアから飛び出し、紙吹雪。 */
function storyFanfare(mapId, onDone) {
  const run = storyRun;
  const tile = storyTileNode(mapId);
  const areaRow = dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId);
  if (tile) tile.classList.add('story-area--success');
  const rect = tile ? tile.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  const icons = buildActionIcons(areaRow.ACTION);
  const reward = el('div', 'story-reward');
  if (icons) reward.appendChild(icons);
  else reward.textContent = areaRow.ACTION;
  reward.style.left = `${rect.left + rect.width / 2}px`;
  reward.style.top = `${rect.top + rect.height * 0.4}px`;
  run.dom.root.appendChild(reward);
  reward.animate([
    { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0 },
    { transform: 'translate(-50%, -110%) scale(1.25)', opacity: 1, offset: 0.35 },
    { transform: 'translate(-50%, -120%) scale(1)', opacity: 1, offset: 0.8 },
    { transform: 'translate(-50%, -150%) scale(1)', opacity: 0 },
  ], { duration: 1900, easing: 'ease-out', fill: 'forwards' });
  if (typeof launchLifeStoryConfetti === 'function') launchLifeStoryConfetti(1);
  storyLater(() => {
    reward.remove();
    const t = storyTileNode(mapId);
    if (t) t.classList.remove('story-area--success');
    onDone();
  }, 2000);
}

/* ---------- 場面の共通部品 ---------- */

/** 「何もしない場合N秒ごとにhintLineIdのセリフが出てきてすぐ消える」の繰り返し。画面を触ると数え直す。
 * 戻り値のstop()で止める。 */
function storyStartHint(hintLineId, idleMs) {
  const run = storyRun;
  let stopped = false;
  let timer = null;
  const arm = () => {
    if (stopped) return;
    storyCancel(timer);
    timer = storyLater(() => {
      if (stopped) return;
      storySay(hintLineId, () => {
        timer = storyLater(() => {
          if (stopped) return;
          storyHideDialog();
          arm();
        }, STORY_HINT_SHOW_MS);
      });
    }, idleMs || STORY_HINT_IDLE_MS);
  };
  run.onTap = arm;
  arm();
  return () => {
    stopped = true;
    storyCancel(timer);
    if (run.onTap === arm) run.onTap = null;
  };
}

/** 条件がそろうまで待つ(150msごとに確かめる)。そろったらonDone()。 */
function storyWaitUntil(check, onDone) {
  const loop = () => {
    if (check()) onDone();
    else storyLater(loop, 150);
  };
  loop();
}

/** 全エリアについて、あなた(P1)のダイスが今いくつ置かれているか。 */
function storyPlacementCounts(state) {
  return Object.fromEntries(Object.keys(state.maps).map((m) => [m, storyP1DiceCount(state, [m])]));
}

function storyP1DiceCount(state, mapIds) {
  return mapIds.reduce((n, mapId) => n + state.maps[mapId].slots.reduce((m, occ) => m + occ.filter((o) => o.playerId === 'P1').length, 0), 0);
}

/** 「エリアにダイスを置く」場面: dieValuesのダイスを光らせ、上に「今やること」(goalText)を出し、何もしない
 * 場合はhintLineIdのセリフを出してすぐ消す。P1のダイスがmapIds(省略時は見えている全エリア)のどこかに
 * 置かれたらonPlaced(mapId)。extraDetect(state)がtrueでも置いた扱い(皇帝宮殿のカードを選ぶ画面が開いた等)。
 * 1ターンに置けるダイスは1個(turnActionTaken)なので、場面ごとに置ける状態に戻す。 */
function storyWaitForPlacement({ mapIds, dieValues, goalText, hintLineId, hintIdleMs, extraDetect, onPlaced }) {
  const run = storyRun;
  const targets = mapIds || run.visibleMapIds.slice();
  // 比べる基準は「前の場面が終わった時」の数(run.placementBaseline)。セリフが出ている途中に先に置いても
  // 見逃さないように(このあとのrender()ですぐ「置いた」と判定される)。
  const beforeByMap = Object.fromEntries(targets.map((m) => [m, run.placementBaseline[m] || 0]));
  let placed = false;
  const stopHint = hintLineId ? storyStartHint(hintLineId, hintIdleMs) : () => {};
  run.onRender = (state) => {
    if (placed) return;
    const placedMap = targets.find((m) => storyP1DiceCount(state, [m]) > beforeByMap[m]);
    if (!placedMap && !(extraDetect && extraDetect(state))) return;
    placed = true;
    run.placementBaseline = storyPlacementCounts(state);
    run.glowDieValues = [];
    run.onRender = null;
    stopHint();
    storyShowGoal('');
    storyHideDialog();
    storyLater(() => onPlaced(placedMap || targets[0]), 350);
  };
  turnActionTaken = false;
  selectedDieIds = [];
  run.glowDieValues = dieValues || [];
  render(STATE);
  storyTurnBannerWhenPlaceable(STATE);
  storyShowGoal(goalText);
}

/** 「1手戻る」の後 (main.jsのhandleCancelPreviousActionClickから) -- ダイスを置くのを待っている場面なら、置ける状態の
 * ままにする。戻した手の記録には「その手を使った時に置けたか」が入っていて、セリフの間(置けない間)にタップを使って
 * いると、戻した時に置けない状態になってしまうため(置いたらこの待ちは終わるので、待っている間は必ず置ける)。 */
function storyAfterCancelAction() {
  if (storyRun && storyRun.onRender) turnActionTaken = false;
}

/** 見せるエリアを1つ増やす(枠だけだったタイルの中身がふわっと出てくる)。 */
function storyRevealMap(mapId) {
  storyRun.visibleMapIds.push(mapId);
  storyApplyVisibleMaps();
  const tile = storyTileNode(mapId);
  if (tile) {
    [...tile.children].forEach((child) => child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'ease-out' }));
    tile.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'ease-out' });
  }
}

/** 見せるエリア以外は枠だけ(中身を隠す)。 */
function storyApplyVisibleMaps() {
  const visible = storyRun.visibleMapIds || [];
  let style = document.getElementById('story-visible-maps-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'story-visible-maps-style';
    document.head.appendChild(style);
  }
  const not = visible.map((id) => `:not([data-map-id="${id}"])`).join('');
  style.textContent = `body.story-mode #board .map-tile${not} > * { visibility: hidden; }\n`
    + `body.story-mode #board .map-tile${not} { background: var(--surface-sunken) !important; border-color: var(--border) !important; box-shadow: none !important; }`;
}

/** 右側の資源の表示だけを一時的に別の数に見せる(ゲームの状態は変えない)。 */
function storyApplyResourceOverride(override) {
  const resourcesEl = document.querySelector('#mobile-own-row .mobile-own-row__resources');
  if (!resourcesEl) return;
  resourcesEl.innerHTML = '';
  for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ', 'VP']) {
    const count = override[resource] || 0;
    if (count > 0) resourcesEl.appendChild(renderResourceBadge(resource, count, false, true));
  }
}
function storyResourceBadge(resource) {
  return document.querySelector(`#mobile-own-row .mobile-own-row__resources .resource-badge[data-resource="${resource}"]`);
}

/** 表示を止めていた資源の変化を見せる: fromの資源が光って、toの資源の所へ飛んでいき、本当の数に変わる。 */
function storyShowResourceChange(from, to, onDone) {
  const run = storyRun;
  const fromBadge = storyResourceBadge(from);
  if (fromBadge) fromBadge.classList.add('change-highlight');
  storyLater(() => {
    const a = fromBadge ? fromBadge.getBoundingClientRect() : null;
    run.resourceOverride = null;
    render(STATE);
    const toBadge = storyResourceBadge(to);
    if (!a || !toBadge) { onDone(); return; }
    const b = toBadge.getBoundingClientRect();
    const flyer = fromBadge.cloneNode(true);
    flyer.classList.remove('change-highlight');
    flyer.classList.add('resource-exchange-flyer');
    Object.assign(flyer.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
    document.body.appendChild(flyer);
    toBadge.style.visibility = 'hidden';
    const anim = flyer.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px)` }],
      { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    anim.onfinish = () => {
      flyer.remove();
      const target = storyResourceBadge(to);
      if (target) {
        target.style.visibility = '';
        target.classList.add('change-highlight');
        storyLater(() => target.classList.remove('change-highlight'), 900);
      }
      onDone();
    };
  }, 600);
}

/** カードを選ぶ画面が閉じて、カード獲得などの演出が全部終わったらfn()。 */
function storyWhenVisualsIdle(fn) {
  storyWaitUntil(() => {
    const choosing = typeof pendingBuildChoice !== 'undefined' && pendingBuildChoice;
    const busy = typeof aiVisualsBusy === 'function' && aiVisualsBusy();
    return !choosing && !busy;
  }, fn);
}

/* ---------- 場面1: 農園 (S001〜S007) ---------- */

const STORY_WHEAT_MAP_ID = 'MAP001'; // 小麦畑
const STORY_FARM_MAP_ID = 'MAP002'; // 農園
const STORY_CITY_MAP_ID = 'MAP003'; // ローマ市街
const STORY_CASTLE_MAP_ID = 'MAP008'; // 皇帝宮殿

/** S001 エリアから始まる / クエスト・ショップなどに行けない / 農園以外のエリアは見えない
 *  S002, S003 そのまま自動で進む
 *  S004 ダイスが振られ1 6 3の目が出る → 6のダイスが光る。選択肢「「農園」にダイスを置く」→ S006
 *  S005 何もしない場合5秒ごとに出てきてすぐ消える
 *  S006 ファンファーレの演出の後にセリフ
 *  S007 そのまま → 場面2(ローマ市街) */
function storySceneFarm() {
  const run = storyRun;
  run.visibleMapIds = [STORY_FARM_MAP_ID];
  const state = storyBuildState([1, 6, 3]);
  // 第1章のあなたは性格(怠惰)もジョブ(ローマ市民)も持たない (2026-11-14, per user「怠惰とローマ市民を獲得カードから
  // 消して 使えてしまうので」)。第3章のstory2BuildStateと同じやり方で取り上げる。
  const p1 = state.players.find((p) => p.id === 'P1');
  p1.ownedCardPhysicalIds = p1.ownedCardPhysicalIds.filter((id) => id !== p1.conPhysicalId && id !== p1.jobCardId);
  delete state.cards[p1.conPhysicalId];
  delete state.cards[p1.jobCardId];
  p1.conPhysicalId = null;
  p1.conFace = null;
  p1.jobCardId = null;
  p1.skipOnboarding = true;
  storyUseState(state);
  run.placementBaseline = storyPlacementCounts(STATE);
  storyApplyVisibleMaps();
  applyMobileActiveTab('board');
  render(STATE);
  storySaySeq(['S001', 'S002', 'S003'], () => {
    storySay('S004', (text) => {
      storyLater(() => storyRollHandDice(() => {
        storyWaitForPlacement({
          mapIds: [STORY_FARM_MAP_ID],
          dieValues: [6],
          goalText: storyGoalOf('S004'),
          hintLineId: 'S005',
          onPlaced: () => storyFanfare(STORY_FARM_MAP_ID, () => storySaySeq(['S006', 'S007'], storySceneCity)),
        });
      }), Math.min(900, storyHoldMs(text)));
    });
  });
}

/* ---------- 場面2: ローマ市街 (S008〜S013) ---------- */

/** S008 ローマ市街が現れる
 *  S009 ダイス1と3が光る。上に「「ローマ市街」にダイスを置く」
 *  S010 何もしない場合5秒ごとに出てきてすぐ消える
 *  S011 ファンファーレの演出の後にセリフ
 *  S012 食料→権力(ローマ市街のCHANGE(K,A,ALL))。ゲームでは置いた瞬間に変わるが、表示はS012の後に
 *       変わって見せる(per user回答「S012の後に変わって見える」)
 *  S013 → 場面3 */
function storySceneCity() {
  const run = storyRun;
  storyRevealMap(STORY_CITY_MAP_ID);
  storySayThen('S008', () => {
    storySay('S009', (text) => storyLater(() => {
      // 表示だけS012まで今の数のまま(置いた瞬間のrenderで一瞬変わって見えないよう、置く前から固定しておく)。
      run.resourceOverride = { ...storyPlayer('P1').resources };
      storyWaitForPlacement({
        mapIds: [STORY_CITY_MAP_ID],
        dieValues: [1, 3],
        goalText: '「ローマ市街」にダイスを置く',
        hintLineId: 'S010',
        onPlaced: () => {
          storyFanfare(STORY_CITY_MAP_ID, () => storySayThen('S011', () => {
            storySay('S012', () => {
              storyShowResourceChange('K', 'A', () => storyWaitNext(() => storySayThen('S013', () => {
              // S013とS014の間「１秒間がある」(ストーリー.xlsx、2026-11-14)。
              storyHideDialog();
              storyLater(storySceneCastle, 1000);
            })));
            }, undefined, true);
          }));
        },
      });
    }, Math.min(900, storyHoldMs(text))));
  });
}

/* ---------- 場面3: 皇帝宮殿でローマ市街の支配を獲得 (S014〜S023) ---------- */

/** S014 そのまま
 *  S015 皇帝宮殿が出てくる。残りのダイスが光る。上に「「皇帝宮殿」にダイスを置く」
 *  S016 何もしない場合5秒ごとに出てきてすぐ消える
 *  置くと本物のゲーム通りカードを選ぶ画面が出る(per user回答「本物通りカードを選ぶ画面を出す」)。
 *  S017〜S020はその画面の上で出す。S018でローマ市街の支配のコストが光る。S020まではカードを押せない。
 *  S020「そのカードをクリックしてみてよ」→ 押すと獲得(本物のカード獲得の演出) → S021〜S023 */
function storySceneCastle() {
  const run = storyRun;
  storySayThen('S014', () => {
    storyRevealMap(STORY_CASTLE_MAP_ID);
    storySay('S015', (text) => storyLater(() => {
      const remaining = storyPlayer('P1').dice.filter((d) => !d.placedMapId && !d.passed).map((d) => d.value);
      run.blockBuildChoice = true; // S020まではカードを押せない
      storyWaitForPlacement({
        mapIds: [STORY_CASTLE_MAP_ID],
        dieValues: remaining,
        goalText: '「皇帝宮殿」にダイスを置く',
        hintLineId: 'S016',
        extraDetect: () => typeof pendingBuildChoice !== 'undefined' && !!pendingBuildChoice,
        onPlaced: storySceneAcquire,
      });
    }, Math.min(900, storyHoldMs(text))));
  });
}

function storySceneAcquire() {
  const run = storyRun;
  storySayThen('S017', () => {
    // S019「ここの光ってる部分がコストだよ」の間、ローマ市街の支配のコストが光る(2026-11-12 Excelの台本で
    // S018とS019が入れ替わった)。
    storySayThen('S018', () => {
      storySetGlow(['#build-choice-overlay .shop-card__cost']);
      storySayThen('S019', () => {
        storySetGlow([]);
        storySay('S020', () => {
          run.blockBuildChoice = false;
          storyShowGoal('カードをクリックする');
          storyWhenVisualsIdle(() => {
            storyShowGoal('');
            storyLater(() => {
              storySetGlow([storyTileSelector(STORY_CITY_MAP_ID)]);
              storySayThen('S021', () => {
                storySetGlow([storyTileSelector(STORY_CITY_MAP_ID, '.map-tile__id')]);
                storySayThen('S022', () => {
                  storySetGlow([storyTileSelector(STORY_CITY_MAP_ID, '.map-tile__action')]);
                  storySayThen('S023', () => { storySetGlow([]); storySceneCardsTab(); });
                });
              });
            }, 400);
          });
        });
      });
    });
  });
}

/* ---------- 場面4: 獲得カードの画面 (S024〜S027) ---------- */

/** S024 下部帯の「獲得カード」が光る。選択肢「「獲得カード」を押す」。何もしない場合5秒ごとにS024
 *  S025 獲得したカードが光る
 *  S026 選択肢「「エリア」に移動」(ボタンかフリック)。何もしない場合5秒ごとにS026
 *  S027 */
function storySceneCardsTab() {
  storySetAllowedTabs(['board', 'cards']);
  storySetGlow(['.mobile-tab-switcher__btn[data-tab-target="cards"]']);
  storySay('S024', () => {
    storyShowGoal(storyGoalOf('S024'));
    const stopHint = storyStartHint('S024');
    storyWaitUntil(() => mobileActiveTab === 'cards', () => {
      stopHint();
      storyShowGoal('');
      applyMobileCardsPlayer('P1');
      render(STATE);
      storySetGlow(['#player-cards [data-physical-id="A001"] .shop-card']);
      storySayThen('S025', () => {
        storySetGlow(['.mobile-tab-switcher__btn[data-tab-target="board"]']);
        // 資源タブは許さない(フリックで戻る時は資源タブを飛ばしてエリアへ -- main.jsのスワイプ処理)。
        storySetAllowedTabs(['board', 'cards']);
        storySay('S026', () => {
          storyShowGoal(storyGoalOf('S026'));
          const stopHint2 = storyStartHint('S026');
          storyWaitUntil(() => mobileActiveTab === 'board', () => {
            stopHint2();
            storyShowGoal('');
            storySetGlow([]);
            storySetAllowedTabs(['board']);
            storySayThen('S027', storySceneRound2);
          });
        });
      });
    });
  });
}

/* ---------- 場面5: ラウンド2 (S028〜S035) ---------- */

/** S028〜S032 そのまま
 *  S033 ラウンド2が始まりダイスが回収される(per user回答: ダイスの目はランダム)
 *  S034 小麦畑も出てくる(per user回答「小麦畑追加」)。選択肢「ダイスをエリアに置く」、何もしない場合10秒ごとにS034
 *  S035 『行ったエリア』はダイスのおかれたエリア */
function storySceneRound2() {
  // S065「残念…」で戻ってくる時のために、S028の時の盤面を1回だけ取っておく(storyRewindToRound2)。
  if (!storyRun.round2Snapshot) {
    storyRun.round2Snapshot = { state: gameStateMod.cloneState(STATE), visibleMapIds: storyRun.visibleMapIds.slice(), diceShown: storyRun.diceShown };
  }
  storySaySeq(['S028', 'S029', 'S030', 'S031', 'S032'], () => {
    storyStartNextRound(() => {
      storySayThen('S033', () => {
        storyRevealMap(STORY_WHEAT_MAP_ID);
        storySay('S034', () => {
          storyWaitForPlacement({
            goalText: storyGoalOf('S034'),
            hintLineId: 'S034',
            hintIdleMs: 10000,
            onPlaced: (mapId) => {
              const areaName = dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId).NAME;
              const text = storyLine('S035').text.replace('『行ったエリア』', `「${areaName}」`);
              storySayThen('S035', storyScenePatra, 0, text);
            },
          });
        });
      });
    });
  });
}

/** 次のラウンドへ: 置いてあったダイスが右へ退場 → ゲームのラウンド終了/開始の処理 → あなたのダイスを
 * その場で振る。普段のラウンド開始の演出(資源タブで全員のダイスを転がす)は使わない(他のプレイヤーが
 * まだ登場していないため)。 */
function storyStartNextRound(onDone, keepLocked) {
  // 普段のラウンド開始と同じ「ラウンド2」の文字の演出 (2026-10-29, per user request: "その演出は ストーリーの
  // ダイスを 回収した時も欲しい")。流れ終わってからダイスを振る。
  playRoundBanner(STATE.round + 1);
  const placed = [...document.querySelectorAll('#board .slot .die')];
  for (const node of placed) {
    const rect = node.getBoundingClientRect();
    const flyer = node.cloneNode(true);
    Object.assign(flyer.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', zIndex: 5 });
    document.body.appendChild(flyer);
    node.style.visibility = 'hidden';
    flyer.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${window.innerWidth - rect.left + 40}px, 0)` }],
      { duration: 380, easing: 'cubic-bezier(0.5, 0, 0.9, 0.4)', fill: 'forwards' }).onfinish = () => flyer.remove();
  }
  storyLater(() => {
    turnFlowMod.endRound(STATE, INDEX);
    turnFlowMod.startRound(STATE);
    for (const player of STATE.players) {
      if (player.id === 'P1') player.dice.forEach((d) => { d.value = 1 + Math.floor(Math.random() * 6); });
      else player.dice.forEach((d) => { d.passed = true; });
    }
    STATE.turnOrder = STATE.players.map((p) => p.id);
    STATE.currentPlayerIndex = 0;
    storyRun.placementBaseline = storyPlacementCounts(STATE);
    lastRenderedRound = STATE.round; // 普段のラウンド開始の演出を出さない
    turnActionTaken = false;
    selectedDieIds = [];
    render(STATE);
    if (keepLocked) { // 第2章: このあとスパルのセリフが続くので、振っている間も置けない
      story2LockPlacement();
      render(STATE); // 直前のrenderで付いたダイスのクリックを外すため描き直す
    }
    storyRollHandDice(onDone, 'P1');
  }, Math.max(placed.length ? 420 : 0, ROUND_BANNER_MS));
}

/* ---------- 場面6: パトラ (S036〜S053) ---------- */

/** S036 アレク / S037 「ララララ～～♪」(まだ姿は見えない、名前は？？？) / S038 立ち絵がパトラに
 *  S041 プレイヤー2(パトラ)登場、ダイスが振られる。所有資源食料5、所有カード基礎学問LV1
 *  S042 ダイスを「ローマ市街LV1」に置く(ANYスロット)
 *  S043 / S044(次のセリフに行くのに他より1秒長い) → 分岐: ANYスロットが埋まっていたらS055〜S057(基礎学問で
 *       ダイス目を1にして、元のダイスを追い出して置く) → S045
 *  S045〜S047 / S048 フリーアクションA→KとB→Kが出て来て光る / S049 選択肢「A→KかB→Kを押す」
 *  S050〜S053 → 場面7
 *  ANYが埋まっていた時の順番(S043→S044→S055→S056→S057→S045)はTwineの通り(2026-10-27時点、userが
 *  Twineを見て確認予定)。 */
function storyScenePatra() {
  storySayThen('S036', () => {
    storySetSpeaker('unknown');
    storySayThen('S037', () => {
      storySetSpeaker('patra');
      storySaySeq(['S038', 'S039', 'S040'], () => {
        storyPatraEnters(() => storyPatraPlaces((anyWasTaken) => {
          storySayThen('S043', () => storySayThen('S044', () => {
            if (anyWasTaken) {
              storySaySeq(['S055', 'S056'], () => {
                storySay('S057', () => {
                  storyPatraUsesBasicStudy();
                  storyWaitNext(() => storyWhenVisualsIdle(storyPatraFee));
                }, undefined, true);
              });
            } else {
              storyPatraFee();
            }
          }, 1000));
        }));
      });
    });
  });
}

/** S041: パトラ(P2)登場。あなたの手番を終わらせて、パトラの手番にし、パトラのダイスを振る。 */
function storyPatraEnters(onDone) {
  const p2 = storyPlayer('P2');
  Object.keys(p2.resources).forEach((r) => { p2.resources[r] = 0; });
  p2.resources.K = 5;
  p2.dice.forEach((d) => { d.passed = false; d.value = 1 + Math.floor(Math.random() * 6); });
  storyEndTurnOf('P1');
  document.body.classList.add('story-lock-hand'); // パトラのダイスはあなたが動かせない
  render(STATE);
  storyLater(() => storyRollHandDice(onDone, 'P2'), 300);
}

/** ゲームの手番終了の処理(使用料の支払いなど)をして、次の人の手番にする。画面側の「この人の手番はまだ
 * 続いている」という印(turnActionTaken)も、普段のターン終了ボタンと同じように下ろす。 */
function storyEndTurnOf(playerId) {
  turnFlowMod.endTurn(STATE, INDEX, playerId);
  turnActionTaken = false;
  turnJustEnded = true;
  selectedDieIds = [];
  // ほかの人はパスしていて自分の手番が続くので、main.jsの「手番が替わった時」の片付けが起きない。ここで
  // 1手戻るの記録を消し、ターン開始時に戻るの戻り先も今に取り直す(前の手番まで戻せると、置いた数の基準が
  // ずれて進行不能になる)。
  actionCheckpoints = [];
  undoMod.recordCheckpoint(STATE);
  // 他の人の手番の間に盤面が変わる(パトラにダイスを追い出される等)ので、置いた数の基準もここで取り直す。
  storyRun.placementBaseline = storyPlacementCounts(STATE);
}

function storyCityAnySlotIndex() {
  const requirements = boardMod.getSlotRequirements(dataLoaderMod.getAreaRow(INDEX, STATE.maps[STORY_CITY_MAP_ID].currentAreaId));
  return requirements.indexOf('ANY');
}

/** S042: パトラがローマ市街LV1のANYスロットにダイスを置く。埋まっていたら置かずにonDone(true)。 */
function storyPatraPlaces(onDone) {
  const anyIdx = storyCityAnySlotIndex();
  if (anyIdx < 0 || STATE.maps[STORY_CITY_MAP_ID].slots[anyIdx].length > 0) { onDone(true); return; }
  const die = storyPlayer('P2').dice.find((d) => !d.placedMapId && !d.passed);
  boardMod.placeDice(STATE, INDEX, { playerId: 'P2' }, die.id, STORY_CITY_MAP_ID, anyIdx);
  render(STATE);
  storyLater(() => storyWhenVisualsIdle(() => onDone(false)), 200);
}

/** S057: ANYが埋まっていた時、パトラが基礎学問(ダイス目を1に変えて、どこにでも置ける)を使い、元のダイスを
 * 追い出して置く。 */
function storyPatraUsesBasicStudy() {
  const anyIdx = storyCityAnySlotIndex();
  const die = storyPlayer('P2').dice.find((d) => !d.placedMapId && !d.passed);
  boardMod.useBareTapAbility(STATE, INDEX, { playerId: 'P2', chosenDieId: die.id, chosenValue: 1 }, 'B001');
  boardMod.placeDice(STATE, INDEX, { playerId: 'P2' }, die.id, STORY_CITY_MAP_ID, anyIdx);
  render(STATE);
}

/** S045〜S047: 使用料(ローマ市街は「権力」)の説明。そのまま場面7へ (2026-11-12 Excelの台本: 使用料が「食料」から
 * 「権力」になり、払えないのでA→Kのフリーアクションをパトラの代わりに押すS048〜S053は無くなった)。 */
function storyPatraFee() {
  storySaySeq(['S045', 'S046', 'S047'], storySceneFeeCollect);
}

/* ---------- 場面7: 使用料の回収とEXスロット (S054〜S065) ---------- */

/** S054 アレク「君の番だよ でもその前に使用料をもらっておこう」(パトラの手番が終わり、使用料が
 *       ローマ市街に置かれる)
 *  S058 「ここをクリックしてみて」使用料が光る。選択肢「使用料をクリックする」
 *  S059〜S061 S061でEXスロットが光る
 *  S062〜S065 → storyFreePlay */
function storySceneFeeCollect() {
  storySetSpeaker('alek');
  storyEndTurnOf('P2');
  document.body.classList.remove('story-lock-hand');
  render(STATE);
  storySayThen('S054', () => {
    // 説明の前にもう使用料を回収していたら(回収する物が無いと、待っても進めない): S070 → S062 (per user Twine
    // 「使用料がない」)。
    const city = STATE.maps[STORY_CITY_MAP_ID];
    if (city.feeOwnerId !== 'P1' || !(city.accumulatedFee > 0)) {
      storySayThen('S070', () => storySay('S062', storyFreePlay));
      return;
    }
    storySetGlow([storyTileSelector(STORY_CITY_MAP_ID, '.map-tile__fee')]);
    storySay('S058', () => {
      storyShowGoal(storyGoalOf('S058'));
      // 回収したら(使用料は「権力」になったので、資源の種類ではなく、ローマ市街に貯まった使用料が無くなったかで見る)。
      storyWaitUntil(() => !(STATE.maps[STORY_CITY_MAP_ID].accumulatedFee > 0), () => {
        storyShowGoal('');
        storySetGlow([]);
        storySaySeq(['S059', 'S060'], () => {
          const exIdx = boardMod.getSlotRequirements(dataLoaderMod.getAreaRow(INDEX, STATE.maps[STORY_CITY_MAP_ID].currentAreaId)).indexOf('EX');
          storySetGlow([storyTileSelector(STORY_CITY_MAP_ID, `.slot:nth-child(${exIdx + 1})`)]);
          storySayThen('S061', () => {
            storySetGlow([]);
            storySay('S062', storyFreePlay);
          });
        });
      });
    });
  });
}

/* ---------- 場面8: ダイスを使い切るまで (S062〜S065) ---------- */

/** 2026-10-31, per user (Twine更新 + 回答):
 *  S062 「今度はどこにダイスを置く？」選択肢「ダイスを置く」(何もしない場合5秒ごと)
 *  S063 「それからどうするの？」(最初に置いた後)。ここからはパトラと交互に(per user「パトラと交互に」): あなたが
 *       1個置く(皇帝宮殿ならカードも選ぶ) → パトラが小麦畑か農園に1個置く(per user「パトラは小麦畑か農園に
 *       ダイスを置く」) → … あなたのダイスが無くなるまで。
 *  ダイスを使い切った時、ローマ市街の支配LV2(A001B)を持っていれば S064「やったぁ！…第2章へつづく」→ 終わりの
 *  画面「第2章へつづく」/ 持っていなければ S065「残念…」→ S028の時の盤面に巻き戻してS028から(per user
 *  「S028の時点に巻き戻す」)。 */
function storyFreePlay() {
  const loop = (first) => {
    if (!storyRun) return;
    if (storyForcePassIfStuck('P1', storyRun.visibleMapIds, storyFinishFreePlay)) return;
    if (!storyHasDiceLeft('P1')) { storyFinishFreePlay(); return; }
    storyWaitForPlacement({
      goalText: 'ダイスを置く', // Twineの選択肢は書き換え中なので、今まで通りの文言(STORY_CH1_CLEAR_TEXTの所を参照)
      hintLineId: first ? 'S062' : null,
      extraDetect: () => typeof pendingBuildChoice !== 'undefined' && !!pendingBuildChoice,
      onPlaced: () => {
        const afterTurn = () => storyWhenVisualsIdle(() => {
          storyEndTurnOf('P1');
          turnActionTaken = true; // パトラの手番の間は置けない(次の自分の番でstoryWaitForPlacementが戻す)
          storyPatraPlacesOnField(() => loop(false));
        });
        if (first) storySay('S063', afterTurn, 'それからどうするの？'); // 同上: Twineでは空になった
        else afterTurn();
      },
    });
  };
  loop(true);
}

function storyHasDiceLeft(playerId) {
  return storyPlayer(playerId).dice.some((d) => !d.placedMapId && !d.passed);
}

/** そのダイスを mapIds のどこかに置けるスロットの一覧 [{mapId, slotIndex}](コピーした盤面で試して確かめる)。 */
function storyPlaceableSlots(playerId, dieId, mapIds) {
  const result = [];
  for (const mapId of mapIds) {
    const count = boardMod.getSlotRequirements(dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId)).length;
    for (let slotIndex = 0; slotIndex < count; slotIndex++) {
      const trial = gameStateMod.cloneState(STATE);
      const die = trial.players.find((p) => p.id === playerId).dice.find((d) => d.id === dieId);
      const placed = die && boardMod.isDieWildcard(trial, INDEX, playerId, die) // ☆は置き場所を自分で決める
        ? boardMod.placeWildcardDie(trial, INDEX, { playerId }, dieId, mapId, slotIndex)
        : boardMod.placeDice(trial, INDEX, { playerId }, dieId, mapId, slotIndex);
      if (placed.success) result.push({ mapId, slotIndex });
    }
  }
  return result;
}

/** 残りのダイスがどれもどこにも置けない時は、強制でラウンドパス(残りのダイスを全部パス)にして、お知らせを
 * 出してからonDone()、trueを返す (2026-10-31, per user: ストーリーではターン終了ボタンが無いので、置けなく
 * なると進めなくなる -- "その場合 強制でラウンドパスしてください" + お知らせの文言)。使っていない色ダイスの
 * 3Kは本物のゲームのラウンド終了の処理でもらえる。置けるダイスが1個でもあれば何もせずfalse。 */
const STORY_FORCE_PASS_TEXT = 'ダイスを置けるスロットがないので強制パスになります\n使っていない色ダイスはK3「食料」になります';
function storyForcePassIfStuck(playerId, mapIds, onDone) {
  const remaining = storyPlayer(playerId).dice.filter((d) => !d.placedMapId && !d.passed);
  if (remaining.length === 0 || remaining.some((d) => storyPlaceableSlots(playerId, d.id, mapIds).length > 0)) return false;
  for (const die of remaining) boardMod.passDie(STATE, INDEX, { playerId }, die.id);
  render(STATE);
  const speakerBefore = storyRun.speaker;
  storySetSpeaker('system');
  storySayThen('FORCE_PASS', () => {
    storySetSpeaker(speakerBefore);
    onDone();
  }, 0, STORY_FORCE_PASS_TEXT);
  return true;
}

/** パトラの手番: 小麦畑か農園(置ける方、両方置けるならランダム)にダイスを1個置いて手番を終える。ダイスが
 * 無ければ何もしない。 */
function storyPatraPlacesOnField(onDone) {
  const die = storyPlayer('P2').dice.find((d) => !d.placedMapId && !d.passed);
  if (!die) { onDone(); return; }
  const byMap = [STORY_WHEAT_MAP_ID, STORY_FARM_MAP_ID]
    .map((mapId) => storyPlaceableSlots('P2', die.id, [mapId]))
    .filter((slots) => slots.length > 0);
  if (byMap.length === 0) {
    boardMod.passDie(STATE, INDEX, { playerId: 'P2' }, die.id);
  } else {
    const slots = byMap[Math.floor(Math.random() * byMap.length)];
    const { mapId, slotIndex } = slots[Math.floor(Math.random() * slots.length)];
    boardMod.placeDice(STATE, INDEX, { playerId: 'P2' }, die.id, mapId, slotIndex);
  }
  render(STATE);
  storyLater(() => storyWhenVisualsIdle(() => {
    storyEndTurnOf('P2');
    render(STATE);
    onDone();
  }), 700);
}

// 第1章の終わりのセリフ。Twineでは書き換え中(2026-11-01: S064/S065の中身が変わった)だが、終わり方は今まで
// 通りにしておく(per user「使用料の分岐のみ それ以外変えないで」)ので、前の文章をここに残しておく。
const STORY_CH1_CLEAR_TEXT = 'やったぁ！ローマ市街が更な発展したよ\n\n第2章へつづく';
const STORY_CH1_FAIL_TEXT = '残念……。\n「ローマ市街」はもっと発展すると思っていたのに…。';
function storyFinishFreePlay() {
  const city = STATE.cards.A001;
  const hasLv2 = !!city && city.ownerId === 'P1' && city.currentFaceId === 'A001B';
  if (hasLv2) {
    storyMarkChapterCleared(1);
    // トップに戻らず、そのまま第2章へ (2026-11-12, per user「第１章 クリアしたら トップに戻らず そのまま第２章に」)。
    storySayThen('CH1_CLEAR', () => storyGoChapter(2), 0, STORY_CH1_CLEAR_TEXT);
  }
  else storySayThen('CH1_FAIL', storyRewindToRound2, 0, STORY_CH1_FAIL_TEXT);
}

/** S065 → S028: 盤面・資源・見えているエリアを S028 の時に戻して、そこからやり直す。 */
function storyRewindToRound2() {
  const run = storyRun;
  if (!run) return;
  const snap = run.round2Snapshot;
  storyUseState(gameStateMod.cloneState(snap.state));
  run.turnBannerKeys = new Set(); // 巻き戻したら「ターン○」も数え直す
  run.visibleMapIds = snap.visibleMapIds.slice();
  run.diceShown = snap.diceShown;
  run.placementBaseline = storyPlacementCounts(STATE);
  run.glowDieValues = [];
  playerRoles.set('P2', DEFAULT_AI_ROLE);
  document.body.classList.remove('story-lock-hand');
  lastRenderedRound = STATE.round;
  storySetSpeaker('alek');
  storySetAllowedTabs(['board']);
  storySetGlow([]);
  storyApplyVisibleMaps();
  render(STATE);
  storySceneRound2();
}

/** 台本の終わり。text は終わりの画面の文字(省略時「つづく」)。 */
function storyEndOfScript(text) {
  if (!storyRun) return;
  storyHideDialog();
  const end = el('div', 'story-end');
  end.appendChild(el('div', 'story-end__text', text || 'つづく'));
  const back = el('button', 'story-end__button', 'トップに戻る');
  back.type = 'button';
  back.addEventListener('click', closeStoryMode);
  end.appendChild(back);
  storyRun.dom.root.appendChild(end);
  end.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
}

/* ---------- 会話ログ ---------- */

function toggleStoryLog() {
  const run = storyRun;
  if (!run) return;
  const { logPanel, logButton } = run.dom;
  if (!logPanel.hidden) {
    logPanel.hidden = true;
    logButton.textContent = 'ログ';
    storyResume();
    return;
  }
  storyPause();
  logPanel.innerHTML = '';
  logPanel.appendChild(el('div', 'story-dialog__name', 'ログ'));
  const list = el('div', 'story-log__list');
  for (const entry of run.log) {
    const row = el('div', 'story-log__line');
    row.appendChild(el('span', 'story-log__speaker', entry.speaker));
    const text = el('span', 'story-log__text');
    text.appendChild(storyLineFragment(storyIconize(entry.text)));
    row.appendChild(text);
    list.appendChild(row);
  }
  logPanel.appendChild(list);
  logPanel.hidden = false;
  logButton.textContent = 'とじる';
  list.scrollTop = list.scrollHeight; // 新しいセリフが見える位置から
}

/* ---------- 開く/閉じる ---------- */

/** startScene: 最初の場面(省略時は第1章の農園から)。 */
function openStoryMode(startScene) {
  if (storyRun) return;
  const root = el('div', 'story-overlay');
  root.id = 'story-overlay';
  const portrait = document.createElement('img');
  portrait.className = 'story-alek';
  portrait.hidden = true;
  const goal = el('div', 'story-goal');
  goal.hidden = true;
  const dialog = el('div', 'story-dialog');
  dialog.hidden = true;
  const dialogName = el('div', 'story-dialog__name', '');
  dialog.appendChild(dialogName);
  const dialogText = el('div', 'story-dialog__text');
  dialog.appendChild(dialogText);
  const nextHint = el('div', 'story-dialog__next', '次へ▷');
  nextHint.hidden = true;
  dialog.appendChild(nextHint);
  storySetupNextTap(dialog);
  // ✖(ストーリーをやめる)ボタンは無し (2026-11-01, per user「Xボタン 不要」-- 途中でやめられなくてよいと確認済み)。
  // 会話ログ (2026-10-24, per user request: "会話ログを見れるボタンが欲しい 会話ログは新しいウィンドウが開く
  // のではなくセリフ部分にでる") -- ✖の上の「ログ」ボタンで、セリフ欄の所が上に広がってこれまでのセリフを
  // 一覧表示(新しい物が下)。開いている間はストーリーの自動送りを止める。もう一度押すか一覧を押すと閉じる。
  // 「会話ログ」、一番下(✖があった所)に (2026-11-01, per user「ログは 会話ログ にして 一番下に」)。
  const logButton = el('button', 'story-log-button', '会話ログ');
  logButton.type = 'button';
  logButton.addEventListener('click', toggleStoryLog);
  const logPanel = el('div', 'story-log');
  logPanel.hidden = true;
  logPanel.addEventListener('click', toggleStoryLog);
  root.append(portrait, dialog, logPanel, goal, logButton);
  document.body.appendChild(root);
  storyRun = {
    timers: new Set(), typeTimer: null, diceShown: false, glowDieValues: [], glowSelectors: [], onRender: null, onTap: null,
    resourceOverride: null, blockBuildChoice: false, allowedTabs: new Set(['board']), speaker: null, placementBaseline: {},
    visibleMapIds: [], log: [], paused: false,
    dom: { root, portrait, goal, dialog, dialogName, dialogText, nextHint, logPanel, logButton },
    waitingNext: null, typeFinish: null, skipping: false,
  };
  document.body.classList.add('story-mode', 'story-hide-dice');
  entryBannerDismissed = true;
  aiPacingMode = 'manual'; // パトラなどAIの手は台本が進める
  // 話し手は最初の場面が決める(第2章でアレクが一瞬出ないように)。第1章はアレクから。
  if (!startScene) storySetSpeaker('alek');
  storySetAllowedTabs(['board']);
  (startScene || storySceneFarm)();
  // 前の章から続けて始めた時の覆い(storyGoChapter)は、この章の画面が描けてから外す。
  setTimeout(() => document.documentElement.classList.remove('story-autostarting'), 500);
}

function closeStoryMode() {
  if (!storyRun) return;
  storyRun.timers.forEach((token) => clearTimeout(token.handle));
  storyRun = null;
  location.reload(); // 練習用の盤面を捨ててトップ画面へ
}

// ストーリー中はエリアのタイルを押しても拡大画面を開かない(スロットへの配置と使用料の回収だけ)。カードを
// 選ぶ画面は台本が許すまで押せない。何か触ったら場面に知らせる(「何もしない場合」の数え直し)。
document.addEventListener('click', (e) => {
  if (!storyRun) return;
  if (storyRun.normalGame) {
    // 第4章の対戦中は普段のゲームと同じ。ただし誰かがしゃべっている間(ch4PlayerSegment)は、セリフ欄以外を押せない。
    if (storyRun.talking && !e.target.closest('.story-overlay')) { e.stopPropagation(); e.preventDefault(); }
    return;
  }
  if (storyRun.onTap) storyRun.onTap();
  // ☆ダイス(isWildcardThisTurn)はスロットではなくタイルを押して置く(map-tile--wildcard-target)ので通す。
  const onSlotToPlace = !!e.target.closest('.slot--selectable, #board .map-tile--wildcard-target');
  const blockedTile = e.target.closest('#board .map-tile') && !onSlotToPlace && !e.target.closest('.map-tile__fee');
  const blockedChoice = storyRun.blockBuildChoice && e.target.closest('#build-choice-overlay .owned-card-cell, #build-choice-overlay .shop-card');
  if (blockedTile || blockedChoice) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

/* ---------- 第3章: 傲慢な百人隊長スパル (data/story2.data.js、2026-11-09までは第2章「○○の百人隊長スパル」) ---------- */

/** 2026-10-31, per user: 第2章の台本はストーリー.xlsxのSheet2 ("エクセルのほうです"、tools/story2_xlsx_to_js.py
 * で data/story2.data.js に変換)。1行ずつ順番に、A列=スパルのセリフ、C列=画面で起きること/その部分が始まる
 * 条件。C列は文言で見分ける(下のstory2DoEvent / STORY2_TRIGGERS)ので、行を足したり順番を変えたりしても
 * 文言が同じなら動く。
 *  - 最初から最初の「条件」の行までが導入(ダイスが振られる・訓練場がオープン・1秒消える・初期資源カード4枚
 *    (C列に書かれたIDのカード)・小麦畑/農園/酒場オープン・2枚選ぶ)。
 *  - そのあとは自由に置く(ほかのプレイヤーは出ない)。訓練場で色ダイスが増えた1回目/2回目、酒場で人脈が
 *    増えた時(1回だけ)に、その条件の行から次の条件の行の手前までを出す。
 *  - ダイスを使い切った時、色ダイスが5個なら「5個」の部分(次のラウンド→セリフ)→「つづく」、4個以下なら
 *    「4個以下」の部分のあと、初期資源カードが配られる直前の盤面に戻してやり直し(per user「初期資源カードを
 *    選ぶ所から」)。
 *  - 最後のダイスが訓練場の同じ目に阻まれて置けない時は、スパルが☆にしてくれる(per user 救済)。そのため
 *    最初のダイス3個は完全ランダム(per user「どんなダイス目でもクリアできるようになったので」)。 */
const STORY_TAVERN_MAP_ID = 'MAP006'; // 酒場
const STORY_TRAINING_MAP_ID = 'MAP007'; // 訓練場
const STORY2_TRIGGERS = [
  { key: 'train1', test: (e) => /訓練場/.test(e) && /[1１]回目/.test(e) },
  { key: 'train2', test: (e) => /訓練場/.test(e) && /[2２]回目/.test(e) },
  { key: 'tavern', test: (e) => /酒場/.test(e) && /置く/.test(e) },
  // 最後のダイスが訓練場に置いてあるダイスと同じ目で置けない(資源は足りている)→ スパルが☆にしてくれる。
  { key: 'starRescue', test: (e) => /訓練場/.test(e) && /置けない/.test(e) },
  { key: 'fail', test: (e) => /使い切/.test(e) && /以下/.test(e) },
  { key: 'clear', test: (e) => /使い切/.test(e) && /色ダイス/.test(e) && !/以下/.test(e) },
  // 2ラウンド目の終わり: カードを2枚獲得できなかった / できた(+タップしていないカードがある)。
  { key: 'r2fail', test: (e) => /使い切/.test(e) && /獲得できない/.test(e) },
  { key: 'r2clear', test: (e) => /使い切/.test(e) && /獲得できた/.test(e) },
  // 2ラウンド目: このラウンドで1枚目のカードを獲得したのが何ターン目か / 2枚目を獲得した時。
  { key: 'card1early', test: (e) => /カード獲得/.test(e) && /1枚目/.test(e) && /1-2ターン/.test(e) },
  { key: 'card1mid', test: (e) => /カード獲得/.test(e) && /1枚目/.test(e) && /3-4ターン/.test(e) },
  { key: 'card1late', test: (e) => /カード獲得/.test(e) && /1枚目/.test(e) && /5ターン/.test(e) },
  { key: 'card2', test: (e) => /カード獲得/.test(e) && /2枚目/.test(e) },
  // カードを獲得した次のターンの始めに1回だけ (per user「獲得した次のターンの始め」)。
  { key: 'unusedCard', test: (e) => /獲得後/.test(e) && /使わず/.test(e) },
];
/** 全角の数字・ハイフンを半角に(C列の文言を見分ける前に)。 */
function story2NormalizeEvent(e) {
  return e.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－ー−]/g, (c, k, str) => (/\d/.test(str[k - 1] || '') ? '-' : c));
}

/** 台本を導入と条件ごとの部分に分ける: { intro: [行...], train1: [...], ... }。行は {text, event, index}。 */
function story2Blocks() {
  const blocks = { intro: [] };
  let current = blocks.intro;
  (window.STORY2_SCRIPT || []).forEach((row, index) => {
    // モニュメントのラウンド(2026-11-12 作り直し): 「ダイスを使い切る（モニュメントを獲得できていない）2R」→ mfail:2、
    // 「モニュメントを獲得する 2R 1-2T」→ mget:2:1-2、「3Rはじめ」→ mstart:3。ラウンドの数字で分けておく
    // (3R・4Rの分を台本に足せば、そのまま出る)。
    const me = row.event ? story2NormalizeEvent(row.event) : '';
    // 「3-4R」のような範囲は、そのラウンドすべてに同じ部分を使う。
    const rr = /(\d)(?:-(\d))?\s*R/.exec(me);
    const rounds = [];
    if (rr) for (let r = Number(rr[1]); r <= Number(rr[2] || rr[1]); r++) rounds.push(r);
    const round = rounds[0];
    let mkey = null;
    if (round && /使い切/.test(me) && /モニュメント/.test(me)) mkey = rounds.map((r) => `mfail:${r}`);
    else if (round && /モニュメントを獲得する/.test(me)) {
      const t = /(\d)(?:-(\d))?\s*T/.exec(me);
      if (t) mkey = rounds.map((r) => `mget:${r}:${t[1]}-${t[2] || t[1]}`);
    } else if (round && /R\s*はじめ/.test(me)) mkey = rounds.map((r) => `mstart:${r}`);
    else if (round && /置ききる/.test(me)) {
      // 「4Rダイスをすべて置ききる（モニュメントを合計３枚獲得できている）」/「…合計4枚以上…」→ mend:4:3 / mend:4:4+
      const n = /合計(\d)枚(以上)?/.exec(me);
      if (n) mkey = rounds.map((r) => `mend:${r}:${n[1]}${n[2] ? '+' : ''}`);
    }
    if (mkey) {
      current = [];
      mkey.forEach((k) => { blocks[k] = current; });
      current.push({ text: row.text, event: '', index });
      return;
    }
    const trigger = row.event && STORY2_TRIGGERS.find((t) => t.test(story2NormalizeEvent(row.event)));
    if (trigger) {
      current = blocks[trigger.key] = [];
      current.push({ text: row.text, event: '', index }); // 条件の行: 条件はもう満たしているので、セリフだけ
      return;
    }
    current.push({ ...row, index });
  });
  return blocks;
}

function story2DiceValues() {
  return [0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6));
}

/** 1ラウンド目の救済の条件: 残りのダイスが最後の1個で、訓練場に同じ目のダイスがあって置けないが、☆なら
 * 置ける(=資源は足りている)。 */
function story2NeedsStarRescue() {
  const ch = storyRun.chapter2;
  if (ch.inRound2 || ch.inRound3 || ch.monumentRound || !ch.blocks.starRescue || !storyRun.visibleMapIds.includes(STORY_TRAINING_MAP_ID)) return false;
  const remaining = storyPlayer('P1').dice.filter((d) => !d.placedMapId && !d.passed);
  if (remaining.length !== 1 || remaining[0].isWildcardThisTurn) return false;
  const die = remaining[0];
  const sameValueThere = STATE.maps[STORY_TRAINING_MAP_ID].slots.some((slot) => (slot || []).some((o) => !o.isWildcard && o.value === die.value));
  if (!sameValueThere || storyPlaceableSlots('P1', die.id, [STORY_TRAINING_MAP_ID]).length > 0) return false;
  const trial = gameStateMod.cloneState(STATE);
  trial.players.find((p) => p.id === 'P1').dice.find((d) => d.id === die.id).isWildcardThisTurn = true;
  return boardMod.placeWildcardDie(trial, INDEX, { playerId: 'P1' }, die.id, STORY_TRAINING_MAP_ID).success;
}

function story2BuildState() {
  const state = storyBuildState(story2DiceValues(), { P1: 'CON001', P2: 'CON005' });
  state.shops.NORMAL.slots.SHOP101 = null; // 第2章はショップに何も並べない
  // あなたは性格もジョブもなし (per user「第２章性格はなしでお願い 何も足さない」「ジョブもまだなしで」):
  // 配った性格カードとジョブカードを取り上げる(資源はstoryBuildStateで0に戻してある)。
  const p1 = state.players.find((p) => p.id === 'P1');
  p1.ownedCardPhysicalIds = p1.ownedCardPhysicalIds.filter((id) => id !== p1.conPhysicalId && id !== p1.jobCardId);
  delete state.cards[p1.conPhysicalId];
  delete state.cards[p1.jobCardId];
  p1.conPhysicalId = null;
  p1.conFace = null;
  p1.jobCardId = null;
  p1.skipOnboarding = true; // turn-flowのgetNextTurn / main.jsのhasFinishedOnboarding: 持っていなくても準備済み
  return state;
}

function story2Start() {
  const run = storyRun;
  run.visibleMapIds = [];
  run.chapter2 = { blocks: story2Blocks(), trainCount: 0, tavernDone: false, snapshot: null, cards: [] };
  storyUseState(story2BuildState());
  story2LockPlacement();
  run.placementBaseline = storyPlacementCounts(STATE);
  storyApplyVisibleMaps();
  applyMobileActiveTab('board');
  render(STATE);
  // スパルの絵を読み込んでから始める (per user「一番初め…スパルが遅れて出る」: 読み込みが間に合わず、セリフ
  // だけ先に出ていた)。
  const img = new Image();
  img.src = STORY_SPEAKERS.spal.img;
  const loaded = img.decode ? img.decode() : Promise.resolve();
  loaded.catch(() => {}).then(() => {
    if (storyRun !== run) return;
    storySetSpeaker('spal');
    story2Play(run.chapter2.blocks.intro, 0, story2FreePlay);
  });
}

/** rowsをi行目から順番に: C列があればその出来事、A列があればスパルのセリフ。終わったらonDone()。 */
function story2Play(rows, i, onDone) {
  if (!storyRun) return;
  // ch2SkipBlock: この部分の残りの行は出さない(最高記録がまだ無い時、story2DoEventの「最高記録」)。
  if (i >= rows.length || storyRun.ch2SkipBlock) { storyRun.ch2SkipBlock = false; storyRun.ch2SkipUntil = null; onDone(); return; }
  // ch2SkipUntil: その出来事の行まで飛ばす(最高記録を更新した時、「ちなみに今までの…」を出さずに「更新されたとき」へ)。
  if (storyRun.ch2SkipUntil) {
    if (!storyRun.ch2SkipUntil.test(story2NormalizeEvent(rows[i].event || ''))) { story2Play(rows, i + 1, onDone); return; }
    storyRun.ch2SkipUntil = null;
  }
  const row = rows[i];
  const next = () => story2Play(rows, i + 1, onDone);
  const say = () => {
    if (!row.text || storyRun.ch2SkipBlock || storyRun.ch2SkipUntil || storyRun.ch2SkipLineText) { storyRun.ch2SkipLineText = false; next(); return; }
    story2HideCallout(); // 拡大したカードはセリフが始まったら消す(セリフが隠れないように、per user)
    story2TopicGlow(row);
    storySetSpeaker('spal');
    // 「VPの合計は〇VPだ」「お前の成績は〇VP」「モニュメントを〇枚も」: 〇を今のVP/獲得したモニュメントの枚数に。
    let text = row.text;
    if (storyRun.ch2Emph) {
      if (text.includes(storyRun.ch2Emph)) text = text.replace(storyRun.ch2Emph, STORY_EMPH_START + storyRun.ch2Emph + STORY_EMPH_END);
      storyRun.ch2Emph = null;
    }
    if (storyRun.ch2BestText != null && /〇/.test(text)) { text = text.replace('〇', storyRun.ch2BestText); storyRun.ch2BestText = null; }
    if (/〇/.test(text)) {
      const standing = standingsRows(STATE).find((r) => r.playerId === 'P1');
      text = text.replace(/〇(?=\s*VP)/g, String(standing ? standing.vp : 0)).replace(/〇(?=\s*枚)/g, String(story2MonumentCount()));
    }
    storySayThen(`C2-${row.index}`, () => {
      // 「○○が光る」と同じ行のセリフ: そのセリフの間だけ光らせる。
      if (storyRun && storyRun.ch2GlowLine) { storyRun.ch2GlowLine = false; storySetGlow([]); document.querySelectorAll('.story-glow').forEach((n) => n.classList.remove('story-glow', 'change-highlight')); }
      next();
    }, 0, text);
  };
  if (row.event && storyRun.ch2TopicMapId) story2TopicGlow(row);
  if (row.event) story2DoEvent(row, i, say);
  else say();
}

/** 「「元老院」とはなにかって？」「「市場」とは何かだと？」: その話の間、そのエリアを光らせる (per user「元老院
 * とは 市場とは のセリフの時に 該当エリア 光らせて」)。次の「「○○」とは」、C列のある行、「最後に」で始まる
 * 話の行で消す。 */
function story2TopicGlow(row) {
  const run = storyRun;
  const topic = row.text && /「(.+?)」とは/.exec(row.text);
  const mapId = topic && Object.keys(STATE.maps).find((m) => dataLoaderMod.getAreaRow(INDEX, STATE.maps[m].currentAreaId).NAME === topic[1]);
  if (mapId) {
    run.ch2TopicMapId = mapId;
    storySetGlow([`#board .map-tile[data-map-id="${mapId}"]`]);
  } else if (run.ch2TopicMapId && (row.event || /^最後に/.test(row.text || ''))) {
    run.ch2TopicMapId = null;
    storySetGlow([]);
  }
}

function story2DoEvent(row, i, onDone) {
  const run = storyRun;
  const e = story2NormalizeEvent(row.event); // 全角数字も読む
  const seconds = (/(\d+)秒/.exec(e) || [])[1];
  if (/ダイス目/.test(e) && /星/.test(e)) {
    // 「ダイス目が星になる」: 残りの最後のダイスを☆に(この手番だけ。B001BのSET_WILDCARDと同じ印)。
    const die = storyPlayer('P1').dice.find((d) => !d.placedMapId && !d.passed);
    if (die) die.isWildcardThisTurn = true;
    render(STATE);
    storyLater(onDone, 600);
    return;
  }
  if (/強調/.test(e) && /赤字/.test(e)) {
    // 「このゲームは４人で４ラウンドプレイして一番VPの多いやつの勝ちだ　を強調して赤字で」: 同じ行のセリフの中の
    // その部分を赤字で(story2Play)。全角の数字のまま比べるので、正規化前の文言から取る。
    run.ch2Emph = String(row.event).split(/を強調/)[0].trim();
    onDone();
    return;
  }
  if (/最高記録/.test(e) && /更新されたとき/.test(e)) {
    // 「最高記録が更新されたとき（過去の記録と同じ点でも）」: 更新していなければ、ここから先(「こいつはスゲーぜ」と
    // 歴代最高記録の演出)は出さない。
    if (!run.ch2Best || !run.ch2Best.updated) { run.ch2SkipBlock = true; }
    onDone();
    return;
  }
  if (/最高記録/.test(e) && /演出/.test(e)) {
    // 「歴代最高記録っぽい演出を」: 同じ行の「〇VP‼ 歴代最高記録‼」を画面いっぱいに大きく出して紙吹雪。
    // 文字は演出で出すので、セリフ欄には出さない。
    run.ch2SkipLineText = true;
    story2RecordFanfare(row.text || '', onDone);
    return;
  }
  if (/最高記録/.test(e)) {
    // 「最高記録が更新されるたびに記録する」(4Rでモニュメント4枚以上の時だけ、2026-11-12 per user回答): 今回より前の
    // 最高記録と比べて、同じか上回れば(初めての時も)記録し直して「最高記録が更新されたとき」の部分へ(per user回答
    // 「出さずに入れ替え」「初めてでも出す」)。下回れば、同じ行のセリフ「ちなみに今までの最高記録は〇VP」(〇は前の
    // 記録)と「お前はこれを更新できるか？」まで。
    const standing = standingsRows(STATE).find((r) => r.playerId === 'P1');
    const vp = standing ? standing.vp : 0;
    let prev = null;
    try { const v = localStorage.getItem(STORY3_BEST_VP_KEY); prev = v === null ? null : Number(v); } catch (err) { /* 読めなければ記録なし */ }
    const updated = prev === null || vp >= prev;
    run.ch2Best = { updated, prev, vp };
    try { if (updated) localStorage.setItem(STORY3_BEST_VP_KEY, String(vp)); } catch (err) { /* 書けなくても続ける */ }
    if (updated) { run.ch2SkipUntil = /更新されたとき/; onDone(); return; }
    run.ch2BestText = String(prev);
    onDone();
    return;
  }
  if (/最初に戻る/.test(e)) {
    // 「2R最初に戻る」: 戻すのはこの部分が終わってから(story2Finish)。
    onDone();
    return;
  }
  if (/VP/.test(e) && /表示/.test(e)) {
    // 「獲得したVPを表示」: 同じ行のセリフ「VPの合計は〇VPだ」の〇はstory2Playで今のVPに。VPの表示があれば、そのセリフの間光らせる。
    const badge = storyResourceBadge('VP');
    if (badge) { storySetGlow([]); badge.classList.add('story-glow', 'change-highlight'); run.ch2GlowLine = true; }
    onDone();
    return;
  }
  if (/秒間がある/.test(e)) {
    // 「１秒間がある」: 間を置くだけ。
    storyLater(onDone, (Number(seconds) || 1) * 1000);
    return;
  }
  if (/モニュメント/.test(e) && /右上/.test(e) && /光る/.test(e)) {
    // 「モニュメントの右上の数字が光る」(同じ行のセリフ「そのかわりカードの右上に書いてある数字以上の目…」の間だけ)。
    storySetGlow(['#shop-combined-slots .shop-slot[data-face-id^="M"] .shop-card__req']);
    run.ch2GlowLine = true;
    onDone();
    return;
  }
  if (/モニュメント/.test(e) && /ランダム/.test(e) && !/M\d{3}/.test(e)) {
    // 「ショップ001-006にモニュメントがランダムで出てくる」(2026-11-12 作り直し): M001〜M012からランダムに6枚
    // (per user回答)。見えるようにショップの画面に切り替える(説明が終わって自由に置く時にエリアに戻す)。
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    applyMobileActiveTab('shop');
    story2FillMonuments(false);
    const shopSlots = [...document.querySelectorAll('#shop-combined-slots .shop-slot')].filter((n) => n.style.gridRow === '1');
    shopSlots.forEach((n, k) => n.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 400, delay: k * 120, easing: 'ease-out', fill: 'backwards' }));
    run.chapter2.backToBoard = true;
    storyLater(onDone, shopSlots.length * 120 + 500);
    return;
  }
  if (/消え/.test(e) && /光る/.test(e)) {
    // 「セルフとスパルが5秒間消えて「目1-6」や「目1-5」と書いてあるところがすべて光る」: ショップのダイス目の
    // キャプションを光らせ、その間スパルとセリフを隠す。光はこの部分が終わるまで残す。
    storyHideDialog();
    storySetSpeaker('spalAway');
    if (/目/.test(e)) storySetGlow(['#shop-combined-slots .shop-slot__req']);
    storyLater(onDone, (Number(seconds) || 1) * 1000);
  } else if (/ショップ/.test(e) && /光る/.test(e)) {
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    storySetGlow(['.mobile-tab-switcher__btn[data-tab-target="shop"]']);
    onDone();
  } else if (/フリーアクション/.test(e) && /出てくる/.test(e)) {
    // 「フリーアクションボタンが出てくる」: ここから先はエリアの右下にフリーアクション(と1手戻る)を出す。
    document.body.classList.add('story-free-action');
    render(STATE);
    onDone();
  } else if (/フリーアクション/.test(e) && /光る/.test(e)) {
    storySetGlow(['.mobile-own-row__free-action']);
    onDone();
  } else if (/フリーアクション/.test(e) && /押す/.test(e)) {
    // 押せるものが何も無い時はボタン自体が出ないので、待たずに進む。
    if (!mobileFreeActionsAvailable(STATE, storyPlayer('P1'), 'P1')) { storySetGlow([]); onDone(); return; }
    storyWaitUntil(() => mobileFreeActionOpen, () => { storySetGlow([]); onDone(); });
  } else if (/カードをクリック/.test(e)) {
    // 「カードをクリックする」: フリーアクションの画面でカードを1枚使う(タップされる)まで待つ。使えるカードが
    // 無ければ待たない。使うと0.5秒後に画面が閉じてエリアに戻る(main.jsのmobileFreeActionTappedCardId、全モード
    // 共通)ので、それを待って次へ(このあと1手戻るボタンを光らせる)。
    if (computeMobileFreeActions(STATE, storyPlayer('P1')).cards.length === 0) { onDone(); return; }
    const tapped = () => storyPlayer('P1').ownedCardPhysicalIds.filter((id) => STATE.cards[id] && STATE.cards[id].tapped).length;
    const before = tapped();
    storyWaitUntil(() => tapped() > before && !pendingTapChoice && !pendingBuildChoice && !mobileFreeActionOpen, onDone);
  } else if (/1手戻る/.test(e) && /光る/.test(e)) {
    storySetGlow(['.mobile-own-row__cancel']); // 次にダイスを置くまで光らせる
    onDone();
  } else if (/自由にプレイ/.test(e)) {
    onDone();
  } else if (/ショップ画面/.test(e)) {
    // 「ショップ画面に移動」: こちらでショップのタブに切り替える。
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    applyMobileActiveTab('shop');
    render(STATE);
    storyLater(onDone, 400);
  } else if (/エリア画面/.test(e)) {
    // 「エリア画面に戻る」: こちらでエリアのタブに切り替える。
    applyMobileActiveTab('board');
    render(STATE);
    storyLater(onDone, 400);
  } else if (/M\d{3}/.test(e) && /ショップ/.test(e)) {
    // 「ショップ001-006にM007-012がランダムで出てくる」: モニュメントの段を「次のラウンドから」の裏向きから表に
    // して、書かれた範囲のモニュメントをランダムな順番で並べる。
    const range = /M(\d{3})(?:\s*[-~〜]\s*M?(\d{3}))?/.exec(e);
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    const faces = [];
    for (let n = from; n <= to; n++) faces.push(`M${String(n).padStart(3, '0')}`);
    for (let k = faces.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [faces[k], faces[j]] = [faces[j], faces[k]];
    }
    const slots = Object.keys(STATE.shops.M.slots);
    faces.forEach((faceId, k) => { if (slots[k]) STATE.shops.M.slots[slots[k]] = faceId; });
    STATE.shops.M.drawPile = [];
    if (run.shopOverrides) delete run.shopOverrides.monumentLabel;
    render(STATE);
    const shopSlots = [...document.querySelectorAll('#shop-combined-slots .shop-slot')].filter((n) => n.style.gridRow === '1');
    shopSlots.forEach((n, k) => n.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 400, delay: k * 120, easing: 'ease-out', fill: 'backwards' }));
    storyLater(onDone, shopSlots.length * 120 + 500);
  } else if (/戻る/.test(e) && /ボタン/.test(e)) {
    // 「ターン開始時に戻るボタンと１手戻るボタンが出てくる」: ここから先は、エリアの右下に1手戻る(main.jsの
    // renderMobileOwnRow、戻せる物が無い間は押せない表示。ターン開始時に戻るは場所が狭いので出さない、per user)、
    // カードを選ぶ画面(皇帝宮殿・元老院)に両方を出す。
    // 戻しても、一度見たセリフ・イベントは出し直さない(per user) -- 見たかどうかはchapter2の印で覚えていて、
    // 盤面と一緒には戻らない。
    document.body.classList.add('story-undo-shown');
    render(STATE);
    storySetGlow(['.mobile-own-row__undo', '.mobile-own-row__cancel']);
    storyLater(() => { storySetGlow([]); onDone(); }, 1500);
  } else if (/エリア/.test(e) && /光る/.test(e)) {
    // 「タブの「エリア」が光る」
    storySetAllowedTabs([...run.allowedTabs, 'board']);
    storySetGlow(['.mobile-tab-switcher__btn[data-tab-target="board"]']);
    onDone();
  } else if (/エリアに戻る/.test(e)) {
    storyWaitUntil(() => mobileActiveTab === 'board', () => {
      storySetGlow([]);
      onDone();
    });
  } else if (/拡大/.test(e)) {
    // 「セリフの上にカード貴族を拡大で表示してチェックマークをつけそれを光らせる」: 次の「消える」まで出しておく。
    story2ShowCallout(e);
    onDone();
  } else if (/ショップ/.test(e) && /クリック/.test(e)) {
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    storyShowGoal(e);
    storyWaitUntil(() => mobileActiveTab === 'shop', () => {
      storyShowGoal('');
      storySetGlow([]);
      onDone();
    });
  } else if (/次のラウンドから/.test(e)) {
    // 「SHOP001-006の2Rからの文字→次のラウンドから」: モニュメントの段を裏向きにして「次のラウンドから」と書く。
    run.shopOverrides = { ...(run.shopOverrides || {}), monumentLabel: '次のラウンドから' };
    render(STATE);
    onDone();
  } else if (/SHOP2/.test(e) && /見えなく/.test(e)) {
    run.shopOverrides = { ...(run.shopOverrides || {}), hideSpecial: true };
    render(STATE);
    onDone();
  } else if (/人材カード/.test(e)) {
    // 「SHOP101-106すべて人材カード」: 人材(C)の通常の6枚(総督・学者・商人・貴族・哲学者・金貸し)のLV1を、
    // ランダムな順番で (per user「その6まいでOK 順番ランダム」)。
    const slots = Object.keys(STATE.shops.NORMAL.slots);
    const faces = ['C001A', 'C002A', 'C003A', 'C004A', 'C005A', 'C006A'];
    for (let k = faces.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [faces[k], faces[j]] = [faces[j], faces[k]];
    }
    faces.forEach((faceId, k) => { if (slots[k]) STATE.shops.NORMAL.slots[slots[k]] = faceId; });
    STATE.shops.NORMAL.drawPile = [];
    render(STATE);
    onDone();
  } else if (/出てくる/.test(e)) {
    // 「３秒後スパルが出てくる」
    storyLater(() => { storySetSpeaker('spal'); onDone(); }, (Number(seconds) || 0) * 1000);
  } else if (/配られる/.test(e)) {
    // ここが「やり直し」の戻り先(配られる直前の盤面)。
    if (!run.chapter2.snapshot) {
      run.chapter2.snapshot = { state: gameStateMod.cloneState(STATE), visibleMapIds: run.visibleMapIds.slice(), rowIndex: i };
    }
    run.chapter2.cards = e.match(/R\d{3}/g) || [];
    story2ShowResourceCards(false);
    storyLater(onDone, 600);
  } else if (/選ぶ/.test(e)) {
    // 選んでいる間はスパルとセリフを隠す (per user「初期資源選ぶときには スパルとセリフが見えないように」)。
    storyHideDialog();
    storySetSpeaker('spalAway');
    story2ShowResourceCards(true, onDone);
  } else if (/振られる/.test(e)) {
    storyRollHandDice(onDone, 'P1');
  } else if (/オープン/.test(e)) {
    story2HideResourceCards();
    const mapIds = Object.keys(STATE.maps).filter((mapId) => {
      const name = dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId).NAME;
      return e.includes(name) && !run.visibleMapIds.includes(mapId);
    });
    mapIds.forEach((mapId, k) => storyLater(() => storyRevealMap(mapId), k * 250));
    storyLater(onDone, mapIds.length * 250 + 500);
  } else if (/消え/.test(e)) {
    // 「セルフとスパルが１秒間消える」「スパルとセリフが消える」: 秒数があればその間待つ。
    story2HideCallout();
    storyHideDialog();
    storySetSpeaker('spalAway');
    storyLater(onDone, (Number(seconds) || 0) * 1000);
  } else if (/次のラウンド/.test(e)) {
    const ch = run.chapter2;
    const start = () => storyStartNextRound(() => {
      story2LockPlacement(); // スパルのセリフの間は置けない
      // そのラウンドの「やり直し」の戻り先: 2ラウンド目は43行目「よーし次のラウンドだ」から、3ラウンド目は
      // 最終試験のセリフから。
      // 2026-11-12 作り直し: 2ラウンド目からはモニュメントの獲得(2・3・4ラウンド)。やり直しの戻り先は
      // 自由に置き始める時の盤面(story2FreePlay)。
      ch.monumentRound = STATE.round;
      onDone();
    }, true);
    if (!ch.turnOpen) { start(); return; }
    // 2ラウンド目の最後のダイスの手番はまだ終えていない(story2FreePlay): 「今のうちに獲得したカードを使っときな」
    // -> タップできるカードで未タップの物が無くなったら(per user)手番を終えて次のラウンドへ。
    storySetGlow(['.mobile-own-row__free-action']);
    storyWaitUntil(() => computeMobileFreeActions(STATE, storyPlayer('P1')).cards.length === 0 && !pendingTapChoice && !pendingBuildChoice && !mobileFreeActionOpen, () => {
      storySetGlow([]);
      applyMobileActiveTab('board');
      ch.turnOpen = false;
      storyEndTurnOf('P1');
      start();
    });
  } else if (/減る|増える/.test(e)) {
    // 「食料2減る」「人脈3増える」: 資源はもう本物のゲームの処理で変わっているが、表示は置く前の数のままに
    // してある(story2FreePlayのresourceOverride)ので、ここでその資源だけ本当の数に変えて光らせる (per user
    // 「酒場に行ったとき 会話に合わせて 食料を減らして 人脈を増やして」)。
    const names = { 食料: 'K', 権力: 'A', 知識: 'B', 金貨: 'C', 人脈: 'Z' };
    const key = Object.keys(names).find((n) => e.includes(n));
    if (key && run.resourceOverride) {
      const resource = names[key];
      run.resourceOverride = { ...run.resourceOverride, [resource]: storyPlayer('P1').resources[resource] || 0 };
      const actual = storyPlayer('P1').resources;
      if (Object.keys(run.resourceOverride).every((r) => (run.resourceOverride[r] || 0) === (actual[r] || 0))) run.resourceOverride = null;
      render(STATE);
    }
    const badge = key && storyResourceBadge(names[key]);
    if (badge) badge.classList.add('change-highlight');
    storyLater(() => { if (badge) badge.classList.remove('change-highlight'); onDone(); }, 1200);
  } else {
    console.warn(`第2章: C列「${e}」はまだ対応していません`);
    onDone();
  }
}

/** 初期資源カード(C列に書かれたIDのカード)を並べる。selectable=trueなら2枚選べて、「この2枚にする」で
 * 獲得(カードのONCEの資源ももらう)してonPicked()。 */
function story2ShowResourceCards(selectable, onPicked, cards, extraClass) {
  const run = storyRun;
  story2HideResourceCards();
  const root = el('div', 'story2-cards');
  if (extraClass) root.classList.add(extraClass);
  const row = el('div', 'story2-cards__row');
  const selected = new Set();
  const confirm = el('button', 'story-end__button story2-cards__confirm', 'この2枚にする');
  confirm.type = 'button';
  confirm.hidden = true;
  for (const faceId of cards || run.chapter2.cards) {
    const cell = el('div', 'story2-cards__card');
    cell.appendChild(buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true }));
    if (selectable) {
      cell.classList.add('story2-cards__card--selectable');
      cell.addEventListener('click', () => {
        if (selected.has(faceId)) selected.delete(faceId);
        else if (selected.size < 2) selected.add(faceId);
        cell.classList.toggle('story2-cards__card--selected', selected.has(faceId));
        confirm.hidden = selected.size !== 2;
      });
    }
    row.appendChild(cell);
  }
  root.appendChild(row);
  if (selectable) {
    root.appendChild(confirm);
    confirm.addEventListener('click', () => {
      story2HideResourceCards();
      // cardsを渡した時(第4章)は、受け取り方も呼び出し側(onPicked)で決める。
      if (cards) { onPicked([...selected]); return; }
      story2GrantResourceCards([...selected]);
      onPicked();
    });
  }
  run.dom.root.appendChild(root);
  run.dom.resourceCards = root;
  root.animate([{ opacity: 0, transform: 'translate(-50%, -12px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 300, easing: 'ease-out' });
}

function story2HideResourceCards() {
  const run = storyRun;
  if (run && run.dom.resourceCards) { run.dom.resourceCards.remove(); run.dom.resourceCards = null; }
}

function story2GrantResourceCards(faceIds) {
  const player = storyPlayer('P1');
  for (const faceId of faceIds) {
    const inst = gameStateMod.createCardInstance(faceId);
    inst.ownerId = 'P1';
    STATE.cards[inst.physicalId] = inst;
    player.ownedCardPhysicalIds.push(inst.physicalId);
    const once = dataLoaderMod.getCardRow(INDEX, faceId).ONCE;
    if (once) executorMod.runProgram(STATE, INDEX, { playerId: 'P1', sourcePhysicalId: inst.physicalId }, once);
  }
  render(STATE);
}

/** 導入やスパルのセリフの間はダイスを置けないようにする(次に置く所でstoryWaitForPlacementが戻す)。
 * main.jsのrender()は「手番が替わった」(lastTurnPlayerIdが違う/turnJustEnded)と置ける状態に戻すので、
 * それも今の手番(P1)に合わせておく。 */
function story2LockPlacement() {
  turnActionTaken = true;
  lastTurnPlayerId = 'P1';
  turnJustEnded = false;
  selectedDieIds = [];
}

/** モニュメントの段(ショップ001-006)にM001〜M012からランダムに並べる。onlyEmpty=trueなら空いている所だけ
 * (3・4ラウンド目の補充、per user回答「空いた所を補充」)。ショップに出ている物・獲得済みの物は出さない。 */
function story2FillMonuments(onlyEmpty) {
  const slots = STATE.shops.M.slots;
  const used = new Set(Object.values(slots).filter(Boolean));
  for (const player of STATE.players) {
    for (const id of player.ownedCardPhysicalIds) if (STATE.cards[id] && /^M/.test(STATE.cards[id].currentFaceId || '')) used.add(STATE.cards[id].currentFaceId);
  }
  const pool = [];
  for (let n = 1; n <= 12; n++) { const f = `M${String(n).padStart(3, '0')}`; if (!used.has(f) || !onlyEmpty) pool.push(f); }
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  for (const slotId of Object.keys(slots)) {
    if (onlyEmpty && slots[slotId]) continue;
    slots[slotId] = pool.shift() || null;
  }
  STATE.shops.M.drawPile = [];
  if (storyRun.shopOverrides) delete storyRun.shopOverrides.monumentLabel;
  render(STATE);
}

function story2MonumentCount() {
  return storyPlayer('P1').ownedCardPhysicalIds.filter((id) => STATE.cards[id] && /^M/.test(STATE.cards[id].currentFaceId)).length;
}

function story2ColorDiceCount() {
  return storyPlayer('P1').dice.filter((d) => d.kind === 'COLOR').length;
}

/** 導入のあと: ダイスを自由に置く。訓練場で色ダイスが増えた/酒場で人脈が増えたら、その部分のセリフ。 */
function story2FreePlay() {
  const run = storyRun;
  if (!run) return;
  const ch = run.chapter2;
  storySetSpeaker('spalAway');
  storyHideDialog();
  if (run.resourceOverride) { run.resourceOverride = null; render(STATE); } // 酒場の表示合わせが残っていたら本当の数に
  // モニュメントのラウンド: 説明のあと初めて自由に置く時、エリアの画面に戻す。その盤面を「やり直し」の戻り先に。
  if (ch.backToBoard) { ch.backToBoard = false; applyMobileActiveTab('board'); render(STATE); }
  // 獲得されて空いたモニュメントの所は、普段のゲームと同じく次の手番の初めに補充(2026-11-12, per user
  // 「モニュメントを獲得するとゲームと同じように次のターンの初めに補充される」)。
  if (ch.monumentRound && Object.values(STATE.shops.M.slots).some((f) => !f)) story2FillMonuments(true);
  if (ch.monumentRound && (!ch.monumentSnap || ch.monumentSnap.round !== STATE.round)) {
    ch.monumentSnap = { round: STATE.round, state: gameStateMod.cloneState(STATE), visibleMapIds: run.visibleMapIds.slice(), rowIndex: 0, allowedTabs: [...run.allowedTabs], monuments: story2MonumentCount() };
  }
  if (story2NeedsStarRescue()) { story2Play(ch.blocks.starRescue, 0, story2FreePlay); return; }
  if (storyForcePassIfStuck('P1', run.visibleMapIds, story2Finish)) return;
  if (!storyHasDiceLeft('P1')) { story2Finish(); return; }
  if (ch.unusedCardDue && !ch.unusedCardDone && storyPlayer('P1').ownedCardPhysicalIds.length > ch.unusedCardOwnedBefore) {
    ch.unusedCardDone = true;
    story2Play(ch.blocks.unusedCard || [], 0, story2FreePlay);
    return;
  }
  const ownedBefore = storyPlayer('P1').ownedCardPhysicalIds.length;
  const colorBefore = story2ColorDiceCount();
  const zBefore = storyPlayer('P1').resources.Z || 0;
  const resourcesBefore = { ...storyPlayer('P1').resources };
  const placedBefore = storyP1DiceCount(STATE, Object.keys(STATE.maps));
  storyWaitForPlacement({
    goalText: '',
    onPlaced: (mapId) => storyWhenVisualsIdle(() => {
      // カードを選ぶ画面で「ターン開始時に戻る」「1手戻る」を押してダイスが手元に戻ったら、手番は終えずに置き直し。
      if (storyP1DiceCount(STATE, Object.keys(STATE.maps)) <= placedBefore) {
        run.placementBaseline = storyPlacementCounts(STATE);
        story2FreePlay();
        return;
      }
      storySetGlow([]);
      // 2ラウンド目の最後のダイス: カードを使う時間を残すため、手番はまだ終えない(「次のラウンドになる」で終える)。
      if (ch.inRound2 && !storyHasDiceLeft('P1')) ch.turnOpen = true;
      else storyEndTurnOf('P1');
      render(STATE); // 手番の切り替わり(置ける状態に戻る)をここで済ませてから、
      story2LockPlacement(); // スパルのセリフの間は置けないようにする
      render(STATE);
      let block = null;
      if (storyPlayer('P1').ownedCardPhysicalIds.length > ownedBefore && !ch.unusedCardDue) { // 次のターンの始めに
        ch.unusedCardDue = true;
        ch.unusedCardOwnedBefore = ownedBefore; // 戻るボタンで獲得を取り消していたら出さない
      }
      const cardsGot = ch.inRound2 ? storyPlayer('P1').ownedCardPhysicalIds.length - ch.round2Snapshot.state.players.find((p) => p.id === 'P1').ownedCardPhysicalIds.length : 0;
      if (ch.inRound2 && cardsGot >= 1 && !ch.card1Done) {
        // 1枚目を獲得したのがこのラウンドの何ターン目か(=このラウンドに置いたダイスの数)。
        ch.card1Done = true;
        const turn = storyPlayer('P1').dice.filter((d) => d.placedMapId).length;
        block = ch.blocks[turn <= 2 ? 'card1early' : turn <= 4 ? 'card1mid' : 'card1late'] || [];
      }
      if (ch.inRound2 && cardsGot >= 2 && !ch.card2Done) {
        ch.card2Done = true;
        block = [...(block || []), ...(ch.blocks.card2 || [])];
      }
      // モニュメントのラウンドで、このラウンド初めてモニュメントを獲得した: 何ターン目か(=このラウンドに置いたダイスの
      // 数)で「モニュメントを獲得する 2R 1-2T / 3-4T / 5T」の部分。
      if (ch.monumentRound && ch.monumentSnap && ch.monumentGotRound !== STATE.round && story2MonumentCount() > ch.monumentSnap.monuments) {
        ch.monumentGotRound = STATE.round;
        // 今置いた手番の番号(「ターン○」と同じ数え方、2個まとめて置いても1回)。
        const tc = run.turnCounter;
        const turn = tc && tc.round === STATE.round ? tc.nth : storyPlayer('P1').dice.filter((d) => d.placedMapId).length;
        const key = Object.keys(ch.blocks).find((k) => {
          const m = new RegExp(`^mget:${STATE.round}:(\\d)-(\\d)$`).exec(k);
          return m && turn >= Number(m[1]) && turn <= Number(m[2]);
        }) || Object.keys(ch.blocks).filter((k) => k.startsWith(`mget:${STATE.round}:`)).pop(); // 範囲外(6個目など)は最後の部分
        if (key) block = ch.blocks[key];
      }
      if (block) {
        // 何枚目かの部分は「消える」で終わっていないので、終わったらスパルとセリフを下げる(story2FreePlay)。
      } else if (mapId === STORY_TRAINING_MAP_ID && story2ColorDiceCount() > colorBefore) {
        ch.trainCount++;
        if (ch.trainCount <= 2) block = ch.blocks[ch.trainCount === 1 ? 'train1' : 'train2'];
      } else if (mapId === STORY_TAVERN_MAP_ID && (storyPlayer('P1').resources.Z || 0) > zBefore && !ch.tavernDone) {
        ch.tavernDone = true;
        block = ch.blocks.tavern;
        // 食料・人脈の表示はセリフ(「食料2減る」「人脈3増える」)に合わせて変える: それまでは置く前の数を見せる。
        run.resourceOverride = resourcesBefore;
        render(STATE);
      }
      if (block) story2Play(block, 0, story2FreePlay);
      else story2FreePlay();
    }),
  });
}

function story2Finish() {
  const ch = storyRun.chapter2;
  if (ch.monumentRound) {
    // 2026-11-12 作り直し: 2・3・4ラウンド目は、そのラウンド中にモニュメントを1枚以上獲得できれば次のラウンド
    // (空いた所を補充)、4ラウンド目ならクリアで次の章へ。できなければそのラウンドの始めに戻す(セリフなし、per user回答)。
    // 失敗のセリフ(「ダイスを使い切る（モニュメントを獲得できていない）2R」)があれば、そのあと戻す。
    // 次のラウンドの始めのセリフ(「3Rはじめ」)があれば、補充のあとに出す。
    const snap = ch.monumentSnap;
    if (story2MonumentCount() <= snap.monuments) {
      const fail = ch.blocks[`mfail:${STATE.round}`];
      // 「（ダイスは振りなおす）」と書いてあれば振り直す。
      const reroll = !!fail && fail.some((r) => /振りなお|振り直/.test(r.event || ''));
      if (fail) story2Play(fail, 0, () => story2Rewind(snap, [], reroll));
      else story2Rewind(snap, []);
      return;
    }
    if (STATE.round >= 4) {
      // 「4Rダイスをすべて置ききる（モニュメントを合計３枚獲得できている）/（…4枚以上…）」のあと次の章へ。
      const total = story2MonumentCount();
      const ends = Object.keys(ch.blocks).filter((k) => k.startsWith(`mend:${STATE.round}:`));
      const key = ends.find((k) => k === `mend:${STATE.round}:${total}`)
        || ends.filter((k) => k.endsWith('+') && total >= Number(k.split(':')[2].replace('+', ''))).pop();
      if (key && story2RecordBlockSplit(ch.blocks[key])) ch3PlayRecordEnding(ch.blocks[key]);
      else if (key) story2Play(ch.blocks[key], 0, story2GoNextChapter);
      else story2GoNextChapter();
      return;
    }
    storyStartNextRound(() => {
      ch.monumentRound = STATE.round;
      story2FillMonuments(true);
      const start = ch.blocks[`mstart:${STATE.round}`];
      if (start) story2Play(start, 0, story2FreePlay);
      else story2FreePlay();
    }, true);
    return;
  }
  if (ch.inRound3) {
    // 3ラウンド目(最終試験): 6VP以上なら「つづく」、足りなければ3ラウンド目の始めからやり直し (per user)。
    const row = standingsRows(STATE).find((r) => r.playerId === 'P1');
    if (row && row.vp >= 6) storyEndOfScript('つづく');
    else story2Rewind(ch.round3Snapshot, ch.blocks.r2clear);
    return;
  }
  if (ch.inRound2) {
    // 2ラウンド目: カードを2枚獲得できなかったら、そのセリフのあと43行目「よーし次のラウンドだ」からやり直し。
    if (!ch.card2Done) { story2Play(ch.blocks.r2fail || [], 0, () => story2Rewind(ch.round2Snapshot, ch.blocks.clear)); return; }
    // できた: タップしていない(使える)カードがあれば「今のうちに使っときな」まで、無ければ「次のラウンドになる」から。
    const rows = ch.blocks.r2clear || [];
    const canUse = ch.turnOpen && computeMobileFreeActions(STATE, storyPlayer('P1')).cards.length > 0;
    const nextRoundAt = Math.max(0, rows.findIndex((r) => /次のラウンド/.test(r.event || '')));
    if (!canUse && ch.turnOpen) {
      ch.turnOpen = false;
      storyEndTurnOf('P1');
    }
    story2Play(rows, canUse ? 0 : nextRoundAt, story2FreePlay);
    return;
  }
  if (story2ColorDiceCount() >= 5) story2Play(ch.blocks.clear || [], 0, story2FreePlay);
  else story2Play(ch.blocks.fail || [], 0, () => story2Rewind(ch.snapshot, ch.blocks.intro));
}

/** 第3章クリア: 次の章へ(第2章→第3章と同じ形、per user回答「次の章へ」)。次の章がまだ無ければ「つづく」。 */
const STORY3_BEST_VP_KEY = 'diceWpStory3BestVP'; // 第3章の最高記録(VP)

/** 「歴代最高記録っぽい演出を」: 「〇VP‼ 歴代最高記録‼」(〇は今回のVP)を金色の大きな文字で画面の真ん中に出し、
 * 紙吹雪。3.5秒ほどで消えて次へ。 */
function story2RecordFanfare(text, onDone) {
  const run = storyRun;
  storyHideDialog();
  const vp = run.ch2Best ? run.ch2Best.vp : 0;
  const box = el('div', 'story2-record');
  for (const line of String(text).replace(/〇/g, String(vp)).split('\n')) {
    if (line.trim()) box.appendChild(el('div', 'story2-record__line', line));
  }
  run.dom.root.appendChild(box);
  box.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(0.4)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1.12)', offset: 0.7 }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }], { duration: 700, easing: 'ease-out' });
  if (typeof launchLifeStoryConfetti === 'function') launchLifeStoryConfetti(1);
  storyLater(() => {
    box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' }).onfinish = () => { box.remove(); onDone(); };
  }, 3500);
}
/** 「モニュメントを合計4枚以上」の終わり方(102〜117行目)を、記録の結果ごとの行に分ける。分けられなければnull。
 *  head: 「よーし…文句なしの合格だ」〜「お前はこれを更新できるか？」(「世界最高記録が更新されたとき」の前まで)
 *  world: 「こいつはスゲーぜ」と演出(「世界最高記録が更新されたとき」〜「最高記録が更新されたとき（世界…でない）」)
 *  personal: 「最高記録が更新されたとき（世界最高記録の時はでない）」から最後まで */
function story2RecordBlockSplit(rows) {
  const at = (re) => rows.findIndex((r) => re.test(story2NormalizeEvent(r.event || '')));
  const worldAt = at(/世界最高記録が更新されたとき/);
  const personalAt = at(/最高記録が更新されたとき.*世界最高記録の時はでない/);
  if (worldAt < 0 || personalAt < worldAt) return null;
  return { head: rows.slice(0, worldAt), world: rows.slice(worldAt + 1, personalAt), personal: rows.slice(personalAt) };
}

/** 第3章の最後(モニュメント4枚以上)。自分の最高記録(この端末)と世界最高記録(Firebase、全員の中で)を比べて
 * (2026-11-14, per user回答):
 *  どちらも更新しない → head(「今までの最高記録は〇VP」「世界最高記録は〇VPだ」「更新できるか？」まで)
 *  自分の記録だけ更新 → personal(「最高記録更新だ！」「ちなみに世界最高記録は〇VPだ」…)
 *  世界最高記録も更新 → world(「こいつはスゲーぜ」と演出)だけ
 * 同じ点でも更新(「過去の記録と同じ点でも」)、初めての時も自分の記録は更新。ネットにつながらず世界最高記録が
 * 分からない時は、世界最高記録の行を出さずに進む。 */
function ch3PlayRecordEnding(rows) {
  const run = storyRun;
  const split = story2RecordBlockSplit(rows);
  const standing = standingsRows(STATE).find((r) => r.playerId === 'P1');
  const vp = standing ? standing.vp : 0;
  let prev = null;
  try { const v = localStorage.getItem(STORY3_BEST_VP_KEY); prev = v === null ? null : Number(v); } catch (err) { /* 読めなければ記録なし */ }
  const personalUpdated = prev === null || vp >= prev;
  try { if (personalUpdated) localStorage.setItem(STORY3_BEST_VP_KEY, String(vp)); } catch (err) { /* 書けなくても続ける */ }
  run.ch2Best = { updated: personalUpdated, prev, vp };
  const sync = window.OnlineSync;
  let settled = false;
  const go = (world) => {
    if (settled || storyRun !== run) return;
    settled = true;
    // world: { best: 今回より前の世界最高記録(null=まだ無い) } / null=分からない
    const worldUpdated = !!world && (world.best === null || vp >= world.best);
    const worldText = world ? String(worldUpdated ? vp : world.best) : null;
    const pick = worldUpdated ? split.world : personalUpdated ? split.personal : split.head;
    const lines = [];
    for (const r of pick) {
      if (/演出/.test(r.event || '')) { lines.push(r); continue; }
      if (!r.text) continue;
      let text = r.text;
      if (/世界最高記録は〇/.test(text)) { if (worldText === null) continue; text = text.replace('〇', worldText); }
      else if (/今までの最高記録は〇/.test(text)) text = text.replace('〇', String(prev === null ? vp : prev));
      lines.push({ ...r, text, event: '' });
    }
    story2Play(lines, 0, story2GoNextChapter);
  };
  if (!sync || !sync.getStoryWorldRecord) { go(null); return; }
  storyLater(() => go(null), 6000); // ネットが遅い・つながらない
  sync.getStoryWorldRecord('ch3').then((best) => {
    if (best === null || vp >= best) {
      // 書き込みは結果を待たない(書けなくても、読めた記録で進める)。
      sync.submitStoryWorldRecord('ch3', vp).catch((err) => console.warn('世界最高記録を書けませんでした', err));
    }
    go({ best });
  }).catch((err) => { console.warn('世界最高記録を読めませんでした', err); go(null); });
}

function story2GoNextChapter() {
  storyMarkChapterCleared(3);
  const nextChapter = STORY_CHAPTERS.find((c) => c.no === 4);
  if (!nextChapter || !nextChapter.start) { storyEndOfScript('つづく'); return; }
  storyGoChapter(4);
}

/** 「やり直し」: snapの盤面に戻して、rowsのsnap.rowIndex行目から続きを出す。1ラウンド目は初期資源カードが
 * 配られる直前(導入の途中)、2ラウンド目は「よーし次のラウンドだ」の直前。 */
function story2Rewind(snap, rows, reroll) {
  const run = storyRun;
  if (!run) return;
  const ch = run.chapter2;
  story2HideCallout();
  run.resourceOverride = null;
  document.body.classList.remove('story-undo-shown');
  run.shopOverrides = null;
  if (snap.allowedTabs) storySetAllowedTabs(snap.allowedTabs);
  storySetGlow([]);
  storyUseState(gameStateMod.cloneState(snap.state));
  run.turnBannerKeys = new Set(); // 巻き戻したら「ターン○」も数え直す
  story2LockPlacement();
  run.visibleMapIds = snap.visibleMapIds.slice();
  run.placementBaseline = storyPlacementCounts(STATE);
  run.glowDieValues = [];
  if (snap === ch.snapshot) { // 1ラウンド目のやり直しだけ、訓練場・酒場のセリフも出し直す
    ch.trainCount = 0;
    ch.tavernDone = false;
  }
  if (snap !== ch.round3Snapshot) {
    ch.card1Done = false;
    ch.card2Done = false;
    ch.unusedCardDue = false;
    ch.unusedCardDone = false;
    document.body.classList.remove('story-free-action');
  }
  ch.turnOpen = false;
  ch.inRound2 = snap === ch.round2Snapshot;
  ch.inRound3 = snap === ch.round3Snapshot;
  lastRenderedRound = STATE.round;
  storyApplyVisibleMaps();
  render(STATE);
  // 「最初に戻る（ダイスは振りなおす）」: 戻した盤面の手元のダイスを振り直してから。
  if (reroll) {
    storyPlayer('P1').dice.filter((d) => !d.placedMapId && !d.passed).forEach((d) => { d.value = 1 + Math.floor(Math.random() * 6); });
    render(STATE);
    storyRollHandDice(() => story2Play(rows, snap.rowIndex, story2FreePlay), 'P1');
    return;
  }
  story2Play(rows, snap.rowIndex, story2FreePlay);
}

/** 「セリフの上にカード貴族を拡大で表示してチェックマークをつけそれを光らせる」: C列に名前が書かれたカード
 * (LV1)を、セリフの上に大きく出す。獲得できる印(✓)を付けて光らせる。次の「消える」で消す。 */
function story2ShowCallout(eventText) {
  const run = storyRun;
  story2HideCallout();
  let best = null;
  for (const sheet of ['A', 'B', 'C', 'M']) {
    for (const row of INDEX.raw[sheet] || []) {
      const base = String(row.NAME || '').replace(/LV\d+$/, '');
      if (!base || !eventText.includes(base) || /LV[2-9]$/.test(row.NAME)) continue;
      if (!best || base.length > best.base.length) best = { faceId: row.ID, base };
    }
  }
  if (!best) { console.warn(`第2章: 「${eventText}」のカードが見つかりません`); return; }
  const card = buildCardVisual(best.faceId, { showEffect: true, noInteraction: true });
  card.appendChild(el('span', 'shop-card__acquirable-badge', '✓'));
  card.classList.add('change-highlight');
  const box = el('div', 'story2-callout');
  box.appendChild(card);
  run.dom.root.appendChild(box);
  box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
}
function story2HideCallout() {
  document.querySelectorAll('.story2-callout').forEach((n) => n.remove());
}

/* ---------- 第2章: 几帳面な研究者セネカ (data/story_seneca.data.js) ---------- */

/** 2026-11-09, per user: ストーリー.xlsxのシート「几帳面な研究者セネカ」(tools/story2_xlsx_to_js.py で変換)。
 * スパルの章と同じく1行ずつ、A列=セネカのセリフ、C列=画面で起きること/その部分が始まる条件。
 *  - 「農園にダイスを置く」の行までが導入(ダイス3個・食料5個でスタート、農園/図書館/皇帝宮殿オープン、
 *    セネカ(P2)がダイスを振って皇帝宮殿に置き、図書館の支配LV1を獲得して図書館がLV1に)。
 *  - そのあと、あなたが農園か図書館にダイスを置く。先に農園なら「農園にダイスを置く」の部分(最後に農園が消える)
 *    のあと図書館に置くのを待つ。図書館に置いたら「つづく」(per user回答: いきなり図書館でもそのまま「つづく」)。
 *    図書館に置いた手番は終えない(使用料の支払いが出ないように、そのまま「つづく」)。 */
const STORY_LIBRARY_MAP_ID = 'MAP004'; // 図書館
const SENECA_TRIGGERS = [
  { key: 'farm', test: (e) => /農園/.test(e) && /置く/.test(e) },
  { key: 'library', test: (e) => /図書館/.test(e) && /置く/.test(e) },
];

function senecaBlocks() {
  const blocks = { intro: [] };
  let current = blocks.intro;
  (window.STORY_SENECA_SCRIPT || []).forEach((row, index) => {
    const e = row.event && story2NormalizeEvent(row.event);
    const trigger = e && !/セネカが/.test(e) && SENECA_TRIGGERS.find((t) => t.test(e));
    if (trigger) {
      current = blocks[trigger.key] = [];
      current.push({ text: row.text, event: '', index });
      return;
    }
    current.push({ ...row, index });
  });
  return blocks;
}

function senecaBuildState() {
  const state = storyBuildState(story2DiceValues(), { P1: 'CON001', P2: 'CON005' });
  // ショップには図書館の支配LV1だけ(セネカが皇帝宮殿で獲得する)。
  state.shops.NORMAL.slots.SHOP101 = 'A002A';
  // あなたもセネカも性格・ジョブ・カードなし(第3章スパルと同じく何も足さない)。
  for (const id of ['P1', 'P2']) {
    const p = state.players.find((x) => x.id === id);
    for (const physicalId of p.ownedCardPhysicalIds) {
      if (physicalId === p.conPhysicalId || physicalId === p.jobCardId) delete state.cards[physicalId];
      else if (state.cards[physicalId]) state.cards[physicalId].ownerId = null;
    }
    p.ownedCardPhysicalIds = [];
    p.conPhysicalId = null;
    p.conFace = null;
    p.jobCardId = null;
    p.skipOnboarding = true;
  }
  const seneca = state.players.find((p) => p.id === 'P2');
  // 2026-11-12, per user回答「最初から几帳面な研究者セネカ」: プレイヤーネームもセリフの名前欄も(senecaStart)。
  seneca.name = STORY_SENECA_FIRST_NAME;
  seneca.dice = seneca.dice.slice(0, 1); // セネカは皇帝宮殿に1個置くだけ
  return state;
}

const STORY_SENECA_FIRST_NAME = '几帳面な研究者セネカ';
const STORY_SENECA_WORRIED_IMG = 'assets/story-seneca-worried.webp';
const STORY_SENECA_HAPPY_IMG = 'assets/story-seneca-happy.webp'; // 喜んでいる几帳面な研究者セネカ.png(「素晴らしいわ！」以降)
function senecaStart() {
  const run = storyRun;
  STORY_SPEAKERS.seneca.name = STORY_SENECA_FIRST_NAME;
  STORY_SPEAKERS.senecaAway.name = STORY_SENECA_FIRST_NAME;
  run.visibleMapIds = [];
  run.seneca = { blocks: senecaBlocks(), farmDone: false };
  storyUseState(senecaBuildState());
  story2LockPlacement();
  run.placementBaseline = storyPlacementCounts(STATE);
  storyApplyVisibleMaps();
  applyMobileActiveTab('board');
  render(STATE);
  new Image().src = STORY_SENECA_WORRIED_IMG; // 心配性になった時・喜んでいる時の差分も先に読んでおく
  new Image().src = STORY_SENECA_HAPPY_IMG;
  const img = new Image();
  img.src = STORY_SPEAKERS.seneca.img;
  const loaded = img.decode ? img.decode() : Promise.resolve();
  loaded.catch(() => {}).then(() => {
    if (storyRun !== run) return;
    senecaPlay(run.seneca.blocks.intro, 0, senecaFreePlay);
  });
}

/** セネカの章でショップを光らせる: スマホでは左下のセネカの絵がショップの一番左のカードに重なるので、そこを
 * 光らせている間は絵を消す (per user「光らせている間だけセネカの絵を消す」-- 第3章のスパルが消えるのと同じ形)。 */
function senecaGlow(selectors) {
  const run = storyRun;
  if (!run) return;
  if (run.showAcquirableBadges && !selectors.some((sel) => sel.includes('acquirable-badge'))) {
    run.showAcquirableBadges = false;
    render(STATE);
  }
  storySetGlow(selectors);
  const firstSlot = Object.keys(STATE.shops.NORMAL.slots)[0];
  const firstFace = STATE.shops.NORMAL.slots[firstSlot];
  run.seneca.hidePortrait = isMobileLayout() && selectors.some((sel) => sel.includes('#shop-combined-slots') && (
    sel.includes('acquirable-badge') || sel.includes(`"${firstSlot}"`) || sel.includes('[data-face-id]') || (firstFace && (sel.includes(`"${firstFace}"`) || sel.includes(`^="${firstFace[0]}"`)))));
  storySetSpeaker(run.seneca.hidePortrait ? 'senecaAway' : 'seneca');
}

/** rowsをi行目から順番に: C列があればその出来事、A列があればセネカのセリフ。 */
function senecaPlay(rows, i, onDone) {
  if (!storyRun) return;
  if (i >= rows.length) { onDone(); return; }
  const row = rows[i];
  const next = () => senecaPlay(rows, i + 1, onDone);
  // まだ交渉術・土木技術・基礎学問を持っていない間の盤面を覚えておく(ショートカットで先に獲得した時の「残念」の戻り先)。
  if (!storyRun.seneca.negotiationStarted && !senecaHasCard(/^B00[146]/)) storyRun.seneca.preAcquireSnap = { state: gameStateMod.cloneState(STATE), visibleMapIds: storyRun.visibleMapIds.slice() };
  // チェックマークの説明の間に「このカードを獲得する」で交渉術/土木技術を先に獲得した時も、「ダイスが置ける
  // ようになる」の行(senecaTryNegotiation)へ飛ばす。
  if (!storyRun.seneca.negotiationStarted && !storyRun.seneca.skipToRe && senecaHasCard(/^B00[146]/)) storyRun.seneca.skipToRe = /置けるようになる/;
  // 「置けない場合」で置けた時: skipToReに当たる行まで飛ばす。
  if (storyRun.seneca.skipToRe) {
    if (!storyRun.seneca.skipToRe.test(row.event || '')) { next(); return; }
    storyRun.seneca.skipToRe = null;
  }
  // 「ダイスが置けるようになる」: ここから先の行(ダイスがなくなる/皇帝宮殿以外に置く/交渉術を獲得する)は順番に
  // 流すのではなく、置いた結果で選ぶ(senecaTryNegotiation)。
  if (row.event && /置けるようになる/.test(story2NormalizeEvent(row.event))) {
    senecaTryNegotiation(row, rows.slice(i + 1), onDone);
    return;
  }
  const say = () => {
    if (!row.text) { next(); return; }
    // 「獲得可能なカードはチェックマークがついているのよ」: まだ置けない場面でも、置けるようになったら獲得できる
    // カードに✓を出して光らせる(2026-11-11, per user「おねがい」)。次にショップの別の所を光らせるまで(「交渉術が光る」)。
    if (/チェックマーク/.test(row.text) && !storyRun.showAcquirableBadges) {
      storyRun.showAcquirableBadges = true;
      render(STATE);
      senecaGlow(['#shop-combined-slots .shop-card__acquirable-badge']);
    }
    storySetSpeaker(storyRun.seneca.hidePortrait ? 'senecaAway' : 'seneca');
    // 「素晴らしいわ！」以降は喜んでいる差分(2026-11-12, per user)。
    // 2026-11-13: セリフが「驚いたわ！」に変わった(同じ場面)。
    if (/^(素晴らしいわ|驚いたわ)/.test(row.text)) senecaSwapPortrait(STORY_SENECA_HAPPY_IMG);
    storySayThen(`CS-${row.index}`, () => {
      if (storyRun && storyRun.seneca.glowUntilLineEnd) { storyRun.seneca.glowUntilLineEnd = false; storySetGlow([]); }
      next();
    }, 0, row.text);
  };
  if (row.event) senecaDoEvent(row, say);
  else say();
}

function senecaDoEvent(row, onDone) {
  const run = storyRun;
  const e = story2NormalizeEvent(row.event);
  if (/ターン\s*\d+\s*が流れる/.test(e)) {
    // 「ターン1が流れる」: 「あなた ターン1」を出す(このあと置けるようになった時にもう一度は出ない)。
    storyTurnBannerWhenPlaceable(STATE);
    onDone();
  } else if (/拡大画面/.test(e)) {
    // 「土木技術の拡大画面が出る」: ショップ等でカードを押した時の拡大表示を出す(「フリーアクションボタンが
    // 光る」で閉じる、per user回答)。
    const faceIds = [...storyPlayer('P1').ownedCardPhysicalIds.map((id) => STATE.cards[id] && STATE.cards[id].currentFaceId), ...Object.values(STATE.shops.NORMAL.slots)];
    const faceId = faceIds.find((f) => f && e.includes(dataLoaderMod.getCardRow(INDEX, f).NAME.replace(/LV\d+$/, '')));
    if (faceId) showTutorialCardTermModal(faceId);
    storyLater(onDone, 400);
  } else if (/⤵/.test(e) && /光る/.test(e)) {
    // 「⤵が光る」: 拡大画面の中のタップマーク。
    document.querySelectorAll('#card-inst-overlay .action-emoji').forEach((n) => { if (n.textContent.includes('⤵')) n.dataset.storyTap = '1'; });
    senecaGlow(['#card-inst-overlay [data-story-tap]']);
    onDone();
  } else if (/フリーアクション/.test(e) && /光る/.test(e)) {
    // 「フリーアクションボタンが光る」: 拡大画面を閉じて、エリアの右下にフリーアクション(と1手戻る)を出して光らせる
    // (第3章の「フリーアクションボタンが出てくる」と同じ)。
    hideCardEnlargeModal();
    document.body.classList.add('story-free-action');
    render(STATE);
    senecaGlow(['.mobile-own-row__free-action']);
    onDone();
  } else if (/自分のダイス/.test(e) && /皇帝宮殿のダイス/.test(e) && /光る/.test(e)) {
    // 「自分のダイスと皇帝宮殿のダイスが光る」(「すでに置いてあるダイス目と同じダイス目は…置けないわ」): 手元の
    // ダイスと皇帝宮殿に置いてあるダイスを、そのセリフの間だけ。
    storySetGlow(['#mobile-own-row .mobile-own-row__dice .die', '#players .player-panel[data-player-id="P1"] .die:not(.die--placed)', storyTileSelector(STORY_CASTLE_MAP_ID, '.die')]);
    run.seneca.glowUntilLineEnd = true;
    onDone();
  } else if (/白ダイス/.test(e) && /光る/.test(e)) {
    // 「白ダイスが光る」: あなたの白ダイスを、そのセリフの間だけ。
    storySetGlow(['#mobile-own-row .mobile-own-row__dice--white .die', '#players .player-panel[data-player-id="P1"] .die--WHITE']);
    run.seneca.glowUntilLineEnd = true;
    onDone();
  } else if (/セネカ/.test(e) && /が(.+セネカ)になる/.test(e)) {
    // 「几帳面な研究者セネカが心配性な研究者セネカになる」: 以降のセリフの名前欄とプレイヤーネームを変える(per user回答)。
    // 巻き戻しても戻さない(senecaApplyName)。
    const name = /が(.+セネカ)になる/.exec(e)[1];
    STORY_SPEAKERS.seneca.name = name;
    STORY_SPEAKERS.senecaAway.name = name;
    if (run.speaker === 'seneca' || run.speaker === 'senecaAway') run.dom.dialogName.textContent = name;
    // 立ち絵も差分(心配性な研究者セネカ.png、2026-11-12 per user「差分画像作りました」)に。
    if (/心配性/.test(name)) senecaSwapPortrait(STORY_SENECA_WORRIED_IMG);
    senecaApplyName();
    onDone();
  } else if (/(知識|権力|金貨|食料)が(\d+)増える/.test(e)) {
    // 「知識が2増える」: あなたの資源を増やす。
    const [, kind, n] = /(知識|権力|金貨|食料)が(\d+)増える/.exec(e);
    const key = { 知識: 'B', 権力: 'A', 金貨: 'C', 食料: 'K' }[kind];
    const p1 = storyPlayer('P1');
    p1.resources[key] = (p1.resources[key] || 0) + Number(n);
    render(STATE);
    storyLater(onDone, 400);
  } else if (/分岐に行く/.test(e)) {
    // 「その後獲得したカードの分岐に行く」: 台本の流れの説明(続きはsenecaTryNegotiationが選ぶ)。
    onDone();
  } else if (/アンタップ/.test(e)) {
    // 「基礎学問をアンタップする」: あなたのそのカードを起こす。
    for (const id of storyPlayer('P1').ownedCardPhysicalIds) {
      const card = STATE.cards[id];
      if (card && card.tapped && e.includes(dataLoaderMod.getCardRow(INDEX, card.currentFaceId).NAME.replace(/LV\d+$/, ''))) card.tapped = false;
    }
    render(STATE);
    storyLater(onDone, 400);
  } else if (/フリック/.test(e) && /獲得カード/.test(e)) {
    // 「フリックで獲得カードに行けるようになる」
    storySetAllowedTabs([...run.allowedTabs, 'cards']);
    onDone();
  } else if (/スタート/.test(e)) {
    // 「ダイス３個食料５個でスタート」
    const food = Number((/食料(\d+)/.exec(e) || [])[1] || 0);
    storyPlayer('P1').resources.K = food;
    render(STATE);
    storyRollHandDice(onDone, 'P1');
  } else if (/セネカ/.test(e) && /ふる|振る/.test(e)) {
    // セネカ(P2)の手番にして、ダイスを振る(第1章のパトラ登場と同じ形)。
    // 「ダイス目は６以外」: その目は出ない(あとで高等学問で6にした時に皇帝宮殿に置けるように)。
    const p2 = storyPlayer('P2');
    const excluded = Number((/(\d)以外/.exec(e) || [])[1] || 0);
    const values = [1, 2, 3, 4, 5, 6].filter((v) => v !== excluded);
    p2.dice.forEach((d) => { d.passed = false; d.value = values[Math.floor(Math.random() * values.length)]; });
    storyEndTurnOf('P1');
    document.body.classList.add('story-lock-hand');
    render(STATE);
    storyLater(() => storyRollHandDice(onDone, 'P2'), 300);
  } else if (/セネカ/.test(e) && /皇帝宮殿/.test(e) && /置く/.test(e)) {
    const p2 = storyPlayer('P2');
    p2.resources.A = Math.max(p2.resources.A || 0, 2); // 図書館の支配LV1(2A)を買える分
    const die = p2.dice.find((d) => !d.placedMapId && !d.passed);
    const slotIndex = STATE.maps[STORY_CASTLE_MAP_ID].slots.findIndex((s) => s.length === 0);
    const result = boardMod.placeDice(STATE, INDEX, { playerId: 'P2' }, die.id, STORY_CASTLE_MAP_ID, slotIndex);
    run.seneca.pendingBuild = result.success && result.actionResult && result.actionResult.pendingBuild;
    render(STATE);
    storyLater(() => storyWhenVisualsIdle(onDone), 400);
  } else if (/セネカ/.test(e) && /獲得/.test(e)) {
    // 「セネカが図書館の支配を獲得」: 皇帝宮殿の建築で図書館の支配LV1を選ぶ(図書館がLV1になる)。
    const pending = run.seneca.pendingBuild;
    const candidate = pending && pending.candidates.find((c) => c.faceId === 'A002A');
    if (candidate) boardMod.completeAreaBuild(STATE, INDEX, { playerId: 'P2' }, candidate, pending.remainingCommands);
    run.seneca.pendingBuild = null;
    render(STATE);
    storyLater(() => storyWhenVisualsIdle(() => {
      storyEndTurnOf('P2');
      document.body.classList.remove('story-lock-hand');
      render(STATE);
      story2LockPlacement(); // セリフの間は置けない
      render(STATE);
      onDone();
    }), 600);
  } else if (/食料/.test(e) && /知識/.test(e)) {
    // 「食料が知識に＋金貨2」: 図書館に置いた時の資源の変化は、ここまで置く前の数で見せている(senecaFreePlay)。
    // ここで本当の数にして、増えた資源を光らせる。
    storyShowResourceChange('K', 'B', () => {
      const badge = storyResourceBadge('C');
      if (badge) badge.classList.add('change-highlight');
      storyLater(() => { if (badge) badge.classList.remove('change-highlight'); onDone(); }, 1200);
    });
  } else if (/ターンが終了/.test(e)) {
    // 「ターンが終了し使用料が支払われる」: 手番を終えて(本当のゲームの処理で使用料を払う)、使用料の所を光らせる。
    storyHideDialog();
    const feeMapId = STORY_LIBRARY_MAP_ID;
    storyEndTurnOf('P1');
    render(STATE);
    story2LockPlacement();
    render(STATE);
    const fee = document.querySelector(storyTileSelector(feeMapId, '.map-tile__fee'));
    if (fee) fee.classList.add('change-highlight');
    const badge = storyResourceBadge('B');
    if (badge) badge.classList.add('change-highlight');
    storyLater(() => { if (badge) badge.classList.remove('change-highlight'); onDone(); }, 1200);
  } else if (/使用料/.test(e) && /光る/.test(e)) {
    storySetGlow([storyTileSelector(STORY_LIBRARY_MAP_ID, '.map-tile__fee')]);
    run.seneca.glowUntilLineEnd = true;
    onDone();
  } else if (/次のターン/.test(e)) {
    storySetGlow([]);
    render(STATE);
    storyLater(onDone, 600);
  } else if (/ショップ画面/.test(e)) {
    // 「ショップ画面に行く（スマホ版）」: ショップ画面に移ったら(タブを押しても、フリックでも)セリフが続く。
    // PC・タブレットはショップが最初から見えているので待たない。
    storyHideDialog();
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    const finish = () => { senecaGlow([]); onDone(); };
    if (isMobileLayout()) storyWaitUntil(() => mobileActiveTab === 'shop', finish);
    else finish();
  } else if (/エリア画面/.test(e)) {
    // 「エリア画面にもどる」: こちらでエリアのタブに切り替える。
    senecaGlow([]);
    if (isMobileLayout()) applyMobileActiveTab('board');
    render(STATE);
    storyLater(onDone, 300);
  } else if (/(\d+)秒/.test(e) && !/セネカ/.test(e)) {
    // 「１秒間がある」
    storyHideDialog();
    storyLater(onDone, Number(/(\d+)秒/.exec(e)[1]) * 1000);
  } else if (/必要資源/.test(e) && /光る/.test(e)) {
    senecaGlow(['#shop-combined-slots .shop-slot[data-face-id] .shop-card > .shop-card__cost']);
    onDone();
  } else if (/目\s*\d/.test(e) && /光る/.test(e)) {
    // 「目1-6　目1-5などが光る」(など = ショップの段のダイス目すべて) / 「目1-6が光る」 / 「目1-6　目1-5が光る」。
    const slots = Object.keys(STATE.shops.NORMAL.slots);
    const labels = (e.match(/目\s*\d(?:-\d)?/g) || []).map((s) => s.replace(/\s/g, ''));
    const targets = /など/.test(e) ? slots : slots.filter((slotId) => labels.includes(shopReqForSlotId(slotId).replace(/\s/g, '')));
    senecaGlow(targets.map((slotId) => `#shop-combined-slots .shop-slot[data-slot-id="${slotId}"] .shop-slot__req`));
    onDone();
  } else if (/置けない場合/.test(e)) {
    // 「もし残ったダイス目が皇帝宮殿に置けない場合セリフが出る」: 置けるダイスが1つでもあれば、このあとのセリフと
    // 高等学問の演出は飛ばして「ダイスが置けるようになる」へ (per user回答)。
    const dice = storyPlayer('P1').dice.filter((d) => !d.placedMapId && !d.passed);
    const placeable = dice.some((d) => storyPlaceableSlots('P1', d.id, [STORY_CASTLE_MAP_ID]).length > 0);
    if (placeable) run.seneca.skipToRe = /置けるようになる/;
    onDone();
  } else if (/高等学問/.test(e) && /アニメーション/.test(e)) {
    // 演出だけ(知識は払わない、per user回答)。
    storyHideDialog();
    mobileAiCardGainQueue.push({ faceId: 'B002A' });
    playNextMobileAiCardGain();
    storyLater(() => storyWhenVisualsIdle(onDone), 200);
  } else if (/ダイス目が(\d)に/.test(e)) {
    // 「ダイス目が6に」: 皇帝宮殿に置けないダイスの目を変える。
    const value = Number(/ダイス目が(\d)に/.exec(e)[1]);
    const die = storyPlayer('P1').dice.find((d) => !d.placedMapId && !d.passed);
    if (die) die.value = value;
    run.glowDieValues = [value];
    render(STATE);
    storyLater(() => { run.glowDieValues = []; render(STATE); onDone(); }, 1200);
  } else if (!/カードが光る/.test(e) && /光る/.test(e) && Object.values(STATE.shops.NORMAL.slots).some((f) => f && e.includes(dataLoaderMod.getCardRow(INDEX, f).NAME.replace(/LV\d+$/, '')))) {
    // 「交渉術が光る」: ショップのそのカードを光らせる。
    const faceId = Object.values(STATE.shops.NORMAL.slots).find((f) => f && e.includes(dataLoaderMod.getCardRow(INDEX, f).NAME.replace(/LV\d+$/, '')));
    senecaGlow([`#shop-combined-slots .shop-slot[data-face-id="${faceId}"] .shop-card`]);
    onDone();
  } else if (/ショップ/.test(e) && /オープン/.test(e)) {
    // 「ショップがオープン左から「交渉術」「農園の支配」…」: 書いてある順にSHOP101-106へLV1を並べる。
    const names = (e.match(/「[^」]+」/g) || []).map((s) => s.slice(1, -1));
    const faces = names.map((name) => ['A', 'B', 'C'].map((k) => INDEX.raw[k].find((r) => r.NAME === `${name}LV1`)).find(Boolean)).filter(Boolean).map((r) => r.ID);
    const slots = Object.keys(STATE.shops.NORMAL.slots);
    slots.forEach((slotId, k) => { STATE.shops.NORMAL.slots[slotId] = faces[k] || null; });
    STATE.shops.NORMAL.drawPile = [];
    render(STATE);
    const shopSlots = faces.map((f) => document.querySelector(`#shop-combined-slots .shop-slot[data-face-id="${f}"]`)).filter(Boolean);
    shopSlots.forEach((n, k) => n.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 400, delay: k * 120, easing: 'ease-out', fill: 'backwards' }));
    storyLater(onDone, shopSlots.length * 120 + 500);
  } else if (/ショップ/.test(e) && /光る/.test(e)) {
    // 「タブのショップが光る」
    storySetAllowedTabs([...run.allowedTabs, 'shop']);
    storySetGlow(['.mobile-tab-switcher__btn[data-tab-target="shop"]']);
    onDone();
  } else if (/ショップ/.test(e) && /押す/.test(e)) {
    // 「タブのショップを押す（スマホ版）」: スマホは押すまで待つ。PC・タブレットはショップが最初から見えているので待たない。
    storyHideDialog();
    const finish = () => { senecaGlow([]); onDone(); };
    if (isMobileLayout()) storyWaitUntil(() => mobileActiveTab === 'shop', finish);
    else finish();
  } else if (/(領地|学問|人材)カード/.test(e) && /光る/.test(e)) {
    // 「領地カードが光る」(赤=A)「学問カードが光る」(青=B)「人材カードが光る」(黄=C): 次のカードの種類が光るまで光らせておく。
    const kind = /領地/.test(e) ? 'A' : /学問/.test(e) ? 'B' : 'C';
    senecaGlow([`#shop-combined-slots .shop-slot[data-face-id^="${kind}"] .shop-card`]);
    onDone();
  } else if (/能力/.test(e) && /光る/.test(e)) {
    // 「図書館の能力部分が光る」: そのセリフの間だけ。
    const mapId = Object.keys(STATE.maps).find((m) => e.includes(dataLoaderMod.getAreaRow(INDEX, STATE.maps[m].currentAreaId).NAME.replace(/LV\d+$/, '')));
    if (mapId) {
      storySetGlow([`#board .map-tile[data-map-id="${mapId}"] .map-tile__action`]);
      run.seneca.glowUntilLineEnd = true;
    }
    onDone();
  } else if (/オープン/.test(e)) {
    const mapIds = Object.keys(STATE.maps).filter((mapId) => {
      const name = dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId).NAME;
      return e.includes(name) && !run.visibleMapIds.includes(mapId);
    });
    mapIds.forEach((mapId, k) => storyLater(() => storyRevealMap(mapId), k * 250));
    storyLater(onDone, mapIds.length * 250 + 500);
  } else if (/消える/.test(e)) {
    // 「「農園」が消える」: そのエリアを枠だけに戻す。
    const mapIds = Object.keys(STATE.maps).filter((mapId) => e.includes(dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId).NAME));
    storyHideDialog();
    mapIds.forEach((mapId) => {
      const tile = storyTileNode(mapId);
      const finish = () => {
        run.visibleMapIds = run.visibleMapIds.filter((m) => m !== mapId);
        storyApplyVisibleMaps();
      };
      if (tile) [...tile.children].forEach((child, k) => { const a = child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-in' }); if (k === 0) a.onfinish = finish; });
      if (!tile || tile.children.length === 0) finish();
    });
    storyLater(onDone, 600);
  } else {
    console.warn(`セネカの章: C列「${e}」はまだ対応していません`);
    onDone();
  }
}

/** 「ダイスが置けるようになる」(row、セリフ「さあ、あとは自分で考えて行動してみて」)のあと: 見えているエリアのどこに
 * 置いてもよい。restはその後ろの行で、置いた結果で選ぶ:
 *  - 「交渉術を獲得する」: 皇帝宮殿で交渉術を獲得したらその後ろの行を流してonDone()(「つづく」)。
 *  - 「皇帝宮殿以外にダイスを置く（ダイスがまだ残っている）」: そのセリフ(道草…)を出して、続けて置かせる。
 *  - 「ダイスがなくなる（交渉術が獲得できていない）」: そのセリフ(残念…)を出して、rowのセリフの前まで戻る。 */
/** 第2章を終えて第3章へ: 第2章をクリア済みにして、ページを読み直してから第3章を始める(盤面や演出の状態を
 * 持ち越さないように。STORY_AUTO_START_KEY参照)。 */
function senecaGoChapter3() {
  storyMarkChapterCleared(2);
  storyGoChapter(3);
}

/** 次の章へ: ページを読み直して(盤面や演出の状態を持ち越さないように)その章を始める。読み直している間はトップ画面を
 * 見せない(index.htmlのstory-autostartingで覆い、章が始まったら外す、2026-11-12 per user「一瞬トップに戻るので
 * 戻らずに第３章に」)。 */
function storyGoChapter(no) {
  try { sessionStorage.setItem(STORY_AUTO_START_KEY, String(no)); } catch (e) { /* 読めなければ普通にトップへ */ }
  document.documentElement.classList.add('story-autostarting');
  closeStoryMode();
}

/** セネカの立ち絵を同じポーズの差分に替える。出ている立ち絵はその場で差し替える(出し直しのアニメーションはしない)。 */
function senecaSwapPortrait(img) {
  const run = storyRun;
  STORY_SPEAKERS.seneca.img = img;
  if (run.speaker === 'seneca' && !run.dom.portrait.hidden) {
    run.dom.portrait.src = img;
    run.dom.portrait.dataset.src = img;
  }
}

/** セネカのプレイヤーネームを今の名前(セリフの名前欄と同じ)にする。盤面を巻き戻した後にも呼ぶ。 */
function senecaApplyName() {
  storyPlayer('P2').name = STORY_SPEAKERS.seneca.name;
  render(STATE);
}

function senecaHasCard(re) {
  return storyPlayer('P1').ownedCardPhysicalIds.some((id) => STATE.cards[id] && re.test(STATE.cards[id].currentFaceId));
}

function senecaTryNegotiation(row, rest, onDone, snap) {
  const run = storyRun;
  if (!run) return;
  run.seneca.negotiationStarted = true;
  if (run.showAcquirableBadges) { run.showAcquirableBadges = false; render(STATE); }
  // 戻る盤面: チェックマークの説明中にショートカットで先に獲得していたら、獲得する前の盤面(senecaPlayが覚えている)。
  // 獲得した後の盤面に戻ると、また「もう獲得したの」から同じことを繰り返してしまう(2026-11-12, user報告の動画)。
  if (!snap) snap = senecaHasCard(/^B00[146]/) && run.seneca.preAcquireSnap ? run.seneca.preAcquireSnap
    : { state: gameStateMod.cloneState(STATE), visibleMapIds: run.visibleMapIds.slice() };
  run.tapAnyTime = false;
  // afterRe: その区切りより後ろで探す(「上記の続きで基礎学問がタップ状態」が交渉術・土木技術の後ろに1つずつあるため)。
  const section = (re, afterRe) => {
    const from = afterRe ? rest.findIndex((r) => afterRe.test(story2NormalizeEvent(r.event || ''))) : -1;
    const start = rest.findIndex((r, k) => k > from && re.test(story2NormalizeEvent(r.event || '')));
    if (start < 0) return [];
    const end = rest.findIndex((r, k) => k > start && r.event && /ダイスがなくなる|以外にダイスを置く|を獲得する|まで戻る|もう一度行く|タップ状態|ショートカットで獲得|資源がなくて/.test(story2NormalizeEvent(r.event)));
    return rest.slice(start + 1, end < 0 ? rest.length : end);
  };
  const sayLines = (rows, then) => {
    const lines = rows.filter((r) => r.text);
    const step = (k) => {
      if (!storyRun) return;
      if (k >= lines.length) { then(); return; }
      storySetSpeaker('seneca');
      storySayThen(`CS-${lines[k].index}`, () => step(k + 1), 0, lines[k].text);
    };
    step(0);
  };
  const hasCard = senecaHasCard;
  const hasNegotiation = () => hasCard(/^B004/);
  const diceLeft = () => storyPlayer('P1').dice.filter((d) => !d.placedMapId && !d.passed)
    .some((d) => storyPlaceableSlots('P1', d.id, run.visibleMapIds).length > 0);
  // 自由に遊んでいる間に基礎学問を獲得した: 「基礎学問を獲得する（交渉術と土木技術を獲得している）」/
  // 「…（交渉術か土木技術を獲得している）」の部分を1回だけ出す。
  const basicLines = () => {
    if (run.seneca.basicDone || !hasCard(/^B001/)) return null;
    run.seneca.basicDone = true;
    // 「（セネカに資源をもらっていない）」: もらっていたら「交渉術か土木技術」のほう(よくできました…)。
    return hasNegotiation() && hasCard(/^B006/) && !run.seneca.gaveResources ? section(/基礎学問を獲得する.*交渉術と土木技術/) : section(/基礎学問を獲得する.*交渉術か土木技術/);
  };
  // 「「基礎学問」を使って私に会いに来て」のあと: 図書館に(新しく)ダイスを置いたら「図書館にもう一度行く」の
  // 部分を出してすぐ「つづく」(2026-11-11, per user回答)。基礎学問で追い出して置くと数は増えないので、ダイスで見る。
  const libraryDieIds = () => storyPlayer('P1').dice.filter((d) => d.placedMapId === STORY_LIBRARY_MAP_ID).map((d) => d.id);
  // 図書館で会うのを待ち始める。行かないままダイスがなくなった時に戻る盤面も覚えておく。
  const awaitLibrary = () => {
    run.seneca.libraryBefore = libraryDieIds();
    run.seneca.meetSnap = { state: gameStateMod.cloneState(STATE), visibleMapIds: run.visibleMapIds.slice(), libraryBefore: run.seneca.libraryBefore.slice(), canMeet: diceLeft() || canStillMeet() };
  };
  // 起きている交渉術・土木技術のタップで、今獲得できるカードがある(ショップの✓と同じ見つけ方)。
  // その場で計算し直す(ダイスを置いた直後はショップの✓がまだ前の盤面のままのことがある)。
  const canTapToGain = () => storyPlayer('P1').ownedCardPhysicalIds.some((id) => STATE.cards[id] && /^B00[46]/.test(STATE.cards[id].currentFaceId) && !STATE.cards[id].tapped)
    && [...computeShopAcquirableMoveCache().values()].some((found) => found && found.move && found.move.type === 'BARE_TAP');
  // 置けるダイスがなくても、起きている基礎学問と手元のダイスがあれば、目を1にして図書館のダイスを追い出して置ける。
  const canStillMeet = () => storyPlayer('P1').dice.some((d) => !d.placedMapId && !d.passed)
    && storyPlayer('P1').ownedCardPhysicalIds.some((id) => STATE.cards[id] && /^B001/.test(STATE.cards[id].currentFaceId) && !STATE.cards[id].tapped);
  const playUntilDiceUsed = (then) => {
    if (!storyRun) return;
    run.tapAnyTime = true; // ダイスを全部置いたあとも交渉術・土木技術をタップできる(main.jsのstoryTapAnyTime)
    if (run.seneca.libraryBefore && libraryDieIds().some((id) => !run.seneca.libraryBefore.includes(id))) {
      run.seneca.libraryBefore = null;
      senecaPlay(section(/図書館にもう一度行く/), 0, onDone);
      return;
    }
    const lines = basicLines();
    if (lines) {
      senecaPlay(lines, 0, () => {
        if (section(/図書館にもう一度行く/).length > 0) awaitLibrary();
        playUntilDiceUsed(then);
      });
      return;
    }
    // 「「基礎学問」を使って私に会いに来て」のあと、図書館に行かないままダイスがなくなった: 残念…のあと、
    // 「会いに来て」の直後の盤面に戻る(2026-11-12, per user「「基礎学問」を使って私に会いに来て」の直後に戻したい)。
    if (!diceLeft() && run.seneca.libraryBefore && !canStillMeet()) {
      const meet = run.seneca.meetSnap;
      // 「会いに来て」の時点ですでに会えない盤面だった(戻しても同じ): 「さあ、あとは…」まで戻る。
      if (!meet.canMeet) { failAndRewind(); return; }
      sayLines(section(/ダイスがなくなる/), () => {
        storySetGlow([]);
        hideCardEnlargeModal();
        storyUseState(gameStateMod.cloneState(meet.state));
        run.visibleMapIds = meet.visibleMapIds.slice();
        storyApplyVisibleMaps();
        run.seneca.libraryBefore = meet.libraryBefore.slice();
        run.turnBannerKeys = new Set();
        senecaApplyName();
        storyLater(() => playUntilDiceUsed(then), 400);
      });
      return;
    }
    // ダイスを使い切っても、交渉術か土木技術が起きていて(タップで獲得できるカードがある)なら続ける。それもなければ
    // 残念…で「さあ、あとは…」まで戻る(2026-11-12, per user「もうつづくは不要」「ダイスを使い切って交渉術か土木技術が
    // アンタップなら続けれるように」)。
    if (!diceLeft() && !(run.seneca.libraryBefore && canStillMeet()) && !canTapToGain()) {
      // 「交渉術か土木技術がアンタップで資源がなくて獲得できるカードがない」: 1回だけセネカが資源をくれる。
      const untappedTapCard = storyPlayer('P1').ownedCardPhysicalIds.some((id) => STATE.cards[id] && /^B00[46]/.test(STATE.cards[id].currentFaceId) && !STATE.cards[id].tapped);
      const help = section(/資源がなくて/);
      if (untappedTapCard && !run.seneca.gaveResources && help.length > 0) {
        run.seneca.gaveResources = true;
        senecaPlay(help, 0, () => playUntilDiceUsed(then));
        return;
      }
      failAndRewind();
      return;
    }
    storyHideDialog();
    // 自由に遊ぶ間はフリーアクション(カードのタップ)と獲得カードの画面も使える。
    if (!document.body.classList.contains('story-free-action')) { document.body.classList.add('story-free-action'); render(STATE); }
    const cardsBefore = storyPlayer('P1').ownedCardPhysicalIds.length;
    run.placementBaseline = storyPlacementCounts(STATE);
    storySetAllowedTabs([...run.allowedTabs, 'shop', 'cards']);
    storyWaitForPlacement({
      mapIds: run.visibleMapIds.slice(),
      goalText: '',
      // カードの獲得(ショートカットでタップを使った時など、ダイスを置かない獲得も)でも見直す。
      extraDetect: () => (typeof pendingBuildChoice !== 'undefined' && !!pendingBuildChoice) || storyPlayer('P1').ownedCardPhysicalIds.length !== cardsBefore
        || (!!run.seneca.libraryBefore && libraryDieIds().some((id) => !run.seneca.libraryBefore.includes(id))),
      onPlaced: () => storyWhenVisualsIdle(() => playUntilDiceUsed(then)),
    });
  };
  // ダイスがなくなった: 残念…のあと、「さあ、あとは自分で考えて行動してみて」の前の盤面まで戻る。
  const failAndRewind = () => {
    sayLines(section(/ダイスがなくなる/), () => {
      storySetGlow([]);
      hideCardEnlargeModal();
      storyUseState(gameStateMod.cloneState(snap.state));
      run.visibleMapIds = snap.visibleMapIds.slice();
      storyApplyVisibleMaps();
      run.placementBaseline = storyPlacementCounts(STATE);
      run.turnBannerKeys = new Set(); // 巻き戻したら「ターン○」も数え直す
      run.seneca.libraryBefore = null;
      run.seneca.gaveResources = false;
      if (!senecaHasCard(/^B001/)) run.seneca.basicDone = false; // 戻した盤面で基礎学問をまだ持っていなければ、また出す
      senecaApplyName();
      storyLater(() => senecaTryNegotiation(row, rest, onDone, snap), 400);
    });
  };
  const waitPlacement = () => {
    storyHideDialog();
    // ショートカットで先に置いていた分を「今置いた」と数えないように、ここから数える。
    run.placementBaseline = storyPlacementCounts(STATE);
    // 皇帝宮殿はカードを選ぶ画面が先に出る(extraDetect)ので、置いた場所は皇帝宮殿のダイスの数で見分ける。
    const castleBefore = storyP1DiceCount(STATE, [STORY_CASTLE_MAP_ID]);
    storyWaitForPlacement({
      mapIds: run.visibleMapIds.slice(),
      goalText: '',
      extraDetect: () => typeof pendingBuildChoice !== 'undefined' && !!pendingBuildChoice,
      onPlaced: () => storyWhenVisualsIdle(() => {
        if (!storyRun) return;
        judge(storyP1DiceCount(STATE, [STORY_CASTLE_MAP_ID]) > castleBefore);
      }),
    });
  };
  const judge = (onCastle) => {
    story2LockPlacement();
    render(STATE);
    // 交渉術・土木技術を獲得したら、そのあとは残りのダイスを自由に置いて、置ききったら「つづく」
    // (2026-11-11, per user「つづくではなく最後までプレイできるようにして すべてのダイスを置ききったら続くに」)。
    // 「交渉術を獲得する（基礎学問を獲得していない）」「土木技術を獲得する（交渉術を獲得していない）（基礎学問を
    // 獲得していない）」: そのカードでタップマークとフリーアクションの説明。基礎学問も獲得済みなら説明なし。
    const lesson = (re) => senecaPlay(hasCard(/^B001/) ? [] : section(re), 0, () => { hideCardEnlargeModal(); playUntilDiceUsed(onDone); });
    // 「交渉術を獲得する（基礎学問を獲得している）」「土木技術を獲得する（基礎学問を獲得している）」: 先に基礎学問を
    // 持っていた時のレッスン。基礎学問を使ってしまっていたら「上記の続きで基礎学問がタップ状態」の部分(アンタップ)。
    // そのあと図書館で会う。
    const basicFirstLesson = (re) => {
      run.seneca.basicDone = true; // 基礎学問のセリフ(「よくできました」等)はもう出さない
      senecaPlay(section(re), 0, () => {
        hideCardEnlargeModal();
        const basicTapped = storyPlayer('P1').ownedCardPhysicalIds.some((id) => STATE.cards[id] && /^B001/.test(STATE.cards[id].currentFaceId) && STATE.cards[id].tapped);
        senecaPlay(basicTapped ? section(/タップ状態/, re) : [], 0, () => {
          if (section(/図書館にもう一度行く/).length > 0) awaitLibrary();
          playUntilDiceUsed(onDone);
        });
      });
    };
    if (hasNegotiation() && hasCard(/^B001/)) { basicFirstLesson(/^交渉術を獲得する.*基礎学問を獲得している/); return; }
    if (hasCard(/^B006/) && hasCard(/^B001/)) { basicFirstLesson(/^土木技術を獲得する.*基礎学問を獲得している/); return; }
    if (hasNegotiation()) { lesson(/^交渉術を獲得する.*基礎学問を獲得していない/); return; }
    if (hasCard(/^B006/)) { lesson(/^土木技術を獲得する.*基礎学問を獲得していない/); return; }
    // 「基礎学問を獲得する（交渉術も土木技術も獲得していない）」: そのセリフのあと、続けて交渉術を目指す。
    if (hasCard(/^B001/) && !run.seneca.basicDone) {
      run.seneca.basicDone = true;
      senecaPlay(section(/基礎学問を獲得する.*交渉術も土木技術も/), 0, () => (diceLeft() ? waitPlacement() : judge(onCastle)));
      return;
    }
    if (!diceLeft()) { failAndRewind(); return; }
    // 「道草を楽しむのも勉強ね」は1回出たらもう出さない(「残念」で戻った後も、2026-11-12 per user)。
    if (!onCastle && !run.seneca.detourSaid) { run.seneca.detourSaid = true; sayLines(section(/以外にダイスを置く/), waitPlacement); }
    else waitPlacement();
  };
  storySetSpeaker('seneca');
  // 先にショートカットで獲得していた: 「さあ、あとは…」は出さずに「チェックマークの説明中にショートカットで獲得」の
  // 部分(「もう獲得したの」…)のあと、その分かれ道へ。
  if (hasNegotiation() || hasCard(/^B006/) || hasCard(/^B001/)) {
    storyWhenVisualsIdle(() => senecaPlay(section(/ショートカットで獲得/), 0, () => judge(true)));
    return;
  }
  if (row.text) storySayThen(`CS-${row.index}`, waitPlacement, 0, row.text);
  else waitPlacement();
}

/** 導入のあと: 農園か図書館にダイスを置く。農園なら「農園」の部分のあと図書館を待つ。図書館なら「つづく」。 */
function senecaFreePlay() {
  const run = storyRun;
  if (!run) return;
  const ch = run.seneca;
  storyHideDialog();
  const mapIds = run.visibleMapIds.filter((m) => m === STORY_LIBRARY_MAP_ID || (m === STORY_FARM_MAP_ID && !ch.farmDone));
  const resourcesBefore = { ...storyPlayer('P1').resources };
  storyWaitForPlacement({
    mapIds,
    goalText: '',
    onPlaced: (mapId) => storyWhenVisualsIdle(() => {
      if (mapId === STORY_LIBRARY_MAP_ID) {
        if (ch.blocks.library && ch.blocks.library.some((r) => /食料/.test(r.event || '') && /知識/.test(r.event || ''))) {
          run.resourceOverride = resourcesBefore;
          render(STATE);
        }
        // 資源の表示は「食料が知識に＋金貨2」の行まで置く前の数のまま(その行で本当の数にする)。手番はまだ終えない
        // (「ターンが終了し使用料が支払われる」の行で終える)。
        story2LockPlacement();
        // 2回目の図書館(レッスン終わり)のあとは「つづく」ではなく第3章へ(2026-11-12, per user)。
        senecaPlay(ch.blocks.library || [], 0, senecaGoChapter3);
        return;
      }
      ch.farmDone = true;
      storyEndTurnOf('P1');
      render(STATE);
      story2LockPlacement();
      render(STATE);
      senecaPlay(ch.blocks.farm || [], 0, senecaFreePlay);
    }),
  });
}

/* ---------- 章を選ぶ画面 ---------- */

// 2026-10-31, per user: "第２章のストーリーに行った後 また ストーリー に入ったら 第１章 怠惰なローマ市民アレク
// 第２章 ○○の百人隊長スパル という風に選べるように" + 回答: 第1章をクリアする前は今まで通りそのまま第1章、
// 第2章は「今作成中」、題名の○○は仮でそのまま。クリアの記録はこの端末だけ(localStorage)。
const STORY_CLEARED_KEY = 'diceWpStoryChaptersCleared';
/* ---------- 第4章: ４人対戦 (data/story_ch4.data.js) ---------- */

/** 2026-11-13, per user: ストーリー.xlsxのシート「４人対戦」(tools/story2_xlsx_to_js.py)。第3章と同じく1行ずつ、
 * A列=アレクのセリフ、C列=画面で起きること。
 *  - 性格を4つ(強欲・几帳面・見栄っ張り(虚栄)・嫉妬深い(嫉妬)、どれも表)から1つ選ぶ。「○○を選ぶ」の部分のセリフと、
 *    その性格の初期資源(性格カードのONCE)。あなたのジョブはローマ市民だけ(per user回答)。
 *  - 性格のペナルティは「なしでいいや」(per user回答「はい」=本当に効かなくする): あなたの性格カードは持ち札に入れない
 *    (ペナルティはどれも持ち札の性格カードから数えるため)。名前の呼び名(怠惰な…)は持ち札と別に出る。
 *  - 初期資源カードは4枚から2枚(per user回答)。
 *  - そのあと本物の4人対戦(4ラウンド): 敵はAI LV1。几帳面以外を選んだら パトラ(心配性な巫女)・スパル(傲慢な百人隊長)・
 *    セネカ(几帳面な研究者)、几帳面を選んだら セネカの代わりにネロ(色欲の権力者)(per user)。敵は立ち絵で登場する。
 *  - あなたの席は各ラウンドの1ターン目だけあなたが操作し、2ターン目からはアレク(一番強いAI、AI_LV3)が打つ(per user)。
 *  台本の続き(対戦中のセリフ)は後で足す(per user「セリフは後で考えるので最後まで進めれるように」)。 */
const CH4_CON_CHOICES = [
  { label: '強欲', faceId: 'CON001A' },
  { label: '几帳面', faceId: 'CON002A' },
  { label: '見栄っ張り', faceId: 'CON003A' },
  { label: '嫉妬深い', faceId: 'CON004A' },
];
const CH4_ENEMIES = {
  normal: [
    { id: 'P2', name: 'パトラ', con: 'CON006A', job: 'JOB002', img: 'assets/story-patra.webp' },
    { id: 'P3', name: 'スパル', con: 'CON002B', job: 'JOB004', img: 'assets/story-spal.webp' },
    { id: 'P4', name: 'セネカ', con: 'CON002A', job: 'JOB007', img: 'assets/story-seneca.webp' },
  ],
  // あなたが几帳面を選んだ時: セネカの代わりに色欲の権力者ネロ。
  kichomen: [
    { id: 'P2', name: 'パトラ', con: 'CON006A', job: 'JOB002', img: 'assets/story-patra.webp' },
    { id: 'P3', name: 'スパル', con: 'CON002B', job: 'JOB004', img: 'assets/story-spal.webp' },
    { id: 'P4', name: 'ネロ', con: 'CON001B', job: 'JOB005', img: 'assets/story-nero.webp' },
  ],
};
const CH4_ALEK_ROLE = 'AI_LV3'; // 2ターン目からあなたの席を打つアレク(一番強いAI)
const CH4_ENEMY_ROLE = 'AI_LV1';

/** 台本を { intro, branches: {強欲: [...], ...}, common } に分ける。各「○○を選ぶ」の部分は次の「○○を選ぶ」まで。
 * 最後の部分は、最初の部分の最後のセリフ(「性格によって…違うんだよ」)と同じ行まで。 */
function ch4Blocks() {
  const rows = (window.STORY_CH4_SCRIPT || []).map((row, index) => ({ ...row, index }));
  const choiceAt = rows.findIndex((r) => /から.*選ぶ/.test(r.event || ''));
  const blocks = { intro: rows.slice(0, Math.max(0, choiceAt)), branches: {}, common: [] };
  const marks = [];
  rows.forEach((r, k) => {
    const m = /^(.+?)を選ぶ$/.exec((r.event || '').trim());
    // 「スパルが百人隊長を選ぶ」(敵がジョブを選ぶ)は性格の分かれ道ではない。
    if (m && k > choiceAt && !/が/.test(m[1])) marks.push({ k, label: m[1] });
  });
  marks.forEach((mark, n) => {
    let end = n + 1 < marks.length ? marks[n + 1].k : rows.length;
    if (n + 1 === marks.length && marks.length > 1) {
      const first = blocks.branches[marks[0].label];
      const lastText = first.length ? first[first.length - 1].text : '';
      const sameAt = rows.findIndex((r, k) => k > mark.k && lastText && r.text === lastText);
      if (sameAt >= 0) end = sameAt + 1;
    }
    blocks.branches[mark.label] = rows.slice(mark.k + 1, end);
    if (n + 1 === marks.length) blocks.common = rows.slice(end);
  });
  return blocks;
}

function ch4BuildState() {
  const state = gameStateMod.createEmptyGameState(`story-ch4-${Date.now()}`);
  setupMod.createPlayers(state, [(loadRememberedRankingName() || '').trim() || 'あなた', 'パトラ', 'スパル', 'セネカ']);
  setupMod.prepareMaps(state, INDEX);
  setupMod.prepareShops(state, INDEX);
  setupMod.rollInitialColorDice(state);
  state.jobPool = [];
  qstMod.setupQuests(state);
  for (const player of state.players) player.skipOnboarding = true; // 性格・ジョブ・初期資源は第4章が配る
  return state;
}

function ch4Start() {
  const run = storyRun;
  run.visibleMapIds = [];
  run.ch4 = { blocks: ch4Blocks(), conFaceId: null };
  storyUseState(ch4BuildState());
  story2LockPlacement();
  storyApplyVisibleMaps();
  applyMobileActiveTab('board');
  render(STATE);
  storySetSpeaker('alek');
  ch4Play(run.ch4.blocks.intro, 0, ch4ChooseCon);
}

/** rowsをi行目から: C列の出来事、A列のアレクのセリフ。 */
function ch4Play(rows, i, onDone) {
  const run = storyRun;
  if (!run) return;
  if (i >= rows.length) { onDone(); return; }
  const row = rows[i];
  const next = () => ch4Play(rows, i + 1, onDone);
  const say = () => {
    if (!row.text) { next(); return; }
    storySetSpeaker(run.ch4.speaker || 'alek');
    // 「カードをクリックしてみてよ」: 出してある性格カードを押して拡大するまで待つ。
    if (/クリック/.test(row.text) && run.ch4.callout) {
      storySay(`C4-${row.index}`, () => {
        storyWaitUntil(() => !!run.ch4.calloutOpened, next);
      }, row.text);
      return;
    }
    let text = row.text;
    // 「君のスタプレ合計は〇だね」: 〇はあなたのスタプレ合計。
    if (/スタプレ合計は〇/.test(text)) {
      const p1 = storyPlayer('P1');
      text = text.replace('〇', String(resourceChoiceStartOrderTotal(STATE, 'P1', ch4ResourceIds(p1))));
    }
    // C列「〇とZはアイコン」: その行の〇を食料(K)のアイコンで出す(Zはいつもアイコン)。
    if (/アイコン/.test(row.event || '')) text = text.replace(/〇/g, 'K');
    // 「「ローマ市民」」: ジョブ選択画面で、アレクがあなたのジョブ(ローマ市民)を選ぶ。
    if (run.ch4.jobPanel && /「ローマ市民」/.test(text)) ch4PickJob('P1', 'JOB001');
    storySayThen(`C4-${row.index}`, () => {
      if (storyRun && storyRun.ch4.glowLine) { storyRun.ch4.glowLine = false; storySetGlow([]); }
      next();
    }, 0, text);
  };
  if (!row.event) { say(); return; }
  const e = story2NormalizeEvent(row.event);
  const seconds = Number((/(\d+)秒/.exec(e) || [])[1]) || 1;
  if (CH4_RANK_EVENT.test(e)) {
    ch4IntroductionRound(rows, i);
  } else if (/アイコン/.test(e)) {
    say();
  } else if (/が.+を選ぶ/.test(e)) {
    ch4EnemyChoosesJob(e, say);
  } else if (/ジョブ選択画面/.test(e)) {
    ch4ShowJobDraft(say);
  } else if (/皇帝宮殿の手番順/.test(e) && /光る/.test(e)) {
    // 「皇帝宮殿の手番順が光る」: 皇帝宮殿の「次ラウンド」の手番順(チュートリアルと同じ所)。
    storySetGlow(['.map-tile--castle .map-tile__turnorder--current']);
    run.ch4.glowLine = true;
    const t = document.querySelector('.map-tile--castle .map-tile__turnorder--current');
    if (t) t.scrollIntoView({ block: 'center' });
    say();
  } else if (/手番順の.*光る/.test(e)) {
    // 「手番順のピンクが光る（プレイヤーがピンクなら）」: その手番順の中の、あなたの色の丸。
    storySetGlow([`.map-tile--castle .map-tile__turnorder--current .player-panel__swatch[data-color="${colorForPlayer(STATE, 'P1')}"]`]);
    run.ch4.glowLine = true;
    say();
  } else if (/光る/.test(e) && /スタプレ/.test(e) && run.ch4.orderOverlay) {
    // 4人の画面の「スタプレ値が光る」: あなたの行のスタプレの数字と合計。
    storySetGlow(['.story-ch4-order__me .shop-card > .shop-card__start-order .shop-card__start-order-number', '.story-ch4-order__me .tutorial-turnorder-total__number']);
    run.ch4.glowLine = true;
    say();
  } else if (/秒間がある/.test(e)) {
    storyHideDialog();
    // ジョブを選んだあとの「１秒間がある」: ジョブの画面もここで閉じる(「１ターン目は君がプレイしてね」は盤面の上で)。
    if (run.ch4.jobPanel && run.ch4.segmentRunning === 'P1' && storyPlayer('P1').jobCardId) { run.ch4.jobPanel.remove(); run.ch4.jobPanel = null; }
    storyLater(say, seconds * 1000);
  } else if (/初期資源が手に入る/.test(e)) {
    ch4GrantConResources();
    storyLater(say, 800);
  } else if (/光る/.test(e) && /資源/.test(e)) {
    // 「もらえる資源が光る」: 並べた性格・初期資源カードの資源アイコンの所。
    storySetGlow(['.story-ch4-mine .shop-card > .shop-card__effect .action-icons']);
    run.ch4.glowLine = true;
    say();
  } else if (/光る/.test(e) && /スタプレ/.test(e)) {
    // 「スタプレ値が光る」: チュートリアルと同じく、各カードのスタプレの数字と合計。
    storySetGlow(['.story-ch4-mine .shop-card > .shop-card__start-order .shop-card__start-order-number', '.story-ch4-mine .story-ch4-total__number']);
    run.ch4.glowLine = true;
    say();
  } else if (/並ぶ/.test(e) && /[４4]人/.test(e)) {
    ch4ShowTurnOrder();
    storyLater(say, 500);
  } else if (/並ぶ/.test(e)) {
    ch4ShowMyCards();
    storyLater(say, 500);
  } else if (/表になる/.test(e)) {
    storyHideDialog();
    // セリフ欄を消してから少し間を開けて(1秒)めくる(セリフ欄が4人の画面に重なったままめくらないように)。
    storyLater(() => ch4RevealOthers(say), 1000);
  } else if (/光る/.test(e)) {
    // 「該当部分光る」(この部分が性格のペナルティ): 拡大した性格カードのペナルティの所。
    storySetGlow(['.story-ch4-callout .card-note']);
    run.ch4.glowLine = true;
    say();
  } else if (/初期資源カード/.test(e) && /配られる/.test(e)) {
    // 「初期資源カードが４枚配られる（ランダム）」: 4枚を並べて見せる(選ぶのは「…２枚選ぶ」の行で)。
    ch4HideCallout();
    ch4DealResourceCards();
    storyLater(say, 600);
  } else if (/初期資源カード/.test(e) && /選ぶ/.test(e)) {
    ch4ChooseResourceCards(say);
  } else {
    console.warn(`第4章: C列「${e}」はまだ対応していません`);
    say();
  }
}

/** 「強欲、几帳面、見栄っ張り、嫉妬深いから１つ選ぶ」: 性格カード(表)を4枚並べて1枚選ぶ。 */
function ch4ChooseCon() {
  const run = storyRun;
  storyHideDialog();
  const root = el('div', 'story2-cards story2-cards--ch4');
  const row = el('div', 'story2-cards__row');
  let selected = null;
  const confirm = el('button', 'story-end__button story2-cards__confirm', 'この性格にする');
  confirm.type = 'button';
  confirm.hidden = true;
  const cells = [];
  for (const choice of CH4_CON_CHOICES) {
    const cell = el('div', 'story2-cards__card story2-cards__card--selectable');
    cell.appendChild(buildCardVisual(choice.faceId, { showEffect: true, allowTextFallback: false, noInteraction: true }));
    cell.addEventListener('click', () => {
      selected = choice;
      cells.forEach((c) => c.classList.toggle('story2-cards__card--selected', c === cell));
      confirm.hidden = false;
    });
    cells.push(cell);
    row.appendChild(cell);
  }
  root.append(row, confirm);
  confirm.addEventListener('click', () => {
    root.remove();
    run.dom.resourceCards = null;
    run.ch4.conFaceId = selected.faceId;
    run.ch4.conLabel = selected.label;
    const branch = run.ch4.blocks.branches[selected.label] || [];
    ch4Play(branch, 0, () => ch4Play(run.ch4.blocks.common, 0, ch4StartGame));
  });
  run.dom.root.appendChild(root);
  run.dom.resourceCards = root;
  root.animate([{ opacity: 0, transform: 'translate(-50%, -12px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 300, easing: 'ease-out' });
}

/** 「○○の初期資源が手に入る」: 選んだ性格の初期資源(性格カードのONCE)をもらう。性格カードは持ち札に入れない
 * (ペナルティなし、第4章の先頭のdoc参照)。カードはセリフの上に出しておく(「カードをクリックしてみてよ」で押す)。 */
function ch4GrantConResources() {
  const run = storyRun;
  const faceId = run.ch4.conFaceId;
  const player = storyPlayer('P1');
  player.conPhysicalId = faceId.slice(0, -1);
  player.conFace = faceId.slice(-1);
  const row = dataLoaderMod.getCardRow(INDEX, faceId);
  if (row.ONCE) executorMod.runProgram(STATE, INDEX, { playerId: 'P1', sourcePhysicalId: player.conPhysicalId }, row.ONCE);
  render(STATE);
  for (const r of ['A', 'B', 'C', 'Z', 'K']) { const badge = storyResourceBadge(r); if (badge) badge.classList.add('change-highlight'); }
  ch4ShowCallout(faceId);
}

function ch4ShowCallout(faceId) {
  const run = storyRun;
  ch4HideCallout();
  const card = buildCardVisual(faceId, { showEffect: true, noInteraction: true });
  const box = el('div', 'story2-callout story-ch4-callout');
  box.style.pointerEvents = 'auto';
  box.style.cursor = 'pointer';
  box.appendChild(card);
  // 押すと、セリフ欄の上でそのまま大きくなる(拡大画面だとセリフ欄にペナルティの所が隠れるため)。
  box.addEventListener('click', () => {
    box.classList.add('story-ch4-callout--big');
    run.ch4.calloutOpened = true;
  });
  run.dom.root.appendChild(box);
  run.ch4.callout = box;
  box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
}
function ch4HideCallout() {
  const run = storyRun;
  if (run && run.ch4 && run.ch4.callout) { run.ch4.callout.remove(); run.ch4.callout = null; }
}

/** 「初期資源カードが４枚配られる（ランダム）」: 普段のゲームと同じく4枚配って並べる(まだ選べない)。 */
function ch4DealResourceCards() {
  setupMod.dealResourceCandidates(STATE, INDEX);
  const choice = STATE.pendingChoices.find((c) => c.playerId === 'P1' && c.kind === 'SELECT_RESOURCE_CARDS');
  storyRun.ch4.resourceCandidates = choice.context.candidates;
  story2ShowResourceCards(false, null, choice.context.candidates, 'story2-cards--ch4');
}

/** 「初期資源カードを２枚選ぶ」: 配った4枚から2枚選ぶ(普段のゲームと同じ受け取り方)。 */
function ch4ChooseResourceCards(onDone) {
  if (!storyRun.ch4.resourceCandidates) ch4DealResourceCards();
  storyHideDialog();
  story2ShowResourceCards(true, (picked) => {
    setupMod.chooseResourceCards(STATE, 'P1', picked);
    setupMod.receiveInitialResources(STATE, INDEX, 'P1');
    render(STATE);
    onDone();
  }, storyRun.ch4.resourceCandidates, 'story2-cards--ch4');
}

function ch4Enemies() {
  return storyRun.ch4.conFaceId === 'CON002A' ? CH4_ENEMIES.kichomen : CH4_ENEMIES.normal;
}

/** P1の初期資源カード2枚(持ち札のR…)。 */
function ch4ResourceIds(player) {
  return player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
}

/** カード1枚(チュートリアルの確認画面と同じ見た目)。hiddenなら裏向き(中身を見えなくする)。 */
function ch4CardCell(faceId, hidden) {
  const cardNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
  if (hidden) cardNode.classList.add('tutorial-card-hidden');
  const cell = el('div', cardNode.classList.contains('shop-card--tall') ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
  cell.appendChild(cardNode);
  return cell;
}

/** 「選んだ性格と初期資源カードが並ぶ」: チュートリアルの「あなたが選んだカードはこちら」と同じく、選んだ性格と
 * 初期資源カード2枚、スタプレ合計を並べる。 */
function ch4ShowMyCards() {
  const run = storyRun;
  story2HideResourceCards();
  const p1 = storyPlayer('P1');
  const resourceIds = ch4ResourceIds(p1);
  const root = el('div', 'story2-cards story2-cards--ch4 story-ch4-mine');
  const row = el('div', 'story2-cards__row');
  for (const faceId of [run.ch4.conFaceId, ...resourceIds]) {
    const cell = el('div', 'story2-cards__card');
    cell.appendChild(ch4CardCell(faceId, false));
    row.appendChild(cell);
  }
  const total = el('div', 'story-ch4-total', 'スタプレ合計 ');
  total.appendChild(el('span', 'story-ch4-total__number', String(resourceChoiceStartOrderTotal(STATE, 'P1', resourceIds))));
  root.append(row, total);
  run.dom.root.appendChild(root);
  run.dom.resourceCards = root;
  root.animate([{ opacity: 0, transform: 'translate(-50%, -12px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 300, easing: 'ease-out' });
}

/** 敵3人の名前・性格・初期資源カード(配られた4枚からランダムに2枚)を決めて、手番の順番も決める(1回だけ)。
 * 「４人の…並ぶ」の行で見せるため、ジョブより先にここで決める。 */
function ch4SetupEnemies() {
  const run = storyRun;
  if (run.ch4.enemiesReady) return;
  run.ch4.enemiesReady = true;
  const p1 = storyPlayer('P1');
  const usedCon = new Set([p1.conPhysicalId]);
  for (const enemy of ch4Enemies()) {
    const player = storyPlayer(enemy.id);
    player.name = enemy.name;
    // 性格カードは1枚の表裏なので、几帳面(CON002A)と傲慢(CON002B)を2人が持つ時は、ストーリーの中だけ同じカードを
    // もう1枚作る(持ち札の番号を変える。呼び名は conPhysicalId+conFace で出る)。
    const physical = enemy.con.slice(0, -1);
    const inst = gameStateMod.createCardInstance(enemy.con);
    if (usedCon.has(physical)) inst.physicalId = `${physical}_${enemy.id}`;
    usedCon.add(physical);
    inst.ownerId = enemy.id;
    STATE.cards[inst.physicalId] = inst;
    player.ownedCardPhysicalIds.push(inst.physicalId);
    player.conPhysicalId = physical;
    player.conFace = enemy.con.slice(-1);
    const row = dataLoaderMod.getCardRow(INDEX, enemy.con);
    if (row.ONCE) executorMod.runProgram(STATE, INDEX, { playerId: enemy.id, sourcePhysicalId: inst.physicalId }, row.ONCE);
    // 初期資源カード: 配られた4枚からランダムに2枚。
    const choice = STATE.pendingChoices.find((c) => c.playerId === enemy.id && c.kind === 'SELECT_RESOURCE_CARDS');
    if (choice) {
      const pick = choice.context.candidates.slice().sort(() => Math.random() - 0.5).slice(0, 2);
      setupMod.chooseResourceCards(STATE, enemy.id, pick);
      setupMod.receiveInitialResources(STATE, INDEX, enemy.id);
    }
    playerRoles.set(enemy.id, CH4_ENEMY_ROLE);
  }
  STATE.pendingChoices = STATE.pendingChoices.filter((c) => c.kind !== 'SELECT_RESOURCE_CARDS');
  setupMod.computeStartOrder(STATE, INDEX);
}

/** 「４人の選んだ性格（表示）と初期資源カード（裏）が並ぶ」: チュートリアルの手番順の画面と同じく、4人を1行ずつ
 * (順番・名前・スタプレ合計、性格カード、初期資源カード2枚)。他の3人の初期資源カードとスタプレ合計は伏せておき、
 * 「初期資源カードがすべて表になる」で見せる(ch4RevealOthers)。スマホは4行が画面に収まるようにカードを縮める。 */
function ch4ShowTurnOrder() {
  const run = storyRun;
  story2HideResourceCards();
  ch4SetupEnemies();
  const overlay = el('div', 'card-inst-overlay story-ch4-order');
  const modal = el('div', 'card-inst-modal build-choice-modal tutorial-turnorder-modal story-ch4-order__modal');
  const list = el('div', 'tutorial-turnorder-list story-ch4-order__list');
  STATE.players.forEach((player) => {
    const isSelf = player.id === 'P1';
    const resourceIds = ch4ResourceIds(player);
    const row = el('div', isSelf ? 'tutorial-turnorder-row story-ch4-order__me' : 'tutorial-turnorder-row');
    const header = el('div', 'tutorial-turnorder-row__header');
    header.appendChild(el('span', 'tutorial-turnorder-rank', `${STATE.turnOrder.indexOf(player.id) + 1}番手`));
    const swatch = el('span', 'player-panel__swatch player-panel__swatch--tiny');
    swatch.dataset.color = player.color;
    header.appendChild(swatch);
    header.appendChild(el('span', 'tutorial-turnorder-name', player.name));
    const totalEl = el('span', 'tutorial-turnorder-total', 'スタプレ合計 ');
    const number = el('span', 'tutorial-turnorder-total__number', isSelf ? String(resourceChoiceStartOrderTotal(STATE, player.id, resourceIds)) : '？');
    if (!isSelf) number.dataset.total = String(resourceChoiceStartOrderTotal(STATE, player.id, resourceIds));
    totalEl.appendChild(number);
    header.appendChild(totalEl);
    row.appendChild(header);
    const cards = el('div', 'build-choice-group');
    cards.appendChild(ch4CardCell(`${player.conPhysicalId}${player.conFace}`, false));
    for (const faceId of resourceIds) cards.appendChild(ch4CardCell(faceId, !isSelf));
    row.appendChild(cards);
    list.appendChild(row);
  });
  const body = el('div', 'card-inst-modal__body');
  body.appendChild(list);
  modal.appendChild(body);
  overlay.appendChild(modal);
  run.dom.root.appendChild(overlay);
  run.ch4.orderOverlay = overlay;
  ch4FitTurnOrder();
  overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
}

/** スマホ: 4行が縦にスクロールなしで収まる大きさまでカードを縮める(収まるならそのまま=なるべく大きく)。 */
function ch4FitTurnOrder() {
  const overlay = storyRun && storyRun.ch4.orderOverlay;
  if (!overlay) return;
  const list = overlay.querySelector('.story-ch4-order__list');
  overlay.querySelectorAll('.build-choice-group').forEach((g) => { g.style.zoom = ''; });
  if (!window.matchMedia('(max-width: 760px), (max-height: 500px)').matches) return;
  const rows = [...list.querySelectorAll('.tutorial-turnorder-row')];
  const groups = rows.map((r) => r.querySelector('.build-choice-group'));
  const natural = Math.max(...groups.map((g) => g.offsetHeight));
  const rowHeight = list.clientHeight / rows.length - 6; // 行の上下の余白・枠の分
  const scale = Math.max(0.3, Math.min(1, rowHeight / natural));
  groups.forEach((g) => { g.style.zoom = String(scale); });
}

/** 「初期資源カードがすべて表になる」: 他の3人の初期資源カードとスタプレ合計を見せる。めくり終わったら次へ。
 * そのあと4人の画面を閉じて、手番順の自己紹介に進む(ch4IntroductionRound)。 */
function ch4RevealOthers(onDone) {
  const overlay = storyRun.ch4.orderOverlay;
  overlay.querySelectorAll('.tutorial-card-hidden').forEach((n) => {
    n.classList.remove('tutorial-card-hidden');
    n.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0)' }], { duration: 350, easing: 'ease-out' });
  });
  overlay.querySelectorAll('[data-total]').forEach((n) => { n.textContent = n.dataset.total; });
  storyLater(onDone, 900);
}

function ch4CloseTurnOrder() {
  const run = storyRun;
  const overlay = run && run.ch4.orderOverlay;
  if (!overlay) return;
  run.ch4.orderOverlay = null;
  overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: 'ease-in', fill: 'forwards' }).onfinish = () => overlay.remove();
}

/** 敵の立ち絵・呼び名(ジョブを選ぶ前なので「性格＋名前」)。 */
function ch4EnemyTitle(enemy) {
  const conName = rankingCardDisplayName(enemy.con);
  return `${CON_ADJECTIVE_BY_NAME[conName] || conName}${enemy.name}`;
}
/** 敵の立ち絵の登場(まだ登場していない人だけ、1人ずつ)。終わったらonDone。 */
function ch4IntroEnemies(enemies, titleOf, onDone) {
  const run = storyRun;
  run.ch4.introduced = run.ch4.introduced || new Set();
  const list = enemies.filter((enemy) => !run.ch4.introduced.has(enemy.id));
  if (!list.length) { onDone(); return; }
  storyHideDialog();
  for (const enemy of list) {
    run.ch4.introduced.add(enemy.id);
    storyCharacterQueue.push({ title: titleOf(enemy), character: { name: enemy.name, img: enemy.img } });
  }
  playStoryCharacterIntro();
  storyWaitUntil(() => !storyCharacterPlaying && storyCharacterQueue.length === 0, onDone);
}
const CH4_SPEAKER_BY_NAME = { スパル: 'spal', セネカ: 'seneca', パトラ: 'patra', ネロ: 'nero' };

const CH4_RANK_EVENT = /(スパル|セネカ|パトラ|ネロ|プレイヤー)が([１-４1-4])番/;
/** 「以下セリフ→行動の順番です」より下: [{ name: 'スパル', event: '訓練場に行く', rows: [...] }, ...]。 */
function ch4ActionSegments(rows) {
  const list = [];
  let current = null;
  for (const row of rows) {
    const e = story2NormalizeEvent(row.event || '').trim();
    const m = /^(スパル|セネカ|パトラ|ネロ)が(.+)$/.exec(e);
    if (m) { current = { name: m[1], event: m[2], rows: [] }; list.push(current); continue; }
    if (e) { current = null; continue; } // 行動ではない出来事(「1R2Tの最初」など)
    if (current && row.text) current.rows.push(row);
  }
  return list;
}

/** AIの1手が、台本のどの行動に当たるか(上から順に最初に当たったもの)。
 * 「訓練場に行く」/「領地(学問・人材)カードを獲得する」/「訓練場、皇帝宮殿、元老院以外のエリアに行く」/「研究を使う」。 */
function ch4FindActionLine(enemy, move, state, allActions) {
  const actions = (allActions || []).filter((a) => a.name === enemy.name);
  if (!actions.length || !move) return null;
  let areaName = '';
  let key = null;
  let upgrade = false; // LVアップ(2R以降の「獲得かLVUPする」「LVUPする」)
  let usedName = '';
  if (move.mapId !== undefined && /^PLACE_/.test(move.type)) {
    areaName = String(dataLoaderMod.getAreaRow(INDEX, state.maps[move.mapId].currentAreaId).NAME || '').replace(/LV\d+$/, ''); // 発展したエリアの「LV1」は付けない
    if (move.buildCandidateKey) { upgrade = /^U:/.test(move.buildCandidateKey); key = move.buildCandidateKey.replace(/^U:/, ''); }
  } else if (move.type === 'BARE_TAP' || move.type === 'TAP_REACTION') {
    const card = state.cards[move.physicalId];
    usedName = card ? String(dataLoaderMod.getCardRow(INDEX, card.currentFaceId).NAME || '').replace(/LV\d+$/, '') : '';
    // タップでカードを獲得する時(研究など)は、獲得するカードも分かるようにする。
    if (move.buildCandidateIndex !== undefined) {
      try {
        const clone = gameStateMod.cloneState(state);
        const r = boardMod.useBareTapAbility(clone, INDEX, { playerId: enemy.id }, move.physicalId);
        const c = r && r.pendingBuild && r.pendingBuild.candidates[move.buildCandidateIndex];
        if (c) { upgrade = c.type === 'UPGRADE'; key = upgrade ? c.toFaceId : c.faceId; }
      } catch (err) { /* 分からなければ獲得のセリフは無し */ }
    }
  } else {
    return null;
  }
  const cardName = key ? String(dataLoaderMod.getCardRow(INDEX, key).NAME || '') : '';
  const kind = key ? { A: '領地', B: '学問', C: '人材' }[key[0]] : null;
  const hit = actions.find((a) => {
    const others = /^(.+)以外のエリアに行く/.exec(a.event);
    if (others) return !!areaName && !key && !others[1].split(/[、,，]/).map((x) => x.trim()).includes(areaName);
    const go = /^(.+)に行く/.exec(a.event);
    if (go) return !!areaName && areaName === go[1].trim();
    const get = /(領地|学問|人材)カードを(獲得か[LV]{2}UP|獲得|[LV]{2}UP)/.exec(a.event);
    if (get) {
      if (kind !== get[1]) return false;
      if (/UP/.test(get[2]) && /獲得/.test(get[2])) return true; // 獲得かLVUP(「VLUP」の書き間違いも)
      return /UP/.test(get[2]) ? upgrade : !upgrade;
    }
    const use = /^(.+)を使う/.exec(a.event);
    return !!use && !!usedName && usedName === use[1].trim();
  });
  if (!hit || !hit.rows.length) return null;
  const fill = (text) => text
    .replace(/獲得したエリア名/g, cardName.replace(/の支配.*$/, ''))
    .replace(/獲得したカード名/g, cardName.replace(/LV\d+$/, ''))
    .replace(/行ったエリア名/g, areaName)
    .replace(/使ったカード名/g, usedName);
  return hit.rows.map((r) => ({ ...r, text: fill(r.text) }));
}

/** main.jsのpumpAiDelayedが、AIの1手を打つ直前に呼ぶ: 第4章で自己紹介を終えた敵のその手番(ch4.actionTurn)なら、
 * これから打つ手(selectAiMoveMemo: このあと実際に打つ手と同じ)のセリフを先に言う。言っている間はAIを止め
 * (trueを返す)、言い終わったらAIを再開して、その手を打つ。1手ごとに1回だけ。 */
function storyBeforeAiStep(state) {
  const run = storyRun;
  if (!run || !run.ch4 || !run.normalGame || run.holdAi) return false;
  const ch = run.ch4;
  const segs = ch.segs || {};
  const ctx = resolveAiTurnContext(state);
  if (!ctx || ctx.type !== 'TURN') return false;
  let move = null;
  try { move = selectAiMoveMemo(state, ctx.playerId, { hasPlacedDieThisTurn: ctx.hasPlacedDieThisTurn }); } catch (err) { return false; }
  const key = `${JSON.stringify(move)}|${JSON.stringify(state).length}|${state.progressLog ? state.progressLog.length : 0}`;
  if (ch.announcedKey === key) return false;
  // 「1Rの最後　ダイス回収直前」: 1ラウンド目を終わらせるターン終了(このあとダイスを回収)の前に、アレクのセリフ。
  if (move && move.type === 'END_TURN' && state.round === 1 && turnFlowMod.isRoundOver(state) && !ch.round1EndSaid && (segs.roundEnd1 || []).length) {
    ch.round1EndSaid = true;
    ch.announcedKey = key;
    if (isMobileLayout()) applyMobileActiveTab('board');
    ch4Talk('alek', segs.roundEnd1);
    return true;
  }
  const enemy = ch4Enemies().find((x) => x.id === ctx.playerId);
  if (!enemy) return false;
  const used = storyPlayer(ctx.playerId).dice.filter((d) => d.placedMapId || d.passed).length;
  const firstTurn = used === 0 || (used === 1 && ctx.hasPlacedDieThisTurn);
  let actions = null;
  if (state.round === 1 && ch.actionTurn) {
    // 1R1T: 自己紹介のすぐあとの手番だけ(2026-11-13, per user「1R1Tのみを想定」)。
    if (ctx.playerId !== ch.actionTurn || !firstTurn) { ch.actionTurn = null; return false; }
    actions = segs.actions;
  } else if (state.round === 2 && firstTurn) {
    actions = segs.actions2; // 2R1T(各自の最初の手番)だけ
  }
  if (!actions || !actions.length) return false;
  ch.announcedKey = key;
  const rows = ch4FindActionLine(enemy, move, state, actions);
  if (!rows) return false;
  ch4Talk(CH4_SPEAKER_BY_NAME[enemy.name] || 'alek', rows);
  return true;
}

/** 対戦の途中でセリフを言う(言っている間はAIと盤面の操作を止める)。言い終わったら再開。 */
function ch4Talk(speaker, rows, onDone) {
  const run = storyRun;
  const ch = run.ch4;
  run.holdAi = true;
  run.talking = true;
  ch.speaker = speaker;
  ch4Play(rows, 0, () => {
    ch.speaker = null;
    storyHideDialog();
    storySetSpeaker('system');
    storySetGlow([]);
    storyLater(() => { run.talking = false; run.holdAi = false; render(STATE); if (onDone) onDone(); }, 300);
  });
}

// 道化師(JOB003)は外した: 6枚だとジョブ選択時に立ち絵の顔が隠れるため(per user「道化師を外して カードを右に寄せて」)。
const CH4_JOB_POOL = ['JOB001', 'JOB007', 'JOB004', 'JOB002', 'JOB005']; // ローマ市民 研究者 百人隊長 巫女 権力者

/** 「傲慢なスパルが１番」〜「ジョブ選択画面に行く」の前までを、人ごとに分ける (2026-11-13, per user: 手番順に1人ずつ
 * 「◯番手はオレだ」→性格の説明→ジョブを選ぶ→ジョブの説明)。
 * { スパル: { ranks: {1: [...], ...}, common: [...] }, ..., tail: [「ジョブ選択画面に行く」から最後まで(アレク)] }
 * 同じ人の「…が◯番」が続く間は、次の「…が◯番」までがその番のセリフ。その人の最後の「…が◯番」だけは、すぐ下の
 * 1行がその番のセリフで、残り(次の人の「…が◯番」まで)がどの番でも言う共通のセリフ。 */
function ch4IntroSegments(rows, i) {
  const segs = {};
  let tailAt = rows.findIndex((r, k) => k >= i && /ジョブ選択画面/.test(r.event || ''));
  if (tailAt < 0) tailAt = rows.length;
  // 「以下セリフ→行動の順番です」から下は、ダイスを置く時のセリフ(ch4ActionSegments)。
  let actionAt = rows.findIndex((r, k) => k >= i && /セリフ→行動/.test(r.event || ''));
  if (actionAt < 0) actionAt = rows.length;
  const marks = [];
  for (let k = i; k < tailAt; k++) {
    const m = CH4_RANK_EVENT.exec(story2NormalizeEvent(rows[k].event || ''));
    if (m) marks.push({ k, name: m[1], rank: Number(m[2].replace(/[１-４]/, (c) => '１２３４'.indexOf(c) + 1)) });
  }
  marks.forEach((mark, n) => {
    const seg = segs[mark.name] = segs[mark.name] || { ranks: {}, common: [] };
    const nextK = n + 1 < marks.length ? marks[n + 1].k : tailAt;
    const body = rows.slice(mark.k + 1, nextK);
    if (n + 1 < marks.length && marks[n + 1].name === mark.name) { seg.ranks[mark.rank] = body; return; }
    seg.ranks[mark.rank] = body.slice(0, 1);
    seg.common = body.slice(1);
  });
  segs.tail = rows.slice(tailAt, Math.max(tailAt, actionAt));
  // 「ローマ市民を使っていない場合５秒ごとに出る」とすぐ下のセリフ: その場では言わず、あなたの1R1Tの間のヒントにする
  // (ch4StartRomaHint)。
  const hintAt = segs.tail.findIndex((r) => /ローマ市民を使っていない/.test(r.event || ''));
  if (hintAt >= 0) {
    segs.romaHint = segs.tail[hintAt + 1] && !segs.tail[hintAt + 1].event ? segs.tail[hintAt + 1] : null;
    segs.tail = segs.tail.filter((r, k) => k !== hintAt && !(segs.romaHint && k === hintAt + 1));
  }
  // 1ラウンド目の行動(〜「1Rの最後」)、「1Rの最後　ダイス回収直前」、「プレイヤーの2T1T」(2R1Tのあなた)、2つ目の
  // 「以下セリフ→行動」(2R1Tの敵の行動、「獲得かLVUPする」)。
  const findAt = (re, from) => rows.findIndex((r, k) => k >= from && re.test(r.event || ''));
  const endAt = (k) => (k < 0 ? rows.length : k);
  const r1EndAt = findAt(/1Rの最後/, actionAt);
  const p2At = findAt(/プレイヤーの2[TR]1T/, Math.max(actionAt, r1EndAt));
  const act2At = p2At >= 0 ? findAt(/セリフ→行動/, p2At) : -1;
  segs.actions = ch4ActionSegments(rows.slice(actionAt + 1, endAt(r1EndAt)));
  segs.roundEnd1 = r1EndAt >= 0 ? rows.slice(r1EndAt + 1, endAt(p2At)) : [];
  segs.playerRound2 = p2At >= 0 ? rows.slice(p2At + 1, endAt(act2At)).filter((r) => !/セリフ→行動/.test(r.event || '')) : [];
  segs.actions2 = act2At >= 0 ? ch4ActionSegments(rows.slice(act2At + 1)) : [];
  // 「1R2Tの最初（プレイヤーの番でなくても）」: そのすぐ下のセリフ(アレク)。
  const r2At = rows.findIndex((r, k) => k >= i && /1R2T/.test(r.event || ''));
  segs.round1Turn2 = [];
  for (let k = r2At + 1; r2At >= 0 && k < rows.length && !rows[k].event; k++) segs.round1Turn2.push(rows[k]);
  return segs;
}

/** 「ローマ市民を使っていない場合５秒ごとに出る」: あなたの1R1Tの間、ローマ市民(JOB001)をまだ使っていなければ、
 * 5秒ごとにアレクのヒントが出てすぐ消える。ローマ市民を使うか、あなたの手番が終わったら止まる。 */
function ch4StartRomaHint(row) {
  const run = storyRun;
  const ch = run.ch4;
  const active = () => storyRun === run && STATE.round === 1 && !ch.humanDone && playerRoles.get('P1') === 'HUMAN'
    && !(STATE.cards.JOB001 && STATE.cards.JOB001.tapped);
  const loop = () => {
    if (!active()) return;
    storyLater(() => {
      if (!active()) return;
      if (run.talking) { loop(); return; }
      storySetSpeaker('alek');
      storySay(`C4-${row.index}`, () => {
        storyLater(() => {
          if (storyRun !== run) return;
          if (!run.talking) { storyHideDialog(); storySetSpeaker('system'); }
          loop();
        }, STORY_HINT_SHOW_MS);
      }, row.text);
    }, STORY_HINT_IDLE_MS);
  };
  loop();
}

/** めくり終わったら: 4人の画面を閉じて対戦(1ラウンド目)を始める。普段のゲームと同じく、1ラウンド目は各自の最初の
 * 手番の前にジョブを選ぶ(2026-11-13, per user「スパル→あなた→パトラ→セネカ なら 傲慢なスパルが現れた / 1番手の
 * セリフ ジョブを選ぶ / ダイスを置いたりする / プレイヤーの2番手のセリフ / ジョブを選ぶ ローマ市民 / ダイスを置く…」)。
 * その人の手番が来たら(ch4OnRender)、AIを止めて ch4PlayerSegment でしゃべる。 */
function ch4IntroductionRound(rows, i) {
  const run = storyRun;
  run.ch4.segs = ch4IntroSegments(rows, i);
  storyHideDialog();
  storyLater(() => {
    ch4CloseTurnOrder();
    storyLater(() => {
      run.holdAi = true; // 最初の人がしゃべり出すまでAIは動かない
      turnFlowMod.startRound(STATE);
      run.visibleMapIds = Object.keys(STATE.maps);
      storyApplyVisibleMaps();
      run.diceShown = true;
      ch4BeginPlay();
    }, 400);
  }, 1500);
}

/** 1ラウンド目、ジョブがまだの人の手番が来た時: その人の「◯番手」のセリフ・説明・ジョブ選択(あなたならアレクの
 * 「ジョブ選択画面に行く」から)。敵はその直前に立ち絵で登場。しゃべっている間はAIも盤面の操作も止める。 */
function ch4PlayerSegment(pid) {
  const run = storyRun;
  const ch = run.ch4;
  ch.segmentRunning = pid;
  run.holdAi = true;
  run.talking = true;
  const rank = STATE.turnOrder.indexOf(pid) + 1;
  const enemy = ch4Enemies().find((x) => x.id === pid);
  const segs = ch.segs || { tail: [] };
  const seg = segs[enemy ? enemy.name : 'プレイヤー'] || { ranks: {}, common: [] };
  const lines = [...(seg.ranks[rank] || []), ...seg.common, ...(enemy ? [] : segs.tail)];
  ch4ShowJobPanel();
  const release = () => {
    ch.speaker = null;
    storyHideDialog();
    storySetSpeaker('system');
    storyLater(() => {
      ch.segmentRunning = null;
      run.talking = false;
      run.holdAi = false;
      render(STATE);
      if (!enemy && segs.romaHint) ch4StartRomaHint(segs.romaHint);
    }, 500);
  };
  const finish = () => {
    if (!storyRun) return;
    if (!storyPlayer(pid).jobCardId) ch4PickJob(pid, enemy ? enemy.job : 'JOB001');
    storyHideDialog();
    storyLater(() => {
      if (ch.jobPanel) { ch.jobPanel.remove(); ch.jobPanel = null; }
      // 敵: このあとの手番の行動それぞれの前に、その行動のセリフ(セリフ→行動の順、storyBeforeAiStep)。
      if (enemy) ch.actionTurn = pid;
      release();
    }, 500);
  };
  ch.speaker = enemy ? CH4_SPEAKER_BY_NAME[enemy.name] || 'alek' : 'alek';
  const speak = () => ch4Play(lines, 0, finish);
  if (enemy && lines.some((r) => r.text)) ch4IntroEnemies([enemy], ch4EnemyTitle, speak);
  else speak();
}

/** ジョブ5枚の画面(右寄せ)。もう選ばれているジョブは取られた形(薄く、選んだ人の名前)で出す。 */
function ch4ShowJobPanel() {
  const run = storyRun;
  if (run.ch4.jobPanel) return;
  STATE.jobPool = CH4_JOB_POOL.filter((id) => !STATE.players.some((p) => p.jobCardId === id));
  const root = el('div', 'story2-cards story2-cards--ch4 story-ch4-jobs');
  const row = el('div', 'story2-cards__row');
  run.ch4.jobCells = {};
  for (const jobId of CH4_JOB_POOL) {
    const cell = el('div', 'story2-cards__card');
    cell.appendChild(buildCardVisual(jobId, { showEffect: true, allowTextFallback: false, noInteraction: true }));
    cell.appendChild(el('div', 'story-ch4-jobs__owner'));
    run.ch4.jobCells[jobId] = cell;
    row.appendChild(cell);
    const owner = STATE.players.find((p) => p.jobCardId === jobId);
    if (owner) {
      cell.classList.add('story2-cards__card--selected', 'story-ch4-jobs__card--taken');
      cell.lastChild.textContent = owner.name;
    }
  }
  root.appendChild(row);
  run.dom.root.appendChild(root);
  run.ch4.jobPanel = root;
  root.animate([{ opacity: 0, transform: 'translateY(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'ease-out' });
}

/** 「ジョブ選択画面に行く」: ジョブの画面はもう出ている(ch4IntroductionRound)。出ていなければ出して、あなたより
 * 前の敵でまだ選んでいない人は先に選ぶ。あなたの分はセリフ「「ローマ市民」」でアレクが選ぶ(ch4PickJob)。 */
function ch4ShowJobDraft(onReady) {
  ch4ShowJobPanel();
  const before = STATE.turnOrder.slice(0, STATE.turnOrder.indexOf('P1'));
  ch4EnemiesPickJobs(before, onReady);
}

/** 「スパルが百人隊長を選ぶ」: しゃべっている敵が自分のジョブを選ぶ(ジョブの画面で取られた形になる)。 */
function ch4EnemyChoosesJob(e, onDone) {
  const enemy = ch4Enemies().find((x) => e.includes(x.name));
  if (!enemy) { onDone(); return; }
  ch4ShowJobPanel();
  ch4PickJob(enemy.id, enemy.job);
  storyLater(onDone, 500);
}

/** 1人のジョブを決める(カードに選んだ人の名前を出す。名前の表示にもジョブ名が付く)。 */
function ch4PickJob(playerId, jobId) {
  const run = storyRun;
  const player = storyPlayer(playerId);
  if (player.jobCardId) return;
  setupMod.chooseJob(STATE, INDEX, playerId, jobId);
  const cell = run.ch4.jobCells && run.ch4.jobCells[jobId];
  if (cell) {
    cell.classList.add('story2-cards__card--selected', 'story-ch4-jobs__card--taken');
    cell.querySelector('.story-ch4-jobs__owner').textContent = player.name;
    cell.animate([{ transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
  }
  render(STATE);
}

function ch4EnemiesPickJobs(playerIds, onDone) {
  const ids = playerIds.filter((id) => id !== 'P1' && !storyPlayer(id).jobCardId);
  if (!ids.length) { onDone(); return; }
  storyLater(() => {
    const enemy = ch4Enemies().find((x) => x.id === ids[0]);
    ch4PickJob(enemy.id, enemy.job);
    ch4EnemiesPickJobs(ids.slice(1), onDone);
  }, 900);
}

/** 台本のあと: (まだなら)あなたのジョブはローマ市民、あなたより後の敵もジョブを選んでから4人対戦を始める。 */
function ch4StartGame() {
  const run = storyRun;
  storyHideDialog();
  story2HideResourceCards();
  ch4CloseTurnOrder();
  ch4SetupEnemies();
  if (!run.ch4.jobPanel) STATE.jobPool = CH4_JOB_POOL.filter((id) => !STATE.players.some((p) => p.jobCardId === id));
  ch4PickJob('P1', 'JOB001');
  ch4EnemiesPickJobs(STATE.turnOrder, () => storyLater(() => {
    if (run.ch4.jobPanel) { run.ch4.jobPanel.remove(); run.ch4.jobPanel = null; }
    turnFlowMod.startRound(STATE);
    // 盤面を全部見せる。
    run.visibleMapIds = Object.keys(STATE.maps);
    storyApplyVisibleMaps();
    run.diceShown = true;
    render(STATE);
    // 敵の登場(立ち絵)がまだなら、ここで(ジョブが決まったので「性格＋ジョブ」の呼び名で)。
    // まだ登場していない敵は、ここで(ジョブが決まったので「性格＋ジョブ」の呼び名で)。
    ch4IntroEnemies(ch4Enemies(), (enemy) => rankingConJobTitle(enemy.con, enemy.job), ch4BeginPlay);
  }, 700));
}

/** 4人対戦の本番: ストーリーの縛り(タブ・エリアを押せない等)を外して、普段のゲームと同じように進める。 */
function ch4BeginPlay() {
  const run = storyRun;
  if (!run) return;
  run.normalGame = true;
  storySetSpeaker('system'); // アレクの立ち絵は下げる(対戦中は盤面に重ならないように)
  // 準備(性格・初期資源を配った分)が進捗の記録に入っていると、最初の手番が「ターン2」になるので消す。
  STATE.progressLog = [];
  // 普段のゲームの画面に戻す(ターン終了ボタン・カードを選ぶ画面の戻る等、story-modeで隠していた物を出す)。
  document.body.classList.remove('story-mode', 'story-hide-dice', 'story-free-action', 'story-undo-shown', 'story-lock-hand');
  run.dom.logButton.hidden = true;
  storySetAllowedTabs([...document.querySelectorAll('.mobile-tab-switcher__btn')].map((b) => b.dataset.tabTarget));
  storySetGlow([]);
  aiPacingMode = 'delayed';
  // 1R1T(各自の最初の手番)はアニメーションを1.5倍ゆっくり、1R2Tの最初から普段の速さ(2026-11-13, per user)。
  animSpeedFactor = 1.5;
  turnActionTaken = false;
  lastTurnPlayerId = null;
  run.onRender = ch4OnRender;
  render(STATE);
}

/** 描き直すたび: あなたの席を、そのラウンドの1ターン目ならあなた(人間)、2ターン目からアレク(AI)に。1ターン目は
 * 手番を終えるまで人間のまま(置いたあとのフリーアクションもできる)。ゲームが終わったら第4章クリア。 */
/** あなた(人間)の手番の途中か: ダイスを置いた(turnActionTaken)、または置いたあとの選択(皇帝宮殿のカード選びなど)が
 * 開いている間。ここで交代しないよう、アレクへの交代は「ターン終了」を押したあと(per user 2026-11-14「皇帝宮殿に
 * ダイスを置くと アレクが…変わられる / ターン終了ボタンを押したら アレクに変わる」)。 */
function ch4HumanMidTurn() {
  return playerRoles.get('P1') === 'HUMAN' && !!(turnActionTaken || pendingBuildChoice || pendingBzOutcomeChoice || pendingTapChoice
    || pendingAutoModeChoice || pendingJob007TapPrompt || pendingWhiteOverflowConfirm);
}

function ch4OnRender(state) {
  const run = storyRun;
  if (!run || !run.normalGame) return;
  if (state.phase === 'GAME_END') {
    if (!run.ch4.cleared) { run.ch4.cleared = true; storyMarkChapterCleared(4); }
    return;
  }
  const ch = run.ch4;
  // 「1R2Tの最初（プレイヤーの番でなくても）」: 4人とも1ターン目を終えたら、次の人が打つ前にアレクのセリフ。
  // そのあとは普段の対戦の速さで進む(「以降2Rまで通常ゲームの速度で進む」— 今の速さのまま)。
  if (state.round >= 1 && !ch.turn2Said && !ch.segmentRunning && !run.holdAi && ch.segs
    && state.players.every((p) => p.dice.some((d) => d.placedMapId || d.passed))
    && aiOpenTurnPlayerId === null && !ch4HumanMidTurn()) {
    ch.turn2Said = true;
    animSpeedFactor = 1; // ここから普段の速さ
    if (state.round === 1 && (ch.segs.round1Turn2 || []).length) {
    run.holdAi = true;
    run.talking = true;
    setTimeout(() => {
      if (storyRun !== run) return;
      ch.speaker = 'alek';
      ch4Play(ch.segs.round1Turn2, 0, () => {
        ch.speaker = null;
        storyHideDialog();
        storySetSpeaker('system');
        storyLater(() => { run.talking = false; run.holdAi = false; render(STATE); }, 300);
      });
    }, 0);
    }
  }
  // 1ラウンド目: ジョブがまだの人の手番が来たら、その人の自己紹介とジョブ選択(ch4PlayerSegment)。
  const upcoming = turnFlowMod.getNextTurn(state);
  if (state.round === 1 && !ch.segmentRunning && upcoming.type === 'TURN' && !storyPlayer(upcoming.playerId).jobCardId && ch.segs) {
    ch.segmentRunning = upcoming.playerId;
    setTimeout(() => { if (storyRun === run) ch4PlayerSegment(upcoming.playerId); }, 0);
  }
  const p1 = state.players.find((p) => p.id === 'P1');
  const used = p1.dice.filter((d) => d.placedMapId || d.passed).length;
  const next = turnFlowMod.getNextTurn(state);
  // 「プレイヤーの2T1T」: 2ラウンド目のあなたの最初の手番の初め(ダイスを置く前)に、アレクのセリフ。
  if (state.round === 2 && !ch.round2PlayerSaid && !run.holdAi && ch.segs && (ch.segs.playerRound2 || []).length
    && upcoming.type === 'TURN' && upcoming.playerId === 'P1' && !p1.dice.some((d) => d.placedMapId || d.passed) && aiOpenTurnPlayerId === null) {
    ch.round2PlayerSaid = true;
    run.holdAi = true;
    setTimeout(() => { if (storyRun === run) ch4Talk('alek', ch.segs.playerRound2); }, 0);
  }
  // そのラウンドで、まだダイスを1つも使っていないあなたの番が来たら、その手番は人間。
  if (ch.humanRound !== state.round && next.type === 'TURN' && next.playerId === 'P1' && used === 0) {
    ch.humanRound = state.round;
    ch.humanDone = false;
  }
  // 人間の手番が終わった(ダイスを使ってターン終了した=turnActionTakenが戻った、または別の人の番)ら、そのラウンドはもうアレク。
  if (ch.humanRound === state.round && !ch.humanDone && used > 0
    && (next.type !== 'TURN' || next.playerId !== 'P1' || !ch4HumanMidTurn())) ch.humanDone = true;
  const role = ch.humanRound === state.round && !ch.humanDone ? 'HUMAN' : CH4_ALEK_ROLE;
  if (playerRoles.get('P1') !== role) {
    playerRoles.set('P1', role);
    setTimeout(() => { if (storyRun === run) render(STATE); }, 0);
  }
}

const STORY_CHAPTERS = [
  { no: 1, title: '第１章　怠惰なローマ市民アレク', start: openStoryMode },
  // 2026-11-09, per user: セネカの章を第2章に、スパルは第3章に(題名も「傲慢な百人隊長スパル」、伏せ字はやめる)。
  { no: 2, title: '第２章　几帳面な研究者セネカ', start: () => openStoryMode(senecaStart) },
  { no: 3, title: '第３章　傲慢な百人隊長スパル', start: () => openStoryMode(story2Start) },
  { no: 4, title: '第４章　４人対戦', start: () => openStoryMode(ch4Start) },
];

function storyClearedChapters() {
  try { return JSON.parse(localStorage.getItem(STORY_CLEARED_KEY) || '[]'); } catch (e) { return []; }
}
function storyMarkChapterCleared(no) {
  const cleared = storyClearedChapters();
  if (cleared.includes(no)) return;
  try { localStorage.setItem(STORY_CLEARED_KEY, JSON.stringify([...cleared, no])); } catch (e) { /* 保存できなくても続ける */ }
}

function openStoryChapterSelect() {
  if (storyRun || document.getElementById('story-chapters')) return;
  if (!storyClearedChapters().includes(1)) { openStoryMode(); return; }
  const root = el('div', 'story-chapters');
  root.id = 'story-chapters';
  const panel = el('div', 'story-chapters__panel');
  panel.appendChild(el('div', 'story-chapters__heading', 'ストーリー'));
  const note = el('div', 'story-chapters__note', '');
  for (const chapter of STORY_CHAPTERS) {
    const button = el('button', 'story-chapters__chapter', chapter.title);
    // 第3章: 自分の最高記録があれば右側に「最高記録〇VP」(2026-11-14, per user)。
    if (chapter.no === 3) {
      let best = null;
      try { best = localStorage.getItem(STORY3_BEST_VP_KEY); } catch (err) { /* 読めなければ出さない */ }
      if (best !== null) button.appendChild(el('span', 'story-chapters__record', `最高記録${best}VP`));
    }
    button.type = 'button';
    button.addEventListener('click', () => {
      if (!chapter.start) { note.textContent = `第${chapter.no}章は今作成中です`; return; }
      root.remove();
      chapter.start();
    });
    panel.appendChild(button);
  }
  panel.appendChild(note);
  const back = el('button', 'story-end__button', '戻る');
  back.type = 'button';
  back.addEventListener('click', () => root.remove());
  panel.appendChild(back);
  root.appendChild(panel);
  document.body.appendChild(root);
}

document.getElementById('entry-banner-story-button').addEventListener('click', openStoryChapterSelect);

// 章の終わりから次の章へ(senecaGoChapter3): 読み直した直後にその章を始める。
const STORY_AUTO_START_KEY = 'diceWpStoryAutoStart';
(() => {
  let no = null;
  try { no = Number(sessionStorage.getItem(STORY_AUTO_START_KEY)); sessionStorage.removeItem(STORY_AUTO_START_KEY); } catch (e) { return; }
  const chapter = STORY_CHAPTERS.find((c) => c.no === no);
  // main.jsの初期化(DOMContentLoaded)が終わってから。
  if (chapter && chapter.start) document.addEventListener('DOMContentLoaded', () => setTimeout(chapter.start, 300));
  else document.documentElement.classList.remove('story-autostarting'); // 始める章が無ければ覆いを外してトップへ
})();
