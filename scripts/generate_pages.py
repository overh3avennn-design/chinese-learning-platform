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
    Шапка, меню и футер одинаковые на всех страницах; относительные ссылки
    считаются от глубины страницы (depth_prefix). Файл перезаписывается,
    только если его содержимое изменилось, поэтому повторный запуск
    ничего не меняет.

Как запускать (из любой папки)
    python3 scripts/generate_pages.py           собрать страницы
    python3 scripts/generate_pages.py --check   ничего не записывая, сверить шапку и
                                                футер ручных страниц с шаблоном и
                                                показать устаревшие сгенерированные

Что НЕ трогает
    Всё, чего нет в content.json: главную (index.html), library/index.html,
    library/roadmap.html, library/textbooks/, library/journals/, library/culture/,
    library/additional/index.html, library/practice/index.html,
    library/practice/speaking.html, support/, flashcards/, а также css/, js/, images/ и файлы
    материалов. Страницы, убранные из content.json, не удаляются — удалите сами.
    Правки вручную в сгенерированных страницах будут затёрты: меняйте content.json.

Пункты (items) в content.json
    {"label": "...", "file": "library/hsk-1/x.pdf"}  карточка файла: обложка и название
                                                     открывают файл, кнопки «Открыть» и «Скачать»
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
import glob
import html
import json
import os
import re
import sys
from urllib.parse import quote

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(BASE, "content.json")
RESOURCES = os.path.join(BASE, "data", "resources.json")

# Списки слов собирает scripts/fetch_data.py, PDF — scripts/make_vocab_pdf.py.
VOCAB_NOTE = ("Перевод на русский в списках слов подготовлен автоматически и может содержать "
              "неточности. Иероглифы и пиньинь — из официальных списков HSK.")

# Обложки материалов: images/previews/<имя файла>.jpg, собирает
# scripts/make_previews.py из первой страницы PDF. Если обложки нет,
# карточка рисует заглушку с расширением файла.
PREVIEW_DIR = "images/previews"

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
    "library/journals/index.html",
    "library/culture/index.html",
    "library/culture/films.html",
    "library/additional/index.html",
    "library/practice/index.html",
    "library/practice/speaking.html",
    "support/faq.html",
    "support/teacher.html",
    "support/contacts.html",
    "flashcards/index.html",
]

HOME_PAGE = "index.html"
# Весь скрипт сайта — один файл js/main.js, одинаковый на всех страницах.
PAGE_SCRIPTS = ["js/main.js"]

# Оформление страниц additional/ и practice/: крошка, подзаголовок, заглушка.
COLLECTIONS = {
    "additional": {
        "crumb": "Дополнительные",
        "subtitle": "Дополнительные материалы · Все уровни",
        "placeholder": "Добавьте материалы в этот раздел: справочники, статьи, ссылки на видео.",
    },
    "practice": {
        "crumb": "Практика",
        "subtitle": "Практика и контекст",
        "placeholder": "Добавьте тексты, диалоги, ссылки на аудио и видео.",
    },
}

ITEM_KEYS = {"label", "file", "url", "type", "link_text", "desc", "preview"}
SECTION_KEYS = {"items", "data", "pdf"}
STANDARD_KEYS = {"id", "dir", "title", "label", "desc"}
LEVEL_STANDARD_KEYS = {"subtitle", "next", "sections"}


def depth_prefix(rel_depth):
    return "../" * rel_depth


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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{esc(title)} — Китайский язык</title>
  <link rel="icon" href="{p}favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" sizes="32x32" href="{p}favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="{p}favicon-192.png">
  <link rel="apple-touch-icon" href="{p}apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="{p}css/style.css">
</head>
<body>
  <div class="bg-fixed" aria-hidden="true"></div>
