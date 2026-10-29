"""Сборка общего скрипта в один файл: python build.py -> dist/yaarchive.pyz (+ файлы запуска двойным щелчком)."""
import shutil
import stat
import zipapp
from pathlib import Path

HERE = Path(__file__).resolve().parent
SK = HERE.parent / "skill" / "yaarchive-revision-rows" / "scripts"
DIST = HERE / "dist"
MODULES = [HERE / "yaarchive.py", HERE / "ya_out.py", HERE / "ya_fix.py", HERE / "справочники.json",
           SK / "extract_confession.py", SK / "extract_rows.py", SK / "revision_people.py", SK / "split_names.py"]

COMMAND = """#!/bin/bash
# yaarchive — двойной щелчок (macOS): следить за этой папкой и обрабатывать новые пакеты расширения
cd "$(dirname "$0")"
PY=$(command -v python3)
if [ -z "$PY" ]; then
  echo "Не найден Python 3. Установите его с https://www.python.org/downloads/ (или: xcode-select --install) и запустите снова."
  read -p "Нажмите Enter…"; exit 1
fi
"$PY" yaarchive.pyz "$@"
"""
BAT = """@echo off
rem yaarchive — двойной щелчок (Windows): следить за этой папкой и обрабатывать новые пакеты расширения
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (py -3 "%~dp0yaarchive.pyz" %*) || (python "%~dp0yaarchive.pyz" %*)
pause
"""


def main():
    tmp = DIST / "_src"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for m in MODULES:
        shutil.copy(m, tmp / m.name)
    (tmp / "__main__.py").write_text("import sys\nimport yaarchive\nsys.exit(yaarchive.main())\n", encoding="utf-8")
    out = DIST / "yaarchive.pyz"
    zipapp.create_archive(tmp, out, interpreter="/usr/bin/env python3", compressed=True)
    shutil.rmtree(tmp)
    (DIST / "yaarchive_запуск.command").write_text(COMMAND, encoding="utf-8")
    (DIST / "yaarchive_запуск.bat").write_text(BAT.replace("\n", "\r\n"), encoding="utf-8")
    for f in (out, DIST / "yaarchive_запуск.command"):
        f.chmod(f.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(out, out.stat().st_size, "байт")


if __name__ == "__main__":
    main()
