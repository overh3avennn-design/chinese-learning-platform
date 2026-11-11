#!/usr/bin/env python3
"""Генератор однотипных страниц библиотеки из content.json.

Что делает
    Читает content.json из корня проекта (а также data/resources.json и
    словари data/vocab/, которые собирает scripts/fetch_data.py) и собирает
    по шаблонам ниже:
        library/hsk-N/index.html                обзор уровня   (levels)
        library/hsk-N/<стандарт>/<раздел>.html  разделы        (levels × standards × hsk_sections)
        library/additional/<slug>.html          доп. материалы (additional)
        library/practice/<slug>.html            практика       (practice)

    Уровень живёт в двух стандартах экзамена — HSK 2.0 (старый) и HSK 3.0
    (новый), см. ключ "standards". Разделы у каждого стандарта свои и лежат
    в своей папке: library/hsk-1/2.0/phonetics.html. Обзор уровня — главная
    страница уровня: на ней сразу лежат все материалы обоих стандартов,
    разложенные по заголовкам разделов, так что выбирать раздел, чтобы
    увидеть его содержимое, не нужно. Страницы разделов остаются как
    отдельные адреса, на них ведут эти заголовки. Ступень 7–9 есть только
    в HSK 3.0, так что стандарты уровня нужно перебирать через
    level_standards(), а не по всему списку standards.
    Шапка — общий компонент components/site-header: страница подключает его
    стили в <head> и скрипт первой строкой <body>, разметку и меню вставляет
    скрипт. Каркас страницы (боковые поля темы v2 и <main class="page">) ставит
    shell(), стили темы — css/theme.css. Футер одинаковый на всех страницах
    (у словаря и ИИ-помощника своя третья ячейка); относительные ссылки
    считаются от глубины страницы (depth_prefix). Файл перезаписывается,
    только если его содержимое изменилось, поэтому повторный запуск
    ничего не меняет.

Как запускать (из любой папки)
    python3 scripts/generate_pages.py           собрать страницы
    python3 scripts/generate_pages.py --check   ничего не записывая, сверить <head>,
                                                подключение шапки и футер ручных страниц
                                                с шаблоном и показать устаревшие
                                                сгенерированные

Что НЕ трогает
    Всё, чего нет в content.json: главную (index.html), library/index.html,
    library/roadmap.html, library/textbooks/, library/materials/, library/journals/, library/grammar/, library/culture/,
    library/additional/index.html, library/practice/index.html,
    library/practice/speaking.html, support/, flashcards/, assistant/, а также css/, js/, images/ и файлы
    материалов. Страницы, убранные из content.json, не удаляются — удалите сами.
    Правки вручную в сгенерированных страницах будут затёрты: меняйте content.json.

Пункты (items) в content.json
    {"label": "...", "file": "library/hsk-1/x.pdf"}  карточка файла: обложка и название
                                                     открывают файл, кнопки «Открыть» и «Скачать».
                                                     Если файл загружен на Яндекс Диск (ссылка
                                                     есть в data/links.json), всё это ведёт на Диск
    {"label": "...", "url": "https://..."}          внешняя ссылка, открывается в новой вкладке
    {"label": "...", "type": "Статья"}              заготовка: на сайт не выводится
    "type" — метка типа (у url по умолчанию «Внешняя ссылка»), "desc" — короткое
    описание под названием карточки, "link_text" — текст ссылки у url (по
    умолчанию «Перейти на сайт»). Пустой список items — заглушка.

    Свои файлы и внешние ссылки выводятся разными блоками: файлы — карточками
    с обложкой под заголовком «Содержание раздела», ссылки — списком под
    заголовком «Полезные ссылки по теме» ниже. Обложку карточка берёт сама из
    images/previews/<имя файла>.jpg (собирает scripts/make_previews.py); если
    картинки нет, на её месте плашка с расширением файла. Поле "preview"
    задаёт другой путь к картинке.
    Пункт без url и file — заготовка на будущее (см. has_link): в «Содержание
    раздела» он не попадает, а сам раздел на обзоре уровня уходит в строку
    «Пока пусто» одной ссылкой. Если открыть в разделе нечего, на его странице
    вместо пустого списка стоит заглушка «Раздел в процессе наполнения». Такие пункты остаются в
    content.json и перечислены в конце вывода --check, чтобы не забыть про них.
    Текст экранируется: HTML-теги в content.json выводятся как текст.

Словарь уровня и внешние ссылки
    "data": "data/vocab/hsk-1-2.0.csv" и "pdf": "library/hsk-1/….pdf" у раздела
    "vocabulary" внутри стандарта — на странице появятся ссылки на список слов
    (PDF для печати и CSV для Anki) и пометка о том, что перевод машинный.
    В CSV лежат новые слова этого уровня, а не весь словарь до него. Сами файлы
    собирают scripts/fetch_data.py и scripts/make_vocab_pdf.py; пока PDF не
    собран, ссылки на него нет, а --check про него напоминает.
    Ссылки из data/resources.json подставляются в разделы, указанные в их полях
    "levels" и "sections", и, если у записи есть "standards", только в тот
    стандарт; запись с "resources": true в content.json
    собирает весь каталог на одной странице. Недоступные ссылки (status не
    "ok") на сайт не попадают.
"""

import csv
import difflib
import functools
import glob
import html
import json
import os
import re
import sys
from urllib.parse import quote, unquote

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(BASE, "content.json")
RESOURCES = os.path.join(BASE, "data", "resources.json")

# Списки слов собирает scripts/fetch_data.py, PDF — scripts/make_vocab_pdf.py.
VOCAB_NOTE = ("Перевод на русский в списках слов подготовлен автоматически и может содержать "
              "неточности. Иероглифы и пиньинь — из официальных списков HSK.")

# Публичные ссылки на материалы на Яндекс Диске: «library/…» → «https://disk.yandex.ru/i/…».
# Собирает scripts/yadisk_upload.py. Файл со ссылкой открывается с Диска, без
# неё — с сайта, как раньше.
LINKS = os.path.join(BASE, "data", "links.json")
# Плашка про VPN на страницах, где есть файлы с Диска, — встаёт под первым
# экраном (метка HERO_END). Её же ставит в ручные страницы
# scripts/apply_disk_links.py; сама разметка — DISK_NOTE ниже, рядом с note().
DISK_NOTE_TEXT = ("<b>Если файл не открывается — выключите VPN.</b> Материалы хранятся "
                  "на Яндекс Диске, а Яндекс часто не пускает подключения через VPN.")
HERO_END = "<!-- /hero -->"

