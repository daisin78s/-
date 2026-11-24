"""
相性の計算 (カード相性 data -> numbers), shared by card_pair_stats_to_xlsx.py (the カード相性.xlsx report) and
write_eval_all_sheet.py (game.xlsx's 評価値ALL sheet) so both always agree on what "相性" / "補正後の相性" mean.
See card_pair_stats_to_xlsx.py's own doc for the definitions.
"""

import re

MIN_GAMES = 30
BASELINE_MIN_GAMES = 100
UNIT_SHEETS = ['A', 'B', 'C', 'M', 'JOB', 'CON']
KIND_LABEL = {'A': 'A', 'B': 'B', 'C': 'C', 'M': 'モニュメント', 'JOB': 'ジョブ', 'CON': '性格'}
# Pair-type grouping for 補正後の相性: A/B/C are all area cards, one group.
GROUP_LABEL = {'A': 'エリア', 'B': 'エリア', 'C': 'エリア', 'M': 'モニュメント', 'JOB': 'ジョブ', 'CON': '性格'}
# 追加色ダイスのD欄もデータから自動 (2026-11-24, per user「Dの欄すべて 自動で変わるようにして」「増えた数だけ数える」「すぐ自動に切り替える」):
# ゲーム終了時の追加色ダイスの数 D1/D2/D3(3個以上) も1つの項目として相性を数える (tools/card_pair_stats.js の holdingUnits)。
COLOR_DICE_UNITS = ['D1', 'D2', 'D3']
COLOR_DICE_SHEET = 'D'
KIND_LABEL[COLOR_DICE_SHEET] = '色ダイス'
GROUP_LABEL[COLOR_DICE_SHEET] = '色ダイス'


class PairSynergy:
    def __init__(self, stats, game):
        self.stats = stats
        # Same unit rule as card_pair_stats.js's unitIdOfFace (A/B/C physical card; M/JOB/CON face id as-is).
        # perFace (the LV別 table, 2026-10-30): A/B/C are counted per face too, and keep their LV in the name.
        self.per_face = bool(stats.get('perFace'))
        self.units = []
        seen = set()
        for sheet in UNIT_SHEETS:
            for row in game.get(sheet, []):
                uid = row['ID'] if self.per_face or sheet in ('M', 'JOB', 'CON') else re.sub(r'[AB]$', '', row['ID'])
                if uid in seen:
                    continue
                seen.add(uid)
                name = row.get('NAME') or uid
                self.units.append((uid, sheet, name if self.per_face else re.sub(r'LV\d$', '', name)))
        for uid in COLOR_DICE_UNITS:
            self.units.append((uid, COLOR_DICE_SHEET, uid))
        self.group_of = {uid: GROUP_LABEL[sheet] for uid, sheet, _ in self.units}
        self.name_of = {uid: name for uid, _, name in self.units}
        self.solo = stats.get('solo', {})
        self.pair = stats.get('pair', {})
        # 全体の平均にはD1/D2/D3を入れない(入れるとカードどうしのマスの値まで少し動くため)
        card_solo = [s for u, s in self.solo.items() if u not in COLOR_DICE_UNITS]
        total_n = sum(s['n'] for s in card_solo)
        self.overall = (sum(s['rankSum'] for s in card_solo) / total_n) if total_n else 2.5

        baseline_sum = {}
        self.baseline_n = {}
        for a, b in self.unit_pairs():
            p = self.pair_cell(a, b)
            v = self.synergy(a, b)
            if v is None or p['n'] < BASELINE_MIN_GAMES:
                continue
            t = self.pair_type(a, b)
            baseline_sum[t] = baseline_sum.get(t, 0) + v
            self.baseline_n[t] = self.baseline_n.get(t, 0) + 1
        self.baseline = {t: baseline_sum[t] / self.baseline_n[t] for t in baseline_sum}

    def unit_pairs(self):
        for i, (a, _, _) in enumerate(self.units):
            for b, _, _ in self.units[i + 1:]:
                yield a, b

    def solo_avg(self, u):
        s = self.solo.get(u)
        return s['rankSum'] / s['n'] if s and s['n'] else None

    def pair_cell(self, a, b):
        return self.pair.get(f'{a}|{b}' if a < b else f'{b}|{a}')

    def pair_type(self, a, b):
        return '×'.join(sorted([self.group_of[a], self.group_of[b]]))

    def synergy(self, a, b):
        """(予想の平均順位) - (実際の平均順位); None until the pair has MIN_GAMES games."""
        p = self.pair_cell(a, b)
        sa, sb = self.solo_avg(a), self.solo_avg(b)
        if not p or p['n'] < MIN_GAMES or sa is None or sb is None:
            return None
        return round((sa + sb - self.overall) - p['rankSum'] / p['n'], 3)

    def adjusted_synergy(self, a, b):
        """相性 minus its pair type's own average (補正後の相性)."""
        v = self.synergy(a, b)
        if v is None:
            return None
        return round(v - self.baseline.get(self.pair_type(a, b), 0), 3)
