#!/usr/bin/env python3
"""Сборка PDF со списками слов уровней HSK из data/vocab/.

Что делает
    Для каждого CSV из data/vocab/ собирает печатную страницу и печатает её
    в library/hsk-N/hsk-N-vocabulary-СТАНДАРТ.pdf: отдельный файл на HSK 2.0
    и на HSK 3.0, потому что на сайте у стандартов свои страницы «Словарь».
    В PDF одна таблица — новые слова этого уровня по этому стандарту. Ссылки
    на готовые файлы появляются на страницах «Словарь» (их проставляет
    scripts/generate_pages.py по полю "pdf" в content.json; пока PDF нет,
    ссылки на него тоже нет).

Как запускать
    python3 scripts/make_vocab_pdf.py              собрать недостающие и устаревшие
    python3 scripts/make_vocab_pdf.py --force      пересобрать все
    python3 scripts/make_vocab_pdf.py --browser /путь/к/браузеру

Чем печатает
    Любым установленным браузером на движке Chromium (Chrome, Chromium, Edge,
    Brave, Vivaldi, Opera, Яндекс): скрипт запускает его в фоновом режиме и
    печатает страницу через протокол отладки. Ничего ставить не нужно, всё
    остальное — стандартная библиотека Python.

Что важно знать
    PDF пересобирается, только если он старше своего CSV: у файлов внутри
    записана дата создания, поэтому побайтово одинаковыми они не будут.
    По правилам .gitignore файлы в library/ в git не попадают — это склад
    материалов, как учебники и журналы.
"""

import argparse
import base64
import csv
import html
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(BASE, "content.json")
# Промежуточный HTML и профиль браузера — во временной папке системы, а не в
# проекте: профиль тянет за собой расширения и кэш, ему рядом с сайтом не место.
BUILD = os.path.join(tempfile.gettempdir(), "chinese-platform-print")

# Порядок перебора: первым берётся то, что найдётся.
BROWSERS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    "/Applications/Yandex.app/Contents/MacOS/Yandex",
    "/Applications/Opera.app/Contents/MacOS/Opera",
    "/Applications/Opera GX.app/Contents/MacOS/Opera",
]

PAGE = {"paperWidth": 8.27, "paperHeight": 11.69,  # A4 в дюймах
        "marginTop": 0.55, "marginBottom": 0.6, "marginLeft": 0.55, "marginRight": 0.55,
        "printBackground": True, "displayHeaderFooter": True,
        "headerTemplate": "<div></div>"}

STYLE = """
    @page { size: A4; }
    body { margin: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
           font-size: 9.5pt; color: #1b2430; }
    h1 { font-size: 17pt; margin: 0 0 2mm; }
    h2 { font-size: 12pt; margin: 8mm 0 2mm; page-break-after: avoid; }
    .subtitle { color: #5b6673; margin: 0 0 4mm; }
    .note { border: 1px solid #d8dde4; border-left: 3px solid #b48a3a; border-radius: 2px;
            padding: 2.5mm 3mm; color: #5b6673; font-size: 8.5pt; margin: 0 0 5mm; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em;
         color: #5b6673; border-bottom: 1px solid #b9c2cd; padding: 0 2mm 1.5mm; }
    td { padding: 1.2mm 2mm; border-bottom: 1px solid #edf0f4; vertical-align: top; }
    tr { page-break-inside: avoid; }
    tbody tr:nth-child(even) { background: #f6f8fa; }
    .hanzi { font-family: "PingFang SC", "Noto Sans SC", "Songti SC", "Heiti SC", sans-serif;
             font-size: 12pt; white-space: nowrap; }
    .pinyin { color: #3f4b5b; white-space: nowrap; }
    .num { color: #8b95a3; font-size: 8pt; text-align: right; white-space: nowrap; }
"""


# ---------------------------------------------------------------- печатная страница