# Иероглифы и пиньинь названий — справа от заголовка страницы и в списках.
LEVEL_ZH = {
    "hsk-1": ("一级", "yī jí"), "hsk-2": ("二级", "èr jí"), "hsk-3": ("三级", "sān jí"),
    "hsk-4": ("四级", "sì jí"), "hsk-5": ("五级", "wǔ jí"), "hsk-6": ("六级", "liù jí"),
    "hsk-7-9": ("七至九级", "qī zhì jiǔ jí"),
}
SECTION_ZH = {
    "phonetics": ("语音", "yǔyīn"), "grammar": ("语法", "yǔfǎ"), "characters": ("汉字", "hànzì"),
    "vocabulary": ("词汇", "cíhuì"), "speaking": ("口语", "kǒuyǔ"), "culture": ("文化", "wénhuà"),
    "materials": ("教材", "jiàocái"),
}
# Первые слова заголовков, которые не пишутся со строчной (lower_first).
KEEP_CAPS = {"Хань"}

# Страницы, собранные вручную. Генератор никогда в них не пишет.
MANUAL_PAGES = [
    "index.html",
    "library/index.html",
    "library/roadmap.html",
    "library/textbooks/index.html",
    "library/textbooks/rukodelnikova.html",
    "library/textbooks/practical-course.html",
    "library/textbooks/hanyu-jiaocheng.html",
    "library/textbooks/spoken-chinese.html",
    "library/textbooks/materials.html",
    "library/textbooks/exam-tickets.html",
    "library/materials/index.html",
    "library/journals/index.html",
    "library/grammar/index.html",
    "library/culture/index.html",
    "library/culture/films.html",
    "library/additional/index.html",
    "library/practice/index.html",
    "library/practice/speaking.html",
    "support/contacts.html",
    "flashcards/index.html",
    "assistant/index.html",
    "dictionary/index.html",
]

HOME_PAGE = "index.html"
# Общая шапка сайта: стили — в <head>, скрипт — первой строкой <body>.
HEADER_CSS = "components/site-header/header.css"
HEADER_JS = "components/site-header/header.js"
# Весь скрипт сайта — один файл js/main.js, одинаковый на всех страницах.
PAGE_SCRIPTS = ["js/main.js"]
# Шрифты темы: Onest — интерфейс, Noto Sans SC — иероглифы.
FONTS_URL = ("https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700"
             "&family=Noto+Sans+SC:wght@300;400&display=swap")
# Подвал: страница «Контакты» и Telegram.
CONTACTS_PAGE = "support/contacts.html"
TELEGRAM_URL = "https://t.me/easily_chinesly"
TELEGRAM_NAME = "@easily_chinesly"
# Боковые поля страниц библиотеки (видны на широком окне): слева столбик
# бледных иероглифов раздела и подпись, справа — вторая подпись.
RAIL = {
    "hanzi": "材料库",
    "left": "все материалы — по уровням и разделам",
    "right": "учебники · материалы · культура",
}

# Оформление страниц additional/ и practice/: крошка, кнопка «назад»,
# подзаголовок, заглушка.
COLLECTIONS = {
    "additional": {
        "crumb": "Дополнительные",
        "back": "Дополнительные материалы",
        "subtitle": "Дополнительные материалы · Все уровни",
        "placeholder": "Добавьте материалы в этот раздел: справочники, статьи, ссылки на видео.",
    },
    "practice": {
        "crumb": "Практика",
        "back": "Практика и контекст",
        "subtitle": "Практика и контекст",
        "placeholder": "Добавьте тексты, диалоги, ссылки на аудио и видео.",
        # Ручные страницы подборки: (место в списке, адрес, название).
        "manual": [(2, "speaking", "Упражнения на говорение")],
    },
}

ITEM_KEYS = {"label", "file", "url", "type", "link_text", "desc", "preview"}
SECTION_KEYS = {"items", "data", "pdf"}
STANDARD_KEYS = {"id", "dir", "title", "label", "desc"}
LEVEL_STANDARD_KEYS = {"subtitle", "next", "sections"}


def depth_prefix(rel_depth):
    return "../" * rel_depth


@functools.lru_cache(maxsize=None)
def disk_links():
    """Ссылки на Диск из data/links.json; пустой словарь, пока туда ничего не загружено."""
    if not os.path.exists(LINKS):
        return {}
    with open(LINKS, encoding="utf-8") as f:
        return json.load(f)


def file_href(path, depth):
    """Адрес файла материала: ссылка на Диск, если файл загружен, иначе путь на сайте."""
    return disk_links().get(path) or depth_prefix(depth) + quote(path)


def on_disk(path):
    return path in disk_links()


def level_standards(content, level):
    """[(стандарт, его блок уровня)] в порядке, заданном content["standards"].

    У уровней 1–6 стандарта два, у ступени 7–9 — только HSK 3.0, поэтому
    перебирать нужно то, что у уровня действительно есть.
    """
    return [(std, level["standards"][std["id"]])
            for std in content["standards"] if std["id"] in level["standards"]]


def esc(text):
    return html.escape(text, quote=False)


def attr(value):
    return html.escape(value, quote=True)


# ---------------------------------------------------------------- шаблоны

def head(title, depth):
    p = depth_prefix(depth)
    return f'''<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>{esc(title)} — chineasy</title>
  <meta name="theme-color" content="#D6DBE6">
  <link rel="icon" href="{p}favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" sizes="32x32" href="{p}favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="{p}favicon-192.png">
  <link rel="apple-touch-icon" href="{p}apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="{FONTS_URL}" rel="stylesheet">
  <link rel="stylesheet" href="{p}css/theme.css">
  <link rel="stylesheet" href="{p}css/style.css">
  <link rel="stylesheet" href="{p}{HEADER_CSS}">
</head>
<body>
  <script src="{p}{HEADER_JS}"></script>
'''


def shell(main):
    """Каркас страницы: боковые поля (видны на широком окне) и контент между ними.

    main — содержимое страницы без тега <main>; здесь оно получает отступ и
    встаёт в <main class="page"><div class="container">.
    """
    hanzi = "".join(f"<span>{ch}</span>" for ch in RAIL["hanzi"])
    size = " rail__hanzi--3" if len(RAIL["hanzi"]) > 2 else ""
    body = "\n".join("    " + line if line.strip() else line
                     for line in main.strip("\n").split("\n"))
    return f'''  <div class="layout">
    <aside class="rail rail--left" aria-hidden="true">
      <div class="rail__hanzi{size}" lang="zh-CN">{hanzi}</div>
      <div class="rail__text">{RAIL["left"]}</div>
    </aside>
    <main class="page">
      <div class="container">
{body}
      </div>
    </main>
    <aside class="rail rail--right" aria-hidden="true">
      <div class="rail__text">{RAIL["right"]}</div>
      <span class="rail__dot"></span>
    </aside>
  </div>
'''


