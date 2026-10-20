#!/usr/bin/env node
'use strict';

/**
 * Builds data/ai-reference.json, the single data file the AI rule chat ("ルールAI") feature reads
 * instead of ever touching a card's history or guessing at its behavior from memory. Combines:
 *  - every card/face's actual gameplay data straight from data/game.json (DICE/COST/EMBLEM/VP/LEVEL/etc,
 *    plus its own ONCE/TAP/PASSIVE/TURNEND/ACTION DSL text)
 *  - that same card's own individual INST column (confirmed accurate by the user, 2026-10-20 -- distinct
 *    from the separate, stale INST SHEET covering 17 broad concepts like VP/K/A/B/C/..., which this
 *    script deliberately never reads at all)
 * DSL command *semantics* themselves are NOT duplicated here -- they live once, by hand, in
 * data/dsl-command-spec.json (this file only records that spec's filename, so a caller knows to load it
 * alongside this one).
 *
 * Run straight after `python tools/xlsx_to_json.py` whenever game.xlsx changes, so ルールAI is never
 * answering from stale data:
 *   node tools/build_ai_reference_data.js
 *
 * Every DSL-bearing field (ONCE/TAP/PASSIVE/TURNEND/ACTION) is re-parsed here through the SAME real
 * parser the game itself runs (src/dsl-parser.js + src/command-builder.js) -- not a re-implementation --
 * so a card whose DSL text doesn't actually parse is caught and reported in `issues` rather than silently
 * handed to ルールAI as if it were valid.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('../src/dsl-parser');
const { lowerProgram } = require('../src/command-builder');

const GAME_JSON_PATH = path.join(__dirname, '..', 'data', 'game.json');
const SPEC_PATH = path.join(__dirname, '..', 'data', 'dsl-command-spec.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'ai-reference.json');

// Sheets that define actual playable cards/rules content. MAP/SHOP and every 評価値_* sheet are
// board-layout/AI-tuning data, not something a player would ever ask ルールAI a rules question about.
const CARD_SHEETS = ['M', 'A', 'B', 'C', 'CON', 'JOB', 'RESOURCE', 'QST', 'AREA'];

// Plain gameplay fields, passed through as-is whenever a sheet actually has that column and the cell
// isn't blank. Different sheets have different subsets of these (confirmed via data/game.json's own
// per-sheet column lists) -- no per-sheet special-casing needed, a field simply doesn't appear if absent.
const PLAIN_FIELDS = [
  'DICE', 'COST', 'EMBLEM_A', 'EMBLEM_B', 'EMBLEM_C', 'VP', 'LEVEL', 'AUTO',
  'SLOT1', 'SLOT2', 'SLOT3', 'SLOT4', 'SLOT5', 'SLOT6', // AREA's slot layout
  'fee', // AREA's usage fee
  'GOAL', 'REWARD1', 'REWARD2', 'REWARD3', // QST
  'WARNING', // CON's player-facing warning text (distinct from NOTE, which is an implementation-only
  // comment for Claude Code, never shown to players -- deliberately excluded)
];

// DSL-bearing fields -- included as text AND re-parsed through the real parser (see this file's own doc).
const DSL_FIELDS = ['ONCE', 'TAP', 'PASSIVE', 'TURNEND', 'ACTION'];

function tryParseDsl(text) {
  try {
    lowerProgram(parse(text));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function buildReferenceData() {
  const gameData = JSON.parse(fs.readFileSync(GAME_JSON_PATH, 'utf8'));
  const specExists = fs.existsSync(SPEC_PATH);

  const cards = {};
  const issues = [];
  const seenIds = new Set();

  for (const sheet of CARD_SHEETS) {
    const rows = gameData[sheet];
    if (!rows) continue;
    for (const row of rows) {
      const id = row.ID;
      if (!id) continue;
      if (seenIds.has(id)) {
        issues.push({ type: 'duplicate_id', cardId: id, detail: `ID "${id}" appears in more than one sheet` });
        continue;
      }
      seenIds.add(id);

      const entry = { sheet, name: row.NAME || null };
      for (const field of PLAIN_FIELDS) {
        if (row[field] !== undefined && row[field] !== '') entry[field] = row[field];
      }
      for (const field of DSL_FIELDS) {
        if (!row[field]) continue;
        entry[field] = row[field];
        const result = tryParseDsl(row[field]);
        if (!result.ok) {
          issues.push({ type: 'unparseable_dsl', cardId: id, detail: `${field}="${row[field]}": ${result.error}` });
        }
      }
      // This card's OWN individual INST note -- see this file's top-of-file doc for why this is safe to
      // trust while the separate INST sheet is not.
      if (row.INST) entry.inst = row.INST;

      cards[id] = entry;
    }
  }

  const gameDataVersion = crypto.createHash('sha256').update(fs.readFileSync(GAME_JSON_PATH)).digest('hex').slice(0, 16);

  return {
    gameDataVersion,
    generatedAt: new Date().toISOString(),
    commandSpecFile: specExists ? path.basename(SPEC_PATH) : null,
    cardCount: Object.keys(cards).length,
    cards,
    issues,
  };
}

function main() {
  const output = buildReferenceData();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 1));
  console.log(`Wrote ${OUTPUT_PATH} (${output.cardCount} cards, ${output.issues.length} issues)`);
  if (output.issues.length > 0) {
    console.log('Issues:');
    for (const issue of output.issues) console.log(`  [${issue.type}] ${issue.cardId}: ${issue.detail}`);
  }
}

if (require.main === module) main();

module.exports = { buildReferenceData };