def print_html(level_name, subtitle, tables, note):
    body = ""
    for caption, rows in tables:
        if not rows:
            continue
        lines = ""
        for i, row in enumerate(rows, 1):
            lines += (f'<tr><td class="num">{i}</td>'
                      f'<td class="hanzi">{html.escape(row["hanzi"])}</td>'
                      f'<td class="pinyin">{html.escape(row["pinyin"])}</td>'
                      f'<td>{html.escape(row["translation_ru"])}</td></tr>\n')
        body += f"""
    <h2>{html.escape(caption)} — {len(rows)} слов</h2>
    <table>
      <thead><tr><th></th><th>Иероглиф</th><th>Пиньинь</th><th>Перевод</th></tr></thead>
      <tbody>
{lines}      </tbody>
    </table>
"""
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>{html.escape(level_name)} — словарь уровня</title>
  <style>{STYLE}</style>
</head>
<body>
  <h1>{html.escape(level_name)} — словарь уровня</h1>
  <p class="subtitle">{html.escape(subtitle)}</p>
  <div class="note">{html.escape(note)}</div>{body}
</body>
</html>
"""


def footer_template(level_name):
    return (f'<div style="font-size:7.5pt;color:#8b95a3;width:100%;padding:0 14mm;'
            f'font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:space-between">'
            f'<span>{html.escape(level_name)} · словарь уровня</span>'
            f'<span class="pageNumber"></span></div>')


# ---------------------------------------------------------------- браузер и CDP

class WebSocket:
    """Столько RFC 6455, сколько нужно для протокола отладки браузера."""

    def __init__(self, url, timeout=180):
        host_port, _, path = url[len("ws://"):].partition("/")
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\n"
                           f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("браузер закрыл соединение при рукопожатии")
            head += chunk
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(f"браузер не принял websocket: {head.splitlines()[0]!r}")
        self.buffer = b""

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise ConnectionError("соединение с браузером прервано")
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def send(self, text):
        payload = text.encode()
        header = bytearray([0x81])
        mask = secrets.token_bytes(4)
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        elif len(payload) < 1 << 16:
            header.append(0x80 | 126)
            header += struct.pack(">H", len(payload))
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", len(payload))
        self.sock.sendall(bytes(header) + mask +
                          bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        message = b""
        while True:
            first, second = self._read(2)
            opcode, length = first & 0x0F, second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(length)
            if opcode == 0x9:  # ping
                self.sock.sendall(b"\x8a\x80" + secrets.token_bytes(4))
                continue
            if opcode == 0x8:
                raise ConnectionError("браузер закрыл websocket")
            if opcode in (0x0, 0x1):
                message += payload
                if first & 0x80:
                    return message.decode()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Browser:
    """Headless-браузер, которому можно отдать страницу и забрать PDF."""

    def __init__(self, binary, profile):
        os.makedirs(profile, exist_ok=True)
        self.proc = subprocess.Popen(
            [binary, "--headless=new", "--disable-gpu", "--no-first-run",
             "--no-default-browser-check", "--remote-debugging-port=0",
             f"--user-data-dir={profile}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = os.path.join(profile, "DevToolsActivePort")
        port = None
        for _ in range(300):
            if os.path.exists(port_file):
                lines = open(port_file).read().split("\n")
                if len(lines) > 1:
                    port = int(lines[0])
                    break
            if self.proc.poll() is not None:
                raise RuntimeError(f"браузер завершился с кодом {self.proc.returncode}")
            time.sleep(0.1)
        if port is None:
            raise RuntimeError("браузер не сообщил порт отладки")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=30) as resp:
            self.ws = WebSocket(json.load(resp)["webSocketDebuggerUrl"])
        self.last_id = 0

    def call(self, method, params=None, session=None):
        self.last_id += 1
        message = {"id": self.last_id, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        self.ws.send(json.dumps(message))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == self.last_id:
                if "error" in reply:
                    raise RuntimeError(f'{method}: {reply["error"]}')
                return reply["result"]

    def print_pdf(self, file_url, out_path, options):
        target = self.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = self.call("Target.attachToTarget",
                            {"targetId": target, "flatten": True})["sessionId"]
        self.call("Page.enable", session=session)
        self.call("Page.navigate", {"url": file_url}, session=session)
        deadline = time.time() + 180
        while time.time() < deadline:
            event = json.loads(self.ws.recv())
            if event.get("method") == "Page.loadEventFired" and event.get("sessionId") == session:
                break
        else:
            raise RuntimeError("страница не загрузилась за 180 секунд")
        data = self.call("Page.printToPDF", options, session=session)["data"]
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(data))
        self.call("Target.closeTarget", {"targetId": target})

    def close(self):
        self.ws.close()
        self.proc.terminate()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def find_browser(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"браузер не найден: {explicit}")
        return explicit
    for path in BROWSERS:
        if os.path.exists(path):
            return path
    sys.exit("не нашёл браузера на движке Chromium. Укажите его: --browser /путь/к/браузеру")


# ---------------------------------------------------------------- сборка

def levels_to_build(content, force):
    """Словари стандартов, у которых PDF отсутствует или старше своего CSV.

    Задание теперь на пару «уровень + стандарт»: у HSK 1 их два, у ступени
    7–9 стандарта только один, а словаря пока вообще нет — такие пропускаем.
    """
    titles = {std["id"]: std["title"] for std in content["standards"]}
    jobs = []
    for slug, level in content["levels"].items():
        for std_id, block in level["standards"].items():
            section = block["sections"].get("vocabulary", {})
            csv_rel, pdf_rel = section.get("data"), section.get("pdf")
            if not (csv_rel and pdf_rel):
                continue
            csv_path, pdf_path = os.path.join(BASE, csv_rel), os.path.join(BASE, pdf_rel)
            if not os.path.exists(csv_path):
                print(f"  пропущен {slug} {std_id}: нет {csv_rel}", file=sys.stderr)
                continue
            fresh = (os.path.exists(pdf_path)
                     and os.path.getmtime(pdf_path) >= os.path.getmtime(csv_path))
            jobs.append({"slug": slug, "level": level, "standard": std_id,
                         "standard_title": titles.get(std_id, std_id),
                         "subtitle": block["subtitle"],
                         "csv": csv_path, "pdf": pdf_path,
                         "fresh": fresh and not force})
    return jobs


def read_rows(csv_path):
    with open(csv_path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="пересобрать даже свежие PDF")
    parser.add_argument("--browser", help="путь к браузеру на движке Chromium")
    args = parser.parse_args(argv)

    with open(CONTENT, encoding="utf-8") as f:
        content = json.load(f)
    jobs = levels_to_build(content, args.force)
    todo = [job for job in jobs if not job["fresh"]]
    if not todo:
        print(f"Все {len(jobs)} PDF уже собраны и новее своих CSV. Пересобрать: --force")
        return 0

    os.makedirs(BUILD, exist_ok=True)
    browser = Browser(find_browser(args.browser), os.path.join(BUILD, "browser-profile"))
    try:
        for job in todo:
            title = f'{job["level"]["title"]} — {job["standard_title"]}'
            rows = read_rows(job["csv"])
            tables = [(f'Новые слова уровня ({len(rows)})', rows)]
            note = ("Иероглифы и пиньинь — из официальных списков HSK. Перевод на русский "
                    "подготовлен автоматически и может содержать неточности.")
            page = print_html(title, job["subtitle"], tables, note)
            html_path = os.path.join(BUILD, f'{job["slug"]}-{job["standard"]}.html')
            with open(html_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(page)
            os.makedirs(os.path.dirname(job["pdf"]), exist_ok=True)
            options = dict(PAGE, footerTemplate=footer_template(title))
            browser.print_pdf(f"file://{html_path}", job["pdf"], options)
            print(f'  {os.path.relpath(job["pdf"], BASE)}: {len(rows)} слов, '
                  f'{os.path.getsize(job["pdf"]) // 1024} КБ')
    finally:
        browser.close()
    print(f"Готово: собрано {len(todo)}, пропущено как свежие {len(jobs) - len(todo)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
