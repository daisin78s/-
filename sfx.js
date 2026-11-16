/* 効果音 (2026-11-16, per user「ダイスが鳴る場面すべて入れてみて」) -- plain classic script、ブラウザだけ。
 * 音のデータは assets/sfx.data.js (window.SFX_DATA、tools/sfx_to_js.py が assets/sounds-raw/*.wav から作る)。
 * Web Audioで鳴らす(何個も重ねて鳴らせる、遅れが少ない)。iPadのSafariは、画面を最初に触るまで音を出せない決まり
 * なので、最初のタップ/クリック/キーで音の出口を開ける(それまでの音は鳴らない)。
 *   Sfx.play('dice-roll')                       … 1回
 *   Sfx.play('dice-roll', { count: 4, spread: 150 }) … 少しずつずらして重ねる(ダイスがたくさん転がる時) */
window.Sfx = (function () {
  'use strict';

  let ctx = null;
  const buffers = new Map(); // name -> AudioBuffer
  const decoding = new Map(); // name -> Promise

  function context() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }

  function dataUrlToArrayBuffer(url) {
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function load(name) {
    if (buffers.has(name)) return Promise.resolve(buffers.get(name));
    if (decoding.has(name)) return decoding.get(name);
    const c = context();
    const url = window.SFX_DATA && window.SFX_DATA[name];
    if (!c || !url) return Promise.resolve(null);
    const p = new Promise((resolve) => {
      // 古いSafariはPromise形でないdecodeAudioDataなので、コールバック形で呼ぶ。
      c.decodeAudioData(dataUrlToArrayBuffer(url), (buf) => { buffers.set(name, buf); resolve(buf); }, () => resolve(null));
    });
    decoding.set(name, p);
    return p;
  }

  function unlock() {
    const c = context();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    // 無音を1つ鳴らして出口を開ける(iOS)。
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
    if (window.SFX_DATA) Object.keys(window.SFX_DATA).forEach((name) => { load(name); });
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((type) => document.addEventListener(type, unlock, { capture: true, passive: true }));

  function enabled() {
    try { return localStorage.getItem('diceWpSfxOff') !== '1'; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { if (on) localStorage.removeItem('diceWpSfxOff'); else localStorage.setItem('diceWpSfxOff', '1'); } catch (e) { /* ignore */ }
  }

  function play(name, opts) {
    const c = ctx;
    if (!c || c.state !== 'running' || !enabled() || document.hidden) return;
    const count = Math.max(1, Math.min(6, (opts && opts.count) || 1));
    const spread = (opts && opts.spread) || 0;
    const gainValue = (opts && opts.gain) || (count > 1 ? 0.6 : 1);
    load(name).then((buf) => {
      if (!buf) return;
      for (let i = 0; i < count; i++) {
        const src = c.createBufferSource();
        src.buffer = buf;
        // 重ねる時は少しずつ高さも変えて、同じ音が重なった感じを減らす。
        if (count > 1) src.playbackRate.value = 0.92 + Math.random() * 0.16;
        const g = c.createGain();
        g.gain.value = gainValue;
        src.connect(g).connect(c.destination);
        const delay = count > 1 ? (i === 0 ? 0 : Math.random() * spread / 1000) : 0;
        src.start(c.currentTime + delay);
      }
    });
  }

  /* ---------- 盤面の変化から鳴らす (2026-11-16, per user「(場面ごとの案)おねがい」) ----------
   * render()のたびに、前の盤面と比べて:
   *  ・進捗の記録(main.jsのnoteProgressがSTATE.progressLogに足すもの): カードを獲得 → card-get、LVアップ → card-lvup、
   *    モニュメント(Mから始まるカード) → monument、カードを取らずにエリアへ行った → dice-place。
   *  ・だれかの資源が増えた → resource。
   *  ・ショップの山札が減った(補充された) → shop-restock。
   *  ・タップ済みのカードが増えた(TAP効果を使った) → card-tap。
   *  ・新しいゲームの1ラウンド目になった → game-start。
   * 1回のrender()で同じ音は1回まで。リプレイ中・巻き戻し・ゲームの読み込み(一度に記録がたくさん増えた時)は鳴らさない。 */
  let prev = null;
  function resourceTotals(state) {
    const out = {};
    for (const p of state.players || []) {
      let sum = 0;
      for (const [k, v] of Object.entries(p.resources || {})) if (k !== 'VP' && typeof v === 'number') sum += v;
      out[p.id] = sum;
    }
    return out;
  }
  function drawPileTotal(state) {
    let n = 0;
    for (const deck of Object.values(state.shops || {})) n += (deck && deck.drawPile ? deck.drawPile.length : 0);
    return n;
  }
  function onRender(state, opts) {
    if (!state || !Array.isArray(state.players)) return;
    const now = {
      seed: state.rng && state.rng.seed,
      round: state.round,
      log: (state.progressLog || []).length,
      res: resourceTotals(state),
      pile: drawPileTotal(state),
      tapped: Object.values(state.cards || {}).filter((c) => c && c.tapped).length,
    };
    const before = prev;
    prev = now;
    if (!before || (opts && opts.replay) || before.seed !== now.seed) return;
    if (now.log < before.log) return; // 巻き戻し
    if (now.round === 1 && before.round !== 1 && now.log <= 1) play('game-start');
    const fresh = (state.progressLog || []).slice(before.log);
    if (fresh.length > 8) return; // 途中から読み込んだ時などは鳴らさない
    const sounds = new Set();
    for (const e of fresh) {
      if (e.f) sounds.add(/^M/.test(e.f) ? 'monument' : (e.u ? 'card-lvup' : 'card-get'));
      else if (e.a) sounds.add('dice-place');
    }
    if (Object.keys(now.res).some((pid) => before.res[pid] !== undefined && now.res[pid] > before.res[pid])) sounds.add('resource');
    if (now.pile < before.pile && now.round === before.round) sounds.add('shop-restock');
    // カードのTAP効果を使った(タップ済みのカードが増えた) → card-tap (2026-11-16, per user「カードのTAP効果を使う」時も音を)。
    // TAPで資源が増えても、資源の音は重ねない。
    if (now.tapped > before.tapped && now.round === before.round) { sounds.add('card-tap'); sounds.delete('resource'); }
    // カードの音がある時は、置く音・資源の音は重ねない(にぎやかになりすぎるため)。
    if (sounds.has('card-get') || sounds.has('card-lvup') || sounds.has('monument')) { sounds.delete('dice-place'); sounds.delete('resource'); }
    for (const name of sounds) play(name);
  }

  return { play, onRender, isEnabled: enabled, setEnabled };
})();
