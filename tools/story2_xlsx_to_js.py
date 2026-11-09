"""Convert the Excel-written story chapters (ストーリー.xlsx) into data/*.data.js.

Usage: python tools/story2_xlsx_to_js.py [path/to/ストーリー.xlsx]
Input: the argument, otherwise ~/Desktop/ストーリー.xlsx.
Output: one plain browser global per chapter, loaded via a normal <script src> tag -- same reasoning as
data/game.data.js (index.html must keep working from file://):
  - sheet whose name contains "スパル" -> data/story2.data.js      (window.STORY2_SCRIPT)
  - sheet whose name contains "セネカ" -> data/story_seneca.data.js (window.STORY_SENECA_SCRIPT)
Sheets are found by name, not position (2026-11-09: the user inserted セネカ's sheet before スパル's, and
renamed the sheets after the chapters).

2026-10-31, per user: chapter 2 (now 第3章 傲慢な百人隊長スパル) is written in Excel instead of Twine
("エクセルのほうです"): one row per step, in order, no IDs -- column A is a line (spoken by the chapter's
character), column C is what happens on the screen or the condition that starts that part ("ダイスが振られる",
"訓練場にダイスを置く（１回目）", ...). Both columns are exported as-is ({text, event}); story.js decides what
each event means by its wording. Dev-time tool only; the game never reads the xlsx directly.
"""
import json
import sys
from pathlib import Path

import openpyxl

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = Path.home() / "Desktop" / "ストーリー.xlsx"
CHAPTERS = [
    ("スパル", PROJECT_ROOT / "data" / "story2.data.js", "STORY2_SCRIPT"),
    ("セネカ", PROJECT_ROOT / "data" / "story_seneca.data.js", "STORY_SENECA_SCRIPT"),
]


def cell_text(value):
    return "" if value is None else str(value).strip()


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    wb = openpyxl.load_workbook(src, data_only=True)
    for keyword, dest, var in CHAPTERS:
        ws = next((s for s in wb.worksheets if keyword in s.title), None)
        if ws is None:
            print(f"!! 「{keyword}」のシートがありません ({src})")
            continue
        rows = []
        for row in ws.iter_rows(min_row=1, max_col=3, values_only=True):
            text, event = cell_text(row[0]), cell_text(row[2] if len(row) > 2 else None)
            if text or event:
                rows.append({"text": text, "event": event})
        inline = json.dumps(rows, ensure_ascii=False, indent=1).replace("</script", "<\\/script")
        dest.write_text(f"window.{var} = {inline};\n", encoding="utf-8")
        print(f"{len(rows)} 行 <- {ws.title} -> {dest.name}")


if __name__ == "__main__":
    main()
