/**
 * 「AIルール相談」(ルールAI)機能のCloudflare Worker中継。唯一Gemini APIキーを扱う場所 --
 * ブラウザ側のコード(ai-rules-chat.js)はこのWorkerのURLにしか話しかけず、キーを一切見ない。
 *
 * やること(1リクエストあたり):
 *  1. CORSチェック(ALLOWED_ORIGIN以外からは拒否)
 *  2. 入力の検証(空/長すぎる質問を拒否)
 *  3. レート制限(IPごとに1分間隔・1日の上限、KVで管理)
 *  4. 月間予算チェック(全員合計のリクエスト数がMONTHLY_BUDGET_REQUESTSを超えたら固定の案内文で応答)
 *  5. data/ai-reference.json + data/dsl-command-spec.json をGitHub Pagesから取得(Cache APIで短時間キャッシュ)
 *  6. それらをシステム指示に埋め込み、Gemini APIを呼んで回答を生成
 *  7. 回答をそのままブラウザに返す
 *
 * 常に最新のゲームデータを参照する設計そのもの(カード能力をAIに固定で覚えさせない)がこの機能の核心要件
 * なので、参照データは都度フェッチする(Workerの中に静的コピーを持たない)。
 */

const CACHE_TTL_SECONDS = 300; // 参照データ/仕様書のキャッシュ有効期間(5分) -- xlsx編集直後の反映ラグはこの範囲
const MAX_QUESTION_LENGTH = 500;
const MAX_OUTPUT_TOKENS = 1024;
// 20秒→35秒に延長後も、Gemini側の混雑時に35秒を超えて失敗するケースを確認(2026-10-20)。Cloudflare
// Worker自体には待機時間の実質上限が無い(クライアントの接続が切れない限り待てる)ことを確認済みなので、
// さらに60秒に延長。フロントエンド側(ai-rules-chat.js)の最大3回再試行と合わせ、合計で最大3分程度は
// 粘れる計算になる。
const GEMINI_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT_HEADER = `あなたは「ローマの野望」というボードゲームのルールAI(ルール相談員)です。
以下に与えられた「DSL命令仕様書」と「カード参照データ」だけを根拠に、プレイヤーの質問に日本語で答えてください。

厳守事項:
- 根拠がない、または仕様書/参照データに載っていない内容は、絶対に推測で答えないでください。わからない場合は
  はっきり「現在のデータには載っていないので確認できません」のように答えてください。
- 参照データに載っているカード名・資源名・数値を優先し、記憶や一般的なボードゲームの知識で補完しないでください。
- ローマの野望に全く関係のない質問には「その質問はローマの野望のルールとは関係がないようです」と答え、それ以外には応じないでください。
- 回答は簡潔に、プレイヤーが読みやすい日本語でお願いします。`;

