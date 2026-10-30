#!/usr/bin/env python3
"""Проверка материалов библиотеки на Яндекс Диске: открывается ли каждый файл.

Что делает
    Для каждой ссылки из data/links.json повторяет то, что делает браузер
    посетителя: Диск находит файл по публичной ссылке, выдаёт ссылку на
    скачивание и отдаёт сами байты — начало, середину и конец файла (каждый
    кусок до трёх попыток: сбои хранилища бывают плавающими). Байты
    сверяются с локальным файлом. Заодно открывается и сама страница файла
    на Диске — та, куда ведёт кнопка «Открыть».

    С --fix чинит PDF, которые хранилище Яндекса не отдаёт (503 «LRC groups
    are unavailable»), так же, как учебники 29.10: дописывает в конец
    локального файла перевод строки (PDF его не замечает, а Диск видит новый
    файл и не склеивает его со старой битой копией), загружает поверх,
    проверяет снова, и если публичная ссылка сменилась — меняет её в
    data/links.json и на всех страницах сайта. Файлы .docx и .pptx не
    трогает: им лишний байт в конце может навредить.

    Итог — в library/проверка-диска/итог.json, там же образцы страниц Диска
    для разбора. С --wait скрипт ждёт, пока выключат VPN, и сообщает
    уведомлением macOS, когда закончил.

Как запускать (из любой папки)
    python3 scripts/yadisk_check.py               проверить
    python3 scripts/yadisk_check.py --fix         проверить и починить битые PDF
    python3 scripts/yadisk_check.py --wait --fix  то же, дождавшись выключения VPN
    python3 scripts/yadisk_check.py --only journals   только файлы, в пути которых есть «journals»
"""

import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yadisk_upload import (BASE, DISK_ROOT, LAYOUT, LINKS, Disk, DiskError,  # noqa: E402
                           load_token, md5_of, save_links)
from yadisk_films import online, wait_online  # noqa: E402

REPORT = os.path.join(BASE, "library", "проверка-диска")
SPAN = 65536            # байт в каждом проверочном куске
TRIES = 3               # попыток на кусок
WORKERS = 8
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/15.6 Safari/605.1.15")
# Слова, по которым на странице файла видно, что Диск его не покажет.
PAGE_MARKERS = ("заблокирован", "нарушает", "правообладател", "лимит", "не найден",
                "удалён", "удален", "недоступен", "blocked", "showcaptcha")


def log(text):
    print(time.strftime("%H:%M:%S"), text, flush=True)


def notify(text):
    subprocess.run(["osascript", "-e", f'display notification "{text}" with title "Библиотека на Яндекс Диске"'],
                   capture_output=True)


class Offline(Exception):
    """Соединение оборвалось. Пропала ли связь вообще или Диск рвёт его только на
    этом файле, решает run(): если API в это время отвечает — виноват файл."""

    def __init__(self, stage, why):
        super().__init__(why)
        self.stage = stage


