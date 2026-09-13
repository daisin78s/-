"""
Writes a tools/ga_train.js-evolved genome's values directly into game.xlsx's own 評価値 sheet (in place,
overwriting its 1R/2R/3R/4R columns row by row, matched by ID) -- 2026-09-14, per user request: "AILV4で
使う評価値を変えようと思うけどどれがおすすめ" -> "自己対戦GAの進化させた最新の評価値がおすすめ" -> "1"
(adopt it as-is). game.xlsx is this project's own master spreadsheet (data/game.json/game.data.js are
regenerated FROM it via tools/xlsx_to_json.py, never edited by hand) -- writing here, then re-running
xlsx_to_json.py, is the correct way to make this genome AI LV4's live table, rather than editing
data/game.json directly (which xlsx_to_json.py would silently overwrite again on its next run).

Only touches ID/1R/2R/3R/4R -- doesn't add/remove rows, doesn't touch any other sheet, and every ID in
the genome must already exist as a row (this genome was seeded from the real table itself via
tools/ga_train.js's --seed-real, so its id set is identical; a mismatch here would mean a stale genome
file from a different game.xlsx revision, not a normal case, so this fails loudly rather than guessing).

Usage:
    python tools/apply_evolved_genome.py <genomeJsonPath> [gameXlsxPath=data/game.xlsx]

genomeJsonPath is a best_genome.json ({generation, avgRank, genome: {1:{...},2:{...},3:{...},4:{...}}}).
"""

import json
import sys
import openpyxl

GENOME_PATH = sys.argv[1] if len(sys.argv) > 1 else None
if not GENOME_PATH:
    print('Usage: python tools/apply_evolved_genome.py <genomeJsonPath> [gameXlsxPath=data/game.xlsx]')
    sys.exit(1)
XLSX_PATH = sys.argv[2] if len(sys.argv) > 2 else 'data/game.xlsx'

with open(GENOME_PATH, 'r', encoding='utf-8') as f:
    data = json.load(f)
genome = data['genome'] if 'genome' in data else data

wb = openpyxl.load_workbook(XLSX_PATH)
ws = wb['評価値']

header = [ws.cell(row=1, column=c).value for c in range(1, 6)]
assert header == ['ID', '1R', '2R', '3R', '4R'], f'Unexpected 評価値 header: {header}'

updated = 0
missing_in_genome = []
for row in range(2, ws.max_row + 1):
    id_ = ws.cell(row=row, column=1).value
    if id_ is None:
        continue
    if id_ not in genome['1']:
        missing_in_genome.append(id_)
        continue
    for col, r in ((2, '1'), (3, '2'), (4, '3'), (5, '4')):
        value = genome[r][id_]
        ws.cell(row=row, column=col, value=round(value, 4) if isinstance(value, float) else value)
    updated += 1

if missing_in_genome:
    print(f'WARNING: {len(missing_in_genome)} row(s) left untouched (not in genome): {missing_in_genome}')

wb.save(XLSX_PATH)
meta_desc = f", generation={data.get('generation')} avgRank={data.get('avgRank')}" if 'genome' in data else ''
print(f'Updated {updated} row(s) in {XLSX_PATH}\'s 評価値 sheet from {GENOME_PATH}{meta_desc}')
