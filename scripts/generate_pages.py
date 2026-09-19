#!/usr/bin/env python3
"""Generate library section HTML pages for Chinese Learning Platform V1."""

import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HSK_SECTIONS = [
    ("phonetics", "Фонетика и произношение", "phonetics.html",
     "Правильное произношение звуков, тоны и слоги пиньинь.",
     "4–6 часов", "Никаких"),
    ("grammar", "Основная грамматика", "grammar.html",
     "Базовые грамматические конструкции и их использование в речи.",
     "8–12 часов", "Базовая фонетика"),
    ("characters", "Иероглифика", "characters.html",
     "Написание и запоминание иероглифов, ключи и мнемоники.",
     "10–15 часов", "HSK 1 лексика"),
    ("vocabulary", "Словарь", "vocabulary.html",
     "Списки слов, карточки и аудио для отработки лексики.",
     "Постоянно", "Фонетика"),
    ("speaking", "Разговорные фразы", "speaking.html",
     "Диалоги, типовые фразы и практика устной речи.",
     "6–10 часов", "Базовая лексика"),
    ("culture", "Культура и традиции", "culture.html",
     "Статьи и видео о китайской культуре, традициях и обычаях.",
     "2–4 часа", "Не требуется"),
    ("materials", "Учебные материалы", "materials.html",
     "Учебники, рабочие тетради, презентации и домашние задания.",
     "По курсу", "—"),
]

HSK_LEVELS = {
    "hsk-1": ("HSK 1", "150 слов · Начинающий (A1)", "hsk-2"),
    "hsk-2": ("HSK 2", "300 слов · Элементарный (A2)", "hsk-3"),
    "hsk-3": ("HSK 3", "600 слов · Средний (B1)", "hsk-4"),
    "hsk-4": ("HSK 4", "1200 слов · Средний+ (B2)", "hsk-5"),
    "hsk-5": ("HSK 5", "2500 слов · Продвинутый (C1)", "hsk-6"),
    "hsk-6": ("HSK 6", "5000+ слов · Продвинутый+ (C2)", None),
}

ADDITIONAL = [
    ("advanced-phonetics", "Фонетика (углублённая)", "Сравнение похожих звуков, интонация и ритм."),
    ("grammar-reference", "Грамматика (справочник)", "Полная таблица грамматических конструкций."),
    ("advanced-characters", "Иероглифика (углублённая)", "История иероглифов, ключи и система запоминания."),
    ("spoken-chinese", "Разговорный китайский", "Сленг, современные выражения и диалекты."),
    ("culture", "Культура Китая", "История, философия, традиции и современный Китай."),
    ("pinyin", "Хань Юй Пинь Инь", "Полная система транскрипции и тренировки."),
    ("calligraphy", "Каллиграфия", "Техника письма кистью и упражнения."),
    ("resources", "Полезные ресурсы", "Сайты, приложения, YouTube и подкасты."),
    ("books", "Книги и литература", "Учебники, художественная литература и новости."),
]

PRACTICE = [
    ("reading", "Тексты для чтения", "Адаптированные и аутентичные тексты по уровням."),
    ("dialogues", "Диалоги и разговоры", "Бытовые, деловые и социальные сценарии."),
    ("listening", "Аудирование", "Подкасты, интервью, песни и видео с субтитрами."),
    ("writing", "Письменные упражнения", "Письма, отзывы и творческие задания."),
]


def depth_prefix(rel_depth):
    return "../" * rel_depth


def header(title, nav_active, depth):
    p = depth_prefix(depth)
    return f'''<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — Китайский язык</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="{p}css/style.css">
  <link rel="stylesheet" href="{p}css/atmosphere.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="{p}index.html" class="logo">
        <span class="logo-char">中</span>
        <span>Китайский язык</span>
      </a>
      <button class="nav-toggle" aria-label="Меню" aria-expanded="false">☰</button>
      <nav class="site-nav" aria-label="Основная навигация">
        <ul>
          <li><a href="{p}index.html"{" class=\"active\"" if nav_active == "home" else ""}>Главная</a></li>
          <li><a href="{p}library/index.html"{" class=\"active\"" if nav_active == "library" else ""}>Библиотека</a></li>
          <li><a href="{p}support/faq.html">FAQ</a></li>
          <li><a href="{p}support/contacts.html">Контакты</a></li>
        </ul>
      </nav>
    </div>
  </header>
'''


