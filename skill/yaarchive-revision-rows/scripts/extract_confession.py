#!/usr/bin/env python3
"""
Яндекс Архив, ИСПОВЕДНЫЕ ВЕДОМОСТИ: перепривязка соседних столбцов к Основному блоку (список людей).

Вход : данные страницы (__NEXT_DATA__) в .json, HTML-страница с этим <script>, либо папка с такими файлами.
Выход: JSON (по странице: половины разворота -> столбцы -> люди) и плоский CSV
       (одна строка = один человек: № двора, пол, № м/ж, возраст, текст блока как распознан).

Форма (1739-1864, с изменениями): слева от Основного блока три столбца
   «Домовъ / дворовъ» (№ двора) | «людей: мужеска пола» (№ мужчины) | «женска пола» (№ женщины),
справа два столбца «Лѣта отъ рожденія»: мужеска | женска.
Столбцы «Показанія дѣйства» (кто был у исповеди…) НЕ собираются и пропускаются.

Распознавание НЕ выполняется: используются только готовые тексты и координаты страницы.
Все допуски заданы в долях размера скана или медианного размера числа, поэтому
сканы разного разрешения обрабатываются одинаково.
"""
import argparse
import math
import csv
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from split_names import split_block  # noqa: E402

NEXT_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_MAP = str.maketrans({"ѣ": "е", "і": "и", "i": "и", "ѳ": "ф", "ѵ": "и", "ё": "е", "ѡ": "о", "ꙋ": "у", "ѯ": "кс"})

NUM_RE = re.compile(r"^\s*(?:№|N)?\s*(\d{1,4})\s*[.,:;]?\s*$")
MULTI_RE = re.compile(r"^\s*\d{1,4}(?:\s*[.,]?\s+\d{1,4})+\s*[.,]?\s*$")
AGE_RE = re.compile(r"^\s*(\d{1,3})?\s*(\d\s*/\s*\d)?\s*[.,]?\s*$")          # «45», «7 1/2», «1/2.»
HEADER_WORDS = re.compile(r"(числ|двор|домов|людей|мужеск|женск|лет\b|лет |рожден|показан|исповед|причаст|не были|пола)")
SKIP_HEAD = re.compile(r"(показан|исповед|причаст|не были)")

# Населённые пункты округи (как в logic.js расширения): название -> основа после нормализации
SETTLEMENTS = {
    "село Троицкое": r"троицк",
    "деревня Острогина": r"острогин",
    "деревня Черепкова": r"черепков",
    "деревня Рублева": r"рублев",
    "деревня Луки": r"лук(?:и|ъ)?\b",
    "деревня Мякинина": r"(?:м[яе]кинин|мемин)",
}
SETTLE_PREFIX = r"(?:\bсел\w*\.?|\bдер\w*\.?|\bдрв\w*|\bд\.|\bс\.)\s*[\[(«\"]?\s*"
SAME_VILLAGE = re.compile(r"\bтого\s+сел")        # «Того Села крестьянство» = село прихода
# порядок НП в ведомостях (из описания пользователя) — для подсказки, если заголовок не распознан
ORDER_BEFORE_1750 = ["село Троицкое", "деревня Черепкова", "деревня Острогина", "деревня Рублева", "деревня Луки", "деревня Мякинина"]
ORDER_FROM_1750 = ["село Троицкое", "деревня Острогина", "деревня Черепкова", "деревня Рублева", "деревня Луки"]

CSV_COLS = ["year", "page", "half", "settlement", "yard", "person_text", "sex", "no", "age", "birth_year",
            "person_in_block", "block_id", "names_text", "flags"]


def age_value(age):
    """«45» -> 45; «7 1/2» -> 7.5; «1/2» -> 0.5; иначе None"""
    m = re.match(r"^\s*(\d{1,3})?\s*(?:(\d)\s*/\s*(\d))?", str(age or ""))
    if not m or not (m.group(1) or m.group(2)):
        return None
    v = int(m.group(1) or 0)
    if m.group(2):
        v += int(m.group(2)) / int(m.group(3))
    return v


def birth_year(year, age):
    """год рождения = год ведомости − полных лет (± 1 год: ведомость составлялась в течение года)"""
    v = age_value(age)
    if not year or v is None:
        return ""
    return int(year) - int(math.floor(v))