def footer(content, depth):
    p = depth_prefix(depth)
    script_tags = "".join(f'''
  <script src="{p}{src}"></script>''' for src in PAGE_SCRIPTS)
    return f'''
  <footer class="site-footer">
    <div class="site-footer__brand">
      <a class="site-footer__logo" href="{p}index.html"><span class="seal seal--sm" lang="zh-CN" aria-hidden="true">中</span>chineasy.</a>
      <small>образовательная платформа · V2</small>
    </div>
    <div>
      <small><a href="{p}{CONTACTS_PAGE}">контакты</a></small>
      <span>Telegram: <a href="{TELEGRAM_URL}" target="_blank" rel="noopener">{TELEGRAM_NAME}</a></span>
    </div>
    <div>
      <small>платформа</small>
      <span>Есть пожелания к платформе — пишите в Telegram.</span>
    </div>
  </footer>{script_tags}
</body>
</html>
'''


def page(content, rel_path, title, main):
    depth = rel_path.count("/")
    return head(title, depth) + shell(with_disk_note(main)) + footer(content, depth)


def with_disk_note(main):
    """Плашка про VPN под первым экраном, если хоть один файл страницы открывается с Диска."""
    if not any(url in main for url in disk_links().values()):
        return main
    return main.replace(HERO_END, HERO_END + DISK_NOTE, 1)


def has_link(item):
    """Пункт можно открыть или скачать: за ним стоит файл или внешняя ссылка.

    Пункт без "url" и "file" — заготовка на будущее: подпись с меткой типа
    («Таблица слогов пиньинь · PDF»), за которой ничего нет. На страницу
    такие пункты не выводятся, иначе раздел выглядит наполненным, а по
    строчкам нечего нажать.
    """
    return "url" in item or "file" in item


# ------------------------------------------------- значки и мелкие части

def icon(body, size=18, cls=""):
    """Контурный значок темы: stroke 1.6, без заливки."""
    cls_attr = f' class="{cls}"' if cls else ""
    return (f'<svg{cls_attr} width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{body}</svg>')


ARROW = icon('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', cls="row__arrow")
ARROW_DOWN = icon('<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>', cls="row__arrow")
ARROW_OUT = icon('<path d="M7 17 17 7"/><path d="M8 7h9v9"/>', cls="row__arrow")
ICON_WARN = icon('<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/>', size=20, cls="note__icon")


def lower_first(text):
    """Заголовок со строчной буквы — по правилу темы.

    Имена собственные и аббревиатуры остаются как есть: слово из KEEP_CAPS,
    слово целиком из заглавных (HSK) или с цифрой.
    """
    first = text.split(" ", 1)[0]
    if first in KEEP_CAPS or first.isupper() or any(ch.isdigit() for ch in first):
        return text
    return text[:1].lower() + text[1:]


def zh_pinyin(pair):
    """«语法 · yǔfǎ» — иероглифы и пиньинь через точку."""
    return f'<span lang="zh-CN">{pair[0]}</span> · <span lang="zh-Latn">{pair[1]}</span>'


def crumbs(trail):
    """Хлебные крошки: [(подпись, ссылка или None)], последний пункт — текущая страница."""
    parts = []
    for i, (label, href) in enumerate(trail):
        if i == len(trail) - 1:
            parts.append(f'<span aria-current="page">{label}</span>')
        elif href:
            parts.append(f'<a href="{href}">{label}</a>')
        else:
            parts.append(f"<span>{label}</span>")
    sep = '<span aria-hidden="true">/</span>'
    return f'''
    <nav class="crumbs" aria-label="Навигация">
      {sep.join(parts)}
    </nav>'''


def hero(title, lead, zh=None, meta="", side=""):
    """Первый экран страницы: панель с заголовком слева и списком справа.

    zh — (иероглифы, пиньинь) названия страницы, meta — строка над абзацем,
    side — готовая разметка правой ячейки. После панели стоит метка
    <!-- /hero -->: под неё встаёт плашка про VPN (with_disk_note и
    scripts/apply_disk_links.py).
    """
    long_title = " page-title--long" if len(title) > 16 else ""
    pinyin = f'''
          <p class="title-pinyin"><b lang="zh-Latn">{zh[1]}</b><span lang="zh-CN">{zh[0]}</span></p>''' if zh else ""
    meta_line = f'''
        <p class="hero-meta">{meta}</p>''' if meta else ""
    solo = "" if side else " panel--solo"
    return f'''

    <section class="panel panel--hero{solo}">
      <div class="panel__main">
        <div class="title-row">
          <h1 class="page-title{long_title}">{title}</h1>{pinyin}
        </div>{meta_line}
        <p class="lead">{lead}</p>
        <span class="sun" aria-hidden="true"></span>
      </div>{side}
    </section>
    {HERO_END}'''


def side_list(title, rows):
    """Правая ячейка панели: заголовок и строки [(подпись, справа, ссылка, текущая)]."""
    out = ""
    for i, (label, right, href, current) in enumerate(rows, 1):
        inner = (f'<span class="side-row__num">{i:02d}</span>'
                 f'<span class="side-row__title">{label}</span>'
                 f'<span class="side-row__note">{right}</span>')
        if current:
            out += f'''
        <div class="side-row" aria-current="page">{inner}</div>'''
        elif href:
            out += f'''
        <a class="side-row" href="{href}">{inner}</a>'''
        else:
            out += f'''
        <div class="side-row">{inner}</div>'''
    return f'''
      <div class="panel__side">
        <h2 class="panel__head">{title}</h2>{out}
      </div>'''


def note(text, cls=""):
    """Плашка-примечание: значок и текст (HTML)."""
    extra = f" {cls}" if cls else ""
    return f'''
    <p class="note{extra}" role="note">
      {ICON_WARN}
      <span>{text}</span>
    </p>'''


DISK_NOTE = note(DISK_NOTE_TEXT)


# ------------------------------------------------- строки материалов

