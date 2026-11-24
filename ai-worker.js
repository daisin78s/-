// AIを裏で考えるためのWeb Worker (2026-11-24, per user「4もおねがい」 -- 考えている間も画面が固まらないように)。
// main.jsのstartAiWorkerが起動し、index.htmlと同じ順のsrc/*.jsとdata/game.data.jsを読み込んで(index.htmlと同じ
// require/module.exportsの小さな仕組み)、main.jsと同じ設定(AI_LEVEL_CONFIG)のAIを作る。
// メッセージ: {type:'init', scripts, config} / {type:'weekly', table} / {type:'select', id, level, state, playerId, options}
//   -> {id, move, plannedUntap} または {id, error}。読み込みに失敗した時は {type:'fatal', error}(main.jsは画面の中で考える方に戻る)。
/* eslint-disable no-restricted-globals */
self.window = self;
self.__modules = {};
self.module = { exports: {} };
self.require = function (name) {
  const key = name.replace(/^(\.\.\/|\.\/)+/, '').replace(/\.js$/, '');
  if (key === 'fs') throw new Error('fs is not available in the browser build');
  if (!(key in self.__modules)) throw new Error('Module not loaded yet: ' + key);
  return self.__modules[key];
};

let ai = null; // {lv1, lv2, lv3, lv3weekly}
let shared = null; // {index, moveGenerator, moveGeneratorLv3, simulator, config}

function moduleNameOf(url) {
  const path = url.split('?')[0];
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.js$/, '');
}

function init(msg) {
  for (const url of msg.scripts) {
    self.module = { exports: {} };
    importScripts(url);
    if (url.split('?')[0].includes('/src/')) self.__modules[moduleNameOf(url)] = self.module.exports;
  }
  self.module = { exports: {} };
  const dataLoader = self.__modules['data-loader'];
  const evalTableMod = self.__modules['eval-table'];
  const { Evaluator } = self.__modules.evaluator;
  const { MoveGenerator } = self.__modules['move-generator'];
  const { Simulator } = self.__modules.simulator;
  const { AIPlayer } = self.__modules['ai-player'];
  const index = dataLoader.buildDataIndex(dataLoader.loadGameData(self.GAME_DATA));
  const config = msg.config;
  const evaluator = new Evaluator(index, evalTableMod.buildEvalTable(index.raw), config.evaluatorOptions);
  const moveGenerator = new MoveGenerator();
  const moveGeneratorLv3 = new MoveGenerator(config.lv3MoveGeneratorOptions);
  const simulator = new Simulator();
  shared = { index, moveGeneratorLv3, simulator, config, Evaluator, AIPlayer };
  ai = {
    lv1: new AIPlayer(index, moveGenerator, evaluator, simulator, config.lv1),
    lv2: new AIPlayer(index, moveGenerator, evaluator, simulator, config.lv2),
    lv3: new AIPlayer(index, moveGeneratorLv3, evaluator, simulator, config.lv3),
    lv3weekly: null,
  };
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    try { init(msg); } catch (err) { self.postMessage({ type: 'fatal', error: String(err && (err.stack || err.message) || err) }); }
    return;
  }
  if (msg.type === 'weekly') {
    if (!shared) return;
    const evaluator = new shared.Evaluator(shared.index, msg.table, shared.config.evaluatorOptions);
    ai.lv3weekly = new shared.AIPlayer(shared.index, shared.moveGeneratorLv3, evaluator, shared.simulator, shared.config.lv3);
    return;
  }
  if (msg.type === 'select') {
    try {
      if (!ai) throw new Error('AI worker not initialized');
      const player = ai[msg.level] || ai.lv3;
      const move = player.selectMove(msg.state, msg.playerId, msg.options);
      self.postMessage({ id: msg.id, move, plannedUntap: player.peekPlannedUntap() });
    } catch (err) {
      self.postMessage({ id: msg.id, error: String(err && (err.stack || err.message) || err) });
    }
  }
};
