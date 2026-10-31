/* ストーリーモード (2026-10-23, per user request: "ストーリーモードを実装したい ... スマホだとチュートリアルが
 * ほぼできない そのためスマホに特化したストーリーモードを作る PCやタブレットは後で対応させる" + 回答:
 * 入口の「デザイナーズノート」ボタンを「ストーリー」に、セリフはストーリー専用の表示(立ち絵+名前付きの
 * 会話ウインドウ)、全体の形は「小さな場面の連続」、ファンファーレは見た目だけ、"セリフは基本的にボタンを
 * 押さずに自動で進む")。
 *
 * 台本: data/story.data.js (window.STORY_SCRIPT)。2026-10-27からTwineのストーリー「怠惰なローマ人アレク」が
 * 元(per user「Twineを元にする」、tools/story_twine_to_js.pyで変換)。S001などのパッセージ番号で引く。
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
const STORY_HINT_IDLE_MS = 5000; // 何もしない場合5秒ごとに出る
const STORY_HINT_SHOW_MS = 2600; // 出てすぐ消える(全文が出てからこの時間で消える)

const STORY_SPEAKERS = {
  alek: { name: 'アレク', img: 'assets/story-alek.webp' },
  unknown: { name: '？？？', img: null },
  patra: { name: 'パトラ', img: 'assets/story-patra.webp' },
  spal: { name: 'スパル', img: 'assets/story-spal.webp' },
  spalAway: { name: 'スパル', img: null }, // 第2章: スパルが立ち去っている間(立ち絵を消す)
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
  return text.replace(/(?<![A-Za-z])[ABCZK](?![A-Za-z])/g, (ch) => String.fromCharCode(0xE000 + STORY_ICON_RESOURCES.indexOf(ch)));
}
/** storyIconizeした文章 -> 資源アイコン + 性格・ジョブの名前に色を付けた文章。 */
function storyLineFragment(text) {
  const frag = document.createDocumentFragment();
  let plain = '';
  const flush = () => { if (plain) { frag.appendChild(conJobColoredFragment(plain)); plain = ''; } };
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xE000;
    if (code >= 0 && code < STORY_ICON_RESOURCES.length) {
      flush();
      frag.appendChild(actionDot(STORY_ICON_RESOURCES[code]));
    } else {
      plain += ch;
    }
  }
  flush();
  return frag;
}

/** 会話ウインドウにセリフを1文字ずつ出す。全部出たらonTyped()。textを渡すとそちらを出す(差し込みあり等)。 */
function storySay(id, onTyped, textOverride) {
  const run = storyRun;
  if (!run) return;
  const text = textOverride !== undefined ? textOverride : storyLine(id).text;
  // 会話ログ用に記録(5秒ごとに出るヒントなど、同じセリフは1回だけ)。
  if (text && !run.log.some((e) => e.id === id)) run.log.push({ id, text, speaker: STORY_SPEAKERS[run.speaker].name });
  if (!text) { if (onTyped) onTyped(text); return; }
  const box = run.dom.dialog;
  const body = run.dom.dialogText;
  run.dialogSeq = (run.dialogSeq || 0) + 1; // 隠している途中の storyHideDialog に「また出した」と知らせる
  box.hidden = false;
  box.dataset.lineId = id;
  body.textContent = '';
  storyCancel(run.typeTimer);
  let i = 0;
  const shown = storyIconize(text);
  const step = () => {
    i++;
    body.textContent = '';
    body.appendChild(storyLineFragment(shown.slice(0, i))); // 資源はアイコン、性格・ジョブの名前は色付き
    if (i < shown.length) run.typeTimer = storyLater(step, STORY_TYPE_MS_PER_CHAR);
    else { run.typeTimer = null; if (onTyped) onTyped(text); }
  };
  box.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 220, easing: 'ease-out' });
  run.typeTimer = storyLater(step, 120);
}

