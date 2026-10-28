#!/usr/bin/env python3
"""Загрузка материалов библиотеки на Яндекс Диск.

Что делает
    Берёт таблицу data/yadisk-layout.json («локальный файл → путь на Диске»),
    создаёт папки в /Китайский — платформа/, загружает файлы, публикует каждый
    и записывает публичные ссылки в data/links.json
    («library/…/файл.pdf» → «https://disk.yandex.ru/i/…»). По этой таблице
    scripts/generate_pages.py и ручные страницы ставят ссылки на Диск.

    Файл, который на Диске уже лежит с тем же размером и md5, повторно не
    загружается, а links.json пишется после каждого файла, — поэтому
    прерванную загрузку достаточно запустить ещё раз.

Как запускать (из любой папки)
    python3 scripts/yadisk_upload.py             загрузить всё, что ещё не загружено
    python3 scripts/yadisk_upload.py --limit 1   только первый файл — проверить токен и сеть
    python3 scripts/yadisk_upload.py --dry-run   ничего не отправляя, показать план

Токен
    OAuth-токен с доступом к Диску (чтение и запись) лежит в .env в корне
    проекта строкой YANDEX_DISK_TOKEN=… или в переменной окружения с тем же
    именем. Скрипт не печатает его и шлёт только в заголовке запросов к API.
    .env в .gitignore.

    Яндекс часто не пускает подключения через VPN: если запросы к Диску
    зависают, выключите VPN на время загрузки.
"""

import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAYOUT = os.path.join(BASE, "data", "yadisk-layout.json")
LINKS = os.path.join(BASE, "data", "links.json")
ENV_FILE = os.path.join(BASE, ".env")

API = "https://cloud-api.yandex.net/v1/disk"
DISK_ROOT = "disk:/Китайский — платформа"
API_TIMEOUT = 60          # секунд на запрос к API
UPLOAD_TIMEOUT = 600      # секунд на паузу в передаче файла
ATTEMPTS = 5              # попыток на каждый шаг при сбоях сети и 429/5xx
WAIT_READY = 180          # сколько ждать, пока загруженный файл появится на Диске
# Корневые сертификаты macOS. Python с python.org своих не видит, пока не
# запущен «Install Certificates.command», и без них не проверит HTTPS Диска.
SYSTEM_CA = "/etc/ssl/cert.pem"


class DiskError(Exception):
    """Ошибка API с понятным текстом. Токена в ней нет."""

    def __init__(self, text, status=None):
        super().__init__(text)
        self.status = status


def load_token():
    token = os.environ.get("YANDEX_DISK_TOKEN", "").strip()
    if not token and os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                key, _, value = line.strip().partition("=")
                if key.strip() == "YANDEX_DISK_TOKEN":
                    token = value.strip().strip("\"'")
    return token


def ssl_context():
    ctx = ssl.create_default_context()
    paths = ssl.get_default_verify_paths()
    if not paths.cafile and not paths.capath and os.path.exists(SYSTEM_CA):
        ctx.load_verify_locations(SYSTEM_CA)
    return ctx


