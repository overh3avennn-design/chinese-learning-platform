#!/usr/bin/env python3
"""Обложки материалов библиотеки для карточек разделов.

Что делает
    Берёт первую страницу каждого файла материалов из library/ (PDF, DOCX,
    PPTX, картинки) и кладёт её картинкой в
    images/previews/<имя файла>.jpg. Карточку с этой обложкой рисует
    scripts/generate_pages.py — он ищет картинку по имени файла, так что
    в content.json обложку указывать не нужно.

Как запускать (из любой папки)
    python3 scripts/make_previews.py            собрать недостающие обложки
    python3 scripts/make_previews.py --force    пересобрать все

Чем рисует
    Системным Quick Look (qlmanage) и sips — оба уже есть в macOS, ставить
    ничего не нужно. На другой системе скрипт не заработает: тогда положите
    картинки в images/previews/ вручную, имя — как у файла, расширение .jpg.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREVIEW_DIR = os.path.join(BASE, "images", "previews")
# Расширения материалов, для которых Quick Look умеет показать первую страницу.
SOURCES = ("pdf", "docx", "doc", "pptx", "ppt", "png", "jpg", "jpeg")
WIDTH = 560          # ширина картинки: карточка уже, запас на retina
QUALITY = 78         # JPEG: на глаз без артефактов, ~60–100 КБ на обложку


def render(pdf_paths, out_dir):
    """Первая страница каждого PDF -> <out_dir>/<имя>.pdf.png."""
    subprocess.run(["qlmanage", "-t", "-s", "900", "-o", out_dir] + pdf_paths,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def to_jpeg(png, jpg):
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(QUALITY),
                    "--resampleWidth", str(WIDTH), png, "--out", jpg],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="пересобрать уже существующие обложки")
    args = ap.parse_args(argv)

    if not shutil.which("qlmanage") or not shutil.which("sips"):
        print("Нужны qlmanage и sips — они есть только в macOS.", file=sys.stderr)
        return 1

    os.makedirs(PREVIEW_DIR, exist_ok=True)
    pdfs = sorted(f for ext in SOURCES
                  for f in glob.glob(os.path.join(BASE, f"library/**/*.{ext}"), recursive=True))
    todo = [p for p in pdfs
            if args.force or not os.path.isfile(
                os.path.join(PREVIEW_DIR, os.path.splitext(os.path.basename(p))[0] + ".jpg"))]
    if not todo:
        print(f"Обложки на месте: {len(pdfs)} файлов, собирать нечего.")
        return 0

    made = 0
    with tempfile.TemporaryDirectory() as tmp:
        # qlmanage умеет несколько файлов за раз — так заметно быстрее.
        render(todo, tmp)
        for pdf in todo:
            name = os.path.splitext(os.path.basename(pdf))[0]
            png = os.path.join(tmp, os.path.basename(pdf) + ".png")
            if not os.path.isfile(png):
                print(f"  не удалось: {os.path.relpath(pdf, BASE)}")
                continue
            to_jpeg(png, os.path.join(PREVIEW_DIR, name + ".jpg"))
            made += 1
    print(f"Обложек собрано: {made} из {len(todo)}. Всего материалов в library/: {len(pdfs)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