def footer(depth):
    p = depth_prefix(depth)
    return f'''
  <footer class="site-footer">
    <div class="footer-inner">
      <div>
        <strong style="color: #fff;">Китайский язык</strong>
        <p style="margin: 0.5rem 0 0; font-size: 0.9rem;">Образовательная платформа · V1</p>
      </div>
      <div class="footer-links">
        <a href="{p}library/index.html">Библиотека</a>
        <a href="{p}support/faq.html">FAQ</a>
        <a href="{p}support/contacts.html">Контакты</a>
      </div>
      <p class="footer-copy">&copy; 2026 · Персональная образовательная платформа</p>
    </div>
  </footer>
  <script src="{p}js/atmosphere.js"></script>
  <script src="{p}js/navigation.js"></script>
</body>
</html>
'''


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def hsk_section_page(level_slug, level_name, level_desc, section_id, section_title, filename,
                     description, time_est, prereq, next_section, next_file, full_content=False):
    depth = 2
    p = depth_prefix(depth)
    breadcrumb = f'{p}index.html">Главная</a> / <a href="index.html">Библиотека</a> / <a href="../{level_slug}/index.html">{level_name}</a> / {section_title}'

    if full_content and level_slug == "hsk-1":
        items = '''
        <li><span class="item-label">Видео: Четыре тона китайского языка</span><span class="item-type">Видео</span></li>
        <li><span class="item-label">Таблица слогов пиньинь</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Аудиофайлы для прослушивания</span><span class="item-type">Аудио</span></li>
        <li><span class="item-label">Упражнения для отработки произношения</span><span class="item-type">PDF</span></li>
        <li><span class="item-label">Частые ошибки русскоговорящих</span><span class="item-type">Статья</span></li>''' if section_id == "phonetics" else ""

        if section_id == "grammar":
            items = '''
        <li><span class="item-label">Конспект: предложение 是…的</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Базовые конструкции HSK 1</span><span class="item-type">PDF</span></li>
        <li><span class="item-label">Упражнения на порядок слов</span><span class="item-type">PDF</span></li>
        <li><span class="item-label">Примеры предложений с переводом</span><span class="item-type">Документ</span></li>'''

        if section_id == "characters":
            items = '''
        <li><span class="item-label">Таблица иероглифов HSK 1</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Порядок черт: базовые правила</span><span class="item-type">PDF</span></li>
        <li><span class="item-label">Мнемоники для запоминания</span><span class="item-type">Документ</span></li>
        <li><span class="item-label">Лист для тренировки написания</span><a class="download" href="#">Скачать PDF</a></li>'''

        if section_id == "vocabulary":
            items = '''
        <li><span class="item-label">Список слов HSK 1 (150 слов)</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Карточки для Anki / Quizlet</span><span class="item-type">Ссылка</span></li>
        <li><span class="item-label">Лексика по темам: семья, еда, числа</span><span class="item-type">PDF</span></li>
        <li><span class="item-label">Аудио произношение слов</span><span class="item-type">Аудио</span></li>'''

        if section_id == "speaking":
            items = '''
        <li><span class="item-label">Диалог: Знакомство</span><span class="item-type">PDF + аудио</span></li>
        <li><span class="item-label">Диалог: В кафе</span><span class="item-type">PDF + аудио</span></li>
        <li><span class="item-label">20 полезных фраз для начинающих</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Видео: типичные ситуации</span><span class="item-type">Видео</span></li>'''

        if section_id == "culture":
            items = '''
        <li><span class="item-label">Китайский Новый год: традиции</span><span class="item-type">Статья</span></li>
        <li><span class="item-label">Этикет за столом</span><span class="item-type">Статья</span></li>
        <li><span class="item-label">Видео: повседневная жизнь в Китае</span><span class="item-type">Видео</span></li>'''

        if section_id == "materials":
            items = '''
        <li><span class="item-label">Учебник HSK 1 Standard Course</span><span class="item-type">Ссылка</span></li>
        <li><span class="item-label">Рабочая тетрадь — уроки 1–5</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Презентации к урокам</span><span class="item-type">PPT/PDF</span></li>
        <li><span class="item-label">Домашние задания (общие)</span><a class="download" href="#">Скачать PDF</a></li>
        <li><span class="item-label">Мини-тест HSK 1</span><span class="item-type">PDF</span></li>'''

        placeholder = ""
    else:
        items = ""
        placeholder = '''
      <div class="placeholder-note">
        Раздел в процессе наполнения. Добавьте сюда свои материалы: PDF, ссылки на видео, аудио и конспекты.
      </div>'''

    nav_next = ""
    if next_section and next_file:
        nav_next = f'''
    <nav class="nav-next">
      <span></span>
      <a href="{next_file}" class="btn btn-secondary">Дальше → {next_section}</a>
    </nav>'''

    html = header(f"{section_title} ({level_name})", "library", depth)
    html += f'''
  <main>
    <nav class="breadcrumb" aria-label="Навигация">
      <a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / <a href="index.html">{level_name}</a> / {section_title}
    </nav>
    <h1 class="page-title">{section_title}</h1>
    <p class="page-subtitle">{level_name} · {level_desc}</p>

    <p>{description}</p>

    <div class="meta-block">
      <dl>
        <dt>Уровень</dt><dd>{level_desc.split("·")[1].strip() if "·" in level_desc else level_desc}</dd>
        <dt>Время</dt><dd>{time_est}</dd>
        <dt>Требования</dt><dd>{prereq}</dd>
      </dl>
    </div>

    <section class="section">
      <h2>Содержание раздела</h2>
      <ul class="content-list">{items}
      </ul>{placeholder}
    </section>{nav_next}
  </main>
'''
    html += footer(depth)
    write(os.path.join(BASE, "library", level_slug, filename), html)