'''


def site_header(content, nav_active, depth):
    p = depth_prefix(depth)
    items = ""
    for item in content["nav"]:
        active = ' class="active"' if item["id"] == nav_active else ""
        items += f'''
          <li><a href="{p}{attr(item["href"])}"{active}>{esc(item["label"])}</a></li>'''
    return f'''  <header class="site-header">
    <div class="header-inner">
      <a href="{p}index.html" class="logo">
        <span class="logo-char">中</span>
        <span>Китайский язык</span>
      </a>
      <button class="nav-toggle" aria-label="Меню" aria-expanded="false">☰</button>
      <nav class="site-nav" aria-label="Основная навигация">
        <ul>{items}
        </ul>
      </nav>
    </div>
  </header>
'''


def footer(content, depth):
    p = depth_prefix(depth)
    nav = {item["id"]: item for item in content["nav"]}
    links = ""
    for nav_id in content["footer_links"]:
        item = nav[nav_id]
        links += f'''
        <a href="{p}{attr(item["href"])}">{esc(item["label"])}</a>'''
    script_tags = "".join(f'''
  <script src="{p}{src}"></script>''' for src in PAGE_SCRIPTS)
    return f'''
  <footer class="site-footer">
    <div class="footer-inner">
      <div>
        <strong class="footer-brand">Китайский язык</strong>
        <p class="footer-tagline">Образовательная платформа · V1</p>
      </div>
      <div class="footer-links">{links}
      </div>
      <p class="footer-copy">&copy; 2026 · Персональная образовательная платформа</p>
    </div>
  </footer>{script_tags}
