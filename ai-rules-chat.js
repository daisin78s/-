/** 「AIルール相談」(ルールAI)チャット機能のフロントエンド (2026-10-20)。main.jsとは完全に独立 --
 * GameState/DSL/ゲーム本体のロジックには一切触れず、純粋にチャットUIの表示とCloudflare Workerへの
 * 質問送信だけを担当する。Plain classic <script>, same convention as ranking.js -- browser-only, not
 * run under Node tests.
 *
 * 唯一の依存先はWORKER_URL(Cloudflare Workerの中継URL)。Gemini APIキーはこのファイルにも
 * どこにも書かれない -- Worker側(workers/ai-rules-relay/)がSecretsとして保持する。
 *
 * WORKER_URLはworkers/ai-rules-relay/README.mdの手順でデプロイした後、実際のURLに書き換えること。
 * 空のままだと、チャットは「まだ準備中です」という案内だけ表示する(エラーにはしない)。
 */
window.AiRulesChat = (function () {
  'use strict';

  const WORKER_URL = 'https://ai-rules-relay.aged-hat-0d63.workers.dev';

  // Gemini APIの混雑状況を示す公式なリアルタイムAPIは存在しない(2026-10-20、調査済み)。非公式だが、
  // 太平洋時間(アメリカ西海岸、Geminiの運用拠点)の9-11時/13-15時/18-22時が混雑のピーク、2-7時が比較的
  // 空いている、という複数の利用者報告がある(per user request: "公表されている混雑状況から推測して")。
  // 断定はできないため、あくまで「可能性」としての案内に留める。Intl.DateTimeFormatでタイムゾーン変換
  // すれば、夏時間(PDT/PST)の切り替えも自動で正しく扱える(自前でオフセット計算するより確実)。
  function currentPacificHour() {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' });
    return Number(formatter.format(new Date()));
  }

  const HIGH_CONGESTION_HOURS = new Set([9, 10, 13, 14, 18, 19, 20, 21]);
  const LOW_CONGESTION_HOURS = new Set([2, 3, 4, 5, 6]);

  function congestionNoticeText() {
    const hour = currentPacificHour();
    if (HIGH_CONGESTION_HOURS.has(hour)) {
      return 'この時間帯はAIの利用状況が高いため、大変混雑している可能性があります。質問の返答に時間がかかる場合があります。';
    }
    if (LOW_CONGESTION_HOURS.has(hour)) {
      return 'この時間帯は比較的空いている可能性が高く、スムーズに回答できると思われます。';
    }
    return 'この時間帯の混雑状況ははっきりしませんが、通常程度と思われます。';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendMessage(logEl, role, text) {
    const row = el('div', `ai-rules-chat-message ai-rules-chat-message--${role}`);
    row.appendChild(el('div', 'ai-rules-chat-message__bubble', text));
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
    return row;
  }

  async function sendQuestionOnce(question) {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error || `HTTP ${res.status}`;
      const err = new Error(reason);
      err.status = res.status;
      throw err;
    }
    return data.answer || '(回答が空でした)';
  }

  // Gemini側の一時的な混雑(503/タイムアウト)でWorkerが502を返すことがある(2026-10-20、実際のユーザー
  // 報告で確認済み、1回だけの再試行では不十分なケースも確認されたため最大2回(計3回試行)に強化)。
  // レート制限(429)やそもそもアクセスが許可されていない(403)等、再試行しても解決しないエラーは即座に
  //投げる。err.statusが無い(fetch自体が失敗した、ネットワーク瞬断など)場合も再試行対象に含める --
  // Cloudflare Worker自体には待機時間の実質上限が無いことを確認済み(2026-10-20)なので、再試行を増やす
  // こと自体に新たなコストは無い。
  const MAX_ATTEMPTS = 3;
  function isRetryableStatus(status) {
    return status === undefined || status === 502;
  }
  async function sendQuestion(question, onRetry) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await sendQuestionOnce(question);
      } catch (err) {
        lastErr = err;
        if (!isRetryableStatus(err.status) || attempt === MAX_ATTEMPTS) throw err;
        if (onRetry) onRetry(attempt + 1, MAX_ATTEMPTS);
      }
    }
    throw lastErr;
  }

  function errorMessageFor(err) {
    const reason = String(err && err.message || err);
    if (reason === 'MINUTE_LIMIT') return '少し間隔を空けてから、もう一度質問してください。';
    if (reason === 'DAILY_LIMIT') return '本日の質問回数の上限に達しました。また明日お試しください。';
    return 'うまく回答できませんでした。しばらくしてからもう一度お試しください。';
  }

  function init() {
    const openButton = document.getElementById('ai-rules-chat-open-button');
    const closeButton = document.getElementById('ai-rules-chat-close-button');
    const overlay = document.getElementById('ai-rules-chat-overlay');
    const form = document.getElementById('ai-rules-chat-form');
    const input = document.getElementById('ai-rules-chat-input');
    const sendButton = document.getElementById('ai-rules-chat-send-button');
    const logEl = document.getElementById('ai-rules-chat-log');
    if (!openButton || !overlay || !form || !input || !logEl) return; // このページにチャットUIが無い場合は何もしない

    let greeted = false;

    openButton.addEventListener('click', () => {
      overlay.hidden = false;
      if (!greeted) {
        greeted = true;
        appendMessage(logEl, 'assistant', 'こんにちは。ローマの野望のルールやカードについて質問してください。');
        const notice = congestionNoticeText();
        if (notice) appendMessage(logEl, 'assistant', notice);
      }
      input.focus();
    });
    closeButton.addEventListener('click', () => {
      overlay.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;

      if (!WORKER_URL) {
        appendMessage(logEl, 'user', question);
        appendMessage(logEl, 'assistant', 'この機能は現在準備中です。');
        input.value = '';
        return;
      }

      appendMessage(logEl, 'user', question);
      input.value = '';
      input.disabled = true;
      sendButton.disabled = true;
      const pendingRow = appendMessage(logEl, 'assistant', '考え中...(混雑時は30秒ほどかかることがあります)');
      const pendingBubble = pendingRow.querySelector('.ai-rules-chat-message__bubble');

      try {
        const answer = await sendQuestion(question, (attempt, max) => {
          pendingBubble.textContent = `考え中...(少し時間がかかっています、再試行中 ${attempt}/${max})`;
        });
        pendingBubble.textContent = answer;
      } catch (err) {
        pendingBubble.textContent = errorMessageFor(err);
      } finally {
        input.disabled = false;
        sendButton.disabled = false;
        input.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init };
})();
