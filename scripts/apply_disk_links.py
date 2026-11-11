#!/usr/bin/env python3
"""Ссылки на Яндекс Диск в ручных страницах библиотеки.

Что делает
    Сгенерированные страницы ставят ссылки на Диск сами (scripts/generate_pages.py
    берёт их из data/links.json). Ручные страницы из MANUAL_PAGES генератор не
    трогает — этот скрипт меняет в них ссылки на файлы, которые уже загружены на
    Диск (scripts/yadisk_upload.py):
        href файла            → публичная ссылка Диска
        «скачать» с download  → новая вкладка (чужой адрес браузер не скачивает)
    и ставит под первый экран страницы ту же плашку про VPN, что генератор
    (после метки <!-- /hero -->).
    Остальная разметка не меняется. Повторный запуск ничего не меняет, так что
    после каждой новой загрузки на Диск его можно просто запустить ещё раз.

Как запускать (из любой папки)
    python3 scripts/apply_disk_links.py
"""

import os
import re
import sys
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_pages import (DISK_NOTE, HERO_END, MANUAL_PAGES, BASE, attr,  # noqa: E402
                            disk_links, read, write_if_changed)

NOTE_MARK = "Если файл не открывается — выключите VPN."


def rewrite(rel_path, text):
    """Текст страницы со ссылками на Диск и число заменённых ссылок."""
    base_dir = os.path.dirname(rel_path)
    links = disk_links()
    replaced = 0

    def fix(match):
        nonlocal replaced
        tag = match.group(0)
        href = re.search(r'\shref="([^"]*)"', tag)
        if not href or re.match(r"^[a-z]+:", href.group(1)):
            return tag
        target = os.path.normpath(os.path.join(base_dir, unquote(re.split(r"[?#]", href.group(1))[0])))
        url = links.get(target)
        if not url:
            return tag
        replaced += 1
        tag = tag.replace(href.group(0), f' href="{attr(url)}"', 1)
        tag = re.sub(r"\sdownload(?=[\s>])", "", tag)
        if "target=" not in tag:
            tag = tag[:-1] + ' target="_blank" rel="noopener">'
        return tag

    text = re.sub(r"<a\b[^>]*>", fix, text)
    if replaced or any(url in text for url in links.values()):
        if NOTE_MARK not in text and HERO_END in text:
            # В странице каркас сдвинут на 4 пробела глубже, чем в шаблоне.
            note = DISK_NOTE.replace("\n", "\n    ")
            text = text.replace(HERO_END, HERO_END + note, 1)
    return text, replaced


def main():
    if not disk_links():
        print("В data/links.json пока нет ссылок — сначала scripts/yadisk_upload.py.")
        return 1
    total = 0
    for rel_path in MANUAL_PAGES:
        if not os.path.exists(os.path.join(BASE, rel_path)):
            continue
        text, replaced = rewrite(rel_path, read(rel_path))
        if write_if_changed(rel_path, text):
            print(f"  обновлено: {rel_path} — ссылок на Диск: {replaced}")
        total += replaced
    print(f"Готово: заменено ссылок {total}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
