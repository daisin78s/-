"""
Writes tools/ga_report_top.js's JSON output into a brand-new .xlsx report (2026-08-27, per user request:
"上位10のパラメーターと10戦の平均得点 素点 クエスト 合計がしりたい" -> "出力方法は相談して" -> Excel).
Unlike tools/ai_data_write.py (which fills in an EXISTING AI.DATA.xlsx's fixed layout), this creates a
fresh workbook from scratch since there is no pre-existing "GA report" sheet layout to match.

Sheets:
  - "Summary": one row per top-N genome -- 順位/学習時avgRank/学習時avgScore/合計(平均得点)/素点/クエスト/
    対戦数 -- so rankings are visible at a glance.
  - "Top1".."TopN": one sheet per genome, shaped exactly like game.xlsx's own 評価値 sheet (ID / 1R / 2R /
    3R / 4R) so it reads familiarly and can be pasted straight back into 評価値 if a genome is ever adopted.

Usage: python tools/ga_report_write_xlsx.py [jsonPath] [xlsxOutputPath]
"""

import json
import sys
import openpyxl

JSON_PATH = sys.argv[1] if len(sys.argv) > 1 else 'output/ga_report_top.json'
XLSX_PATH = sys.argv[2] if len(sys.argv) > 2 else 'output/ga_report_top.xlsx'

with open(JSON_PATH, 'r', encoding='utf-8') as f:
    report = json.load(f)

results = report['results']

wb = openpyxl.Workbook()
summary = wb.active
summary.title = 'Summary'
summary.append(['順位', '学習時avgRank', '学習時avgScore', '合計(平均得点)', '素点', 'クエスト', '対戦数', 'シート'])
for r in results:
    summary.append([
        r['rank'], r['trainingAvgRank'], r['trainingAvgScore'],
        round(r['avgTotal'], 2), round(r['avgRaw'], 2), round(r['avgQst'], 2),
        r['gamesPlayed'], f"Top{r['rank']}",
    ])

for r in results:
    ws = wb.create_sheet(f"Top{r['rank']}")
    ws.append(['ID', '1R', '2R', '3R', '4R'])
    genome = r['genome']
    ids = list(genome['1'].keys())
    for card_id in ids:
        ws.append([card_id] + [round(genome[str(rnd)][card_id], 2) for rnd in (1, 2, 3, 4)])

wb.save(XLSX_PATH)
print(f'Wrote {XLSX_PATH} ({len(results)} genome sheets + Summary)')
