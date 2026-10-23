/* ストーリーモード (2026-10-23, per user request: "ストーリーモードを実装したい ... スマホだとチュートリアルが
 * ほぼできない そのためスマホに特化したストーリーモードを作る PCやタブレットは後で対応させる" + 回答:
 * 入口の「デザイナーズノート」ボタンを「ストーリー」に、セリフはストーリー専用の表示(アレクの絵+名前付きの
 * 会話ウインドウ)、全体の形は「小さな場面の連続」、ファンファーレは見た目だけ、"セリフは基本的にボタンを
 * 押さずに自動で進む")。
 *
 * セリフ本文は data/story.data.js (window.STORY_SCRIPT、tools/story_xlsx_to_js.py が デスクトップの
 * ストーリー.xlsx から生成) を S001 などの行IDで引く。Excelの光る/動く/メモ列の指示はこのファイルの
 * 場面ごとの関数(storySceneFarmなど)にコードとして書く。
 *
 * 画面はローカル対戦の本物のエリア画面を使う (2026-10-23, per user request: "基本的にローカル対戦のエリア
 * 画面を使ってください エリアの農園の位置 右側もダイス置き場と同じ 他のエリアは枠だけ見えてそれ以外は
 * 見えない") -- 場面ごとに練習用のGameStateを作ってSTATEと入れ替え、普段のrender()で描く(ダイスの選択・
 * スロットへの配置・資源の増加は本物のゲームの処理そのまま)。その上に透明なオーバーレイ(アレク・会話
 * ウインドウ・今やること・✖)を重ねる。見せないもの(他のエリアの中身、タブ、ターン終了ボタン等)は
 * body.story-modeのCSSで隠す。描き直されるたびにmain.jsのrender()からstoryAfterRender()が呼ばれ、光る演出
 * などを付け直す。練習用の盤面は「進行中のゲーム」として保存しない(saveGameSessionIfApplicable参照)。
 * ✖/トップに戻るは再読み込みでトップ画面へ(STATEを元に戻す手間を省く)。main.jsの後に読み込む。 */

const STORY_TYPE_MS_PER_CHAR = 37; // 1文字ずつ出る速さ (2026-10-23 per user "セリフの表示速度1.5倍に": 55ms→37ms)
const STORY_HOLD_BASE_MS = 930; // 全文出てから次へ進むまでの待ち(+文字数ぶん) (2026-10-23 per user "それも1.5倍に": 1400→930、1文字45→30ms)
const STORY_HOLD_PER_CHAR_MS = 30;
const STORY_HINT_IDLE_MS = 5000; // S005: 何もしない場合5秒ごとに出る
const STORY_HINT_SHOW_MS = 2600; // 出てすぐ消える(全文が出てからこの時間で消える)

let storyRun = null; // 実行中の場面。nullなら閉じている。

function storyLine(id) {
  const script = window.STORY_SCRIPT || {};
  return script[id] || { text: '' };
}

function storyLater(fn, ms) {
  if (!storyRun) return null;
  const run = storyRun;
  const t = setTimeout(() => {
    run.timers.delete(t);
    if (storyRun === run) fn();
  }, ms);
  run.timers.add(t);
  return t;
}
function storyCancel(t) {
  if (!t || !storyRun) return;
  clearTimeout(t);
  storyRun.timers.delete(t);
}

function storyHoldMs(text) {
  return STORY_HOLD_BASE_MS + text.length * STORY_HOLD_PER_CHAR_MS;
}

/** 会話ウインドウにセリフを1文字ずつ出す。全部出たらonTyped()。 */
function storySay(id, onTyped) {
  const run = storyRun;
  if (!run) return;
  const text = storyLine(id).text;
  const box = run.dom.dialog;
  const body = run.dom.dialogText;
  box.hidden = false;
  box.dataset.lineId = id;
  body.textContent = '';
  storyCancel(run.typeTimer);
  let i = 0;
  const step = () => {
    i++;
    body.textContent = text.slice(0, i);
    if (i < text.length) run.typeTimer = storyLater(step, STORY_TYPE_MS_PER_CHAR);
    else { run.typeTimer = null; if (onTyped) onTyped(text); }
  };
  if (!text) { if (onTyped) onTyped(text); return; }
  box.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 220, easing: 'ease-out' });
  run.typeTimer = storyLater(step, 120);
}

