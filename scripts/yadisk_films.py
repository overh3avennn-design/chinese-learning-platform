#!/usr/bin/env python3
"""Перенос фильмов «Привет, Китай» с чужой публичной папки на свой Яндекс Диск.

Зачем
    Страница library/culture/films.html показывала фильмы из чужой публичной
    папки (SOURCE). Хранилище Яндекса отдаёт куски многих её файлов через раз
    (503 «file IO failure: LRC groups are unavailable»), и такие фильмы на
    сайте не запускаются. Починить файлы в чужой папке нельзя, поэтому они
    переезжают на свой Диск.

Что делает
    1. Скачивает видео из SOURCE в library/culture/films/ кусками по 4 МБ, в
       любом порядке: кусок, который Диск не отдал, откладывается и
       повторяется позже, а потоки тем временем берут другие. Скачанные куски
       лежат в «имя.part» (список — в «имя.part.json») и не теряются между
       запусками, так что битый файл собирается постепенно. Готовый файл
       сверяется с md5 из списка Диска.
    2. Дописывает в конец файла пустой блок MP4 «free» (8 байт). Плееры его
       не замечают, а Диск видит новый файл и не склеивает его со старой
       битой копией (с учебниками было именно так).
    3. Загружает готовые файлы в DEST на своём Диске (уже загруженные с тем
       же md5 пропускает): видео API Диска принимает не быстрее 128 КБ/с,
       поэтому файл идёт под расширением .upload и на Диске переименовывается.
       Уже скачанное грузится до докачки, остальное — после. Затем
       публикует папку и проверяет, что Диск отдаёт начало, середину и конец
       каждого файла и считает его видео. Ссылку на папку ставит в
       films.html, только когда перенесены все фильмы и все читаются; с
       --point-page — и при неполном переносе (на сайте будут только
       перенесённые).

    Скачивание длится не дольше --minutes минут. Если 3 минуты подряд Диск
    не ответил ни разу (обычно — включился VPN), скрипт останавливается с
    кодом 2. Недоделанное доделает следующий запуск.

    С --wait скрипт сам ждёт, пока Диск станет доступен, после обрыва связи
    ждёт снова и продолжает, пока перенос не закончится; о начале, паузе и
    конце сообщает уведомлениями macOS, а пока переносит — не даёт Mac
    уснуть. После перезагрузки Mac его достаточно запустить заново.

Как запускать (из любой папки)
    python3 scripts/yadisk_films.py                 скачать (30 мин), загрузить
    python3 scripts/yadisk_films.py --wait          ждать, пока выключат VPN, и довести перенос до конца
    python3 scripts/yadisk_films.py --minutes 60    дать скачиванию час
    python3 scripts/yadisk_films.py --point-page    переключить сайт и при неполном переносе

    Токен и VPN — как у scripts/yadisk_upload.py: токен берётся из .env,
    VPN на время переноса нужно выключить.
"""

import argparse
import heapq
import http.client
import itertools
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yadisk_upload import (API, BASE, DISK_ROOT, Disk, DiskError, load_token, mb,  # noqa: E402
                           md5_of, ssl_context)

SOURCE = "https://disk.yandex.ru/d/m8KBkUbYJi5Qsg"
DEST = DISK_ROOT + "/Культура Китая/Фильмы «Привет, Китай»"
LOCAL = os.path.join(BASE, "library", "culture", "films")
PAGE = os.path.join(BASE, "library", "culture", "films.html")

CHUNK = 4 << 20           # байт в одном Range-запросе
WORKERS = 6               # запросов к Диску одновременно
RETRY_AFTER = (15, 30, 60, 120)   # через сколько секунд повторять кусок после отказа
SILENCE = 180             # секунд без единого ответа Диска — считаем, что связи нет
HREF_TTL = 1200           # секунд, после которых ссылку на файл берём заново
FREE_BOX = b"\x00\x00\x00\x08free"
TMP_EXT = ".upload"       # расширение, под которым видео грузится в обход ограничения скорости


def log(text):
    print(time.strftime("%H:%M:%S"), text, flush=True)


def is_video(item):
    return item.get("type") == "file" and (item.get("media_type") == "video"
                                           or (item.get("mime_type") or "").startswith("video/"))