def fetch_range(disk, href, start, length):
    req = urllib.request.Request(href, headers={"Range": f"bytes={start}-{start + length - 1}", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60, context=disk._ssl) as r:
        return r.status, r.headers.get("Content-Type"), r.read()


def read_span(disk, href, start, length):
    """Кусок файла с Диска. Возвращает (байты, Content-Type) или (None, причина)."""
    why = ""
    for attempt in range(TRIES):
        try:
            status, ctype, data = fetch_range(disk, href, start, length)
            if len(data) == length:
                return data, ctype
            why = f"ответ {status}, {len(data)} байт вместо {length}"
        except urllib.error.HTTPError as e:
            why = f"{e.code} {e.read()[:120].decode('utf-8', 'replace').strip()}"
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            why = str(getattr(e, "reason", e)) or type(e).__name__
            if attempt == TRIES - 1:
                raise Offline("bytes", f"кусок с {start >> 20} МБ: {why}")
        time.sleep(5)
    return None, why


def open_page(disk, url):
    """Страница файла на Диске, куда ведёт «Открыть»: код ответа, адрес и тревожные слова."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=disk._ssl) as r:
            html = r.read().decode("utf-8", "replace")
            return r.status, r.geturl(), html
    except urllib.error.HTTPError as e:
        return e.code, url, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
        raise Offline("page", "страница файла на Диске: " + (str(getattr(e, "reason", e)) or type(e).__name__))


def check(disk, rel, url):
    """Проверка одного файла. Возвращает словарь с state:
    ok — открывается; broken — Диск не отдаёт байты; page — не открывается страница файла
    на Диске; dead — ссылка не ведёт к файлу; error — другая ошибка Диска; offline —
    соединение оборвалось (stage — на каком шаге: api, bytes, page)."""
    res = {"rel": rel, "url": url, "state": "ok", "notes": []}
    local = os.path.join(BASE, rel)
    try:
        meta = disk.call("GET", "/public/resources", {"public_key": url})[1]
        res["meta"] = {k: meta.get(k) for k in ("name", "size", "md5", "mime_type", "media_type",
                                                 "antivirus_status", "type")}
        href = disk.call("GET", "/public/resources/download", {"public_key": url})[1]["href"]
    except DiskError as e:
        if e.status is None:
            return {**res, "state": "offline", "stage": "api", "why": f"API Диска: {e}"}
        return {**res, "state": "dead" if e.status in (404, 410) else "error", "why": str(e)}
    except http.client.HTTPException as e:
        return {**res, "state": "offline", "stage": "api", "why": f"API Диска: {type(e).__name__}"}
    size = meta.get("size") or 0
    if meta.get("antivirus_status") not in (None, "clean"):
        res["notes"].append(f"антивирус Диска: {meta.get('antivirus_status')}")
    same_local = os.path.exists(local) and os.path.getsize(local) == size
    if os.path.exists(local) and md5_of(local) != meta.get("md5"):
        res["notes"].append("на Диске не та версия, что у вас на Mac")
    try:
        for start in sorted({0, size // 2, max(size - SPAN, 0)}):
            length = min(SPAN, size - start)
            data, info = read_span(disk, href, start, length)
            if data is None:
                return {**res, "state": "broken", "stage": "bytes", "why": f"кусок с {start >> 20} МБ: {info}"}
            res.setdefault("content_type", info)
            if same_local:
                with open(local, "rb") as f:
                    f.seek(start)
                    if f.read(length) != data:
                        res["notes"].append(f"байты с {start >> 20} МБ не совпали с локальным файлом")
        status, final, html = open_page(disk, url)
    except Offline as e:
        return {**res, "state": "offline", "stage": e.stage, "why": str(e)}
    low = html.lower()
    res["page"] = {"status": status, "url": final, "markers": [m for m in PAGE_MARKERS if m in low]}
    res["_html"] = html
    if status >= 400:
        res["notes"].append(f"страница файла на Диске отвечает {status}")
    if "showcaptcha" in final:
        # Скрипту Яндекс показывает капчу вместо страницы — её содержимое не проверено.
        res["page"]["markers"] = []
        res["page"]["captcha"] = True
    return res


def check_all(disk, links):
    with ThreadPoolExecutor(WORKERS) as pool:
        return list(pool.map(lambda kv: check(disk, *kv), links.items()))


def replace_everywhere(old, new):
    """Меняет ссылку old на new во всех HTML-страницах сайта."""
    changed = []
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        for name in files:
            if not name.endswith(".html"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8", newline="") as f:
                text = f.read()
            if old in text:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(text.replace(old, new))
                changed.append(os.path.relpath(path, BASE))
    return changed


def repair(disk, res, layout, links):
    """Чинит битый PDF. Возвращает новый результат проверки."""
    rel = res["rel"]
    local = os.path.join(BASE, rel)
    if not rel.lower().endswith(".pdf"):
        res["notes"].append("не PDF — автоматически не чиню")
        return res
    if rel not in layout:
        res["notes"].append("нет в data/yadisk-layout.json — не знаю, куда грузить")
        return res
    dest = f"{DISK_ROOT}/{layout[rel]}"
    for attempt in (1, 2):
        with open(local, "ab") as f:
            f.write(b"\n")
        size = os.path.getsize(local)
        log(f"  чиню {rel}: перевод строки в конце, загрузка поверх (попытка {attempt})")
        disk.upload(local, dest)
        disk.wait_ready(dest, size)
        url = disk.publish(dest)
        if url != links[rel]:
            pages = replace_everywhere(links[rel], url)
            log(f"  новая ссылка {url} — заменена на страницах: {', '.join(pages) or 'нигде'}")
            links[rel] = url
            save_links(links)
        new = check(disk, rel, url)
        new["repaired"] = attempt
        if new["state"] != "broken":
            return new
    return new


def write_report(results):
    """library/проверка-диска/итог.json и по образцу страницы Диска на раздел."""
    os.makedirs(REPORT, exist_ok=True)
    samples = set()
    for res in results:
        html = res.pop("_html", None)
        section = res["rel"].split("/")[1]
        if html and section not in samples:
            samples.add(section)
            with open(os.path.join(REPORT, f"страница-{section}.txt"), "w", encoding="utf-8") as f:
                f.write(f"{res['url']}\n{res['page']}\n\n{html}")
    results.sort(key=lambda r: r["rel"])
    with open(os.path.join(REPORT, "итог.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


def run(disk, args):
    """Один проход. Возвращает (код, строка для уведомления); код 2 — пропала связь."""
    with open(LINKS, encoding="utf-8") as f:
        links = json.load(f)
    with open(LAYOUT, encoding="utf-8") as f:
        layout = json.load(f)
    todo = {rel: url for rel, url in links.items() if not args.only or args.only in rel}
    log(f"Проверяю {len(todo)} файлов на Диске…")
    results = check_all(disk, todo)
    for _ in range(2):
        lost = [r for r in results if r["state"] == "offline"]
        if not lost:
            break
        log(f"Соединение обрывалось на {len(lost)} файлах — проверяю их ещё раз:")
        for r in lost[:10]:
            log(f"    {r['rel']} — {r['why']}")
        again = check_all(disk, {r["rel"]: r["url"] for r in lost})
        results = [r for r in results if r["state"] != "offline"] + again
    lost = [r for r in results if r["state"] == "offline"]
    if lost:
        if sum(online() for _ in range(3)) < 2:
            write_report(results)
            log("Связи с Яндексом нет — проверка на паузе")
            return 2, ""
        # API Диска отвечает, а эти файлы раз за разом рвут соединение — дело в них.
        for r in lost:
            r["state"] = "broken" if r["stage"] == "bytes" else "page" if r["stage"] == "page" else "error"
            r["why"] = "Диск раз за разом обрывает соединение — " + r["why"]

    if args.fix:
        for i, res in enumerate(results):
            if res["state"] == "broken" and res.get("stage") == "bytes":
                try:
                    results[i] = repair(disk, res, layout, links)
                except (DiskError, http.client.HTTPException) as e:
                    if getattr(e, "status", None) is None:
                        log(f"  {res['rel']}: пропала связь во время починки")
                        write_report(results)
                        return 2, ""
                    res["notes"].append(f"починить не вышло: {e}")

    write_report(results)
    ok = [r for r in results if r["state"] == "ok"]
    fixed = [r for r in ok if r.get("repaired")]
    for r in results:
        line = f"  {'✓' if r['state'] == 'ok' else '✗'} {r['rel']}"
        if r["state"] != "ok":
            line += f" — {r['state']}: {r.get('why', '')}"
        if r.get("repaired"):
            line += " — починен"
        if r["notes"] or r.get("page", {}).get("markers"):
            line += f" [{'; '.join(r['notes'] + r.get('page', {}).get('markers', []))}]"
        if r["state"] != "ok" or r.get("repaired") or r["notes"] or r.get("page", {}).get("markers"):
            print(line, flush=True)
    log(f"Итог: открываются {len(ok)} из {len(results)}, починено {len(fixed)}. "
        f"Подробно — library/проверка-диска/итог.json")
    captcha = sum(1 for r in results if r.get("page", {}).get("captcha"))
    if captcha:
        log(f"Страницу «Открыть» на Диске проверить не вышло у {captcha} файлов: Яндекс показал капчу. "
            "Байты файлов проверены, страницу — только в браузере.")
    summary = f"Открываются {len(ok)} из {len(results)} файлов"
    if fixed:
        summary += f", починено {len(fixed)}"
    return (0 if len(ok) == len(results) else 1), summary


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fix", action="store_true", help="чинить PDF, которые Диск не отдаёт")
    ap.add_argument("--wait", action="store_true", help="ждать связи с Диском и сообщить уведомлением")
    ap.add_argument("--only", help="проверять только файлы, в пути которых есть эта строка")
    args = ap.parse_args(argv)

    token = load_token()
    if not token:
        print("Нет токена: впишите YANDEX_DISK_TOKEN=… в .env в корне проекта.", file=sys.stderr)
        return 1
    disk = Disk(token)
    if not args.wait:
        return run(disk, args)[0]
    started = False
    while True:
        log("Жду связи с Яндекс Диском — выключите VPN…")
        wait_online()
        notify(("Продолжаю проверку" if started else "Проверяю библиотеку на Диске") + " — VPN пока не включайте")
        started = True
        awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        try:
            code, summary = run(disk, args)
        finally:
            awake.terminate()
        if code != 2:
            break
        notify("Связь с Яндексом пропала — проверка на паузе. Продолжу, когда VPN выключат")
    notify(summary + ". Можно включать VPN")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