/** セリフを出して、読み終わる頃に自動で次へ(ボタン無し)。extraMsで待ちを延ばせる。 */
function storySayThen(id, next, extraMs, textOverride) {
  storySay(id, (text) => storyLater(next, (text ? storyHoldMs(text) : 0) + (extraMs || 0)), textOverride);
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
  setupMod.dealConCards(state, cons || { P1: 'CON005', P2: 'CON001' });
  state.jobPool = ['JOB001', 'JOB002'];
  setupMod.chooseJob(state, INDEX, 'P1', 'JOB001');
  setupMod.chooseJob(state, INDEX, 'P2', 'JOB002');
  setupMod.chooseConFace(state, INDEX, 'P1', 'A');
  setupMod.chooseConFace(state, INDEX, 'P2', 'A');
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
  storyMaybeTurnBanner(state);
  if (run.glowDieValues.length > 0) {
    for (const node of storyHandDiceNodes('P1')) {
      if (run.glowDieValues.includes(Number(node.textContent.trim()))) node.classList.add('change-highlight');
    }
  }
  if (run.shopOverrides) storyApplyShopOverrides(run.shopOverrides);
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

/** 「ターン2」「ターン3」 (2026-10-31, per user「ダイスを置いたあと ターン2 ターン3 とだして」+ 回答: 普段の
 * 対戦と同じ演出、ラウンドごとに1から、ターン1は出さない)。普段の対戦の手番の表示(main.jsの
 * playPendingTurnBanner)はストーリーでは出さないので、ここで出す: 次の手番の人が、このラウンドで何個目の
 * ダイスを置く番か(置いた/パスしたダイスの数+1)。同じ表示は一度だけ(巻き戻すと数え直す)。 */
function storyMaybeTurnBanner(state) {
  const run = storyRun;
  if (!run.diceShown || state.phase === 'GAME_END') return;
  const next = turnFlowMod.getNextTurn(state);
  if (next.type !== 'TURN') return;
  const player = state.players.find((p) => p.id === next.playerId);
  const nth = player.dice.filter((d) => d.placedMapId || d.passed).length + 1;
  if (nth < 2) return;
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
  return !storyRun || storyRun.allowedTabs.has(tab);
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
  storyShowGoal(goalText);
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
  storyUseState(storyBuildState([1, 6, 3]));
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
            storySay('S012', (text12) => {
              storyShowResourceChange('K', 'A', () => storyLater(() => storySayThen('S013', storySceneCastle), storyHoldMs(text12)));
            });
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
    storySetGlow(['#build-choice-overlay .shop-card__cost']);
    storySayThen('S018', () => {
      storySetGlow([]);
      storySayThen('S019', () => {
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
                storySay('S057', (text57) => {
                  storyPatraUsesBasicStudy();
                  storyLater(() => storyWhenVisualsIdle(storyPatraFee), storyHoldMs(text57));
                });
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

/** S045〜S053: 使用料が払えないので、フリーアクション(A→K/B→K)を、あなたがパトラの代わりに押す。 */
function storyPatraFee() {
  storySaySeq(['S045', 'S046', 'S047'], () => {
    // パトラの手番を、この画面で操作できる形(人間)にして、フリーアクションの画面を開く。
    playerRoles.set('P2', 'HUMAN');
    turnActionTaken = true; // ダイスはもう置いた
    mobileFreeActionOpen = true;
    mobileFreeActionBaseline = mobileFreeActionSignature(STATE, storyPlayer('P2'));
    render(STATE);
    storySetGlow(['#mobile-free-action-body .mobile-free-action-overlay__exchanges > *']);
    storySayThen('S048', () => {
      storySay('S049', () => {
        storyShowGoal(storyGoalOf('S049'));
        storyWaitUntil(() => (storyPlayer('P2').resources.K || 0) >= 1, () => {
          storyShowGoal('');
          storySetGlow([]);
          mobileFreeActionOpen = false;
          mobileFreeActionBaseline = null;
          playerRoles.set('P2', DEFAULT_AI_ROLE);
          render(STATE);
          applyMobileActiveTab('board');
          storySaySeq(['S050', 'S051', 'S052', 'S053'], storySceneFeeCollect);
        });
      });
    });
  });
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
    storySetGlow([storyTileSelector(STORY_CITY_MAP_ID, '.map-tile__fee')]);
    storySay('S058', () => {
      storyShowGoal(storyGoalOf('S058'));
      const kBefore = storyPlayer('P1').resources.K || 0;
      storyWaitUntil(() => (storyPlayer('P1').resources.K || 0) > kBefore, () => {
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
      goalText: storyGoalOf('S062'),
      hintLineId: first ? 'S062' : null,
      extraDetect: () => typeof pendingBuildChoice !== 'undefined' && !!pendingBuildChoice,
      onPlaced: () => {
        const afterTurn = () => storyWhenVisualsIdle(() => {
          storyEndTurnOf('P1');
          turnActionTaken = true; // パトラの手番の間は置けない(次の自分の番でstoryWaitForPlacementが戻す)
          storyPatraPlacesOnField(() => loop(false));
        });
        if (first) storySay('S063', afterTurn);
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
      if (boardMod.placeDice(trial, INDEX, { playerId }, dieId, mapId, slotIndex).success) result.push({ mapId, slotIndex });
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

function storyFinishFreePlay() {
  const city = STATE.cards.A001;
  const hasLv2 = !!city && city.ownerId === 'P1' && city.currentFaceId === 'A001B';
  if (hasLv2) {
    storyMarkChapterCleared(1);
    storySayThen('S064', () => storyEndOfScript('第2章へつづく'));
  }
  else storySayThen('S065', storyRewindToRound2);
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
  const close = el('button', 'story-close', '✖');
  close.type = 'button';
  close.setAttribute('aria-label', 'ストーリーをやめる');
  close.addEventListener('click', closeStoryMode);
  // 会話ログ (2026-10-24, per user request: "会話ログを見れるボタンが欲しい 会話ログは新しいウィンドウが開く
  // のではなくセリフ部分にでる") -- ✖の上の「ログ」ボタンで、セリフ欄の所が上に広がってこれまでのセリフを
  // 一覧表示(新しい物が下)。開いている間はストーリーの自動送りを止める。もう一度押すか一覧を押すと閉じる。
  const logButton = el('button', 'story-log-button', 'ログ');
  logButton.type = 'button';
  logButton.addEventListener('click', toggleStoryLog);
  const logPanel = el('div', 'story-log');
  logPanel.hidden = true;
  logPanel.addEventListener('click', toggleStoryLog);
  root.append(portrait, dialog, logPanel, goal, logButton, close);
  document.body.appendChild(root);
  storyRun = {
    timers: new Set(), typeTimer: null, diceShown: false, glowDieValues: [], glowSelectors: [], onRender: null, onTap: null,
    resourceOverride: null, blockBuildChoice: false, allowedTabs: new Set(['board']), speaker: null, placementBaseline: {},
    visibleMapIds: [], log: [], paused: false,
    dom: { root, portrait, goal, dialog, dialogName, dialogText, logPanel, logButton },
  };
  document.body.classList.add('story-mode', 'story-hide-dice');
  entryBannerDismissed = true;
  aiPacingMode = 'manual'; // パトラなどAIの手は台本が進める
  // 話し手は最初の場面が決める(第2章でアレクが一瞬出ないように)。第1章はアレクから。
  if (!startScene) storySetSpeaker('alek');
  storySetAllowedTabs(['board']);
  (startScene || storySceneFarm)();
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
  if (storyRun.onTap) storyRun.onTap();
  const onSlotToPlace = !!e.target.closest('.slot--selectable');
  const blockedTile = e.target.closest('#board .map-tile') && !onSlotToPlace && !e.target.closest('.map-tile__fee');
  const blockedChoice = storyRun.blockBuildChoice && e.target.closest('#build-choice-overlay .owned-card-cell, #build-choice-overlay .shop-card');
  if (blockedTile || blockedChoice) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

/* ---------- 第2章: ○○の百人隊長スパル (data/story2.data.js) ---------- */

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
 *  - 最初のダイス3個は、3個とも同じ目にはしない(per user: 同じ目だとクリアできないことがあるため)。 */
const STORY_TAVERN_MAP_ID = 'MAP006'; // 酒場
const STORY_TRAINING_MAP_ID = 'MAP007'; // 訓練場
const STORY2_TRIGGERS = [
  { key: 'train1', test: (e) => /訓練場/.test(e) && /[1１]回目/.test(e) },
  { key: 'train2', test: (e) => /訓練場/.test(e) && /[2２]回目/.test(e) },
  { key: 'tavern', test: (e) => /酒場/.test(e) && /置く/.test(e) },
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
  for (;;) {
    const values = [0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6));
    if (new Set(values).size > 1) return values;
  }
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
  if (i >= rows.length) { onDone(); return; }
  const row = rows[i];
  const next = () => story2Play(rows, i + 1, onDone);
  const say = () => {
    if (!row.text) { next(); return; }
    story2HideCallout(); // 拡大したカードはセリフが始まったら消す(セリフが隠れないように、per user)
    story2TopicGlow(row);
    storySetSpeaker('spal');
    storySayThen(`C2-${row.index}`, next, 0, row.text);
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
    // 無ければ待たない。使ったら画面を閉じてエリアに戻す(このあと1手戻るボタンを光らせるため)。
    if (computeMobileFreeActions(STATE, storyPlayer('P1')).cards.length === 0) { onDone(); return; }
    const tapped = () => storyPlayer('P1').ownedCardPhysicalIds.filter((id) => STATE.cards[id] && STATE.cards[id].tapped).length;
    const before = tapped();
    storyWaitUntil(() => tapped() > before && !pendingTapChoice && !pendingBuildChoice, () => {
      mobileFreeActionOpen = false;
      applyMobileActiveTab('board');
      render(STATE);
      onDone();
    });
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
    // 「ターン開始時に戻るボタンと１手戻るボタンが出てくる」: ここから先は、エリアの右下(main.jsの
    // renderMobileOwnRow、戻せる物が無い間は押せない表示)とカードを選ぶ画面(皇帝宮殿・元老院)に出す。
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
      const key = STATE.round === 2 ? 'round2Snapshot' : 'round3Snapshot';
      if (!ch[key]) ch[key] = { state: gameStateMod.cloneState(STATE), visibleMapIds: run.visibleMapIds.slice(), rowIndex: i + 1, allowedTabs: [...run.allowedTabs] };
      ch.inRound2 = STATE.round === 2;
      ch.inRound3 = STATE.round === 3;
      onDone();
    }, true);
    if (!ch.turnOpen) { start(); return; }
    // 2ラウンド目の最後のダイスの手番はまだ終えていない(story2FreePlay): 「今のうちに獲得したカードを使っときな」
    // -> タップできるカードで未タップの物が無くなったら(per user)手番を終えて次のラウンドへ。
    storySetGlow(['.mobile-own-row__free-action']);
    storyWaitUntil(() => computeMobileFreeActions(STATE, storyPlayer('P1')).cards.length === 0 && !pendingTapChoice && !pendingBuildChoice, () => {
      storySetGlow([]);
      mobileFreeActionOpen = false;
      applyMobileActiveTab('board');
      ch.turnOpen = false;
      storyEndTurnOf('P1');
      start();
    });
  } else if (/減る|増える/.test(e)) {
    // 「食料2減る」「人脈3増える」: 資源はもう本物のゲームの処理で変わっているので、その資源を光らせるだけ。
    const names = { 食料: 'K', 権力: 'A', 知識: 'B', 金貨: 'C', 人脈: 'Z' };
    const key = Object.keys(names).find((n) => e.includes(n));
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
function story2ShowResourceCards(selectable, onPicked) {
  const run = storyRun;
  story2HideResourceCards();
  const root = el('div', 'story2-cards');
  const row = el('div', 'story2-cards__row');
  const selected = new Set();
  const confirm = el('button', 'story-end__button story2-cards__confirm', 'この2枚にする');
  confirm.type = 'button';
  confirm.hidden = true;
  for (const faceId of run.chapter2.cards) {
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
      if (block) {
        // 何枚目かの部分は「消える」で終わっていないので、終わったらスパルとセリフを下げる(story2FreePlay)。
      } else if (mapId === STORY_TRAINING_MAP_ID && story2ColorDiceCount() > colorBefore) {
        ch.trainCount++;
        if (ch.trainCount <= 2) block = ch.blocks[ch.trainCount === 1 ? 'train1' : 'train2'];
      } else if (mapId === STORY_TAVERN_MAP_ID && (storyPlayer('P1').resources.Z || 0) > zBefore && !ch.tavernDone) {
        ch.tavernDone = true;
        block = ch.blocks.tavern;
      }
      if (block) story2Play(block, 0, story2FreePlay);
      else story2FreePlay();
    }),
  });
}

function story2Finish() {
  const ch = storyRun.chapter2;
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

/** 「やり直し」: snapの盤面に戻して、rowsのsnap.rowIndex行目から続きを出す。1ラウンド目は初期資源カードが
 * 配られる直前(導入の途中)、2ラウンド目は「よーし次のラウンドだ」の直前。 */
function story2Rewind(snap, rows) {
  const run = storyRun;
  if (!run) return;
  const ch = run.chapter2;
  story2HideCallout();
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

/* ---------- 章を選ぶ画面 ---------- */

// 2026-10-31, per user: "第２章のストーリーに行った後 また ストーリー に入ったら 第１章 怠惰なローマ市民アレク
// 第２章 ○○の百人隊長スパル という風に選べるように" + 回答: 第1章をクリアする前は今まで通りそのまま第1章、
// 第2章は「今作成中」、題名の○○は仮でそのまま。クリアの記録はこの端末だけ(localStorage)。
const STORY_CLEARED_KEY = 'diceWpStoryChaptersCleared';
const STORY_CHAPTERS = [
  { no: 1, title: '第１章　怠惰なローマ市民アレク', start: openStoryMode },
  { no: 2, title: '第２章　○○の百人隊長スパル', start: () => openStoryMode(story2Start) },
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
