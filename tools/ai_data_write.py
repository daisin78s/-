"""
Writes the JSON aggregate report from tools/ai_data_report.js into AI.DATA.xlsx's existing sheets
(CONJOB, ABCM) -- fills in cells by matching existing row/column headers, never touches the sheet
layout/formatting itself.

CONJOB sheet: two pairs of 8x9 tables sharing the same layout (CON001A/002A/003A/004A/001B/002B/003B/
004B rows x JOB001..JOB008 columns) -- "試行回数" (trial count), "平均得点" (average score, QST VP
excluded -- see report['conjob'][].avgScore's own doc in ai_data_report.js), and (2026-08-09, per user
request) "QST平均得点" (QST's own average VP contribution, same row/col layout, a separate table further
down the sheet -- report['conjob'][].avgQstScore). The JOB column headers have no tier suffix (JOB cards
only ever have an 'A' face -- see game-state.js's splitCardId), so a jobFaceId like "JOB005A" is matched
by stripping the trailing letter. A fifth, single-row table (2026-08-07, per user spec) lives at row 30
("使用回数" in column A, JOB001..JOB008 in B:I, the user's own pre-existing layout -- found by
inspection, same as the tables above): one aggregate "usage" value per JOB (not per-round) -- see
report['job']'s own meaning, set by tools/ai_data_report.js's jobEntry doc.

ABCM sheet: one table, ID column (every A/B/C tier-A and tier-B face, M001-M012, plus "D" for "gained a
new colored die") x 試行回数1R-4R / 平均得点1R-4R / QST平均得点1R-4R / 使用回数1-4 columns. Column
positions are looked up by their own header text (find_col, below), not hardcoded -- the exact same
"never desync from the sheet's actual current layout" reasoning as CONJOB's find_table/find_header_row
(2026-08-09: this sheet's columns were reshuffled to interleave the new QST平均得点{r}R columns between
each existing 平均得点{r}R one, which would have silently written into the wrong columns had the old
hardcoded indices been kept). The 使用回数 columns (2026-08-07, per user spec, also the user's own
pre-existing layout addition) only ever get a value for rows report['abcm'][id][round]['avgUsage'] is
non-null for (B008A and the 8 A-deck fee-generating cards -- see tools/ai_data_report.js's
USAGE_ELIGIBLE_ABCM_FACES) -- every other row's cells are cleared to blank, not written as 0, so a card
with no "usage" concept at all never shows a misleading number.

Usage: python tools/ai_data_write.py [jsonPath] [xlsxPath]
"""

import json
import re
import sys
import openpyxl
from openpyxl.utils import get_column_letter

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
# QST平均得点 (2026-08-09, per user request) -- a third table, same row/col layout as the two above,
# further down the sheet (the user's own pre-existing addition, found the same dynamic way).
qst_avg_rows, qst_avg_cols = find_table(find_header_row('QST平均得点'))

# Clears only the JOB001..JOB008 data cells this script actually writes (2026-08-03, per user feedback:
# "すでにある数字を上書きして大丈夫です" for a fresh N-game run) -- without this, a combination that
# simply didn't occur in *this* run would silently keep whatever number an earlier (possibly pre-bugfix)
# run left behind, mixing two different AI behaviors/seed counts in the same sheet.
# Bounded to max(count_cols.values()) (2026-08-07, fixing a bug reported by the user: "CONJOBシートの
# セルL16からM25までもコピペされるようにしてください") -- this used to sweep all the way to
# ws.max_column, which also wiped columns L/M (rows 16-25, alongside the 平均得点 table): the user's own
# hand-maintained reference notes (each CON face's own ONCE-effect DSL + INST description text, e.g. row
# 16 = CON001A's "ADD(6K)" / "資源◯の上限7個..."), unrelated to anything this script computes or writes.
last_job_col = max(count_cols.values())
for row_map in (count_rows, avg_rows, qst_avg_rows):
    for r in row_map.values():
        for c in range(2, last_job_col + 1):
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
    ws.cell(row=qst_avg_rows[con_face_id], column=qst_avg_cols[job_physical_id], value=round(entry['avgQstScore'], 2))
    written += 1

print(f'CONJOB: wrote {written} combinations, skipped {len(skipped)}: {skipped}')

# J/K: per-CON marginal sum/average across the 8 JOB columns (2026-08-07, per user request: "JOBCONシート
# のJ、K列も出力できるようにしてください" -- confirmed by inspecting the user's own manually-entered
# example values, e.g. row16's K = J/8 exactly). Mirrors row 26/27's own JOB-column marginal SUM/AVERAGE
# (e.g. row26 = "=SUM(B16:B25)"), just transposed to a per-CON-row marginal instead. Written as live Excel
# formulas, same style as row26/27, rather than pre-computed Python values, so they keep recalculating
# automatically whenever this script rewrites the underlying B:I cells on a later run. Written for every
# CON row unconditionally (not just ones report['conjob'] had data for this run), matching row26/27's own
# always-present formulas. Written for the QST平均得点 table's own rows too (2026-08-09) -- same J/K
# columns (a per-CON-*row* marginal, and every table shares the same CON row set), just at that table's
# own row positions.
j_col = last_job_col + 1
k_col = last_job_col + 2
first_col_letter = get_column_letter(min(avg_cols.values()))
last_col_letter = get_column_letter(max(avg_cols.values()))
j_col_letter = get_column_letter(j_col)
num_jobs = len(avg_cols)
for row_map in (avg_rows, qst_avg_rows):
    for con_face_id, r in row_map.items():
        ws.cell(row=r, column=j_col, value=f'=SUM({first_col_letter}{r}:{last_col_letter}{r})')
        ws.cell(row=r, column=k_col, value=f'={j_col_letter}{r}/{num_jobs}')

print(f'CONJOB J/K: wrote per-CON marginal sum/avg formulas for {len(avg_rows)} + {len(qst_avg_rows)} rows')

# Third table: a single "使用回数" row (2026-08-07, per user spec, at the user's own pre-existing row --
# see this file's own top-of-file doc) reusing the same JOB001..JOB008 column positions as the two tables
# above (count_cols) rather than re-deriving them, since there's no separate header row of its own.
job_usage_row = find_header_row('使用回数')
for c in range(2, last_job_col + 1):
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

# Column positions looked up by their own row-1 header text, not hardcoded (2026-08-09 -- see this
# file's own top-of-file doc for why: this sheet's columns were reshuffled once already to interleave
# the new QST平均得点{r}R columns, which would have silently desynced a hardcoded layout).
def find_col(label):
    for c in range(1, ws2.max_column + 1):
        if ws2.cell(row=1, column=c).value == label:
            return c
    raise ValueError(f'Could not find column "{label}" in row 1 of the ABCM sheet')

COUNT_COLS = {r: find_col(f'試行回数{r}R') for r in (1, 2, 3, 4)}
AVG_COLS = {r: find_col(f'平均得点{r}R') for r in (1, 2, 3, 4)}
QST_AVG_COLS = {r: find_col(f'QST平均得点{r}R') for r in (1, 2, 3, 4)}
USAGE_COLS = {r: find_col(f'使用回数{r}') for r in (1, 2, 3, 4)}

# Same clear-before-write as the CONJOB sheet above, same reason.
for r in id_rows.values():
    for c in list(COUNT_COLS.values()) + list(AVG_COLS.values()) + list(QST_AVG_COLS.values()) + list(USAGE_COLS.values()):
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
        if cell.get('avgQstScore') is not None:
            ws2.cell(row=row, column=QST_AVG_COLS[round_num], value=round(cell['avgQstScore'], 2))
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
