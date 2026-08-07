"""
Writes the JSON aggregate report from tools/ai_data_report.js into AI.DATA.xlsx's existing sheets
(CONJOB, ABCM) -- fills in cells by matching existing row/column headers, never touches the sheet
layout/formatting itself.

CONJOB sheet: two 8x9 tables sharing the same layout (CON001A/002A/003A/004A/001B/002B/003B/004B rows x
JOB001..JOB008 columns) -- one for "試行回数" (trial count), one for "平均得点" (average score). The
JOB column headers have no tier suffix (JOB cards only ever have an 'A' face -- see game-state.js's
splitCardId), so a jobFaceId like "JOB005A" is matched by stripping the trailing letter. A third,
single-row table (2026-08-07, per user spec) lives at row 30 ("使用回数" in column A, JOB001..JOB008 in
B:I, the user's own pre-existing layout -- found by inspection, same as the two tables above): one
aggregate "usage" value per JOB (not per-round) -- see report['job']'s own meaning, set by
tools/ai_data_report.js's jobEntry doc.

ABCM sheet: one table, ID column (every A/B/C tier-A and tier-B face, M001-M012, plus "D" for "gained a
new colored die") x 試行回数1R-4R / 平均得点1R-4R / 使用回数1-4 columns. The 使用回数 columns
(2026-08-07, per user spec, also the user's own pre-existing layout addition) only ever get a value for
rows report['abcm'][id][round]['avgUsage'] is non-null for (B008A and the 8 A-deck fee-generating
cards -- see tools/ai_data_report.js's USAGE_ELIGIBLE_ABCM_FACES) -- every other row's cells are cleared
to blank, not written as 0, so a card with no "usage" concept at all never shows a misleading number.

Usage: python tools/ai_data_write.py [jsonPath] [xlsxPath]
"""

import json
import re
import sys
import openpyxl

JSON_PATH = sys.argv[1] if len(sys.argv) > 1 else 'output/ai_data_report.json'
XLSX_PATH = sys.argv[2] if len(sys.argv) > 2 else 'AI.DATA.xlsx'

with open(JSON_PATH, 'r', encoding='utf-8') as f:
    report = json.load(f)

wb = openpyxl.load_workbook(XLSX_PATH)

# ---------------------------------------------------------------------------
# CONJOB sheet
# ---------------------------------------------------------------------------
ws = wb['CONJOB']

def find_table(header_row):
    """Given the row index of a table's own header row, returns {con_face_id: row_idx} and
    {job_physical_id: col_idx} (job ids stripped to e.g. "JOB005", matching the sheet's own headers)."""
    row_map = {}
    r = header_row + 1
    while ws.cell(row=r, column=1).value:
        row_map[ws.cell(row=r, column=1).value] = r
        r += 1
    col_map = {}
    c = 2
    while ws.cell(row=header_row, column=c).value:
        col_map[ws.cell(row=header_row, column=c).value] = c
        c += 1
    return row_map, col_map

def find_header_row(label):
    """Finds label ("試行回数" or "平均得点") in column A -- searched fresh each run rather than a
    hardcoded row number, so inserting/removing CON rows (e.g. 2026-08-03's CON005A/B addition) never
    silently desyncs this script from the sheet's actual current layout. Scans the whole used range
    (not stopping at the first blank row) since the two tables are separated by blank spacer rows."""
    for r in range(1, ws.max_row + 1):
        if ws.cell(row=r, column=1).value == label:
            return r
    raise ValueError(f'Could not find a "{label}" header in column A of the CONJOB sheet')

count_rows, count_cols = find_table(find_header_row('試行回数'))
avg_rows, avg_cols = find_table(find_header_row('平均得点'))

# Clears every existing data cell in both tables before writing (2026-08-03, per user feedback: "すでに
# ある数字を上書きして大丈夫です" for a fresh N-game run) -- without this, a combination that simply
# didn't occur in *this* run would silently keep whatever number an earlier (possibly pre-bugfix) run
# left behind, mixing two different AI behaviors/seed counts in the same sheet.
for row_map in (count_rows, avg_rows):
    for r in row_map.values():
        for c in range(2, ws.max_column + 1):
            ws.cell(row=r, column=c).value = None

written = 0
skipped = []
for entry in report['conjob']:
    con_face_id = entry['con']
    job_physical_id = re.sub(r'[A-Z]$', '', entry['job'])  # "JOB005A" -> "JOB005"
    if con_face_id not in count_rows or job_physical_id not in count_cols:
        skipped.append((con_face_id, entry['job']))
        continue
    ws.cell(row=count_rows[con_face_id], column=count_cols[job_physical_id], value=entry['count'])
    ws.cell(row=avg_rows[con_face_id], column=avg_cols[job_physical_id], value=round(entry['avgScore'], 2))
    written += 1