def hsk_index(level_slug, level_name, level_desc, next_level):
    depth = 2
    p = depth_prefix(depth)
    cards = ""
    for i, (sid, title, fname, desc, _, _) in enumerate(HSK_SECTIONS):
        cards += f'''
        <article class="card">
          <h3><a href="{fname}">{title}</a></h3>
          <p>{desc}</p>
        </article>'''

    next_link = f'<a href="../{next_level}/index.html" class="btn btn-secondary">Следующий уровень → {HSK_LEVELS[next_level][0]}</a>' if next_level else ""

    html = header(level_name, "library", depth)
    html += f'''
  <main>
    <nav class="breadcrumb" aria-label="Навигация">
      <a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / {level_name}
    </nav>
    <h1 class="page-title">{level_name}</h1>
    <p class="page-subtitle">{level_desc}</p>

    <p>
      Материалы уровня {level_name}: фонетика, грамматика, иероглифика, словарь,
      разговорная практика, культура и учебные материалы. Выберите нужный раздел.
    </p>

    <div class="card-grid">{cards}
    </div>

    <nav class="nav-next">
      <a href="../index.html" class="btn btn-secondary">← Все уровни</a>
      {next_link}
    </nav>
  </main>
'''
    html += footer(depth)
    write(os.path.join(BASE, "library", level_slug, "index.html"), html)


def generate_all():
    for slug, (name, desc, next_lvl) in HSK_LEVELS.items():
        hsk_index(slug, name, desc, next_lvl)
        for i, (sid, stitle, fname, sdesc, time_est, prereq) in enumerate(HSK_SECTIONS):
            next_sec = HSK_SECTIONS[i + 1] if i + 1 < len(HSK_SECTIONS) else None
            hsk_section_page(
                slug, name, desc, sid, stitle, fname, sdesc, time_est, prereq,
                next_sec[1] if next_sec else None,
                next_sec[2] if next_sec else None,
                full_content=(slug == "hsk-1"),
            )

    # Additional & practice subsection pages
    for slug, title, desc in ADDITIONAL:
        depth = 2
        p = depth_prefix(depth)
        html = header(title, "library", depth)
        html += f'''
  <main>
    <nav class="breadcrumb"><a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / <a href="index.html">Дополнительные</a> / {title}</nav>
    <h1 class="page-title">{title}</h1>
    <p class="page-subtitle">Дополнительные материалы · Все уровни</p>
    <p>{desc}</p>
    <div class="placeholder-note">Добавьте материалы в этот раздел: справочники, статьи, ссылки на видео.</div>
  </main>
'''
        html += footer(depth)
        write(os.path.join(BASE, "library", "additional", f"{slug}.html"), html)

    for slug, title, desc in PRACTICE:
        depth = 2
        p = depth_prefix(depth)
        html = header(title, "library", depth)
        html += f'''
  <main>
    <nav class="breadcrumb"><a href="{p}index.html">Главная</a> / <a href="../index.html">Библиотека</a> / <a href="index.html">Практика</a> / {title}</nav>
    <h1 class="page-title">{title}</h1>
    <p class="page-subtitle">Практика и контекст</p>
    <p>{desc}</p>
    <div class="placeholder-note">Добавьте тексты, диалоги, ссылки на аудио и видео.</div>
  </main>
'''
        html += footer(depth)
        write(os.path.join(BASE, "library", "practice", f"{slug}.html"), html)

    print("Generated HSK, additional, and practice pages.")


if __name__ == "__main__":
    generate_all()