</body>
</html>
'''


def page(content, rel_path, title, main):
    depth = rel_path.count("/")
    return (head(title, depth)
            + site_header(content, active_nav_id(content, rel_path), depth)
            + main
            + footer(content, depth))


def has_link(item):
    """Пункт можно открыть или скачать: за ним стоит файл или внешняя ссылка.

    Пункт без "url" и "file" — заготовка на будущее: подпись с меткой типа
    («Таблица слогов пиньинь · PDF»), за которой ничего нет. На страницу
    такие пункты не выводятся, иначе раздел выглядит наполненным, а по
    строчкам нечего нажать.
    """
    return "url" in item or "file" in item


def render_item(item, depth):
    label = f'<span class="item-label">{esc(item["label"])}</span>'
    item_type = item.get("type")
    if "url" in item:
        item_type = item_type or "Внешняя ссылка"
        link = (f'<a class="download" href="{attr(item["url"])}" target="_blank" rel="noopener">'
                f'{esc(item.get("link_text", "Перейти на сайт"))}</a>')
    elif "file" in item:
        ext = os.path.splitext(item["file"])[1].lstrip(".").upper()
        href = depth_prefix(depth) + quote(item["file"])
        link = f'<a class="download" href="{attr(href)}">{"Скачать " + ext if ext else "Скачать"}</a>'
    else:
        link = ""
    badge = f'<span class="item-type">{esc(item_type)}</span>' if item_type else ""
    return f'''
        <li>{label}{badge}{link}</li>'''


def render_items(items, depth):
    return "".join(render_item(item, depth) for item in items)


# ------------------------------------------------- карточки материалов

def preview_for(item):
    """Обложка материала: images/previews/<имя файла>.jpg.

    Путь считается от имени самого файла, поэтому в content.json обложку
    указывать не нужно — достаточно положить картинку рядом с остальными.
    Поле "preview" перекрывает это правило, если картинка лежит не там.
    Обложки собирает scripts/make_previews.py из первой страницы PDF.
    """
    if item.get("preview"):
        return item["preview"]
    if "file" not in item:
        return None
    rel = f'{PREVIEW_DIR}/{os.path.splitext(os.path.basename(item["file"]))[0]}.jpg'
    return rel if os.path.isfile(os.path.join(BASE, rel)) else None


def render_material(item, depth):
    """Карточка файла: обложка, название, описание, «Открыть» и «Скачать»."""
    p = depth_prefix(depth)
    href = attr(p + quote(item["file"]))
    ext = os.path.splitext(item["file"])[1].lstrip(".").upper()
    preview = preview_for(item)
    if preview:
        cover = f'<img src="{attr(p + quote(preview))}" alt="" loading="lazy">'
    else:
        cover = f'<span class="material-fallback">{esc(ext or "Файл")}</span>'
    desc = (f'''
              <p class="material-desc">{esc(item["desc"])}</p>'''
            if item.get("desc") else "")
    badge = (f'<span class="material-type">{esc(item["type"])}</span>'
             if item.get("type") else "")
    return f'''
          <article class="material-card">
            <a class="material-cover" href="{href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">{cover}</a>
            <div class="material-body">
              <h3 class="material-title"><a href="{href}" target="_blank" rel="noopener">{esc(item["label"])}</a></h3>{desc}
              <div class="material-foot">
                {badge}
                <span class="material-actions">
                  <a class="material-action is-open" href="{href}" target="_blank" rel="noopener">Открыть</a>
                  <a class="material-action" href="{href}" download>Скачать</a>
                </span>
              </div>
            </div>
          </article>'''


def render_materials(items, depth):
    return "".join(render_material(item, depth) for item in items)


def content_blocks(items, depth, note="", placeholder=None):
    """Разметка «Содержание раздела»: карточки файлов и, отдельно, ссылки.

    Свои файлы идут карточками с обложкой — их видно и по ним сразу понятно,
    что открываешь. Внешние ссылки живут отдельным списком внизу, чтобы чужие
    сайты не мешались среди своих материалов.
    """
    files = [item for item in items if "file" in item]
    links = [item for item in items if "file" not in item and "url" in item]
    blocks = []
    if files:
        blocks.append(f'''

    <section class="section">
      <h2>Содержание раздела</h2>
      <div class="material-grid">{render_materials(files, depth)}
      </div>{note}
    </section>''')
    if links:
        blocks.append(f'''

    <section class="section">
      <h2>Полезные ссылки по теме</h2>
      <ul class="content-list">{render_items(links, depth)}
      </ul>
    </section>''')
    if not blocks and placeholder:
        blocks.append(f'''
    <div class="placeholder-note">{placeholder}</div>''')
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
    if pdf and os.path.isfile(os.path.join(BASE, pdf)):
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


def level_section_block(section, href, items, note, depth):
    """Раздел на странице уровня: заголовок, описание, карточки и ссылки.

    Заголовок ведёт на отдельную страницу раздела, но ходить туда незачем:
    всё, что там есть, лежит тут же под заголовком.
    """
    files = [item for item in items if "file" in item]
    links = [item for item in items if "file" not in item and "url" in item]
    body = ""
    if files:
        body += f'''
        <div class="material-grid">{render_materials(files, depth)}
        </div>'''
    if note:
        body += f'''
        <div class="placeholder-note">{note}</div>'''
    if links:
        body += f'''
        <ul class="content-list">{render_items(links, depth)}
        </ul>'''
    return f'''
      <div class="level-section">
        <h3><a href="{href}">{esc(section["title"])}</a></h3>
        <p class="level-section-desc">{esc(section["desc"])}</p>{body}
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
    note = f'''
      <div class="placeholder-note">{vocab_note}</div>''' if vocab_note else ""

    # Ничего открыть нельзя — вместо пустых блоков одна заглушка.
    body = content_blocks(items, depth, note, placeholder=(
        "Раздел в процессе наполнения. Добавьте сюда свои материалы: "
        "PDF, ссылки на видео, аудио и конспекты."))

    nav_next = ""
    if index + 1 < len(content["hsk_sections"]):
        nxt = content["hsk_sections"][index + 1]
        nav_next = f'''
    <nav class="nav-next">
      <a href="../index.html" class="btn btn-secondary">← Все разделы уровня</a>
      <a href="{attr(nxt["file"])}" class="btn btn-secondary">Дальше → {esc(nxt["title"])}</a>
    </nav>'''

    main = f'''
  <main>
    <nav class="breadcrumb" aria-label="Навигация">
      <a href="{p}index.html">Главная</a> / <a href="../../index.html">Библиотека</a> / <a href="../index.html">{esc(level_name)}</a> / {esc(std["title"])} / {esc(section_title)}
    </nav>
    <h1 class="page-title">{esc(section_title)}</h1>
    <p class="page-subtitle">{esc(level_name)} · {esc(std["title"])} · {esc(block["subtitle"])}</p>

    <p>{esc(section["desc"])}</p>{body}{nav_next}
  </main>
'''
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
            items, note = section_entries(content, level_slug, level, std, section, resources)
            if items:
                blocks += level_section_block(section, href, items, note, depth)
            else:
                empty.append(f'<a href="{href}">{esc(section["title"])}</a>')
        if empty:
            # Ссылки на пустые разделы остаются: у каждого своя страница, и
            # с обзора уровня на неё должно быть чем перейти (см. --check).
            lead = "Пока пусто" if blocks else "Материалы этого стандарта ещё не добавлены. Разделы"
            blocks += f'''
      <p class="level-empty">{lead}: {" · ".join(empty)}</p>'''
        groups += f'''

    <section class="section">
      <h2>{esc(std["title"])} · {esc(std["label"])} стандарт</h2>
      <p>{esc(block["subtitle"])}. {esc(std["desc"])}</p>{blocks}
    </section>'''

    # Следующий уровень. У 1–5 он один и тот же в обоих стандартах — тогда
    # ссылка одна. Стандарт называем только там, где пути расходятся: после
    # HSK 6 старый экзамен заканчивается, а новый идёт на ступень 7–9.
    nexts = [(std, block["next"]) for std, block in pairs if block["next"]]
    same = len({slug for _, slug in nexts}) == 1 and len(nexts) == len(pairs)
    links = ""
    for std, next_slug in nexts:
        next_title = content["levels"][next_slug]["title"]
        via = "" if same else f' по {esc(std["title"])}'
        links += f'''
      <a href="../{attr(next_slug)}/index.html" class="btn btn-secondary">Следующий уровень{via} → {esc(next_title)}</a>'''
        if same:
            break
    nav_next = f'''

    <nav class="nav-next">
      <a href="../index.html" class="btn btn-secondary">← Все уровни</a>{links}
    </nav>'''

    if len(pairs) > 1:
        intro = f'''
      Все материалы уровня {esc(level_name)} собраны на этой странице: сначала по
      стандарту {esc(pairs[0][0]["title"])}, ниже — по {esc(pairs[1][0]["title"])}.
      Наборы слов и требования у стандартов разные, структура разделов одинаковая.'''
    else:
        only = pairs[0][0]
        intro = f'''
      {esc(level_name)} существует только в стандарте {esc(only["title"])}: в старом
      экзамене такой ступени не было. Все материалы ступени — на этой странице.'''

    standards_line = " · ".join(f'{std["title"]} ({std["label"]})' for std, _ in pairs)

    main = f'''
  <main>
    <nav class="breadcrumb" aria-label="Навигация">
      <a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / {esc(level_name)}
    </nav>
    <h1 class="page-title">{esc(level_name)}</h1>
    <p class="page-subtitle">{esc(standards_line)}</p>

    <p>{intro}
    </p>{groups}{nav_next}
  </main>
'''
    return rel_path, page(content, rel_path, level_name, main)


