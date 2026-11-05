#!/usr/bin/env python3
"""Собирает базу данных yaarchive_db.sqlite для скиллов анализа и отчётов.
Вход: Итог_люди.xlsx (yaarchive 3.2.0, исповедные ведомости) и xlsx ревизской сказки.
Слитые ячейки (год, двор, ссылка на страницу, скан) разворачиваются на каждую строку.
Запуск: python3 build_db.py Итог_люди.xlsx Ревизская_сказка.xlsx yaarchive_db.sqlite"""
import sys, os, re, sqlite3, datetime
import openpyxl

CONF = {'Год': 'year', 'Документ': 'document', 'Населённый пункт': 'settlement', 'Двор / семья №': 'household_no', 'Номер': 'person_no',
        'Человек (как распознано)': 'person_text', 'Имя': 'given_name', 'Отчество': 'patronymic', 'Фамилия': 'surname', 'Пол': 'sex',
        'Возраст': 'age', 'Возраст по прошлой ревизии': 'age_prev_revision', 'Год рождения': 'birth_year', 'Родство': 'relation',
        'Статус': 'status', 'Выбытие / примечание': 'note', 'Проверить': 'to_check', 'Исправлено': 'corrected', 'ID': 'id',
        'ID отца / мужа': 'father_or_husband_id', 'Ссылка на страницу': 'page_url', 'Ссылка на ЦГА Москвы': 'archive_path'}
REV = {'Скан': 'scan', 'Селение': 'village', 'Семья №': 'family_no', 'Пол': 'sex', 'ФИО': 'person_text', 'Отношение к главе': 'relation_to_head',
       'Лет по 8-й рев. (1834)': 'age_1834', 'Лет в 1850': 'age_1850', 'Выбытие / примечание': 'note', 'Сословие': 'estate'}
PAGES = {'Год': 'year', 'Документ': 'document', 'Тип определён': 'doc_type_by', 'Страница': 'page', 'Людей': 'people', 'Замечания': 'remarks', 'Ссылка': 'page_url'}
FAMS = {'Год': 'year', 'Документ': 'document', 'Населённый пункт': 'settlement', 'Двор / семья №': 'household_no', 'Людей': 'people', 'Мужчин': 'males',
        'Женщин': 'females', 'Глава': 'head', 'Состав': 'members'}
CHECKS = {'Год': 'year', 'Страница': 'page', 'Человек': 'person', 'ID': 'id', 'Что проверить': 'what', 'Ссылка': 'page_url'}

def sheet(wb, name):
    ws = wb[name]
    # в столбцах «Ссылка…» текст («стр. 865») заменяется адресом гиперссылки
    rows = [[(c.hyperlink.target if (c.hyperlink and c.hyperlink.target) else c.value) for c in r] for r in ws.iter_rows()]
    for m in ws.merged_cells.ranges:                      # развернуть слитые ячейки
        v = rows[m.min_row - 1][m.min_col - 1]
        for r in range(m.min_row, m.max_row + 1):
            for c in range(m.min_col, m.max_col + 1):
                rows[r - 1][c - 1] = v
    return rows[0], [r for r in rows[1:] if any(x not in (None, '') for x in r)]

def load(con, tbl, wb, name, mp):
    h, rows = sheet(wb, name)
    keep = [(i, mp[x]) for i, x in enumerate(h) if x in mp]
    con.execute(f'create table {tbl} (' + ','.join(f'"{n}"' for _, n in keep) + ')')
    con.executemany(f'insert into {tbl} values (' + ','.join('?' * len(keep)) + ')',
                    [[r[i] if r[i] is None or isinstance(r[i], (int, float)) else str(r[i]) for i, _ in keep] for r in rows])
    return len(rows)

def main(conf, rev, out):
    if os.path.exists(out): os.remove(out)
    con = sqlite3.connect(out)
    wc = openpyxl.load_workbook(conf); wr = openpyxl.load_workbook(rev)
    n = {'confession_people': load(con, 'confession_people', wc, 'Люди', CONF),
         'confession_families': load(con, 'confession_families', wc, 'Семьи', FAMS),
         'confession_pages': load(con, 'confession_pages', wc, 'Страницы', PAGES),
         'confession_checks': load(con, 'confession_checks', wc, 'Проверка', CHECKS),
         'revision_people': load(con, 'revision_people', wr, 'Люди', REV)}
    for sql in ('create index ix_cp_year on confession_people(year)', 'create index ix_cp_settlement on confession_people(settlement)',
                'create index ix_cp_surname on confession_people(surname)', 'create index ix_cp_id on confession_people(id)',
                'create index ix_rp_village on revision_people(village)'):
        con.execute(sql)
    con.execute('create table meta(key text primary key, value text)')
    meta = {'schema_version': '1', 'built': datetime.date.today().isoformat(),
            'confession_source': 'yaarchive 3.2.0, итог от 29.10.2026 (пакет расширения 2.3.0, 992 страницы, 44 документа; ЦГА Москвы ф.203 оп.747 и ф.51 оп.8 д.34)',
            'revision_source': 'Ревизская сказка 1850, ЦГА Москвы ф.51 оп.8 д.588, сканы 130–225 (имение Бутурлина)'}
    meta.update({'rows_' + k: str(v) for k, v in n.items()})
    con.executemany('insert into meta values (?,?)', meta.items())
    con.commit(); con.execute('vacuum'); con.close()
    print(n, round(os.path.getsize(out) / 1e6, 1), 'MB')

if __name__ == '__main__':
    main(*sys.argv[1:4])