print(f'CONJOB: wrote {written} combinations, skipped {len(skipped)}: {skipped}')

# Third table: a single "使用回数" row (2026-08-07, per user spec, at the user's own pre-existing row --
# see this file's own top-of-file doc) reusing the same JOB001..JOB008 column positions as the two tables
# above (count_cols) rather than re-deriving them, since there's no separate header row of its own.
job_usage_row = find_header_row('使用回数')
for c in range(2, ws.max_column + 1):
    ws.cell(row=job_usage_row, column=c).value = None

job_written = 0
job_skipped = []
for job_face_id, entry in report.get('job', {}).items():
    job_physical_id = re.sub(r'[A-Z]$', '', job_face_id)
    if job_physical_id not in count_cols:
        job_skipped.append(job_face_id)
        continue
    if entry['avgUsage'] is not None:
        ws.cell(row=job_usage_row, column=count_cols[job_physical_id], value=round(entry['avgUsage'], 2))
    job_written += 1

print(f'CONJOB row {job_usage_row} (JOB使用回数): wrote {job_written} JOBs, skipped {len(job_skipped)}: {job_skipped}')

# ---------------------------------------------------------------------------
# ABCM sheet
# ---------------------------------------------------------------------------
ws2 = wb['ABCM']
id_rows = {}
r = 2
while ws2.cell(row=r, column=1).value:
    id_rows[ws2.cell(row=r, column=1).value] = r
    r += 1

# Column layout confirmed via inspection: A=ID, B-E=試行回数1R-4R, F=blank spacer, G-J=平均得点1R-4R,
# K=blank spacer, L-O=使用回数1-4 (2026-08-07, per user spec -- the user's own pre-existing column
# addition, only meaningful for B008A/A-deck rows, see this file's own top-of-file doc).
COUNT_COLS = {1: 2, 2: 3, 3: 4, 4: 5}
AVG_COLS = {1: 7, 2: 8, 3: 9, 4: 10}
USAGE_COLS = {1: 12, 2: 13, 3: 14, 4: 15}

# Same clear-before-write as the CONJOB sheet above, same reason.
for r in id_rows.values():
    for c in list(COUNT_COLS.values()) + list(AVG_COLS.values()) + list(USAGE_COLS.values()):
        ws2.cell(row=r, column=c).value = None

abcm_written = 0
abcm_skipped = []
for card_id, by_round in report['abcm'].items():
    if card_id not in id_rows:
        abcm_skipped.append(card_id)
        continue
    row = id_rows[card_id]
    for round_str, cell in by_round.items():
        round_num = int(round_str)
        ws2.cell(row=row, column=COUNT_COLS[round_num], value=cell['count'])
        if cell['avgScore'] is not None:
            ws2.cell(row=row, column=AVG_COLS[round_num], value=round(cell['avgScore'], 2))
        if cell.get('avgUsage') is not None:
            ws2.cell(row=row, column=USAGE_COLS[round_num], value=round(cell['avgUsage'], 2))
    abcm_written += 1

print(f'ABCM: wrote {abcm_written} card rows, skipped {len(abcm_skipped)}: {abcm_skipped}')

# ---------------------------------------------------------------------------
# HighScores sheet (2026-08-04, per user feedback: "20点以上の点数があった時 その得点を取ったAIが何を
# したのか確認できるように...ログは一つのエクセルファイルにまとめる") -- one row per player (all 4, not
# just whoever crossed the threshold, per "4人とも記録 それぞれの得点も") for every game where at least
# one player's score reached report['highScoreThreshold']. Deliberately limited to score-relevant fields
# only (CON/JOB/initial RESOURCE/builds by round, per "スコアに直結する行動だけに絞ります") -- not a full
# move-by-move log.
# ---------------------------------------------------------------------------
if 'HighScores' in wb.sheetnames:
    del wb['HighScores']
ws3 = wb.create_sheet('HighScores')
ws3.append(['Seed', 'Player', 'Score', 'CON', 'JOB', 'Resources', 'R1 Builds', 'R2 Builds', 'R3 Builds', 'R4 Builds'])
for row in report.get('highScoreRows', []):
    ws3.append([
        row['seed'],
        row['playerId'],
        row['score'],
        row['con'],
        row['job'],
        ','.join(row['resources']),
        ','.join(row['builds1']),
        ','.join(row['builds2']),
        ','.join(row['builds3']),
        ','.join(row['builds4']),
    ])
print(f"HighScores: wrote {len(report.get('highScoreRows', []))} player-rows (threshold={report.get('highScoreThreshold')})")

wb.save(XLSX_PATH)
print(f'Saved {XLSX_PATH} (based on {report["gamesRun"]} games)')
