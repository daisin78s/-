/* BGM (2026-11-23, per user「BGM用意しました ストーリー や 対戦で 鳴らして 対戦は ラウンド 1-4 で ちがうBGMに」+ 回答):
 *  ・トップ画面(#entry-banner が出ている間) … title.mp3 (元: take-1)
 *  ・対戦 … ラウンドごとに round1〜4.mp3 (R1 街の賑わい / R2 交易や資源のやり取り / R3 政治的な駆け引き / R4 終盤向け)
 *  ・ストーリー … story.mp3 (皇帝の権威)。ただしストーリーの中の対戦(第4章の4人対戦、storyRun.normalGame)はラウンドの曲。
 *  ・設定の「BGM」ON/OFF (効果音とは別、最初はON、localStorage diceWpBgmOff)。
 * 曲は assets/bgm/*.mp3 を <audio> でそのまま鳴らす(file://でも読める。fetchは使わない)。くりかえし鳴らす。
 * 0.5秒ごとに今の場面を見て、曲が変わったら切り替える(main.js・story.jsには手を入れない)。
 * iPhone/iPadは画面を最初に触るまで音を出せないので、最初のタップ/クリック/キーで鳴らし始める。
 * アプリを隠した(別のアプリに切り替えた)間は止める。 */
window.Bgm = (function () {
  'use strict';

  const VOLUME = 0.45; // パソコン等。iPhone/iPadは音量を変えられない(本体の音量のまま)。
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = VOLUME;
  let current = null; // 今セットしている曲の名前
  let unlocked = false;

  function enabled() {
    try { return localStorage.getItem('diceWpBgmOff') !== '1'; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { if (on) localStorage.removeItem('diceWpBgmOff'); else localStorage.setItem('diceWpBgmOff', '1'); } catch (e) { /* ignore */ }
    update();
  }

  /** 今の場面で鳴らす曲の名前(鳴らさないならnull)。 */
  function wanted() {
    const banner = document.getElementById('entry-banner');
    const run = typeof storyRun !== 'undefined' ? storyRun : null;
    if (run && !run.normalGame) return 'story';
    if (banner && !banner.hidden) return 'title';
    const state = typeof STATE !== 'undefined' ? STATE : null;
    const round = state && typeof state.round === 'number' ? state.round : 1;
    return `round${Math.min(4, Math.max(1, round))}`;
  }

  function update() {
    const name = enabled() && !document.hidden ? wanted() : null;
    if (name !== current) {
      current = name;
      if (name) {
        audio.src = `assets/bgm/${name}.mp3`;
        audio.currentTime = 0;
      } else {
        audio.pause();
      }
    }
    if (current && unlocked && audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  // タップのたびに(止まっていれば)タップの中で play() を呼ぶ(iOSの決まり。最初の1回が失敗しても次のタップで鳴る)。
  function unlock() {
    unlocked = true;
    if (current && audio.paused) update();
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((type) => document.addEventListener(type, unlock, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', update);
  setInterval(update, 500);

  return { isEnabled: enabled, setEnabled, update };
})();
