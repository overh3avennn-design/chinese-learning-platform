#!/usr/bin/env python3
"""Скачивание списков слов HSK и проверка ссылок каталога ресурсов.

Что делает
    1. Скачивает файлы из data/sources.json в data/raw/ (только те, которых
       там ещё нет): перед первым запросом к сайту читает его robots.txt,
       между запросами ждёт delay_seconds, представляется своим User-Agent.
       Скачанное проверяется (размер > 1 КБ, есть иероглифы, число строк
       близко к expected_rows) и записывается, только если проверка прошла.
    2. Приводит всё к data/vocab/hsk-N-СТАНДАРТ.csv (hsk-1-2.0.csv, hsk-1-3.0.csv):
           hanzi,pinyin,translation_ru,translation_en,level,standard
       translation_en — из источника (есть только у HSK 2.0 с hskhsk.com).
       translation_ru — из data/translations_ru.csv: переводы сделаны
       автоматически (Claude) и не сверены с преподавателем. Русские
       словарные статьи ChinesePlus не используются: это авторский текст.

Как запускать
    python3 scripts/fetch_data.py                скачать недостающее и пересобрать data/vocab/
    python3 scripts/fetch_data.py --check-links  проверить ссылки data/resources.json,
                                                 записать код ответа и дату в "checked"

Что НЕ делает
    Не перекачивает то, что уже лежит в data/raw/ (чтобы скачать заново,
    удалите файл). Не обходит robots.txt: если он запрещает, скрипт
    останавливается. Не качает ничего, кроме перечисленного в sources.json.
"""

import csv
import datetime
import io
import json
import logging
import os
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
RAW = os.path.join(DATA, "raw")
VOCAB = os.path.join(DATA, "vocab")
SOURCES = os.path.join(DATA, "sources.json")
RESOURCES = os.path.join(DATA, "resources.json")
TRANSLATIONS_RU = os.path.join(DATA, "translations_ru.csv")

VOCAB_COLUMNS = ["hanzi", "pinyin", "translation_ru", "translation_en", "level", "standard"]
MIN_BYTES = 1024
ROW_TOLERANCE = 0.05  # допустимое отклонение числа строк от expected_rows
TIMEOUT = 30
SYSTEM_CA = "/etc/ssl/cert.pem"
HANZI = re.compile(r"[一-鿿]")

log = logging.getLogger("fetch_data")


class RobotsDisallowed(Exception):
    pass


# ---------------------------------------------------------------- сеть

class Client:
    """Все запросы к чужим серверам идут через него: пауза, User-Agent, robots.txt."""

    def __init__(self, user_agent, delay):
        self.user_agent = user_agent
        self.delay = delay
        self.last_request = 0.0
        self.robots = {}
        # Python с python.org на macOS приходит без корневых сертификатов;
        # тогда берём системные, те же, что у curl. Проверка не отключается.
        self.ssl = ssl.create_default_context()
        paths = ssl.get_default_verify_paths()
        if not (paths.cafile or paths.capath) and os.path.exists(SYSTEM_CA):
            self.ssl.load_verify_locations(SYSTEM_CA)

    def _wait(self):
        pause = self.last_request + self.delay - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        self.last_request = time.monotonic()

    def request(self, url, method="GET"):
        """(код ответа, итоговый URL, тело). HTTP-ошибки возвращаются кодом, не исключением."""
        self._wait()
        req = urllib.request.Request(url, method=method, headers={"User-Agent": self.user_agent})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=self.ssl) as resp:
                return resp.status, resp.geturl(), resp.read() if method == "GET" else b""
        except urllib.error.HTTPError as err:
            return err.code, url, b""

    def allowed(self, url):
        """Разрешает ли robots.txt сайта этот URL. Читается один раз на сайт."""
        parts = urllib.parse.urlsplit(url)
        site = f"{parts.scheme}://{parts.netloc}"
        if site not in self.robots:
            robots_url = site + "/robots.txt"
            try:
                code, _, body = self.request(robots_url)
            except (urllib.error.URLError, OSError) as err:
                raise RobotsDisallowed(f"не удалось прочитать {robots_url}: {err}") from err
            parser = urllib.robotparser.RobotFileParser()
            if 200 <= code < 300:
                parser.parse(body.decode("utf-8", errors="replace").splitlines())
            elif 400 <= code < 500:  # robots.txt нет — ограничений нет (RFC 9309)
                parser.allow_all = True
            else:  # сервер не смог ответить — считаем, что запрещено
                raise RobotsDisallowed(f"{robots_url} ответил {code}, считаю доступ запрещённым")
            self.robots[site] = parser
        return self.robots[site].can_fetch(self.user_agent, url)


# ---------------------------------------------------------------- разбор источников

def clean(text):
    return unicodedata.normalize("NFC", text).strip()


