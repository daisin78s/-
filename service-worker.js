/** PWA用Service Worker (2026-10-22, per user request: "PWA対応させて 全画面表示にしたい"
 * -> "オフラインプレイ可能に") -- 「ネットワーク優先、オフライン時だけキャッシュにフォールバック」戦略。
 *
 * このプロジェクトは以前iPad Safariが古いJS/CSSをキャッシュし続けた不具合と戦った経緯があり(index.html
 * の#copyright-notice own doc参照、?v=X.XXXクエリ文字列での強制更新がその対策)、Service Workerの
 * キャッシュ戦略を誤ると同じ問題をより根深い形で再発させかねない。そのため「キャッシュ優先」は使わず、
 * 電波がある限り常に最新のファイルをネットから取りに行き、キャッシュは取得に失敗した時(=オフライン)
 * だけのフォールバックとして使う。
 *
 * CACHE_NAMEをindex.htmlの?v=X.XXXと同じバージョン番号に連動させているので、バージョンを上げて
 * デプロイするたびにactivateハンドラが古いキャッシュを自動削除する -- 既存の手動バージョン更新運用と
 * 矛盾なく共存する。
 *
 * src/*.js・data/*.js・assets/*などの大半は明示的なプリキャッシュ一覧を持たない(対象ファイル数が多く、
 * 新規ファイル追加のたびにこの一覧も更新しないと漏れる、というメンテナンス負債を避けるため) -- 代わりに
 * 実際にfetchされ成功したファイルをその場でキャッシュへ書き込んでいく「ランタイムキャッシュ」方式。
 * 初回はオンラインでプレイした時点で使われたファイルが自然に蓄積され、以降はオフラインでもそれらが
 * 使える(1回もオンラインで開いたことがないファイル/未訪問の画面はオフラインでは使えない、という制約は
 * 残るが、通常プレイで触れる範囲は数回のオンライン起動で揃う)。
 *
 * install時にindex.html自体を明示的にプリキャッシュした上で、その中の全<script src>/<link href>を
 * 自分で読み取ってまとめてプリキャッシュする(手書きのファイル一覧は持たない -- index.html自身が
 * 唯一の正(常に最新)なので、新しいsrc/*.jsファイルが追加されてもservice-worker.js側の更新は不要)。
 * これが必要な理由: 新しく登録されたService Workerは「登録した瞬間のページ自身」を一切制御できない
 * (次のナビゲーションから初めて効く、という仕様上の制約)ため、初回ページ読み込みで発生する
 * <script src>/<link>群のfetchはどれ一つとしてこちらのfetchハンドラを経由しない -- ランタイム
 * キャッシュ任せだと「一度もオンラインでreloadせずオフラインになった」場合、index.html以外
 * (main.js/data/game.data.js等)が1つもキャッシュされておらずオフライン起動できない、という事態に
 * なることを実機/自動テストで確認した。 */
const CACHE_NAME = 'dice-wp-v1.263';
const APP_SHELL = ['./', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL).catch(() => {});
      try {
        const htmlRes = await fetch('./index.html');
        const htmlResForCache = htmlRes.clone();
        const html = await htmlRes.text();
        await cache.put('./index.html', htmlResForCache);
        const urls = new Set();
        const attrRe = /\s(?:src|href)="([^"]+)"/g;
        let m;
        while ((m = attrRe.exec(html))) {
          const url = m[1];
          if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
          if (!/\.(js|css)(\?|$)/.test(url)) continue;
          urls.add(url);
        }
        await Promise.all([...urls].map((url) => cache.add(url).catch(() => {})));
      } catch (e) { /* file://等、fetch自体ができない環境では何もしない -- 通常のページ表示には影響しない */ }
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});