def collection_page(content, group, entry, resources=()):
    style = COLLECTIONS[group]
    rel_path = f'library/{group}/{entry["slug"]}.html'
    depth = rel_path.count("/")
    p = depth_prefix(depth)
    title = esc(entry["title"])
    items = list(entry["items"])
    if entry.get("resources"):  # страница-каталог: сюда идут все ссылки из data/resources.json
        items += [resource_item(res) for res in resources]
    items = [item for item in items if has_link(item)]
    body = content_blocks(items, depth, placeholder=style["placeholder"])

    main = f'''
  <main>
    <nav class="breadcrumb"><a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / <a href="index.html">{style["crumb"]}</a> / {title}</nav>
    <h1 class="page-title">{title}</h1>
    <p class="page-subtitle">{style["subtitle"]}</p>
    <p>{esc(entry["desc"])}</p>{body}
  </main>
'''
    return rel_path, page(content, rel_path, entry["title"], main)


# ---------------------------------------------------------------- данные

def active_nav_id(content, rel_path):
    """Пункт меню, который подсвечивается на странице rel_path."""
    for item in content["nav"]:
        href = item["href"]
        section_dir = os.path.dirname(href)
        if rel_path == href or (section_dir and os.path.basename(href) == "index.html"
                                and rel_path.startswith(section_dir + "/")):
            return item["id"]
    return None


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
            if "file" in item and not os.path.isfile(os.path.join(BASE, item["file"])):
                found.append(f'{where}: нет файла {item["file"]}')
            elif "file" in item and not preview_for(item):
                found.append(f'{where}: нет обложки для {item["file"]} '
                             f'(соберите: python3 scripts/make_previews.py)')

    # PDF словарей собирает отдельный скрипт; без него страница словаря
    # отдаёт только CSV (см. vocab_items), а не битую ссылку.
    for slug, level in content["levels"].items():
        for std_id, block in level["standards"].items():
            pdf = block["sections"].get("vocabulary", {}).get("pdf")
            if pdf and not os.path.isfile(os.path.join(BASE, pdf)):
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

    "faq.html" на support/teacher.html и "../support/faq.html" на
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


