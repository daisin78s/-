/* バグ報告の掲示板 (2026-10-27, per user request: "バグで進行不能になったときのために途中でもリプレイをとる仕組みと
 * バグ報告用の掲示板(リプレイを保存できてバグの内容も書き込める)が欲しい" + 回答「誰でも見られる」) --
 * 設定タブ(PCは下のボタン列)の「バグ報告」から開く。
 * ・上の欄にバグの内容を書いて「送信」すると、その時点までのゲームの進行(リプレイ、main.jsのreplayHistory)も
 *   一緒に保存される。ゲームの途中でも送れる。
 * ・下に、これまでの報告(手で書いた報告と、AIの自動進行が異常を見つけた時の自動の報告)が新しい順に並び、
 *   誰でも読める。リプレイ付きの報告は「▶ リプレイ」で、いつものリプレイ画面で1手ずつ見られる。
 * 保存先は自動の報告と同じ(online-sync.jsのbugReportsコレクション + StorageのbugReplays/)。手で書いた報告は
 * kind:'manual'。main.jsのグローバル(replayHistory/enterReplayMode/appVersionLabel/STATE/el)を使うので
 * main.jsの後に読み込む。 */
(function () {
  'use strict';

  const MAX_TEXT = 1000;

  function overlay() { return document.getElementById('bug-board-overlay'); }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function currentModeLabel() {
    if (typeof storyRun !== 'undefined' && storyRun) return 'ストーリー';
    if (onlineRoomCode) return 'オンライン対戦';
    if (weeklyChallengeActive) return 'ウィークリーチャレンジ';
    if (tutorialModeActive) return 'チュートリアル';
    return 'ローカル対戦';
  }

  // 自動の報告の理由(main.jsのdriveOneAiStepInnerの検知箇所)を読める言葉に。
  const AUTO_REASON_LABELS = {
    AI_MOVE_APPLY_FAILED: 'AIが不正な手を選んだ',
    AI_TURN_MOVE_COUNT_EXCEEDED: 'AIのターン内の手数が異常に多い',
    AI_ONBOARDING_REENTRY_EXCEEDED: 'AIのジョブ/制約選択が終わらない',
  };

  function renderList(listEl) {
    listEl.innerHTML = '';
    listEl.appendChild(el('div', 'bug-board__empty', '読み込み中...'));
    OnlineSync.listBugReports().then((reports) => {
      listEl.innerHTML = '';
      if (reports.length === 0) {
        listEl.appendChild(el('div', 'bug-board__empty', 'まだ報告はありません'));
        return;
      }
      for (const report of reports) {
        const row = el('div', 'bug-board__row');
        const head = el('div', 'bug-board__row-head');
        head.appendChild(el('span', 'bug-board__date', formatDate(report.detectedAt)));
        const kind = report.kind === 'manual' ? '報告' : '自動検知';
        head.appendChild(el('span', `bug-board__kind bug-board__kind--${report.kind === 'manual' ? 'manual' : 'auto'}`, kind));
        const meta = [report.appVersion, report.mode, report.round !== undefined && report.round !== null ? `${report.round}R` : null].filter(Boolean).join(' / ');
        if (meta) head.appendChild(el('span', 'bug-board__meta', meta));
        row.appendChild(head);
        const text = report.kind === 'manual'
          ? report.text
          : `${AUTO_REASON_LABELS[report.reason] || report.reason || '不明'}${report.playerId ? `（${report.playerId}）` : ''}`;
        row.appendChild(el('div', 'bug-board__text', text || ''));
        if (report.hasReplay !== false) {
          const play = el('button', 'undo-button bug-board__replay', '▶ リプレイ');
          play.type = 'button';
          play.addEventListener('click', () => {
            play.disabled = true;
            play.textContent = '読み込み中...';
            OnlineSync.loadBugReplay(report.id).then((history) => {
              if (history && history.length) {
                overlay().hidden = true;
                enterReplayMode(history);
              } else {
                play.textContent = 'リプレイがありません';
              }
            });
          });
          row.appendChild(play);
        }
        listEl.appendChild(row);
      }
    }).catch(() => {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'bug-board__empty', '読み込みに失敗しました'));
    });
  }

  function submit(textarea, sendButton, statusEl, listEl) {
    const text = textarea.value.trim().slice(0, MAX_TEXT);
    if (!text) { statusEl.textContent = 'バグの内容を書いてください'; return; }
    const id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const hasReplay = Array.isArray(replayHistory) && replayHistory.length > 0;
    const report = {
      kind: 'manual',
      text,
      detectedAt: new Date().toISOString(),
      appVersion: appVersionLabel(),
      mode: currentModeLabel(),
      round: STATE && typeof STATE.round === 'number' ? STATE.round : null,
      phase: STATE ? STATE.phase || null : null,
      hasReplay,
    };
    sendButton.disabled = true;
    statusEl.textContent = '送信中...';
    const saves = [OnlineSync.saveBugReport(id, report)];
    if (hasReplay) saves.push(OnlineSync.saveBugReplay(id, replayHistory));
    Promise.all(saves).then(() => {
      textarea.value = '';
      statusEl.textContent = hasReplay ? '送信しました（リプレイも保存しました）' : '送信しました';
      renderList(listEl);
    }).catch(() => {
      statusEl.textContent = '送信に失敗しました。通信状態を確かめて、もう一度お試しください';
    }).finally(() => {
      sendButton.disabled = false;
    });
  }

  function open() {
    const ov = overlay();
    ov.hidden = false;
    const body = document.getElementById('bug-board-body');
    body.innerHTML = '';
    const form = el('div', 'bug-board__form');
    const hasReplay = Array.isArray(replayHistory) && replayHistory.length > 0;
    form.appendChild(el('div', 'bug-board__note', hasReplay
      ? 'どんなバグが起きたか書いてください。今のゲームのここまでの進行(リプレイ)も一緒に送られます。'
      : 'どんなバグが起きたか書いてください。'));
    const textarea = document.createElement('textarea');
    textarea.className = 'bug-board__input';
    textarea.maxLength = MAX_TEXT;
    textarea.rows = 3;
    textarea.placeholder = '例: 3ラウンド目に皇帝宮殿にダイスを置いたら進まなくなった';
    form.appendChild(textarea);
    const actions = el('div', 'bug-board__actions');
    const sendButton = el('button', 'undo-button', '送信');
    sendButton.type = 'button';
    const statusEl = el('span', 'bug-board__status', '');
    actions.append(sendButton, statusEl);
    form.appendChild(actions);
    body.appendChild(form);
    body.appendChild(el('div', 'bug-board__list-title', 'これまでの報告'));
    const listEl = el('div', 'bug-board__list');
    body.appendChild(listEl);
    sendButton.addEventListener('click', () => submit(textarea, sendButton, statusEl, listEl));
    renderList(listEl);
  }

  function init() {
    const button = document.getElementById('bug-board-open-button');
    if (!button || !overlay()) return;
    button.addEventListener('click', open);
    document.getElementById('bug-board-close-button').addEventListener('click', () => { overlay().hidden = true; });
    overlay().addEventListener('click', (e) => { if (e.target === overlay()) overlay().hidden = true; });
  }

  init();
  window.BugBoard = { open };
})();
