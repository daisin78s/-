/* ストーリーモード (2026-10-23, per user request: "ストーリーモードを実装したい ... スマホだとチュートリアルが
 * ほぼできない そのためスマホに特化したストーリーモードを作る PCやタブレットは後で対応させる" + 回答:
 * 入口の「デザイナーズノート」ボタンを「ストーリー」に、セリフはストーリー専用の表示(アレクの絵+名前付きの
 * 会話ウインドウ)、全体の形は「小さな場面の連続」、ファンファーレは見た目だけ、"セリフは基本的にボタンを
 * 押さずに自動で進む")。
 *
 * セリフ本文は data/story.data.js (window.STORY_SCRIPT、tools/story_xlsx_to_js.py が デスクトップの
 * ストーリー.xlsx から生成) を S001 などの行IDで引く。Excelの光る/動く/メモ列の指示はこのファイルの
 * 場面ごとの台本(STORY_SCENES)にコードとして書く。
 *
 * 本物のGameStateには一切触れない: 場面ごとに必要な分(エリア1枚、手元のダイスなど)だけを、ゲームと同じ
 * 部品(tpl-map-tile / renderDie / dieFace / buildActionIcons、main.jsのグローバル)で描く、独立した全画面
 * オーバーレイ。トップ画面(入口バナー)の上に開き、✖で閉じればトップ画面に戻る。main.jsの後に読み込む。 */

const STORY_TYPE_MS_PER_CHAR = 55; // 1文字ずつ出る速さ
const STORY_HOLD_BASE_MS = 1400; // 全文出てから次へ進むまでの待ち(+文字数ぶん)
const STORY_HOLD_PER_CHAR_MS = 45;
const STORY_HINT_IDLE_MS = 5000; // S005: 何もしない場合5秒ごとに出る
const STORY_HINT_SHOW_MS = 2600; // 出てすぐ消える(全文が出てからこの時間で消える)

let storyRun = null; // 実行中の場面 { timers:Set, ... }。nullなら閉じている。

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

/* ---------- 場面の部品 ---------- */

/** ゲームと同じ見た目のエリアタイル(スロットは空)。 */
function storyBuildAreaTile(areaId) {
  const areaRow = dataLoaderMod.getAreaRow(INDEX, areaId);
  const node = document.getElementById('tpl-map-tile').content.firstElementChild.cloneNode(true);
  node.classList.add('story-area');
  node.querySelector('.map-tile__id').textContent = areaRow.NAME;
  const slotsEl = node.querySelector('.map-tile__slots');
  const slots = boardMod.getSlotRequirements(areaRow);
  const slotEls = slots.map((requirement, i) => {
    const slotEl = el('div', 'slot');
    slotEl.dataset.slotIndex = String(i);
    slotEl.dataset.requirement = String(requirement);
    if (typeof requirement === 'number') slotEl.appendChild(dieFace(requirement));
    else slotEl.textContent = requirement;
    slotsEl.appendChild(slotEl);
    return slotEl;
  });
  const actionEl = node.querySelector('.map-tile__action');
  const icons = buildActionIcons(areaRow.ACTION);
  if (icons) actionEl.appendChild(icons);
  else actionEl.textContent = areaRow.ACTION;
  return { node, slotEls, slots, areaRow };
}

const STORY_DIE_COLOR = 'PINK';

/** 手元のダイス置き場に、ダイスをその場で振る演出(回転しながら跳ねる)。終わったらonDone(dieNodes)。 */
function storyRollDice(values, onDone) {
  const run = storyRun;
  const panel = run.dom.dice;
  panel.innerHTML = '';
  panel.hidden = false;
  const nodes = values.map((v) => {
    const node = renderDie({ kind: 'COLOR', value: v, color: STORY_DIE_COLOR });
    node.classList.add('story-die');
    node.dataset.value = String(v);
    panel.appendChild(node);
    return node;
  });
  const ROLL_MS = 900;
  nodes.forEach((node, i) => {
    const valueEl = node.querySelector('.die__value');
    const finalValue = values[i];
    const spin = (i % 2 ? -1 : 1) * 720;
    node.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: `translateY(-26px) rotate(${spin * 0.35}deg)`, offset: 0.25 },
      { transform: `translateY(0) rotate(${spin * 0.6}deg)`, offset: 0.5 },
      { transform: `translateY(-10px) rotate(${spin * 0.85}deg)`, offset: 0.72 },
      { transform: `translateY(0) rotate(${spin}deg)` },
    ], { duration: ROLL_MS + i * 120, easing: 'ease-out' });
    // 振っている間は目がくるくる変わり、止まったら決まった目に。
    const flicker = () => { valueEl.textContent = String(1 + Math.floor(Math.random() * 6)); };
    for (let t = 0; t < ROLL_MS + i * 120 - 90; t += 90) storyLater(flicker, t);
    storyLater(() => { valueEl.textContent = String(finalValue); }, ROLL_MS + i * 120);
  });
  storyLater(() => onDone(nodes), ROLL_MS + (values.length - 1) * 120 + 150);
}