def chrome_blocks(text, is_home):
    """Общие для всех страниц куски: шапка до <header>, <header>, футер со скриптами."""
    blocks = {}
    if not is_home:  # у главной свой <head>: другие шрифты, прелоадер, нет bg-fixed
        m = re.search(r"<!DOCTYPE html>.*?(?=\n\s*<header class=\"site-header\">)", text, re.S)
        blocks["<head> и начало <body>"] = m.group(0) if m else ""
    m = re.search(r'<header class="site-header">.*?</header>', text, re.S)
    header = m.group(0) if m else ""
    if is_home:  # кнопка «Записаться на урок» есть только на главной
        header = "\n".join(line for line in header.splitlines() if 'class="nav-cta"' not in line)
    blocks["шапка <header>"] = header
    m = re.search(r'<footer class="site-footer">.*</html>', text, re.S)
    blocks["футер и скрипты"] = m.group(0) if m else ""
    return blocks


def expected_chrome(content, rel_path):
    depth = rel_path.count("/")
    is_home = rel_path == HOME_PAGE
    text = (head("…", depth)
            + site_header(content, active_nav_id(content, rel_path), depth)
            + footer(content, depth))
    return chrome_blocks(text, is_home)


def html_pages():
    """Страницы сайта. data/ и scripts/ — служебные папки, там страниц нет."""
    found = []
    for path in glob.glob(os.path.join(BASE, "**", "*.html"), recursive=True):
        rel_path = os.path.relpath(path, BASE).replace(os.sep, "/")
        parts = rel_path.split("/")
        if parts[0] in ("data", "scripts") or any(p.startswith((".", "__")) for p in parts):
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
            card = re.search(r'<article class="card( is-empty)?">\s*<h3><a href="'
                             + re.escape(entry["slug"]) + r'\.html"', text)
            if not card:
                found.append(f'{page}: не нашёл карточку {entry["slug"]}.html')
            elif bool(card.group(1)) != empty:
                found.append(f'{page}: карточка {entry["slug"]} ' + (
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

    print("Ручные страницы: шапка и футер против шаблона")
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