def render_item(item, depth, num):
    """Внешняя ссылка или файл без карточки — строка, нажимается целиком."""
    item_type = item.get("type")
    if "url" in item:
        item_type = item_type or "Внешняя ссылка"
        href, target, arrow = attr(item["url"]), ' target="_blank" rel="noopener"', ARROW_OUT
    else:
        href = attr(file_href(item["file"], depth))
        target = ' target="_blank" rel="noopener"' if on_disk(item["file"]) else ""
        arrow = ARROW
    # Без метки строка короче на колонку: номер | текст | стрелка.
    tag = f'''
            <span class="row__tags"><span class="tag">{esc(lower_first(item_type))}</span></span>''' if item_type else ""
    plain = "" if item_type else " row--plain"
    return f'''
          <li><a class="row{plain}" href="{href}"{target}>
            <span class="row__num">{num:02d}</span>
            <span class="row__body"><span class="row__title">{esc(item["label"])}</span></span>{tag}
            {arrow}
          </a></li>'''


def render_items(items, depth, start=1):
    return "".join(render_item(item, depth, start + i) for i, item in enumerate(items))


def render_material(item, depth, num):
    """Строка файла: номер, название и описание, метка, «открыть» и «скачать»."""
    href = attr(file_href(item["file"], depth))
    # Чужой адрес браузер по атрибуту download не скачивает, поэтому файл с
    # Диска «скачать» открывает в новой вкладке — там кнопка «Скачать» Диска.
    save = ' target="_blank" rel="noopener"' if on_disk(item["file"]) else " download"
    desc = (f'<span class="row__text">{esc(item["desc"])}</span>'
            if item.get("desc") else "")
    ext = os.path.splitext(item["file"])[1].lstrip(".").upper()
    badge = item.get("type") or ext
    tag = f'<span class="tag">{esc(badge)}</span>' if badge else ""
    return f'''
          <li class="row mat">
            <span class="row__num">{num:02d}</span>
            <span class="row__body"><a class="row__title" href="{href}" target="_blank" rel="noopener">{esc(item["label"])}</a>{desc}</span>
            <span class="row__tags">{tag}</span>
            <span class="mat__actions">
              <a class="btn btn--sm" href="{href}" target="_blank" rel="noopener">открыть</a>
              <a class="btn btn--sm btn--outline" href="{href}"{save}>скачать</a>
            </span>
          </li>'''


def render_materials(items, depth, start=1):
    return "".join(render_material(item, depth, start + i) for i, item in enumerate(items))


def split_items(items):
    """(файлы, внешние ссылки): файлы идут строками с кнопками, ссылки — отдельным списком."""
    files = [item for item in items if "file" in item]
    links = [item for item in items if "file" not in item and "url" in item]
    return files, links


def content_blocks(items, depth, note_html="", placeholder=None):
    """Разметка «содержание раздела»: строки файлов и, отдельно, ссылки.

    Свои файлы идут первыми — с кнопками «открыть» и «скачать». Внешние
    ссылки живут отдельным списком ниже, чтобы чужие сайты не мешались
    среди своих материалов.
    """
    files, links = split_items(items)
    blocks = []
    if files:
        blocks.append(f'''

    <section class="section">
      <h2 class="section-label">содержание раздела</h2>
      <ul class="list">{render_materials(files, depth)}
      </ul>{note_html}
    </section>''')
    if links:
        blocks.append(f'''

    <section class="section">
      <h2 class="section-label">полезные ссылки по теме</h2>
      <ul class="list">{render_items(links, depth)}
      </ul>
    </section>''')
    if not blocks and placeholder:
        blocks.append(f'''

    <p class="note note--empty">{placeholder}</p>''')
    return "".join(blocks)


# ------------------------------------------------- каталог внешних ресурсов

def load_resources():
    """Записи data/resources.json, которые доступны (status == "ok").

    Битые и недоступные остаются в каталоге, но на сайт не идут: иначе
    на страницах появятся ссылки, которые не открываются.
    """
    if not os.path.exists(RESOURCES):
        return []
    with open(RESOURCES, encoding="utf-8") as f:
        return [res for res in json.load(f) if res.get("status") == "ok"]


def resource_item(res):
    """Запись каталога в виде пункта списка — такого же, как в content.json."""
    label = res["title"]
    if res.get("note"):
        label += f'. {res["note"]}'
    item_type = "Внешняя ссылка"
    if res.get("lang") and res["lang"] != "ru":
        item_type += " · на английском"
    return {"label": label, "url": res["url"], "type": item_type}


def resources_for(resources, level_slug, section_id, standard):
    """Ссылки каталога для раздела: по уровню, разделу и стандарту.

    Запись без "standards" относится к обоим стандартам — так большинству
    ссылок в data/resources.json ничего указывать не нужно, а поле стоит
    только у тех, что привязаны к одному экзамену (например официальные
    списки слов HSK 2.0).
    """
    return [resource_item(res) for res in resources
            if level_slug in res.get("levels", [])
            and section_id in res.get("sections", [])
            and standard in res.get("standards", [standard])]


# ------------------------------------------------- таблица слов уровня