def parse_hskhsk_tsv(text):
    """hskhsk.com: упрощённый, традиционный, пиньинь цифрами, пиньинь со знаками, английский."""
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        cols = line.rstrip("\t").split("\t")  # в списке L3 у каждой строки лишний таб в конце
        if len(cols) != 5:
            raise ValueError(f"ожидалось 5 колонок через табуляцию, в строке {len(cols)}: {line[:60]!r}")
        rows.append({"hanzi": clean(cols[0]), "pinyin": clean(cols[3]), "translation_en": clean(cols[4])})
    return rows


def parse_chineseplus_csv(text):
    """ChinesePlus: chinese, pinyin, russian. Колонка russian — словарная статья, её не берём."""
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if header != ["chinese", "pinyin", "russian"]:
        raise ValueError(f"неожиданный заголовок CSV: {header}")
    return [{"hanzi": clean(r[0]), "pinyin": clean(r[1]), "translation_en": ""} for r in reader if r]


PARSERS = {"hskhsk-tsv": parse_hskhsk_tsv, "chineseplus-csv": parse_chineseplus_csv}


def decode(body):
    return body.decode("utf-8-sig")


def validate(source, body):
    """Список причин, почему скачанное — не данные. Пустой список — всё хорошо."""
    if len(body) <= MIN_BYTES:
        return [f"файл слишком маленький: {len(body)} байт"]
    try:
        text = decode(body)
    except UnicodeDecodeError as err:
        return [f"не UTF-8: {err}"]
    if re.match(r"\s*<(!doctype|html)", text, re.I):
        return ["пришла HTML-страница, а не файл с данными"]
    if not HANZI.search(text):
        return ["в файле нет китайских иероглифов"]
    try:
        rows = PARSERS[source["format"]](text)
    except (ValueError, csv.Error) as err:
        return [f"не разобрать как {source['format']}: {err}"]
    expected = source["expected_rows"]
    if abs(len(rows) - expected) > expected * ROW_TOLERANCE:
        return [f"строк {len(rows)}, ожидалось около {expected}"]
    return []


# ---------------------------------------------------------------- скачивание