def list_source(disk, path="/", depth=0):
    """Все видео SOURCE (с подпапками, как js/main.js)."""
    found, offset = [], 0
    while True:
        data = disk.call("GET", "/public/resources", {
            "public_key": SOURCE, "path": path, "limit": 100, "offset": offset,
            "fields": "type,_embedded.total,_embedded.items.name,_embedded.items.path,"
                      "_embedded.items.type,_embedded.items.size,_embedded.items.md5,"
                      "_embedded.items.media_type,_embedded.items.mime_type"})[1]
        emb = data.get("_embedded") or {"items": [], "total": 0}
        for item in emb["items"]:
            if is_video(item):
                found.append(item)
            elif item.get("type") == "dir" and depth < 3:
                found += list_source(disk, item["path"], depth + 1)
        offset += len(emb["items"])
        if not emb["items"] or offset >= emb.get("total", 0):
            return found


class Film:
    """Один фильм: какие куски уже скачаны, запись куска, сборка файла."""

    def __init__(self, disk, item):
        self.disk, self.item = disk, item
        self.size = item["size"]
        self.target = os.path.join(LOCAL, item["name"])
        self.part = self.target + ".part"
        self.state = self.part + ".json"
        self.chunks = (self.size + CHUNK - 1) // CHUNK
        self.lock = threading.Lock()
        self.href, self.href_at = None, 0
        self.finished = False
        self.retried = False
        if os.path.exists(self.part) and os.path.exists(self.state):
            with open(self.state, encoding="utf-8") as f:
                self.done = set(json.load(f))
        elif os.path.exists(self.part) and os.path.getsize(self.part) < self.size:
            # .part от прежней версии скрипта — куски подряд с начала.
            self.done = set(range(os.path.getsize(self.part) // CHUNK))
        else:
            # Полноразмерный .part без списка кусков — прошлый запуск оборвался
            # раньше, чем записал хоть один: внутри нули, а не куски.
            self.done = set()
        with open(self.part, "ab") as f:
            f.truncate(self.size)
        self.save()

    def missing(self):
        return [i for i in range(self.chunks) if i not in self.done]

    def fetch(self, idx):
        """Пробует скачать кусок один раз. Возвращает (итог, ответил_ли_Диск, текст)."""
        start = idx * CHUNK
        length = min(CHUNK, self.size - start)
        answered = False
        try:
            if not self.href or time.time() - self.href_at > HREF_TTL:
                self.href = self.disk.call("GET", "/public/resources/download",
                                           {"public_key": SOURCE, "path": self.item["path"]})[1]["href"]
                self.href_at = time.time()
            answered = True
            req = urllib.request.Request(self.href, headers={"Range": f"bytes={start}-{start + length - 1}"})
            with urllib.request.urlopen(req, timeout=60, context=self.disk._ssl) as r:
                data = r.read()
            if r.status != 206 or len(data) != length:
                return "fail", True, f"ответ {r.status}, {len(data)} байт вместо {length}"
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                self.href = None
            return "fail", True, f"{e.code} {e.read()[:120].decode('utf-8', 'replace')}"
        except DiskError as e:
            return "fail", e.status is not None, str(e)
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            return "fail", answered and isinstance(e, http.client.HTTPException), \
                str(getattr(e, "reason", e)) or type(e).__name__
        with self.lock:
            with open(self.part, "r+b") as f:
                f.seek(start)
                f.write(data)
            self.done.add(idx)
            self.save()
        return "ok", True, ""

    def save(self):
        tmp = self.state + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(self.done), f)
        os.replace(tmp, self.state)

    def finish(self):
        """Все куски на месте: сверить md5, дописать блок free, переименовать."""
        with self.lock:
            if self.finished:
                return None
            self.finished = True
        if md5_of(self.part) != self.item["md5"]:
            # Какой кусок испорчен, не узнать — файл качается с нуля.
            with self.lock:
                self.done = set()
                with open(self.part, "wb") as f:
                    f.truncate(self.size)
                self.save()
                self.finished = False
            return "скачанный файл не совпал по md5 — качаю заново"
        with open(self.part, "ab") as f:
            f.write(FREE_BOX)
        os.replace(self.part, self.target)
        os.remove(self.state)
        return None


def download_all(disk, items, minutes):
    """Качает куски всех фильмов по очереди с отложенными повторами.

    Возвращает (готовые имена, {имя: причина}) и признак, что пропала связь.
    """
    os.makedirs(LOCAL, exist_ok=True)
    films = [Film(disk, it) for it in items if not os.path.exists(os.path.join(LOCAL, it["name"]))]
    seq = itertools.count()
    heap = [(0, next(seq), film, idx, 0) for film in films for idx in film.missing()]
    heapq.heapify(heap)
    log(f"Скачать: {len(films)} из {len(items)} фильмов, {len(heap)} кусков по {CHUNK >> 20} МБ")

    cond = threading.Condition()
    deadline = time.time() + minutes * 60
    state = {"inflight": 0, "answered": time.time(), "offline": False}
    errors = {}
    finished = []

    def complete(film):
        err = film.finish()
        with cond:
            if err:
                errors[film.item["name"]] = err
                # Второй раз за проход не качаем: если md5 снова не сойдётся,
                # дело не в случайном сбое.
                if not film.retried:
                    film.retried = True
                    for idx in film.missing():
                        heapq.heappush(heap, (0, next(seq), film, idx, 0))
                    cond.notify_all()
            else:
                finished.append(film.item["name"])
        log(f"  ↓ {film.item['name']} — {err or 'скачан (' + mb(film.size) + ')'}")

    def worker():
        while True:
            with cond:
                while True:
                    now = time.time()
                    if now > deadline or state["offline"]:
                        return
                    if now - state["answered"] > SILENCE:
                        state["offline"] = True
                        cond.notify_all()
                        return
                    if not heap and not state["inflight"]:
                        return
                    if heap and heap[0][0] <= now:
                        _, _, film, idx, tries = heapq.heappop(heap)
                        state["inflight"] += 1
                        break
                    cond.wait(timeout=1)
            result, answered, text = film.fetch(idx)
            with cond:
                if answered:
                    state["answered"] = time.time()
                if result == "ok":
                    errors.pop(film.item["name"], None)
                    ready = len(film.done) == film.chunks
                else:
                    errors[film.item["name"]] = f"кусок с {idx * CHUNK >> 20} МБ: {text}"
                    delay = RETRY_AFTER[min(tries, len(RETRY_AFTER) - 1)]
                    heapq.heappush(heap, (time.time() + delay, next(seq), film, idx, tries + 1))
                    ready = False
                if not ready:
                    state["inflight"] -= 1
                cond.notify_all()
            if ready:
                # Пока файл сверяется, поток считается занятым: если md5 не
                # сойдётся, куски вернутся в очередь, и остальные не должны
                # решить, что работа кончилась.
                try:
                    complete(film)
                finally:
                    with cond:
                        state["inflight"] -= 1
                        cond.notify_all()

    # Все куски есть, а файл не собран — прошлый запуск оборвался на сборке.
    for film in films:
        if not film.missing():
            complete(film)

    threads = [threading.Thread(target=worker) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    left = {}
    for film in films:
        if film.item["name"] in finished:
            continue
        missing = film.missing()
        why = errors.get(film.item["name"], "не успел за отведённое время")
        left[film.item["name"]] = f"не хватает {len(missing)} из {film.chunks} кусков; последнее: {why}"
    return finished, left, state["offline"]


def wait_same(disk, path, md5):
    """Свойства файла, когда по пути path на Диске окажется файл с этим md5."""
    deadline = time.time() + 180
    while True:
        info = disk.meta(path, fields="name,size,md5,media_type,mime_type")
        if info and info.get("md5") == md5:
            return info
        if time.time() > deadline:
            raise DiskError("файл загружен, но так и не появился на Диске под своим именем")
        time.sleep(3)


def put(disk, local, dest, md5, fast):
    """Загружает фильм. Возвращает свойства файла на Диске.

    Ссылку для загрузки видео (.mp4 и др.) API Диска выдаёт с ограничением
    128 КБ/с — фильм грузился бы 3 минуты. Решает это имя файла в момент
    запроса ссылки, а не содержимое, поэтому при fast файл грузится как
    «имя.upload» и уже на Диске переименовывается в «имя.mp4».
    """
    if not fast:
        disk.upload(local, dest)
        return wait_same(disk, dest, md5)
    tmp = os.path.splitext(dest)[0] + TMP_EXT
    info = disk.meta(tmp)
    if not (info and info.get("md5") == md5):     # иначе остался от оборванного запуска
        disk.upload(local, tmp)
        wait_same(disk, tmp, md5)
    disk.call("POST", "/resources/move", {"from": tmp, "path": dest, "overwrite": "true"})
    return wait_same(disk, dest, md5)


def is_video_on_disk(disk, dest, info):
    """Сайт показывает только файлы, которые Диск считает видео (js/main.js)."""
    for _ in range(10):            # тип Диск может определить не сразу после переименования
        if is_video({**info, "type": "file"}):
            return True
        time.sleep(3)
        info = disk.meta(dest, fields="name,size,md5,media_type,mime_type") or info
    return False


def upload_all(disk, items):
    """Загружает скачанные фильмы. Возвращает (сколько на Диске, {имя: ошибка}, нет ли связи)."""
    ready = [it for it in items if os.path.exists(os.path.join(LOCAL, it["name"]))]
    if not ready:
        return 0, {}, False
    log(f"Загрузить на Диск: {len(ready)} фильмов")
    parts = DEST.split("/")
    for i in range(2, len(parts) + 1):     # parts[0] — «disk:»
        disk.mkdir("/".join(parts[:i]))
    on_disk, already, failed = 0, 0, {}
    fast = True
    for item in ready:
        local = os.path.join(LOCAL, item["name"])
        dest = f"{DEST}/{item['name']}"
        size = os.path.getsize(local)
        if failed and any(e.startswith(("401", "507")) for e in failed.values()):
            failed[item["name"]] = "не загружался: загрузка остановлена выше"
            continue
        try:
            md5 = md5_of(local)
            info = disk.meta(dest)
            if info and info.get("size") == size and info.get("md5") == md5:
                on_disk += 1
                already += 1
                continue
            started = time.time()
            info = put(disk, local, dest, md5, fast)
            note = ""
            if fast and not is_video_on_disk(disk, dest, info):
                # Тогда сайт файл не покажет — грузим его и остальные по-честному, медленно.
                fast = False
                note = (f"; после переименования Диск не признал его видео "
                        f"({info.get('media_type')}, {info.get('mime_type')}) — гружу без обхода, медленно")
                put(disk, local, dest, md5, fast)
            seconds = time.time() - started
            state = f"загружен ({mb(size)}, {seconds:.0f} с, {size / 1024 / max(seconds, 1):.0f} КБ/с{note})"
            on_disk += 1
        except DiskError as e:
            log(f"  ↑ {item['name']} — ✗ {e}")
            if e.status is None:           # нет связи — дальше пробовать бесполезно
                return on_disk, failed, True
            failed[item["name"]] = f"{e.status} {e}"
            continue
        log(f"  ↑ {item['name']} — {state}")
    if already:
        log(f"  ↑ уже были на Диске: {already}")
    return on_disk, failed, False


def point_page(url):
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()
    new = re.sub(r'(data-yadisk-public="|Не открывается\? <a href=")[^"]+"', r"\g<1>" + url + '"', html)
    if new != html:
        with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
            f.write(new)
        log(f"films.html теперь показывает {url}")


def check_public(disk, url):
    """Отдаёт ли Диск начало, середину и конец каждого файла опубликованной папки."""
    fields = ",".join("_embedded.items." + f for f in
                      ("name", "path", "size", "type", "media_type", "mime_type", "preview"))
    data = disk.call("GET", "/public/resources", {"public_key": url, "limit": 1000, "fields": fields})[1]
    files = [it for it in data["_embedded"]["items"] if it["type"] == "file"]
    types = {}

    def one(item):
        if not is_video(item):
            return item["name"], (f"сайт его не покажет: Диск не считает его видео "
                                  f"({item.get('media_type')}, {item.get('mime_type')})")
        try:
            href = disk.call("GET", "/public/resources/download",
                             {"public_key": url, "path": item["path"]})[1]["href"]
            for start in (0, item["size"] // 2, max(item["size"] - 65536, 0)):
                req = urllib.request.Request(href, headers={"Range": f"bytes={start}-{start + 65535}"})
                with urllib.request.urlopen(req, timeout=60, context=disk._ssl) as r:
                    r.read()
                    types[item["name"]] = r.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            return item["name"], f"{e.code} {e.read()[:120].decode('utf-8', 'replace')}"
        except (DiskError, urllib.error.URLError, http.client.HTTPException, OSError) as e:
            return item["name"], str(getattr(e, "reason", e)) or type(e).__name__
        return item["name"], None

    with ThreadPoolExecutor(8) as pool:
        bad = {name: err for name, err in pool.map(one, files) if err}
    covers = sum(1 for it in files if it.get("preview"))
    kinds = ", ".join(f"{t}: {n}" for t, n in sorted(
        {t: list(types.values()).count(t) for t in set(types.values())}.items(), key=str))
    log(f"Проверка папки: Диск отдаёт {len(files) - len(bad)} из {len(files)} файлов; "
        f"с обложкой {covers}; Content-Type — {kinds or 'нет данных'}")
    return bad


def transfer(disk, args):
    """Один проход переноса. Возвращает (код выхода, строка для уведомления)."""
    try:
        items = sorted(list_source(disk), key=lambda it: it["path"])
        total = sum(it["size"] for it in items)
        info = disk.call("GET", "/", {"fields": "total_space,used_space"})[1]
        free = info["total_space"] - info["used_space"]
        log(f"Фильмов в исходной папке: {len(items)}, {total / 1073741824:.2f} ГБ; "
            f"свободно на Диске: {free / 1073741824:.2f} ГБ")
    except DiskError as e:
        print(f"Остановлено: {e}", file=sys.stderr)
        return (2 if e.status is None else 1), "Перенос остановлен с ошибкой"

    lost_upload = ("Остановлено: пропала связь с Диском во время загрузки. "
                   "Загруженное останется, запустите скрипт ещё раз.")
    try:
        # Сначала — то, что уже скачано: если VPN включат посреди докачки,
        # эти фильмы будут на Диске.
        on_disk, up_failed, offline = upload_all(disk, items)
    except DiskError as e:
        print(f"Остановлено: {e}", file=sys.stderr)
        return (2 if e.status is None else 1), "Перенос остановлен с ошибкой"
    if offline:
        print(lost_upload, file=sys.stderr)
        return 2, ""

    finished, down_failed, offline = download_all(disk, items, args.minutes)
    if offline:
        print(f"Остановлено: Диск не отвечает уже {SILENCE // 60} мин — включён VPN? "
              "Скачанное сохранено, запустите скрипт ещё раз.", file=sys.stderr)
        for name, err in down_failed.items():
            print(f"  ✗ {name}: {err}")
        return 2, ""
    try:
        more, more_failed, offline = upload_all(disk, [it for it in items if it["name"] in finished])
        on_disk += more
        up_failed.update(more_failed)
        if offline:
            print(lost_upload, file=sys.stderr)
            return 2, ""
        url = disk.publish(DEST)
        log(f"Папка на Диске: {url}")
        unreadable = check_public(disk, url)
    except DiskError as e:
        print(f"Остановлено: {e}", file=sys.stderr)
        return (2 if e.status is None else 1), "Перенос остановлен с ошибкой"
    # Без --point-page страницу переключаем, только когда перенесено всё:
    # иначе с сайта пропали бы фильмы, которые в старой папке иногда открываются.
    if on_disk and not up_failed and not unreadable and (args.point_page or on_disk == len(items)):
        point_page(url)
    else:
        log("films.html не менялась: перенесено или читается не всё")

    log(f"Готово: на своём Диске {on_disk} из {len(items)} фильмов")
    for name, err in {**down_failed, **up_failed}.items():
        print(f"  ✗ {name}: {err}")
    for name, err in unreadable.items():
        print(f"  ✗ {name}: на своём Диске не читается — {err}")
    code = 1 if down_failed or up_failed or unreadable else 0
    summary = f"Перенос закончен: на Диске {on_disk} из {len(items)} фильмов"
    if down_failed:
        summary += f", {len(down_failed)} Яндекс пока не отдаёт"
    return code, summary


def online():
    """Отвечает ли API Диска. Без токена он отвечает 401 — значит, связь есть."""
    try:
        urllib.request.urlopen(API + "/", timeout=8, context=ssl_context()).read()
    except urllib.error.HTTPError as e:
        return e.code == 401
    except (urllib.error.URLError, http.client.HTTPException, OSError):
        return False
    return True


def wait_online():
    """Ждёт трёх ответов Диска подряд: при выключении VPN связь первые секунды скачет."""
    ok = 0
    while ok < 3:
        ok = ok + 1 if online() else 0
        time.sleep(3)


def notify(text):
    subprocess.run(["osascript", "-e", f'display notification "{text}" with title "Фильмы на Яндекс Диске"'],
                   capture_output=True)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--minutes", type=float, default=30, help="сколько минут отвести на скачивание")
    ap.add_argument("--point-page", action="store_true",
                    help="поставить ссылку в films.html, даже если перенесены не все фильмы")
    ap.add_argument("--wait", action="store_true",
                    help="ждать связи с Диском и продолжать после обрывов, пока перенос не закончится")
    args = ap.parse_args(argv)

    token = load_token()
    if not token:
        print("Нет токена: впишите YANDEX_DISK_TOKEN=… в .env в корне проекта.", file=sys.stderr)
        return 1
    disk = Disk(token)
    if not args.wait:
        return transfer(disk, args)[0]

    started = False
    while True:
        log("Жду связи с Яндекс Диском — выключите VPN…")
        wait_online()
        notify(("Продолжаю перенос" if started else "Переношу фильмы на ваш Диск")
               + " — VPN пока не включайте")
        started = True
        awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        try:
            code, summary = transfer(disk, args)
        finally:
            awake.terminate()
        if code != 2:
            break
        notify("Связь с Яндексом пропала — перенос на паузе. Продолжу сам, когда VPN выключат")
    notify(summary + ". Можно включать VPN")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