def norm(t):
    t = (t or "").lower().translate(_MAP).replace("ъ", "").replace("ь", "")
    t = re.sub(r"[^\w\s/]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load_node(path):
    raw = Path(path).read_text(encoding="utf-8")
    m = NEXT_RE.search(raw)
    data = json.loads(m.group(1) if m else raw)
    url = None
    if "props" in data:
        data = data["props"]["pageProps"]
    if isinstance(data, dict) and "currentNode" in data:
        url = data.get("url")
        data = data["currentNode"]
    data = dict(data)
    data.setdefault("_url", url)
    return data


class Blk:
    __slots__ = ("i", "id", "tid", "text", "x0", "y0", "x1", "y1", "w", "h", "cx", "cy", "kind", "vals")

    def __init__(self, i, j, t):
        pts = j["points"]
        xs, ys = [p["x"] for p in pts], [p["y"] for p in pts]
        self.i, self.id, self.tid = i, j["id"], t["id"]
        self.text = (t.get("text") or "").strip()
        self.x0, self.y0, self.x1, self.y1 = min(xs), min(ys), max(xs), max(ys)
        self.w, self.h = self.x1 - self.x0, self.y1 - self.y0
        self.cx, self.cy = (self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2
        self.kind, self.vals = "text", []

    def bb(self):
        return [self.x0, self.y0, self.x1, self.y1]


def classify(b):
    t = b.text
    m = NUM_RE.match(t)
    if m:
        b.kind, b.vals = "num", [m.group(1)]
        return
    if MULTI_RE.match(t):
        b.kind, b.vals = "multi", re.findall(r"\d{1,4}", t)
        return
    m = AGE_RE.match(t)
    if m and (m.group(1) or m.group(2)):
        b.kind, b.vals = "frac", [re.sub(r"\s+", " ", t.strip(" .,"))]
        return
    b.kind = "text"


def settlement_of(text):
    n = norm(text)
    if SAME_VILLAGE.search(n):
        return "село Троицкое", "того села"
    for name, tail in SETTLEMENTS.items():
        if re.search(SETTLE_PREFIX + tail, n):
            return name, "заголовок"
    m = re.search(r"(?:\bсел\w*|\bдер\w*|\bдрв\w*|\bдрвн\w*)\.?\s+([а-я]{4,})", n)
    if m and len(n) < 60:
        w = m.group(1)
        for name, stem in SETTLE_STEMS.items():      # распознано с ошибкой: «Черепкава», «Острагина»
            if lev(w[: len(stem)], stem) <= max(1, len(stem) // 4):
                return name, "похоже на «" + w + "»"
        return "other:" + w, "заголовок"
    return None, None


SETTLE_STEMS = {"село Троицкое": "троицк", "деревня Острогина": "острогин", "деревня Черепкова": "черепков",
                "деревня Рублева": "рублев", "деревня Мякинина": "мякинин"}


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def pct(vals, q):
    s = sorted(vals)
    if not s:
        return 0
    k = (len(s) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ----------------------------------------------------------------------------- столбцы
def deskew_slope(blocks, sigma, ymid):
    """Наклон столбцов (скан повёрнут): подбирается s, при котором центры x' = cx - s*(cy - ymid)
    собираются плотнее всего (сумма гауссовых сближений пар). sigma — доля ширины числа, поэтому
    результат не зависит от разрешения скана (нет корзин гистограммы в пикселях)."""
    if len(blocks) < 6:
        return 0.0
    import math
    pts = [(b.cx, b.cy - ymid) for b in blocks]
    best, best_s = -1.0, 0.0
    for k in range(-40, 41):
        s = k * 0.0015
        xs = sorted(x - s * y for x, y in pts)
        score = 0.0
        for i in range(len(xs)):
            for j in range(i + 1, len(xs)):
                d = (xs[j] - xs[i]) / sigma
                if d > 3:
                    break
                score += math.exp(-d * d)
        if score > best + 1e-9 or (abs(score - best) <= 1e-9 and abs(s) < abs(best_s)):
            best, best_s = score, s
    return best_s


def cluster_columns(blocks, gap, ymid, slope):
    """1-D кластеризация по x' (с поправкой на наклон). gap — в пикселях."""
    if not blocks:
        return []
    xs = sorted((((b.cx - slope * (b.cy - ymid)), b) for b in blocks), key=lambda t: t[0])
    groups = [[xs[0]]]
    for x, b in xs[1:]:
        if x - groups[-1][-1][0] > gap:
            groups.append([(x, b)])
        else:
            groups[-1].append((x, b))
    cols = []
    for g in groups:
        cols.append({"blocks": sorted((b for _, b in g), key=lambda b: b.cy), "b": slope,
                     "center": statistics.median(x for x, _ in g)})
    return sorted(cols, key=lambda c: c["center"])


def stable_by_y(blocks, eps):
    """сортировка по y; блоки почти на одной высоте (|dy| < eps) — по x, чтобы порядок не зависел от округления"""
    bs = sorted(blocks, key=lambda b: b.cy)
    out, grp = [], []
    for b in bs:
        if grp and b.cy - grp[0].cy >= eps:
            out += sorted(grp, key=lambda b: (b.cx, b.id)); grp = []
        grp.append(b)
    out += sorted(grp, key=lambda b: (b.cx, b.id))
    return out


def shift_line(pairs, med_h):
    """shift(y) = c0 + c1*y по парам (y, dy); выбросы (> 0.5 высоты числа от прямой) отбрасываются"""
    if not pairs:
        return 0.0, 0.0
    pts = list(pairs)
    for _ in range(3):
        if len(pts) < 4:
            return statistics.median(d for _, d in pts), 0.0
        my = statistics.mean(y for y, _ in pts); md = statistics.mean(d for _, d in pts)
        syy = sum((y - my) ** 2 for y, _ in pts)
        c1 = sum((y - my) * (d - md) for y, d in pts) / syy if syy else 0.0
        c0 = md - c1 * my
        keep = [(y, d) for y, d in pts if abs(d - (c0 + c1 * y)) <= 0.5 * med_h]
        if len(keep) == len(pts) or len(keep) < 4:
            break
        pts = keep
    return c0, c1


def align(av, pv, tol):
    """выравнивание двух возрастающих последовательностей y с сохранением порядка (динамическое программирование);
    пара допустима, если |разница| <= tol; пропуск стоит 0.6 tol"""
    n, m = len(av), len(pv)
    INF = float("inf")
    gap = 0.6 * tol
    D = [[INF] * (m + 1) for _ in range(n + 1)]
    B = [[None] * (m + 1) for _ in range(n + 1)]
    D[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            if i == 0 and j == 0:
                continue
            best, bk = INF, None
            if i and D[i - 1][j] + gap < best:
                best, bk = D[i - 1][j] + gap, (i - 1, j, False)
            if j and D[i][j - 1] + gap < best:
                best, bk = D[i][j - 1] + gap, (i, j - 1, False)
            if i and j:
                d = abs(av[i - 1] - pv[j - 1])
                if d <= tol and D[i - 1][j - 1] + d < best:
                    best, bk = D[i - 1][j - 1] + d, (i - 1, j - 1, True)
            D[i][j], B[i][j] = best, bk
    out, i, j = [], n, m
    while (i, j) != (0, 0):
        pi, pj, mt = B[i][j]
        if mt:
            out.append((i - 1, j - 1))
        i, j = pi, pj
    return out[::-1]


# ----------------------------------------------------------------------------- страница
def process(node, a):
    size = node.get("originalImageSize") or {}
    W, H = size.get("width"), size.get("height")
    jb = node.get("joinedTextBlocks") or []
    tb = node.get("textBlocks") or []
    rep = {"page": node.get("sheetPageNumber"), "node_id": node.get("id"), "url": node.get("_url"),
           "image": [W, H], "flags": [], "halves": [], "persons": [], "settlement_marks": [],
           "skipped": {"show_columns": 0, "noise": 0}, "orphans": []}
    if not (W and H) or not jb or len(jb) != len(tb):
        rep["flags"].append(f"count_mismatch:joined={len(jb)},text={len(tb)}")
        return rep
    blks = [Blk(i, j, t) for i, (j, t) in enumerate(zip(jb, tb))]
    for b in blks:
        classify(b)

    nums = [b for b in blks if b.kind in ("num", "frac")]
    if len(nums) < 4:
        rep["flags"].append("no_numbers")
        return rep
    med_h = statistics.median(b.h for b in nums)
    med_w = statistics.median(b.w for b in nums)

    # 1. шапка таблицы (если есть на странице): нижняя граница по словам заголовков
    heads = [b for b in blks if b.kind == "text" and b.cy < 0.35 * H and not re.search(r"\d", b.text)
             and HEADER_WORDS.search(norm(b.text))]
    # низ шапки — по заголовкам столбцов данных (столбцы «Показанія дѣйства» выше и длиннее, их не берём)
    hdr_bottom = max((b.y1 for b in heads if not SKIP_HEAD.search(norm(b.text))), default=0)
    rep["header"] = [b.text for b in sorted(heads, key=lambda b: (b.cy, b.cx))]

    # 2. Основной блок: широкие текстовые блоки со списками людей, сгруппированные по x
    # блок со списком людей может начинаться внутри шапки (верх выше её низа) — берём по нижнему краю
    body = [b for b in blks if (b.cy > hdr_bottom) or (b.kind != "text" and b.cy > hdr_bottom - med_h) or (b.kind == "text" and b.y1 > hdr_bottom + 0.3 * med_h and not HEADER_WORDS.search(norm(b.text)))]
    def letters(s):
        return len(re.findall(r"[^\W\d_]", s))
    settle_blocks = []
    cand = []
    for b in body:
        if b.kind != "text":
            continue
        name, how = settlement_of(b.text)
        if name and letters(b.text) < 45:
            settle_blocks.append((b, name, how))
            continue
        if b.w >= a.main_min_w * W and letters(b.text) >= 10:
            cand.append(b)
    # заголовок НП может стоять и в шапке страницы
    for b in heads + [x for x in blks if x.cy <= hdr_bottom and x.kind == "text"]:
        name, how = settlement_of(b.text)
        if name and all(b is not s[0] for s in settle_blocks):
            settle_blocks.append((b, name, how))
    groups = []
    for b in sorted(cand, key=lambda b: b.cx):
        for g in groups:
            gx0, gx1 = pct([x.x0 for x in g], 0.5), pct([x.x1 for x in g], 0.5)
            ov = min(b.x1, gx1) - max(b.x0, gx0)
            if ov > 0.5 * min(b.w, gx1 - gx0):
                g.append(b)
                break
        else:
            groups.append([b])
    groups = [g for g in groups if len(g) >= 2 or sum(x.h for x in g) > 0.12 * H]
    groups.sort(key=lambda g: -sum(x.h for x in g))
    groups = sorted(groups[: a.max_halves], key=lambda g: pct([x.x0 for x in g], 0.5))
    if not groups:
        rep["flags"].append("no_main_block")
        return rep

    # 3. числа данных (без шапки и шума: номер листа, слишком крупные блоки)
    data_nums = []
    for b in body:
        if b.kind not in ("num", "frac", "multi"):
            continue
        if b.kind != "multi" and (b.h > 2.2 * med_h or b.w > 2.6 * med_w):
            rep["skipped"]["noise"] += 1
            continue
        data_nums.append(b)
    ymid = statistics.median(b.cy for b in data_nums) if data_nums else H / 2

    halves = []
    for gi, g in enumerate(groups):
        mx0 = pct([x.x0 for x in g], 0.25)
        mx1 = pct([x.x1 for x in g], 0.75)
        halves.append({"no": gi + 1, "main": g, "x0": mx0, "x1": mx1})
    # границы зон: слева — до правой границы предыдущей половины; справа — до левой зоны следующей
    for k, hf in enumerate(halves):
        prev_x1 = halves[k - 1]["x1"] if k else 0
        nxt_x0 = halves[k + 1]["x0"] if k + 1 < len(halves) else W
        hf["left_zone"] = (max(prev_x1 + 0.02 * W, hf["x0"] - a.left_zone * W), hf["x0"] + 0.03 * W)
        hf["right_zone"] = (hf["x1"] - 0.04 * W, min(hf["x1"] + a.right_zone * W, nxt_x0 - a.left_zone * W + 0.0 * W if k + 1 < len(halves) else W))

    gap = a.col_gap * med_w
    persons_all = []
    for hf in halves:
        lz, rz = hf["left_zone"], hf["right_zone"]
        left = [b for b in data_nums if lz[0] <= b.cx <= lz[1] and b.kind in ("num", "multi")]
        right = [b for b in data_nums if rz[0] <= b.cx <= rz[1] and b.kind in ("num", "frac")]
        slope = deskew_slope(left + right, 0.15 * med_w, ymid)
        hf["slope"] = slope
        lcols = cluster_columns(left, gap, ymid, slope)
        rcols = cluster_columns(right, gap, ymid, slope)
        # роли слева: ближайшие к Основному блоку три столбца, справа налево: женщины, мужчины, двор
        lcols = [c for c in lcols if len(c["blocks"]) >= 1]
        roles = {}
        pick = lcols[-3:]
        names = ["yard", "m_no", "f_no"][-len(pick):] if pick else []
        if len(pick) == 2:
            # два столбца: редкий левый — это двор (номер стоит только у первого в семье)
            if len(pick[0]["blocks"]) < 0.45 * len(pick[1]["blocks"]):
                names = ["yard", "m_no"]
                rep["flags"].append(f"half{hf['no']}:left_columns_2_sex_unknown")
            else:
                names = ["m_no", "f_no"]
                rep["flags"].append(f"half{hf['no']}:yard_column_not_found")
        for c, nm in zip(pick, names):
            roles[nm] = c
        for c in lcols[:-3]:
            rep["skipped"]["noise"] += len(c["blocks"])
        rpick = rcols[:2]
        rnames = ["age_m", "age_f"][: len(rpick)]
        for c, nm in zip(rpick, rnames):
            roles[nm] = c
        for c in rcols[2:]:
            rep["skipped"]["show_columns"] += len(c["blocks"])
        if len(rpick) < 2:
            rep["flags"].append(f"half{hf['no']}:age_columns_{len(rpick)}")
        hf["columns"] = {nm: {"center_x": round(c["center"]), "center_x_rel": round(c["center"] / W, 4),
                              "slope": round(c["b"], 4), "cells": len(c["blocks"])} for nm, c in roles.items()}

        # 4. люди: номера мужчин и женщин (составной блок «358 359» делится по высоте)
        people = []
        for sex, role in (("M", "m_no"), ("F", "f_no")):
            for b in roles.get(role, {"blocks": []})["blocks"]:
                vals = b.vals
                for k, v in enumerate(vals):
                    hk = b.h / len(vals)
                    cy = b.y0 + hk * (k + 0.5)
                    people.append({"sex": sex, "no": v, "age": "", "cy": cy, "num_id": b.id,
                                   "flags": ["split_cell"] if len(vals) > 1 else []})
        # возраст: пара «номер — возраст» по y. Сдвиг строки между левыми и правыми столбцами зависит от y
        # (поворот и изгиб листа у корешка), поэтому он оценивается прямой shift(y) по надёжным парам,
        # а затем последовательности выравниваются с сохранением порядка (без перекрёстных пар).
        for sex, role in (("M", "age_m"), ("F", "age_f")):
            ages = stable_by_y(roles.get(role, {"blocks": []})["blocks"], 0.15 * med_h)
            cands = sorted([p for p in people if p["sex"] == sex], key=lambda p: p["cy"])
            pairs = sorted(((abs(ag.cy - p["cy"]), i, j) for i, ag in enumerate(ages)
                            for j, p in enumerate(cands)), key=lambda t: t[0])
            used_a, used_p, first = set(), set(), []
            for d, i, j in pairs:
                if d > 1.0 * med_h or i in used_a or j in used_p:
                    continue
                used_a.add(i); used_p.add(j); first.append((ages[i].cy, ages[i].cy - cands[j]["cy"]))
            c0, c1 = shift_line(first, med_h)
            sh = lambda y: c0 + c1 * y
            match = align([ag.cy - sh(ag.cy) for ag in ages], [p["cy"] for p in cands], a.age_tol * med_h)
            used_a = set()
            for i, j in match:
                used_a.add(i)
                cands[j]["age"] = ages[i].vals[0] if ages[i].vals else ages[i].text
                cands[j]["age_id"] = ages[i].id
            for i, ag in enumerate(ages):
                if i not in used_a:
                    people.append({"sex": sex, "no": "", "age": ag.vals[0] if ag.vals else ag.text,
                                   "cy": ag.cy - sh(ag.cy), "age_id": ag.id, "flags": ["age_without_number"]})
        people.sort(key=lambda p: p["cy"])
        # 5. номер двора: к первому человеку двора (ближайший по y), дальше действует вниз
        yards = sorted(roles.get("yard", {"blocks": []})["blocks"], key=lambda b: b.cy)
        for yb in yards:
            for v in yb.vals:
                best = min(people, key=lambda p: abs(p["cy"] - yb.cy), default=None)
                if best is None or abs(best["cy"] - yb.cy) > 1.2 * med_h:
                    rep["orphans"].append({"text": yb.text, "id": yb.id, "why": "yard_without_person"})
                    continue
                if best.get("yard_mark"):
                    best["flags"].append("two_yard_numbers")
                best["yard_mark"] = v
        # 6. Основной блок: человек -> блок по y (самый низкий из содержащих)
        mains = sorted(hf["main"], key=lambda b: b.y0)
        for p in people:
            # глубина: насколько центр строки внутри блока (у края блока решение неустойчиво к округлению)
            depth = {m.id: min(p["cy"] - m.y0, m.y1 - p["cy"]) for m in mains}
            inside = [m for m in mains if depth[m.id] > 0.15 * med_h]
            edge = [m for m in mains if depth[m.id] > -0.3 * med_h]
            if inside:
                m = min(inside, key=lambda m: m.h)
                if len(inside) > 1:
                    p["flags"].append("nested_block")
            elif edge:
                m = max(edge, key=lambda m: depth[m.id])
                p["flags"].append("block_edge")
            else:
                near = sorted(mains, key=lambda m: min(abs(p["cy"] - m.y0), abs(p["cy"] - m.y1)))
                if near and min(abs(p["cy"] - near[0].y0), abs(p["cy"] - near[0].y1)) <= 1.2 * med_h:
                    m = near[0]
                    p["flags"].append("y_near")
                else:
                    m = None
                    p["flags"].append("no_main_block")
            p["block_id"] = m.id if m else None
            p["names_text"] = m.text if m else ""
        # 6а. текст блока -> по людям (по именам в тексте и полу строк), каждый человек — своя строка
        by_block = {}
        for p in people:
            if p["block_id"]:
                by_block.setdefault(p["block_id"], []).append(p)
        for bid, ps in by_block.items():
            parts = split_block(ps[0]["names_text"], [p["sex"] for p in ps])
            for p, (txt, fl) in zip(ps, parts):
                p["person_text"] = txt
                if fl:
                    p["flags"].append("split:" + fl)
        for p in people:
            p.setdefault("person_text", "")
        cnt = {}
        for p in people:
            if p["block_id"]:
                cnt[p["block_id"]] = cnt.get(p["block_id"], 0) + 1
                p["person_in_block"] = cnt[p["block_id"]]
            else:
                p["person_in_block"] = ""
        # 7. проверка: номера мужчин и женщин идут подряд
        for sex in ("M", "F"):
            seq = [int(p["no"]) for p in people if p["sex"] == sex and p["no"]]
            breaks = sum(1 for x, y in zip(seq, seq[1:]) if not (0 < y - x <= 3))
            if seq and breaks:
                rep["flags"].append(f"half{hf['no']}:seq_breaks_{sex}={breaks}/{len(seq)}")
        hf["people"] = people
        hf["settlements"] = sorted(
            [(b.cy, name, how, b.text) for b, name, how in settle_blocks
             if b.x1 > hf["x0"] - 0.05 * W and b.x0 < hf["x1"] + 0.02 * W], key=lambda t: t[0])
        hf["blocks"] = [{"block_id": m.id, "text_block_id": m.tid, "bbox": m.bb(), "names_text": m.text,
                         "persons": cnt.get(m.id, 0)} for m in mains]
        persons_all.append(hf)

    # 8. порядок людей страницы, НП и двор (двор — вниз до следующего номера)
    for hf in persons_all:
        marks = list(hf["settlements"])
        for p in hf["people"]:
            p["settlement_here"] = None
            while marks and marks[0][0] <= p["cy"]:
                _, name, how, text = marks.pop(0)
                rep["settlement_marks"].append({"half": hf["no"], "name": name, "how": how, "text": text})
                p["settlement_here"] = name
            p["half"] = hf["no"]
            rep["persons"].append(p)
        for _, name, how, text in marks:   # заголовок НП ниже последнего человека половины
            rep["settlement_marks"].append({"half": hf["no"], "name": name, "how": how, "text": text, "after_last": True})
        rep["halves"].append({"no": hf["no"], "main_x": [round(hf["x0"]), round(hf["x1"])],
                              "main_x_rel": [round(hf["x0"] / W, 4), round(hf["x1"] / W, 4)],
                              "columns": hf["columns"], "blocks": hf["blocks"], "people": len(hf["people"])})
    for p in rep["persons"]:
        p["cy"] = round(p["cy"])
    rep["median_number_h"] = med_h
    if rep["orphans"]:
        rep["flags"].append(f"orphans:{len(rep['orphans'])}")
    return rep


def resolve_settlement(name, cur, year):
    """заголовок НП не распознан (other:…) — следующий по порядку НП округи (порядок зависит от года)"""
    if not name.startswith("other:"):
        return name, ""
    order = ORDER_BEFORE_1750 if (year and year < 1750) else ORDER_FROM_1750
    if cur in order and order.index(cur) + 1 < len(order):
        return order[order.index(cur) + 1], f"НП определён по порядку (заголовок «{name[6:]}» не распознан)"
    return "чужой НП: " + name[6:], ""


def assign_running(pages, year=None):
    """двор и населённый пункт по порядку страниц (двор и НП действуют, пока не встретится следующий)"""
    cur_s, cur_y = None, ""
    for rep in pages:
        for p in rep.get("persons", []):
            if p.get("settlement_here"):
                cur_s, note = resolve_settlement(p["settlement_here"], cur_s, year)
                if note:
                    p["flags"].append(note)
                cur_y = ""
            if p.get("yard_mark"):
                cur_y = p["yard_mark"]
            p["settlement"] = cur_s or "не определён (начало диапазона)"
            p["yard"] = cur_y
        for m in rep.get("settlement_marks", []):
            if m.get("after_last"):
                cur_s, cur_y = resolve_settlement(m["name"], cur_s, year)[0], ""


def csv_rows(rep, year=None):
    for p in rep.get("persons", []):
        yield {"year": year or "", "page": rep.get("page"), "half": p.get("half"), "settlement": p.get("settlement", ""),
               "yard": p.get("yard", ""), "person_text": p.get("person_text", ""),
               "sex": "м" if p["sex"] == "M" else "ж", "no": p.get("no", ""),
               "age": p.get("age", ""), "birth_year": birth_year(year, p.get("age")),
               "person_in_block": p.get("person_in_block", ""),
               "block_id": p.get("block_id") or "", "names_text": p.get("names_text", ""),
               "flags": ";".join(p.get("flags", []))}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="файлы .json/.html или папки")
    ap.add_argument("--out-json", default="confession_pages.json")
    ap.add_argument("--out-csv", default="confession_people.csv")
    ap.add_argument("--main-min-w", type=float, default=0.08, help="мин. ширина блока Основного столбца, доля ширины скана")
    ap.add_argument("--left-zone", type=float, default=0.14, help="ширина зоны трёх левых столбцов, доля ширины скана")
    ap.add_argument("--right-zone", type=float, default=0.09, help="ширина зоны двух столбцов возраста, доля ширины скана")
    ap.add_argument("--col-gap", type=float, default=0.35, help="разрыв между столбцами, доля медианной ширины числа")
    ap.add_argument("--age-tol", type=float, default=0.8, help="допуск по y для пары номер-возраст, доля высоты числа")
    ap.add_argument("--year", type=int, default=None, help="год документа (порядок НП: до 1750 / с 1750)")
    ap.add_argument("--max-halves", type=int, default=2, help="сколько листов на скане (разворот = 2)")
    a = ap.parse_args()

    files = []
    for p in a.inputs:
        p = Path(p)
        files += sorted(f for f in p.rglob("*") if f.suffix in (".json", ".html")) if p.is_dir() else [p]
    pages = []
    for f in files:
        try:
            rep = process(load_node(f), a)
        except Exception as e:  # одна битая страница не останавливает пакет
            rep = {"page": None, "flags": [f"error:{type(e).__name__}:{e}"], "persons": [], "halves": []}
        rep["source"] = str(f)
        pages.append(rep)
    assign_running(pages, a.year)
    n = 0
    with open(a.out_csv, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLS)
        w.writeheader()
        for rep in pages:
            for row in csv_rows(rep, a.year):
                w.writerow(row); n += 1
            cols = "; ".join(f"лист {h['no']}: " + ", ".join(f"{k}={v['cells']}" for k, v in h["columns"].items())
                             for h in rep.get("halves", []))
            print(f"стр. {rep.get('page')}: людей {len(rep.get('persons', []))} | {cols} | флаги: {rep['flags'] or '-'}")
    Path(a.out_json).write_text(json.dumps(pages, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"готово: {len(pages)} стр., {n} человек -> {a.out_csv}, {a.out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