function corsHeaders(origin, allowedOrigin) {
  if (origin !== allowedOrigin) return null;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

async function fetchJsonCached(url) {
  const cache = caches.default;
  const cacheKey = new Request(url, { cf: { cacheTtl: CACHE_TTL_SECONDS } });
  let response = await cache.match(cacheKey);
  if (!response) {
    response = await fetch(url, { cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    response = new Response(response.body, response);
    response.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    await cache.put(cacheKey, response.clone());
  }
  return response.json();
}

/** KVベースの簡易レート制限。key例: "rl:minute:1.2.3.4:202610201530" のような時間窓キーを使い、TTLで
 * 自動的に消える(明示的な削除処理が不要)。 */
async function checkRateLimit(kv, ip, env) {
  const now = new Date();
  const minuteKey = `rl:minute:${ip}:${Math.floor(now.getTime() / 60000)}`;
  const dayKey = `rl:day:${ip}:${now.toISOString().slice(0, 10)}`;

  const [minuteCountRaw, dayCountRaw] = await Promise.all([kv.get(minuteKey), kv.get(dayKey)]);
  const minuteCount = Number(minuteCountRaw || 0);
  const dayCount = Number(dayCountRaw || 0);

  if (minuteCount >= Number(env.MINUTE_LIMIT_PER_IP)) return { ok: false, reason: 'MINUTE_LIMIT' };
  if (dayCount >= Number(env.DAILY_LIMIT_PER_IP)) return { ok: false, reason: 'DAILY_LIMIT' };

  await Promise.all([
    kv.put(minuteKey, String(minuteCount + 1), { expirationTtl: 90 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 60 * 60 * 24 * 2 }),
  ]);
  return { ok: true };
}

/** 月間の総リクエスト数(全員合計)。予算到達時は自動で固定の案内文に切り替える -- Gemini自体の無料枠や
 * 料金表は変わりうるため、確実に守れる自衛策としてこちら側で上限をかける。 */
async function checkMonthlyBudget(kv, env) {
  const now = new Date();
  const monthKey = `rl:month:total:${now.toISOString().slice(0, 7)}`;
  const countRaw = await kv.get(monthKey);
  const count = Number(countRaw || 0);
  if (count >= Number(env.MONTHLY_BUDGET_REQUESTS)) return { ok: false };
  await kv.put(monthKey, String(count + 1), { expirationTtl: 60 * 60 * 24 * 35 });
  return { ok: true };
}

// AREA系カードの"XXXの支配LV1"/"XXXLV2"のような接尾辞を外した「素の名前」を返す -- 質問文には
// 「小麦畑」とだけ書かれ、「小麦畑の支配LV1」とは書かれないのが普通なので、この正規化をしないと
// 一致しない。末尾パターンのどれにも当てはまらなければそのまま返す。
const NAME_SUFFIX_PATTERNS = [/の支配LV[12]$/, /LV[12]$/];
function baseCardName(name) {
  for (const pattern of NAME_SUFFIX_PATTERNS) {
    if (pattern.test(name)) return name.replace(pattern, '');
  }
  return name;
}

/** 質問文に名前が直接出てくるカードだけに絞り込む(2026-10-20、プロンプトを軽量化してGemini混雑時の
 * タイムアウトを減らすため -- per user request)。「常に最新データを参照する」という大前提(カード能力を
 * AIに固定で覚えさせない)はそのまま保ち、1回のリクエストで送るデータ量だけを減らす。
 *
 * 単純な部分文字列一致(質問文.includes(カード名)) -- 誤マッチ(例えば説明文の一部が別のカード名と
 * たまたま一致する)はほぼ起きない想定(カード名はどれも固有の単語のため)。LV1/LV2の接尾辞を外した
 * 「素の名前」でも照合するので、「小麦畑」とだけ聞かれても該当するLV1/LV2両方のカードがヒットする。
 *
 * 1件もヒットしない場合(カード名を含まない、幅広い/一般的な質問)は、安全側に倒してフィルタせず全カード
 * をそのまま返す -- 「VPを得る方法を全部教えて」のような、特定カード名を挙げない横断的な質問で情報が
 * 欠けるのを防ぐため。 */
function filterRelevantCards(referenceData, question) {
  const matched = {};
  for (const [id, card] of Object.entries(referenceData.cards)) {
    if (!card.name) continue;
    if (question.includes(card.name) || question.includes(baseCardName(card.name))) {
      matched[id] = card;
    }
  }
  const matchedCount = Object.keys(matched).length;
  return {
    cards: matchedCount > 0 ? matched : referenceData.cards,
    filtered: matchedCount > 0,
    matchedCount,
    totalCount: Object.keys(referenceData.cards).length,
  };
}

async function callGemini(env, question, referenceData, commandSpec) {
  const systemInstruction = `${SYSTEM_PROMPT_HEADER}

### DSL命令仕様書
${JSON.stringify(commandSpec)}

### カード参照データ
${JSON.stringify(referenceData)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) throw new Error('Gemini API returned no text');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (!cors) {
      return new Response(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' }), { status: 403 });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: cors });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400, headers: cors });
    }

    const question = typeof payload?.question === 'string' ? payload.question.trim() : '';
    if (!question) {
      return new Response(JSON.stringify({ error: 'EMPTY_QUESTION' }), { status: 400, headers: cors });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return new Response(JSON.stringify({ error: 'QUESTION_TOO_LONG', max: MAX_QUESTION_LENGTH }), { status: 400, headers: cors });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, ip, env);
    if (!rateLimit.ok) {
      return new Response(JSON.stringify({ error: rateLimit.reason }), { status: 429, headers: cors });
    }

    const budget = await checkMonthlyBudget(env.RATE_LIMIT_KV, env);
    if (!budget.ok) {
      return new Response(
        JSON.stringify({ answer: '申し訳ありません、今月のAIルール相談の利用回数上限に達したため、現在は利用できません。来月またお試しください。' }),
        { status: 200, headers: cors }
      );
    }

    try {
      const [referenceData, commandSpec] = await Promise.all([
        fetchJsonCached(env.REFERENCE_DATA_URL),
        fetchJsonCached(env.COMMAND_SPEC_URL),
      ]);
      // issuesはビルドスクリプト向けの開発用メタ情報(プレイヤーの質問には無関係)なので、
      // プロンプトには最初から含めない。cardsだけ質問内容で絞り込む(filterRelevantCardsの doc 参照)。
      const { cards } = filterRelevantCards(referenceData, question);
      const trimmedReferenceData = {
        gameDataVersion: referenceData.gameDataVersion,
        cardCount: Object.keys(cards).length,
        cards,
      };
      const answer = await callGemini(env, question, trimmedReferenceData, commandSpec);
      return new Response(JSON.stringify({ answer }), { status: 200, headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'INTERNAL_ERROR', detail: String(err.message || err) }), { status: 502, headers: cors });
    }
  },
};
