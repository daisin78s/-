/**
 * Parses every DSL-bearing cell in data/game.json and reports any that fail to parse.
 * Never throws on bad DSL data -- collects errors and prints a report.
 *
 * Usage: node tools/validate_dsl.js
 * Exit code: 0 if all cells parse, 1 if any cell fails to parse.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseSafe, parseArgList, DslParseError } = require('../src/dsl-parser');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');

// Sheet -> DSL-bearing column names. These are all "program" fields (parsed via parseSafe/parse),
// i.e. semicolon-separated statements like ONCE/TAP/ACTION/QST's REWARD1-3.
const DSL_FIELDS_BY_SHEET = {
  A: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  B: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  C: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  CON: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  JOB: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  M: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  RESOURCE: ['ONCE', 'TAP', 'PASSIVE', 'TURNEND'],
  AREA: ['ACTION'],
  // REWARD1/2/3 (2026-08-09, back to 3 separate columns -- rank-based rewards, see src/qst.js).
  QST: ['REWARD1', 'REWARD2', 'REWARD3'],
};

// QST's GOAL is a bare metric expression (e.g. "CARD_COUNT" or "LEVEL_COUNT(A,2)"), not a program --
// same grammar as a COST column, parsed via parseArgList rather than parseSafe/parse (see
// src/qst.js's evalGoalMetric). Validated separately below since it needs a different entry point
// into the parser.
const GOAL_FIELDS_BY_SHEET = {
  QST: ['GOAL'],
};

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  let checked = 0;
  let ok = 0;
  const failures = [];

  for (const [sheet, fields] of Object.entries(DSL_FIELDS_BY_SHEET)) {
    const rows = data[sheet] || [];
    for (const row of rows) {
      for (const field of fields) {
        const raw = row[field];
        if (raw === '' || raw === undefined || raw === null) continue;
        checked++;
        const result = parseSafe(raw);
        if (result.success) {
          ok++;
        } else {
          failures.push({
            sheet,
            id: row.ID,
            field,
            value: raw,
            message: result.error.message,
            pos: result.error.pos,
          });
        }
      }
    }
  }

  for (const [sheet, fields] of Object.entries(GOAL_FIELDS_BY_SHEET)) {
    const rows = data[sheet] || [];
    for (const row of rows) {
      for (const field of fields) {
        const raw = row[field];
        if (raw === '' || raw === undefined || raw === null) continue;
        checked++;
        try {
          parseArgList(raw);
          ok++;
        } catch (err) {
          if (!(err instanceof DslParseError)) throw err;
          failures.push({ sheet, id: row.ID, field, value: raw, message: err.message, pos: err.pos });
        }
      }
    }
  }

  const sheetCount = new Set([...Object.keys(DSL_FIELDS_BY_SHEET), ...Object.keys(GOAL_FIELDS_BY_SHEET)]).size;
  console.log(`Checked ${checked} DSL cells across ${sheetCount} sheets.`);
  console.log(`OK: ${ok}  Failed: ${failures.length}`);

  if (failures.length > 0) {
    console.log('\n--- Failures ---');
    for (const f of failures) {
      console.log(`\n${f.sheet}.${f.id}.${f.field} = ${JSON.stringify(f.value)}`);
      console.log(`  -> ${f.message}`);
      if (f.pos >= 0) {
        console.log(`  -> ${f.value}`);
        console.log(`     ${' '.repeat(f.pos)}^`);
      }
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main();