def vocab_items(data, level_name):
    """Ссылки на словарь уровня: PDF для чтения и печати, CSV для Anki.

    В CSV лежат новые слова этого уровня, а не весь словарь до него. Поэтому
    число здесь меньше накопительной цифры из подзаголовка: «300 слов» у
    HSK 2 по стандарту 2.0 — это 150 слов первого уровня плюс 151 новое.

    PDF собирает scripts/make_vocab_pdf.py из того же CSV. Пока его нет,
    ссылки на него тоже нет: лучше один пункт, чем битая кнопка «Скачать».
    Про отсутствующий PDF предупреждает missing_files().
    """
    with open(os.path.join(BASE, data["data"]), encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    items = []
    pdf = data.get("pdf")
    if pdf and (os.path.isfile(os.path.join(BASE, pdf)) or on_disk(pdf)):
        items.append({"label": f"Список новых слов уровня {level_name} ({len(rows)})",
                      "file": pdf, "type": "Для печати"})
    items.append({"label": f"Список слов таблицей — для Anki и Excel ({len(rows)})",
                  "file": data["data"], "type": "CSV"})
    return items


def section_entries(content, level_slug, level, std, section, resources=()):
    """Что открывается в разделе стандарта: (пункты, примечание к словарю).

    Считается одинаково для страницы раздела и для обзора уровня, где те же
    материалы выводятся под заголовком раздела, — иначе две страницы легко
    разъезжаются. Словарь стандарта идёт первым: это готовые файлы, а не
    планы на будущее. Пункты-заготовки (см. has_link) отсеиваются.
    """
    data = level["standards"][std["id"]]["sections"].get(section["id"], {})
    items = []
    note = ""
    if data.get("data"):
        items += vocab_items(data, level["title"])
        note = VOCAB_NOTE
    items += list(data.get("items", []))
    items += resources_for(resources, level_slug, section["id"], std["id"])
    return [item for item in items if has_link(item)], note


def level_section_block(section, href, items, note_text, depth):
    """Раздел на странице уровня: заголовок, описание, файлы и ссылки.

    Заголовок ведёт на отдельную страницу раздела, но ходить туда незачем:
    всё, что там есть, лежит тут же под заголовком.
    """
    files, links = split_items(items)
    rows = render_materials(files, depth) + render_items(links, depth, start=len(files) + 1)
    extra = f'''
        <p class="lib-group__note">{note_text}</p>''' if note_text else ""
    return f'''
      <div class="list lib-group">
        <div class="lib-group__head">
          <h3 class="lib-group__title"><a href="{href}">{esc(lower_first(section["title"]))}</a></h3>
          <span class="lib-group__zh">{zh_pinyin(SECTION_ZH[section["id"]])}</span>
          <p class="lib-group__text">{esc(section["desc"])}</p>
        </div>
        <ul class="rows">{rows}
        </ul>{extra}
      </div>'''


def hsk_section_page(content, level_slug, level, std, index, resources=()):
    block = level["standards"][std["id"]]
    section = content["hsk_sections"][index]
    rel_path = f'library/{level_slug}/{std["dir"]}/{section["file"]}'
    depth = rel_path.count("/")
    p = depth_prefix(depth)
    level_name = level["title"]
    section_title = section["title"]

    items, vocab_note = section_entries(content, level_slug, level, std, section, resources)
    note_html = note(vocab_note, "note--plain") if vocab_note else ""

    # Ничего открыть нельзя — вместо пустых блоков одна заглушка.
    body = content_blocks(items, depth, note_html, placeholder=(
        "Раздел в процессе наполнения. Добавьте сюда свои материалы: "
        "PDF, ссылки на видео, аудио и конспекты."))

    # «Назад» есть на каждой странице, «дальше» — у всех разделов, кроме последнего.
    next_link = ""
    if index + 1 < len(content["hsk_sections"]):
        nxt = content["hsk_sections"][index + 1]
        next_link = f'''
      <a href="{attr(nxt["file"])}" class="btn btn--outline">дальше → {esc(lower_first(nxt["title"]))}</a>'''
    nav_next = f'''

    <nav class="nav-next">
      <a href="../index.html" class="btn btn--outline">← все разделы уровня</a>{next_link}
    </nav>'''

    # Справа — все разделы уровня в этом стандарте, текущий отмечен.
    side = side_list("разделы уровня", [
        (esc(lower_first(s["title"])), zh_pinyin(SECTION_ZH[s["id"]]), attr(s["file"]), i == index)
        for i, s in enumerate(content["hsk_sections"])])

    main = crumbs([
        ("главная", f"{p}index.html"),
        ("библиотека", "../../index.html"),
        (esc(level_name), "../index.html"),
        (esc(std["title"]), None),
        (esc(lower_first(section_title)), None),
    ]) + hero(
        esc(lower_first(section_title)), esc(section["desc"]), zh=SECTION_ZH[section["id"]],
        meta=f'{esc(level_name)} · {esc(std["title"])} · {esc(block["subtitle"])}', side=side,
    ) + body + nav_next + "\n"
    title = f'{section_title} ({level_name}, {std["title"]})'
    return rel_path, page(content, rel_path, title, main)


def hsk_index(content, level_slug, level, resources=()):
    """Обзор уровня: все материалы обоих стандартов на одной странице.

    Раньше тут были карточки разделов, и до файла приходилось идти через
    лишний выбор: сначала «Словарь» или «Учебные материалы», и только потом
    материал. Теперь под заголовком стандарта сразу идут разделы с их
    материалами, а ниже, на той же странице, то же самое по второму
    стандарту. Разделы, куда материалы ещё не добавлены, собраны одной
    строкой в конце стандарта: их страницы на месте, но показывать там
    пока нечего.
    """
    rel_path = f"library/{level_slug}/index.html"
    depth = rel_path.count("/")
    p = depth_prefix(depth)
    level_name = level["title"]
    pairs = level_standards(content, level)

    groups = ""
    for std, block in pairs:
        blocks = ""
        empty = []
        for section in content["hsk_sections"]:
            href = f'{attr(std["dir"])}/{attr(section["file"])}'
            items, vocab_note = section_entries(content, level_slug, level, std, section, resources)
            if items:
                blocks += level_section_block(section, href, items, vocab_note, depth)
            else:
                empty.append(f'<a href="{href}">{esc(lower_first(section["title"]))}</a>')
        if empty:
            # Ссылки на пустые разделы остаются: у каждого своя страница, и
            # с обзора уровня на неё должно быть чем перейти (см. --check).
            lead = "Пока пусто" if blocks else "Материалы этого стандарта ещё не добавлены. Разделы"
            blocks += f'''
      <p class="lib-empty">{lead}: {" · ".join(empty)}</p>'''
        groups += f'''

    <section class="section" id="{std_anchor(std)}">
      <h2 class="section-label">{esc(std["title"])} · {esc(std["label"])} стандарт</h2>
      <p class="section-intro">{esc(block["subtitle"])}. {esc(std["desc"])}</p>{blocks}
    </section>'''

    # Следующий уровень. У 1–5 он один и тот же в обоих стандартах — тогда
    # ссылка одна. Стандарт называем только там, где пути расходятся: после
    # HSK 6 старый экзамен заканчивается, а новый идёт на ступень 7–9.
    nexts = [(std, block["next"]) for std, block in pairs if block["next"]]
    same = len({slug for _, slug in nexts}) == 1 and len(nexts) == len(pairs)
    links = ""
    side_next = ""
    for std, next_slug in nexts:
        next_title = content["levels"][next_slug]["title"]
        via = "" if same else f' по {esc(std["title"])}'
        links += f'''
      <a href="../{attr(next_slug)}/index.html" class="btn btn--outline">следующий уровень{via} → {esc(next_title)}</a>'''
        side_next += f'''
        <a class="row row--plain" href="../{attr(next_slug)}/index.html">
          <span class="row__num">{len(pairs) + 1:02d}</span>
          <span class="row__body"><span class="row__title">{esc(next_title)}</span><span class="row__text">следующий уровень{via}</span></span>
          {ARROW}
        </a>'''
        if same:
            break
    nav_next = f'''

    <nav class="nav-next">
      <a href="../index.html" class="btn btn--outline">← все уровни</a>{links}
    </nav>'''

    if len(pairs) > 1:
        intro = (f'Все материалы уровня {esc(level_name)} собраны на этой странице: сначала по '
                 f'стандарту {esc(pairs[0][0]["title"])}, ниже — по {esc(pairs[1][0]["title"])}. '
                 f'Наборы слов и требования у стандартов разные, структура разделов одинаковая.')
    else:
        only = pairs[0][0]
        intro = (f'{esc(level_name)} существует только в стандарте {esc(only["title"])}: в старом '
                 f'экзамене такой ступени не было. Все материалы ступени — на этой странице.')

    # Справа — стандарты уровня (ссылки к их блокам ниже) и следующий уровень.
    side_rows = ""
    for i, (std, block) in enumerate(pairs, 1):
        side_rows += f'''
        <a class="row row--plain" href="#{std_anchor(std)}">
          <span class="row__num">{i:02d}</span>
          <span class="row__body"><span class="row__title">{esc(std["title"])} · {esc(std["label"])} стандарт</span><span class="row__text">{esc(block["subtitle"])}</span></span>
          {ARROW_DOWN}
        </a>'''
    side = f'''
      <div class="panel__side">
        <h2 class="panel__head">на этой странице</h2>{side_rows}{side_next}
      </div>'''

    main = crumbs([
        ("главная", f"{p}index.html"),
        ("библиотека", "../index.html"),
        (esc(level_name), None),
    ]) + hero(esc(level_name), intro, zh=LEVEL_ZH.get(level_slug), side=side) + groups + nav_next + "\n"
    return rel_path, page(content, rel_path, level_name, main)


def std_anchor(std):
    """Якорь блока стандарта на странице уровня: «2.0» → «std-2-0»."""
    return "std-" + re.sub(r"[^0-9a-z]+", "-", std["dir"].lower())


def collection_side(content, group, current):
    """Правая ячейка страницы подборки: соседние страницы, текущая отмечена.

    Ручные страницы подборки (COLLECTIONS[...]["manual"]) стоят в том же
    списке; ими же пользуется сама ручная страница.
    """
    style = COLLECTIONS[group]
    rows = [(esc(lower_first(e["title"])),
             "" if e["items"] or e.get("resources") else "пока пусто",
             f'{attr(e["slug"])}.html', e["slug"] == current)
            for e in content[group]]
    for pos, slug, title in style.get("manual", []):
        rows.insert(pos, (esc(lower_first(title)), "", f"{slug}.html", slug == current))
    return side_list(lower_first(style["back"]), rows)


def collection_page(content, group, entry, resources=()):
    style = COLLECTIONS[group]
    rel_path = f'library/{group}/{entry["slug"]}.html'
    depth = rel_path.count("/")
    p = depth_prefix(depth)
    title = esc(lower_first(entry["title"]))
    items = list(entry["items"])
    if entry.get("resources"):  # страница-каталог: сюда идут все ссылки из data/resources.json
        items += [resource_item(res) for res in resources]
    items = [item for item in items if has_link(item)]
    body = content_blocks(items, depth, placeholder=style["placeholder"])

    side = collection_side(content, group, entry["slug"])

    main = crumbs([
        ("главная", f"{p}index.html"),
        ("библиотека", "../index.html"),
        (lower_first(style["crumb"]), "index.html"),
        (title, None),
    ]) + hero(title, esc(entry["desc"]), meta=lower_first(style["subtitle"]).replace("Все уровни", "все уровни"),
              side=side) + body + f'''

    <nav class="nav-next">
      <a href="index.html" class="btn btn--outline">← {lower_first(style["back"])}</a>
    </nav>
'''
    return rel_path, page(content, rel_path, entry["title"], main)


# ---------------------------------------------------------------- данные

def load_content():
    with open(CONTENT, encoding="utf-8") as f:
        content = json.load(f)
    errors = validate(content)
    if errors:
        sys.exit("content.json: ошибки\n  " + "\n  ".join(errors))
    return content


def check_vocab(spot, rel_path):
    """Файл со словарём на месте и в нужном формате."""
    path = os.path.join(BASE, rel_path)
    if not os.path.isfile(path):
        return [f'{spot}.data: нет файла {rel_path} (соберите его: python3 scripts/fetch_data.py)']
    with open(path, encoding="utf-8", newline="") as f:
        header = next(csv.reader(f), [])
    missing = {"hanzi", "pinyin", "translation_ru", "standard"} - set(header)
    if missing:
        return [f'{spot}.data: в {rel_path} нет колонок {sorted(missing)}']
    return []


def validate(content):
    errors = []
    nav_ids = {item["id"] for item in content["nav"]}
    for nav_id in content["footer_links"]:
        if nav_id not in nav_ids:
            errors.append(f'footer_links: нет пункта меню "{nav_id}"')
    section_ids = [s["id"] for s in content["hsk_sections"]]

    def check_items(where, items):
        for i, item in enumerate(items):
            spot = f"{where}.items[{i}]"
            unknown = set(item) - ITEM_KEYS
            if unknown:
                errors.append(f"{spot}: неизвестные поля {sorted(unknown)} (допустимы {sorted(ITEM_KEYS)})")
            if not item.get("label"):
                errors.append(f'{spot}: нет "label"')
            if "file" in item and "url" in item:
                errors.append(f'{spot}: укажите что-то одно — "file" или "url"')
            if "file" in item and re.match(r"^(https?:|/|\.\./)", item["file"]):
                errors.append(f'{spot}: "file" — путь от корня сайта, например library/hsk-1/x.pdf; '
                              f'для внешних ссылок используйте "url"')

    standard_ids = []
    for i, std in enumerate(content["standards"]):
        spot = f"standards[{i}]"
        unknown = set(std) - STANDARD_KEYS
        if unknown:
            errors.append(f"{spot}: неизвестные поля {sorted(unknown)} (допустимы {sorted(STANDARD_KEYS)})")
        missing = STANDARD_KEYS - set(std)
        if missing:
            errors.append(f"{spot}: нет полей {sorted(missing)}")
        standard_ids.append(std.get("id"))
    for dup in {s for s in standard_ids if standard_ids.count(s) > 1}:
        errors.append(f'standards: id "{dup}" повторяется')
    dirs = [std.get("dir") for std in content["standards"]]
    for dup in {d for d in dirs if dirs.count(d) > 1}:
        errors.append(f'standards: dir "{dup}" повторяется — папки разделов перезапишут друг друга')

    for slug, level in content["levels"].items():
        if not level.get("standards"):
            errors.append(f"levels.{slug}: нет ни одного стандарта")
            continue
        for std_id, block in level["standards"].items():
            spot = f"levels.{slug}.standards.{std_id}"
            if std_id not in standard_ids:
                errors.append(f'{spot}: нет такого стандарта в standards')
            unknown = set(block) - LEVEL_STANDARD_KEYS
            if unknown:
                errors.append(f"{spot}: неизвестные поля {sorted(unknown)} "
                              f"(допустимы {sorted(LEVEL_STANDARD_KEYS)})")
            nxt = block.get("next")
            if nxt is not None:
                if nxt not in content["levels"]:
                    errors.append(f'{spot}.next: нет уровня "{nxt}"')
                elif std_id not in content["levels"][nxt].get("standards", {}):
                    errors.append(f'{spot}.next: у уровня "{nxt}" нет стандарта {std_id}')
            for sid, data in block.get("sections", {}).items():
                where = f"{spot}.sections.{sid}"
                if sid not in section_ids:
                    errors.append(f'{where}: нет такого раздела в hsk_sections')
                unknown = set(data) - SECTION_KEYS
                if unknown:
                    errors.append(f"{where}: неизвестные поля {sorted(unknown)} (допустимы {sorted(SECTION_KEYS)})")
                if data.get("data"):
                    errors += check_vocab(where, data["data"])
                check_items(where, data.get("items", []))
    for group in COLLECTIONS:
        slugs = [entry["slug"] for entry in content[group]]
        for dup in {s for s in slugs if slugs.count(s) > 1}:
            errors.append(f'{group}: slug "{dup}" повторяется')
        for entry in content[group]:
            check_items(f'{group}.{entry["slug"]}', entry["items"])
    return errors


def build_all(content):
    """Все генерируемые страницы: {путь от корня: html}."""
    resources = load_resources()
    pages = {}
    for slug, level in content["levels"].items():
        path, text = hsk_index(content, slug, level, resources)
        pages[path] = text
        for std, _ in level_standards(content, level):
            for index in range(len(content["hsk_sections"])):
                path, text = hsk_section_page(content, slug, level, std, index, resources)
                pages[path] = text
    for group in COLLECTIONS:
        for entry in content[group]:
            path, text = collection_page(content, group, entry, resources)
            pages[path] = text

    clash = sorted(set(pages) & set(MANUAL_PAGES))
    if clash:
        sys.exit("content.json описывает ручные страницы, генератор их не перезапишет:\n  "
                 + "\n  ".join(clash))
    return pages


def missing_files(content):
    found = []
    items = []
    for slug, level in content["levels"].items():
        for std_id, block in level["standards"].items():
            for sid, data in block["sections"].items():
                items.append((f"library/{slug}/{std_id}/{sid}", data.get("items", [])))
    items += [(f'library/{group}/{e["slug"]}', e["items"]) for group in COLLECTIONS for e in content[group]]
    for where, entries in items:
        for item in entries:
            if ("file" in item and not os.path.isfile(os.path.join(BASE, item["file"]))
                    and not on_disk(item["file"])):
                found.append(f'{where}: нет файла {item["file"]}')

    # PDF словарей собирает отдельный скрипт; без него страница словаря
    # отдаёт только CSV (см. vocab_items), а не битую ссылку.
    for slug, level in content["levels"].items():
        for std_id, block in level["standards"].items():
            pdf = block["sections"].get("vocabulary", {}).get("pdf")
            if pdf and not os.path.isfile(os.path.join(BASE, pdf)) and not on_disk(pdf):
                found.append(f'library/{slug}/{std_id}: нет PDF {pdf} '
                             f'(соберите: python3 scripts/make_vocab_pdf.py)')
    return found


def read(rel_path):
    with open(os.path.join(BASE, rel_path), encoding="utf-8") as f:
        return f.read()


def write_if_changed(rel_path, text):
    path = os.path.join(BASE, rel_path)
    if os.path.exists(path) and read(rel_path) == text:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


# ---------------------------------------------------------------- --check

def canonical(block, rel_path):
    """Строки блока без отступов, ссылки приведены к пути от корня сайта.

    "contacts.html" на support/contacts.html и "../support/contacts.html" на
    library/index.html ведут в одно место и считаются одинаковыми.
    """
    base_dir = os.path.dirname(rel_path)

    def resolve(match):
        name, url = match.group(1), match.group(2)
        if re.match(r"^([a-z]+:|//|#)", url):
            return match.group(0)
        return f'{name}="/{os.path.normpath(os.path.join(base_dir, url))}"'

    block = re.sub(r"<title>.*?</title>", "<title>…</title>", block)
    block = re.sub(r'\b(href|src)="([^"]*)"', resolve, block)
    return [line.strip() for line in block.splitlines() if line.strip()]


def header_includes(text):
    """Строки, которыми страница подключает общую шапку."""
    css = re.search(r'<link rel="stylesheet" href="[^"]*%s">' % re.escape(HEADER_CSS), text)
    js = re.search(r'<body[^>]*>\s*(<script src="[^"]*%s"></script>)' % re.escape(HEADER_JS), text)
    return "\n".join([css.group(0) if css else f"(нет стилей шапки {HEADER_CSS} в <head>)",
                      js.group(1) if js else f"(нет скрипта шапки {HEADER_JS} первой строкой <body>)"])


def chrome_blocks(text, is_home):
    """Общие для всех страниц куски: <head> с началом <body>, шапка, футер со скриптами."""
    if is_home:  # у главной свой <head> (шрифты, прелоадер) и свой подвал, общая только шапка
        return {"подключение шапки": header_includes(text)}
    blocks = {}
    m = re.search(r'<!DOCTYPE html>.*?<body[^>]*>', text, re.S)
    blocks["<head> и начало <body>"] = m.group(0) if m else ""
    blocks["подключение шапки"] = header_includes(text)
    m = re.search(r'<footer class="site-footer">.*</html>', text, re.S)
    blocks["футер и скрипты"] = m.group(0) if m else ""
    return blocks


def expected_chrome(content, rel_path):
    depth = rel_path.count("/")
    text = head("…", depth) + footer(content, depth)
    return chrome_blocks(text, rel_path == HOME_PAGE)


def html_pages():
    """Страницы сайта. data/ и scripts/ — служебные папки, design/ — макеты темы."""
    found = []
    for path in glob.glob(os.path.join(BASE, "**", "*.html"), recursive=True):
        rel_path = os.path.relpath(path, BASE).replace(os.sep, "/")
        parts = rel_path.split("/")
        if parts[0] in ("data", "scripts", "design") or any(p.startswith((".", "__")) for p in parts):
            continue
        found.append(rel_path)
    return sorted(found)


def parent_page(content, rel_path):
    """Страница, с которой должна вести ссылка на rel_path.

    У страницы раздела внутри стандарта (library/hsk-1/2.0/phonetics.html)
    своего index.html в папке нет — её родитель это обзор уровня.
    """
    parts = rel_path.split("/")
    std_dirs = {std["dir"] for std in content["standards"]}
    if len(parts) == 4 and parts[2] in std_dirs:
        return f"{parts[0]}/{parts[1]}/index.html"
    parent_dir = os.path.dirname(rel_path)
    if rel_path.endswith("/index.html"):
        parent_dir = os.path.dirname(parent_dir)
    return f"{parent_dir}/index.html"


def links_to(rel_path, target):
    """Есть ли на странице rel_path ссылка на target."""
    base_dir = os.path.dirname(rel_path)
    for url in re.findall(r'href="([^"#?]+)', read(rel_path)):
        if os.path.normpath(os.path.join(base_dir, url)) == target:
            return True
    return False


def stale_local_links(rel_path):
    """Файлы, на которые страница ссылается на сайте, хотя они уже на Диске."""
    base_dir = os.path.dirname(rel_path)
    found = []
    for url in re.findall(r'href="([^"#?]+)', read(rel_path)):
        if re.match(r"^[a-z]+:", url):
            continue
        target = os.path.normpath(os.path.join(base_dir, unquote(url)))
        if on_disk(target) and target not in found:
            found.append(target)
    return found


def check_empty_cards(content):
    """Пометка is-empty на ручных страницах-обзорах не разошлась с content.json."""
    found = []
    for page, group in (("library/additional/index.html", "additional"),
                        ("library/practice/index.html", "practice")):
        if not os.path.exists(os.path.join(BASE, page)):
            continue
        text = read(page)
        for entry in content[group]:
            empty = not entry["items"] and not entry.get("resources")
            card = re.search(r'<a class="row row--plain( is-empty)?" href="'
                             + re.escape(entry["slug"]) + r'\.html"', text)
            if not card:
                found.append(f'{page}: не нашёл строку {entry["slug"]}.html')
            elif bool(card.group(1)) != empty:
                found.append(f'{page}: строка {entry["slug"]} ' + (
                    "помечена пустой, хотя материалы есть" if card.group(1)
                    else "без пометки is-empty, хотя материалов нет"))
    return found


def placeholder_items(content):
    """Пункты-заготовки: на сайт они не идут (см. has_link), но лежат в content.json.

    Показываем их списком, чтобы было видно, где материал обещан, но не
    приложен, и чтобы такой пункт не исчез из вида совсем.
    """
    found = []
    for slug, level in content["levels"].items():
        for std_id, block in level["standards"].items():
            for sid, data in block["sections"].items():
                for item in data.get("items", []):
                    if not has_link(item):
                        found.append(f'levels.{slug}.{std_id}.{sid}: {item["label"]}')
    for group in COLLECTIONS:
        for entry in content[group]:
            for item in entry["items"]:
                if not has_link(item):
                    found.append(f'{group}.{entry["slug"]}: {item["label"]}')
    return found


def check(content, pages):
    problems = 0

    print("Ручные страницы: <head>, подключение шапки и футер против шаблона")
    for rel_path in [p for p in html_pages() if p not in pages]:
        is_home = rel_path == HOME_PAGE
        actual = chrome_blocks(read(rel_path), is_home)
        diffs = []
        for name, block in expected_chrome(content, rel_path).items():
            want, got = canonical(block, rel_path), canonical(actual[name], rel_path)
            if want != got:
                diff = difflib.unified_diff(want, got, "шаблон", rel_path, n=0, lineterm="")
                diffs.append((name, [line for line in diff if not line.startswith("@@")]))
        if diffs:
            problems += 1
            print(f"  ✗ {rel_path}")
            for name, lines in diffs:
                print(f"      {name}:")
                for line in lines:
                    print(f"        {line}")
        else:
            print(f"  ✓ {rel_path}")

    print("\nРучные страницы: ссылки на файлы, которые уже на Яндекс Диске")
    stale_links = [f"{rel_path} → {target}" for rel_path in MANUAL_PAGES
                   if os.path.exists(os.path.join(BASE, rel_path))
                   for target in stale_local_links(rel_path)]
    for line in stale_links:
        print(f"  ✗ {line} (запустите scripts/apply_disk_links.py)")
    if not stale_links:
        print("  ✓ все ведут на Диск")
    problems += len(stale_links)

    print("\nСгенерированные страницы: есть ли ссылка с родительской страницы")
    orphans = []
    for rel_path in pages:
        parent = parent_page(content, rel_path)
        if not os.path.exists(os.path.join(BASE, parent)):
            continue
        if not links_to(parent, rel_path):
            orphans.append(f"{parent} не ссылается на {rel_path}")
    for line in orphans:
        print(f"  ✗ {line}")
    if not orphans:
        print("  ✓ все на месте")
    problems += len(orphans)

    print("\nСгенерированные страницы: совпадают ли с content.json")
    stale = [p for p in pages if not os.path.exists(os.path.join(BASE, p)) or read(p) != pages[p]]
    for rel_path in stale:
        print(f"  ✗ {rel_path} — устарела или правилась вручную (запустите генератор)")
    if not stale:
        print(f"  ✓ все {len(pages)} актуальны")
    problems += len(stale)

    print("\nЛишние страницы: не описаны ни в content.json, ни в MANUAL_PAGES")
    extra = [p for p in html_pages() if p not in pages and p not in MANUAL_PAGES]
    for rel_path in extra:
        print(f"  ✗ {rel_path} — осталась от прежней структуры, удалите файл")
    if not extra:
        print("  ✓ таких нет")
    problems += len(extra)

    print("\nРучные страницы-обзоры: пометка пустых карточек")
    stale_cards = check_empty_cards(content)
    for line in stale_cards:
        print(f"  ✗ {line}")
    if not stale_cards:
        print("  ✓ совпадает с content.json")
    problems += len(stale_cards)

    for line in missing_files(content):
        print(f"\n  ✗ {line}")
        problems += 1

    # Не расхождение, а список дел: пункты без файла и ссылки на сайт не идут.
    waiting = placeholder_items(content)
    if waiting:
        print(f"\nПункты без файла и ссылки — на сайт не выводятся ({len(waiting)}):")
        for line in waiting:
            print(f"  · {line}")

    print(f"\nИтого расхождений: {problems}")
    return problems


def main(argv):
    content = load_content()
    pages = build_all(content)
    if "--check" in argv:
        return 1 if check(content, pages) else 0

    changed = [p for p, text in pages.items() if write_if_changed(p, text)]
    for rel_path in changed:
        print(f"  обновлено: {rel_path}")
    for line in missing_files(content):
        print(f"  внимание: {line}", file=sys.stderr)
    print(f"Готово: {len(pages)} страниц, изменено {len(changed)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