/** セリフを出して、読み終わる頃に自動で次へ(ボタン無し)。 */
function storySayThen(id, next) {
  storySay(id, (text) => storyLater(next, storyHoldMs(text)));
}

function storyHideDialog() {
  if (!storyRun) return;
  const box = storyRun.dom.dialog;
  if (box.hidden) return;
  storyCancel(storyRun.typeTimer);
  const a = box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in' });
  a.onfinish = () => { if (storyRun) box.hidden = true; };
}

/** 画面上部に、今やること(Excelの選択肢の文言)を左から流して出す。空文字で消す。 */
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

/** 練習用のGameStateを作る: プレイヤーはP1(あなた)だけが動く(他の3人はダイスを全部パス済みにして手番が
 * 来ないようにする)。P1は1ラウンド目の自分の手番から。JOB/制約は効果の無いものを持たせ、資源は0から。 */
function storyBuildState(diceValues) {
  const state = gameStateMod.createEmptyGameState(`story-${Date.now()}`);
  setupMod.createPlayers(state, [loadRememberedRankingName() || 'Alice', 'Bob', 'Carol', 'Dan']);
  setupMod.prepareMaps(state, INDEX);
  setupMod.prepareShops(state, INDEX);
  setupMod.rollInitialColorDice(state, { P1: diceValues });
  setupMod.dealConCards(state, { P1: 'CON005' });
  state.jobPool = ['JOB001'];
  setupMod.chooseJob(state, INDEX, 'P1', 'JOB001');
  setupMod.chooseConFace(state, INDEX, 'P1', 'A');
  qstMod.setupQuests(state);
  const p1 = state.players.find((p) => p.id === 'P1');
  Object.keys(p1.resources).forEach((r) => { p1.resources[r] = 0; });
  for (const player of state.players) {
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
}

/** 手元のダイス置き場(スマホは画面右)にある、P1のダイスの要素。 */
function storyHandDiceNodes() {
  return [...document.querySelectorAll('#mobile-own-row .die[data-die-key^="P1:"], #players .player-panel[data-player-id="P1"] .die')]
    .filter((n) => n.getBoundingClientRect().width > 0);
}
function storyTileNode(mapId) {
  return document.querySelector(`#board .map-tile[data-map-id="${mapId}"]`);
}

/** main.jsのrender()から毎回呼ばれる: 描き直された画面に、場面の演出(ダイスを隠す/光らせる等)を付け直し、
 * 場面の進行条件(ダイスが置かれた等)を確かめる。 */
function storyAfterRender(state) {
  const run = storyRun;
  if (!run) return;
  document.body.classList.toggle('story-hide-dice', !run.diceShown);
  if (run.glowDieValue !== null) {
    for (const node of storyHandDiceNodes()) {
      if (node.textContent.trim() === String(run.glowDieValue)) node.classList.add('change-highlight');
    }
  }
  if (run.onRender) run.onRender(state);
}

/** ダイスをその場で振る演出(回転しながら跳ねる、目がくるくる変わって決まった目で止まる)。 */
function storyRollHandDice(onDone) {
  storyRun.diceShown = true;
  document.body.classList.remove('story-hide-dice');
  const nodes = storyHandDiceNodes();
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

/* ---------- 場面1: 農園 (S001〜S006) ---------- */

const STORY_FARM_MAP_ID = 'MAP002'; // 農園

/** S001 エリアから始まる / クエスト・ショップなどに行けない / 農園以外のエリアは見えない
 *  S002, S003 そのまま自動で進む
 *  S004 ダイスが振られ1 6 3の目が出る → 6のダイスが光る。選択肢1「「農園」にダイスを置く」→ S006
 *  S005 何もしない場合5秒ごとに出てきてすぐ消える
 *  S006 ファンファーレの演出の後にセリフ */
function storySceneFarm() {
  const run = storyRun;
  run.visibleMapIds = [STORY_FARM_MAP_ID];
  storyUseState(storyBuildState([1, 6, 3]));
  storyApplyVisibleMaps();
  applyMobileActiveTab('board');
  render(STATE);
  let placed = false;
  let hintTimer = null;

  const armHint = () => {
    storyCancel(hintTimer);
    hintTimer = storyLater(() => {
      if (placed) return;
      storySay('S005', () => {
        hintTimer = storyLater(() => {
          if (placed) return;
          storyHideDialog();
          armHint();
        }, STORY_HINT_SHOW_MS);
      });
    }, STORY_HINT_IDLE_MS);
  };

  run.onRender = (state) => {
    if (placed) return;
    const onFarm = state.maps[STORY_FARM_MAP_ID].slots.some((occ) => occ.some((o) => o.playerId === 'P1'));
    if (!onFarm) return;
    placed = true;
    run.glowDieValue = null;
    storyCancel(hintTimer);
    run.onTap = null;
    storyShowGoal('');
    storyHideDialog();
    storyLater(() => storyFanfare(STORY_FARM_MAP_ID, () => storySayThen('S006', storyEndOfScript)), 350);
  };

  storySayThen('S001', () => storySayThen('S002', () => storySayThen('S003', () => {
    storySay('S004', (text) => {
      storyLater(() => storyRollHandDice(() => {
        run.glowDieValue = 6;
        render(STATE);
        const choice = (storyLine('S004').choices || [])[0];
        storyShowGoal(choice ? choice.label : '');
        run.onTap = armHint; // 何か触ったら「何もしない」5秒を数え直す
        armHint();
      }), Math.min(900, storyHoldMs(text)));
    });
  })));
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
  style.textContent = `body.story-mode #board .map-tile${not} > * { visibility: hidden; }
`
    + `body.story-mode #board .map-tile${not} { background: var(--surface-sunken) !important; border-color: var(--border) !important; box-shadow: none !important; }`;
}

/** 台本の終わり(続きはExcelが増えたら追加)。 */
function storyEndOfScript() {
  if (!storyRun) return;
  storyHideDialog();
  const end = el('div', 'story-end');
  end.appendChild(el('div', 'story-end__text', 'つづく'));
  const back = el('button', 'story-end__button', 'トップに戻る');
  back.type = 'button';
  back.addEventListener('click', closeStoryMode);
  end.appendChild(back);
  storyRun.dom.root.appendChild(end);
  end.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
}

/* ---------- 開く/閉じる ---------- */

function openStoryMode() {
  if (storyRun) return;
  const root = el('div', 'story-overlay');
  root.id = 'story-overlay';
  const alek = document.createElement('img');
  alek.className = 'story-alek';
  alek.src = 'assets/story-alek.png';
  alek.alt = 'アレク';
  const goal = el('div', 'story-goal');
  goal.hidden = true;
  const dialog = el('div', 'story-dialog');
  dialog.hidden = true;
  dialog.appendChild(el('div', 'story-dialog__name', 'アレク'));
  const dialogText = el('div', 'story-dialog__text');
  dialog.appendChild(dialogText);
  const close = el('button', 'story-close', '✖');
  close.type = 'button';
  close.setAttribute('aria-label', 'ストーリーをやめる');
  close.addEventListener('click', closeStoryMode);
  root.append(alek, dialog, goal, close);
  document.body.appendChild(root);
  storyRun = {
    timers: new Set(), typeTimer: null, diceShown: false, glowDieValue: null, onRender: null, onTap: null,
    visibleMapIds: [], dom: { root, goal, dialog, dialogText },
  };
  document.body.classList.add('story-mode', 'story-hide-dice');
  entryBannerDismissed = true;
  storySceneFarm();
}

function closeStoryMode() {
  if (!storyRun) return;
  storyRun.timers.forEach((t) => clearTimeout(t));
  storyRun = null;
  location.reload(); // 練習用の盤面を捨ててトップ画面へ
}

// ストーリー中はエリアのタイルを押しても拡大画面を開かない(スロットへの配置だけ)。何か触ったら場面に知らせる。
document.addEventListener('click', (e) => {
  if (!storyRun) return;
  if (storyRun.onTap) storyRun.onTap();
  if (e.target.closest('#board .map-tile') && !e.target.closest('.slot')) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

document.getElementById('entry-banner-story-button').addEventListener('click', openStoryMode);