def fetch_all(manifest):
    """Скачивает недостающее. Возвращает {id: "кэш" | "скачан" | "ошибка: …"}."""
    client = Client(manifest["user_agent"], max(1.0, manifest["delay_seconds"]))
    os.makedirs(RAW, exist_ok=True)
    result = {}
    for source in manifest["sources"]:
        path = os.path.join(RAW, source["file"])
        if os.path.exists(path):
            result[source["id"]] = "кэш"
            continue
        url = source["url"]
        try:
            if not client.allowed(url):
                raise RobotsDisallowed(f"robots.txt запрещает {url}")
            code, final_url, body = client.request(url)
            if code != 200:
                raise ValueError(f"HTTP {code}")
            problems = validate(source, body)
            if problems:
                raise ValueError("; ".join(problems))
        except RobotsDisallowed as err:
            log.error("%s — стоп: %s. Обходить не буду, решите сами.", url, err)
            result[source["id"]] = f"стоп: {err}"
            return result, True
        except (urllib.error.URLError, OSError, ValueError) as err:
            log.error("%s — не записан: %s", url, err)
            result[source["id"]] = f"ошибка: {err}"
            continue
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        log.info("скачан %s → data/raw/%s (%d КБ)", final_url, source["file"], len(body) // 1024)
        result[source["id"]] = "скачан"
    return result, False


# ---------------------------------------------------------------- нормализация

def pinyin_key(pinyin):
    return re.sub(r"[\s'’·-]", "", unicodedata.normalize("NFC", pinyin).lower())


def load_translations():
    """{(иероглифы, пиньинь): перевод} и {иероглифы: [переводы]} из data/translations_ru.csv."""
    exact, by_hanzi = {}, {}
    if not os.path.exists(TRANSLATIONS_RU):
        return exact, by_hanzi
    with open(TRANSLATIONS_RU, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            ru = row["translation_ru"].strip()
            if not ru:
                continue
            exact[(row["hanzi"], pinyin_key(row["pinyin"]))] = ru
            by_hanzi.setdefault(row["hanzi"], []).append(ru)
    return exact, by_hanzi


def translate(row, exact, by_hanzi):
    found = exact.get((row["hanzi"], pinyin_key(row["pinyin"])))
    if found is None and len(by_hanzi.get(row["hanzi"], [])) == 1:
        found = by_hanzi[row["hanzi"]][0]  # одно чтение — пиньинь в источниках записан по-разному
    return found or ""


def build_vocab(manifest):
    """{уровень: [строки]} из всего, что лежит в data/raw/."""
    exact, by_hanzi = load_translations()
    levels = {}
    for source in manifest["sources"]:
        path = os.path.join(RAW, source["file"])
        if not os.path.exists(path):
            continue
        with open(path, "rb") as f:
            rows = PARSERS[source["format"]](decode(f.read()))
        for row in rows:
            levels.setdefault(source["level"], []).append({
                "hanzi": row["hanzi"],
                "pinyin": row["pinyin"],
                "translation_ru": translate(row, exact, by_hanzi),
                "translation_en": row["translation_en"],
                "level": source["level"],
                "standard": source["standard"],
            })
    return levels


def write_vocab(levels):
    """Пишет data/vocab/hsk-N-СТАНДАРТ.csv, только если содержимое изменилось.

    Файл на каждый стандарт, а не один на уровень: у HSK 2.0 и HSK 3.0 на
    сайте свои страницы «Словарь», и CSV, который с них скачивают, должен
    содержать ровно тот список слов, который на странице обещан. Колонку
    "standard" оставляем — по ней видно, откуда файл, и её читает
    scripts/make_vocab_pdf.py.
    """
    os.makedirs(VOCAB, exist_ok=True)
    changed = []
    for level, rows in sorted(levels.items()):
        by_standard = {}
        for row in rows:
            by_standard.setdefault(row["standard"], []).append(row)
        for standard, std_rows in sorted(by_standard.items()):
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=VOCAB_COLUMNS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(std_rows)
            path = os.path.join(VOCAB, f"hsk-{level}-{standard}.csv")
            text = buf.getvalue()
            if os.path.exists(path):
                with open(path, encoding="utf-8", newline="") as f:
                    if f.read() == text:
                        continue
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            changed.append(path)
    return changed


# ---------------------------------------------------------------- --check-links

def check_links():
    with open(SOURCES, encoding="utf-8") as f:
        manifest = json.load(f)
    with open(RESOURCES, encoding="utf-8") as f:
        resources = json.load(f)
    client = Client(manifest["user_agent"], max(1.0, manifest["delay_seconds"]))
    today = datetime.date.today().isoformat()
    for res in resources:
        url = res["url"]
        checked = {"date": today, "code": None}
        try:
            code, _, _ = client.request(url, method="HEAD")
            if code in (403, 405, 501):  # часть сайтов не принимает HEAD — пробуем GET
                code, _, _ = client.request(url)
            checked["code"] = code
            res["status"] = "ok" if code < 400 else "dead"
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", err)
            log.error("%s — не отвечает: %s", url, reason)
            checked["error"] = str(reason)
            res["status"] = "unreachable"
        res["checked"] = checked
        print(f"  {res['status']:<12} {checked['code'] or '—':<4} {url}")
    with open(RESOURCES, "w", encoding="utf-8", newline="\n") as f:
        f.write(dump_resources(resources))
    bad = [r["id"] for r in resources if r["status"] != "ok"]
    print(f"\nПроверено {len(resources)}, недоступны: {', '.join(bad) or 'нет'}")
    return 1 if bad else 0


def dump_resources(resources):
    """JSON с короткими списками и словарями в одну строку, как в исходном файле."""
    text = json.dumps(resources, ensure_ascii=False, indent=2)
    text = re.sub(r"\[\s+((?:\"[^\"]*\",?\s*)+)\]",
                  lambda m: "[" + ", ".join(re.findall(r"\"[^\"]*\"", m.group(1))) + "]", text)
    text = re.sub(r"\"checked\": \{\s+(.*?)\s+\}",
                  lambda m: "\"checked\": { " + re.sub(r",\s+", ", ", m.group(1)) + " }", text, flags=re.S)
    return text + "\n"


# ---------------------------------------------------------------- main

def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    if "--check-links" in argv:
        return check_links()

    with open(SOURCES, encoding="utf-8") as f:
        manifest = json.load(f)
    fetched, stopped = fetch_all(manifest)
    levels = build_vocab(manifest)
    changed = write_vocab(levels)

    print("\nИсточники:")
    for source in manifest["sources"]:
        state = fetched.get(source["id"], "пропущен (скрипт остановлен)")
        path = os.path.join(RAW, source["file"])
        rows = ""
        if os.path.exists(path):
            with open(path, "rb") as f:
                rows = f"{len(PARSERS[source['format']](decode(f.read()))):>5} строк (ожидалось {source['expected_rows']})"
        print(f"  {source['id']:<7} {state:<10} {rows}")

    print("\ndata/vocab/:")
    for level, rows in sorted(levels.items()):
        by_std = {}
        for row in rows:
            by_std.setdefault(row["standard"], []).append(row)
        for std, std_rows in sorted(by_std.items()):
            ru = sum(1 for r in std_rows if r["translation_ru"])
            print(f"  hsk-{level}-{std}.csv  {len(std_rows):>5} строк, с русским переводом {ru}")

    downloaded = sum(1 for s in fetched.values() if s == "скачан")
    failed = [i for i, s in fetched.items() if s not in ("скачан", "кэш")]
    print(f"\nСкачано {downloaded}, из кэша {sum(1 for s in fetched.values() if s == 'кэш')}, "
          f"не удалось {len(failed)}{': ' + ', '.join(failed) if failed else ''}. "
          f"Обновлено файлов в data/vocab/: {len(changed)}.")
    return 1 if failed or stopped else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