class Disk:
    def __init__(self, token):
        self._auth = {"Authorization": "OAuth " + token}
        self._ssl = ssl_context()

    def call(self, method, endpoint, params=None, ok=(200, 201, 202)):
        """Запрос к API; повторяет при сбоях сети, 429 и 5xx. Возвращает (код, JSON)."""
        url = API + endpoint + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in range(1, ATTEMPTS + 1):
            req = urllib.request.Request(url, method=method, headers=self._auth)
            try:
                with urllib.request.urlopen(req, timeout=API_TIMEOUT, context=self._ssl) as r:
                    body = r.read()
                    return r.status, (json.loads(body) if body else {})
            except urllib.error.HTTPError as e:
                if e.code in ok:
                    return e.code, {}
                text = describe(e)
                if e.code == 401:
                    raise DiskError("Диск не принял токен (401). Проверьте, что в .env именно "
                                    "OAuth-токен (обычно начинается с y0_), а не ClientID или "
                                    "Client secret приложения.", 401)
                if e.code not in (429, 500, 502, 503, 504) or attempt == ATTEMPTS:
                    raise DiskError(f"{e.code}: {text}", e.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt == ATTEMPTS:
                    raise DiskError(f"нет связи с Диском ({reason(e)}). Если включён VPN — "
                                    "выключите его.")
            time.sleep(min(2 ** attempt, 30))

    def meta(self, path, fields="name,size,md5,public_url,type"):
        """Свойства ресурса или None, если его нет."""
        try:
            return self.call("GET", "/resources", {"path": path, "fields": fields})[1]
        except DiskError as e:
            if e.status == 404:
                return None
            raise

    def mkdir(self, path):
        try:
            self.call("PUT", "/resources", {"path": path})
        except DiskError as e:
            if e.status != 409:        # 409 — папка уже есть
                raise

    def upload(self, local, path):
        size = os.path.getsize(local)
        for attempt in range(1, ATTEMPTS + 1):
            href = self.call("GET", "/resources/upload", {"path": path, "overwrite": "true"})[1]["href"]
            try:
                with open(local, "rb") as f:
                    # Адрес загрузки уже подписан Диском — токен туда не нужен.
                    req = urllib.request.Request(href, data=f, method="PUT",
                                                 headers={"Content-Length": str(size)})
                    with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT, context=self._ssl) as r:
                        r.read()
                return
            except urllib.error.HTTPError as e:
                if e.code in (201, 202):
                    return
                if e.code == 413:
                    raise DiskError("файл больше, чем Диск разрешает загрузить (413)", 413)
                if e.code == 507:
                    raise DiskError("на Диске не хватает места (507)", 507)
                if attempt == ATTEMPTS:
                    raise DiskError(f"загрузка не прошла: {e.code} {describe(e)}", e.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt == ATTEMPTS:
                    raise DiskError(f"загрузка оборвалась ({reason(e)})")
            time.sleep(min(2 ** attempt, 30))

    def wait_ready(self, path, size):
        """Большой файл Диск дообрабатывает после загрузки — ждём, пока он появится."""
        deadline = time.time() + WAIT_READY
        while True:
            info = self.meta(path)
            if info and info.get("size") == size:
                return info
            if time.time() > deadline:
                raise DiskError("файл загружен, но так и не появился на Диске")
            time.sleep(3)

    def publish(self, path):
        self.call("PUT", "/resources/publish", {"path": path})
        # Ссылка появляется не сразу после публикации — переспрашиваем.
        for _ in range(10):
            url = (self.meta(path, fields="public_url") or {}).get("public_url")
            if url:
                return url
            time.sleep(3)
        raise DiskError("Диск не выдал публичную ссылку")


def describe(http_error):
    try:
        data = json.loads(http_error.read() or b"{}")
        return data.get("message") or data.get("description") or data.get("error") or http_error.reason
    except (ValueError, OSError):
        return http_error.reason


def reason(error):
    return str(getattr(error, "reason", error)) or type(error).__name__


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def save_links(links):
    tmp = LINKS + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(dict(sorted(links.items())), f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, LINKS)


def mb(size):
    return f"{size / 1048576:.1f} МБ"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="ничего не отправлять, только показать план")
    ap.add_argument("--limit", type=int, help="обработать только первые N файлов")
    args = ap.parse_args(argv)

    with open(LAYOUT, encoding="utf-8") as f:
        layout = json.load(f)
    links = {}
    if os.path.exists(LINKS):
        with open(LINKS, encoding="utf-8") as f:
            links = json.load(f)

    missing = [rel for rel in layout if not os.path.isfile(os.path.join(BASE, rel))]
    todo = [(rel, f"{DISK_ROOT}/{dest}") for rel, dest in layout.items() if rel not in missing]
    if args.limit:
        todo = todo[:args.limit]
    total = sum(os.path.getsize(os.path.join(BASE, rel)) for rel, _ in todo)
    print(f"Файлов: {len(todo)}, {total / 1073741824:.2f} ГБ → {DISK_ROOT}/")

    if args.dry_run:
        for rel, dest in todo:
            print(f"  {rel}\n    → {dest}")
        return 0

    token = load_token()
    if not token:
        print("Нет токена: впишите YANDEX_DISK_TOKEN=… в .env в корне проекта.", file=sys.stderr)
        return 1
    disk = Disk(token)

    try:
        info = disk.call("GET", "/", {"fields": "total_space,used_space"})[1]
        free = info["total_space"] - info["used_space"]
        print(f"Свободно на Диске: {free / 1073741824:.2f} ГБ")
        if free < total:
            print("Места может не хватить: уже загруженные файлы место не займут, "
                  "остальные — займут. Продолжаю; если место кончится, Диск ответит 507.")
        folders = sorted({dest.rsplit("/", 1)[0] for _, dest in todo})
        made = set()
        for folder in folders:
            parts = folder.split("/")
            for i in range(2, len(parts) + 1):     # parts[0] — «disk:»
                sub = "/".join(parts[:i])
                if sub not in made:
                    disk.mkdir(sub)
                    made.add(sub)
    except DiskError as e:
        print(f"Остановлено: {e}", file=sys.stderr)
        return 1

    uploaded, skipped, failed = [], [], []
    for n, (rel, dest) in enumerate(todo, 1):
        local = os.path.join(BASE, rel)
        size = os.path.getsize(local)
        label = f"[{n:>3}/{len(todo)}] {dest[len(DISK_ROOT) + 1:]}"
        try:
            info = disk.meta(dest)
            if info and info.get("size") == size and info.get("md5") == md5_of(local):
                skipped.append(rel)
                state = "уже на Диске"
            else:
                started = time.time()
                disk.upload(local, dest)
                disk.wait_ready(dest, size)
                uploaded.append(rel)
                state = f"загружен ({mb(size)}, {time.time() - started:.0f} с)"
            links[rel] = disk.publish(dest)
            save_links(links)
            print(f"{label} — {state}")
        except DiskError as e:
            failed.append((rel, str(e)))
            print(f"{label} — ✗ {e}", file=sys.stderr)
            if e.status == 401:
                break

    print(f"\nЗагружено: {len(uploaded)}, уже были на Диске: {len(skipped)}, "
          f"с ошибкой: {len(failed)}, ссылок в data/links.json: {len(links)}")
    for rel, err in failed:
        print(f"  ✗ {rel}: {err}")
    for rel in missing:
        print(f"  ✗ {rel}: нет локального файла")
    return 1 if failed or missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