/** ダイスを手元からスロットへ素早く飛ばす。 */
function storyFlyDieToSlot(dieNode, slotEl, onDone) {
  const a = dieNode.getBoundingClientRect();
  const b = slotEl.getBoundingClientRect();
  const clone = dieNode.cloneNode(true);
  clone.classList.remove('change-highlight', 'die--selected', 'story-die--selected');
  clone.classList.add('story-die-flyer');
  Object.assign(clone.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  storyRun.dom.root.appendChild(clone);
  dieNode.style.visibility = 'hidden';
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = clone.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${dx}px, ${dy}px)` }],
    { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
  anim.onfinish = () => {
    clone.remove();
    dieNode.remove();
    slotEl.innerHTML = '';
    slotEl.classList.add('slot--filled');
    const stack = el('div', 'slot__stack');
    stack.appendChild(renderDie({ kind: 'COLOR', value: Number(dieNode.dataset.value), color: STORY_DIE_COLOR }));
    slotEl.appendChild(stack);
    onDone();
  };
}

/** ファンファーレ(見た目だけ): エリアが光り、もらえる物(アクションのアイコン)がエリアから飛び出し、紙吹雪。 */
function storyFanfare(tile, onDone) {
  const run = storyRun;
  tile.node.classList.add('story-area--success');
  const rect = tile.node.getBoundingClientRect();
  const icons = buildActionIcons(tile.areaRow.ACTION);
  const reward = el('div', 'story-reward');
  if (icons) reward.appendChild(icons);
  else reward.textContent = tile.areaRow.ACTION;
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
  storyLater(() => { reward.remove(); onDone(); }, 2000);
}

/* ---------- 場面1: 農園 (S001〜S006) ---------- */

/** S001 エリアから始まる / クエスト・ショップなどに行けない / 農園以外のエリアは見えない
 *  S002, S003 そのまま自動で進む
 *  S004 ダイスが振られ1 6 3の目が出る → 6のダイスが光る。選択肢1「「農園」にダイスを置く」→ S006
 *  S005 何もしない場合5秒ごとに出てきてすぐ消える
 *  S006 ファンファーレの演出の後にセリフ */
function storySceneFarm() {
  const run = storyRun;
  const tile = storyBuildAreaTile('AREA002A');
  run.dom.stage.appendChild(tile.node);
  let selectedDie = null;
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

  const refreshSlots = () => {
    tile.slotEls.forEach((slotEl, i) => {
      const ok = !!selectedDie && !slotEl.classList.contains('slot--filled')
        && tile.slots[i] === Number(selectedDie.dataset.value);
      slotEl.classList.toggle('slot--highlight', ok);
      slotEl.classList.toggle('slot--selectable', !!selectedDie);
    });
  };

  const onPlaced = () => {
    storyShowGoal('');
    storyHideDialog();
    storyFanfare(tile, () => {
      storySayThen('S006', storyEndOfScript);
    });
  };

  const enableDice = (nodes) => {
    const six = nodes.find((n) => n.dataset.value === '6');
    if (six) six.classList.add('change-highlight');
    storyShowGoal((storyLine('S004').choices || [])[0] ? storyLine('S004').choices[0].label : '');
    armHint();
    nodes.forEach((node) => {
      node.classList.add('story-die--tappable');
      node.addEventListener('click', () => {
        if (placed) return;
        selectedDie = selectedDie === node ? null : node;
        nodes.forEach((n) => n.classList.toggle('story-die--selected', n === selectedDie));
        refreshSlots();
        armHint();
      });
    });
    tile.slotEls.forEach((slotEl, i) => {
      slotEl.addEventListener('click', () => {
        if (placed || !selectedDie || slotEl.classList.contains('slot--filled')) return;
        if (tile.slots[i] !== Number(selectedDie.dataset.value)) return; // 目が合わないスロットには置けない
        placed = true;
        storyCancel(hintTimer);
        tile.slotEls.forEach((s) => s.classList.remove('slot--highlight', 'slot--selectable'));
        storyFlyDieToSlot(selectedDie, slotEl, onPlaced);
      });
    });
  };

  storySayThen('S001', () => storySayThen('S002', () => storySayThen('S003', () => {
    storySay('S004', (text) => {
      storyLater(() => storyRollDice([1, 6, 3], enableDice), Math.min(900, storyHoldMs(text)));
    });
  })));
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
  const stage = el('div', 'story-stage');
  const dice = el('div', 'story-dice');
  dice.hidden = true;
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
  root.append(stage, dice, alek, dialog, goal, close);
  document.body.appendChild(root);
  storyRun = { timers: new Set(), typeTimer: null, dom: { root, stage, dice, goal, dialog, dialogText } };
  storySceneFarm();
}

function closeStoryMode() {
  if (!storyRun) return;
  storyRun.timers.forEach((t) => clearTimeout(t));
  storyRun.dom.root.remove();
  document.querySelectorAll('.confetti-layer').forEach((n) => n.remove());
  storyRun = null;
}

document.getElementById('entry-banner-story-button').addEventListener('click', openStoryMode);
