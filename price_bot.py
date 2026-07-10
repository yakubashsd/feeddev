#!/usr/bin/env python3
"""Telegram bot that monitors developer websites for apartment price changes."""

from __future__ import annotations

import html
import json
import os
import re
import signal
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONFIG_PATH = Path(os.getenv("CONFIG_PATH", "builders.example.json"))
STATE_PATH = Path(os.getenv("STATE_PATH", "price_state.json"))
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "900"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "25"))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
INITIAL_CHAT_IDS = [
    item.strip()
    for item in os.getenv("TELEGRAM_CHAT_ID", "").replace(";", ",").split(",")
    if item.strip()
]
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

PRICE_PATTERNS = [
    re.compile(r"(?:от\s*)?(\d{1,3}(?:[\s\u00a0]\d{3}){1,3})(?:\s*)(?:₽|руб\.?|р\.)", re.I),
    re.compile(r"(?:от\s*)?(\d+(?:[,.]\d+)?)\s*(?:млн|миллион(?:а|ов)?)", re.I),
]

STOP = False


@dataclass
class Site:
    id: str
    name: str
    url: str
    currency: str = "₽"
    price_regex: str | None = None
    change_threshold_percent: float = 0.0
    min_price: int | None = None
    max_price: int | None = None
    headers: dict[str, str] | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def format_price(value: int | float, currency: str = "₽") -> str:
    if float(value).is_integer():
        return f"{int(value):,}".replace(",", " ") + f" {currency}"
    return f"{value:,.2f}".replace(",", " ") + f" {currency}"


def load_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def save_json(path: Path, data: dict[str, Any]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")
    tmp_path.replace(path)


def load_config() -> list[Site]:
    raw = load_json(CONFIG_PATH, {"sites": []})
    sites = []
    for item in raw.get("sites", []):
        if not item.get("id") or not item.get("url"):
            continue
        sites.append(
            Site(
                id=str(item["id"]),
                name=str(item.get("name") or item["id"]),
                url=str(item["url"]),
                currency=str(item.get("currency", "₽")),
                price_regex=item.get("price_regex"),
                change_threshold_percent=float(item.get("change_threshold_percent", 0)),
                min_price=item.get("min_price"),
                max_price=item.get("max_price"),
                headers=item.get("headers") or None,
            )
        )
    return sites


def request_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {}
    if payload is not None:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def telegram(method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("Set TELEGRAM_BOT_TOKEN before running the bot.")
    return request_json(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}", payload)


def send_message(chat_id: str | int, text: str) -> None:
    telegram(
        "sendMessage",
        {
            "chat_id": str(chat_id),
            "text": text[:3900],
            "disable_web_page_preview": "true",
        },
    )


def fetch_html(site: Site) -> str:
    headers = dict(DEFAULT_HEADERS)
    if site.headers:
        headers.update(site.headers)
    request = urllib.request.Request(site.url, headers=headers)
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def html_to_text(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", markup)
    markup = re.sub(r"(?s)<[^>]+>", " ", markup)
    text = html.unescape(markup)
    return re.sub(r"\s+", " ", text).strip()


def parse_price(raw_value: str, multiplier: int = 1) -> int | None:
    cleaned = raw_value.replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    cleaned = re.sub(r"[^\d.]", "", cleaned)
    if not cleaned:
        return None
    try:
        return int(float(cleaned) * multiplier)
    except ValueError:
        return None


def extract_price(site: Site, markup: str) -> tuple[int, str]:
    text = html_to_text(markup)
    candidates: list[tuple[int, str]] = []

    if site.price_regex:
        pattern = re.compile(site.price_regex, re.I | re.S)
        for match in pattern.finditer(text):
            raw_value = match.group(1) if match.groups() else match.group(0)
            multiplier = 1_000_000 if re.search(r"млн|миллион", match.group(0), re.I) else 1
            price = parse_price(raw_value, multiplier)
            if price is not None:
                candidates.append((price, match.group(0).strip()))

    if not candidates:
        for pattern in PRICE_PATTERNS:
            for match in pattern.finditer(text):
                multiplier = 1_000_000 if "мл" in match.group(0).lower() else 1
                price = parse_price(match.group(1), multiplier)
                if price is not None:
                    candidates.append((price, match.group(0).strip()))

    filtered = []
    for price, raw in candidates:
        if site.min_price is not None and price < int(site.min_price):
            continue
        if site.max_price is not None and price > int(site.max_price):
            continue
        filtered.append((price, raw))

    if not filtered:
        raise ValueError("Price was not found. Add or adjust price_regex in the config.")

    return min(filtered, key=lambda item: item[0])


def describe_change(old_price: int, new_price: int, currency: str) -> str:
    delta = new_price - old_price
    percent = (delta / old_price * 100) if old_price else 0
    direction = "выросла" if delta > 0 else "снизилась"
    return (
        f"Цена {direction}: {format_price(old_price, currency)} -> "
        f"{format_price(new_price, currency)} ({delta:+,} {currency}, {percent:+.2f}%)"
    ).replace(",", " ")


def should_notify(site: Site, old_price: int | None, new_price: int) -> bool:
    if old_price is None or old_price == new_price:
        return old_price is None
    percent = abs(new_price - old_price) / old_price * 100
    return percent >= site.change_threshold_percent


def check_site(site: Site, state: dict[str, Any]) -> tuple[str, bool]:
    markup = fetch_html(site)
    new_price, raw_match = extract_price(site, markup)
    old_record = state.get("prices", {}).get(site.id, {})
    old_price = old_record.get("price")

    state.setdefault("prices", {})[site.id] = {
        "price": new_price,
        "raw_match": raw_match,
        "checked_at": utc_now(),
        "url": site.url,
    }

    if old_price is None:
        return (
            f"{site.name}: начальная цена сохранена - {format_price(new_price, site.currency)}\n{site.url}",
            True,
        )
    if should_notify(site, int(old_price), new_price):
        return f"{site.name}\n{describe_change(int(old_price), new_price, site.currency)}\n{site.url}", True
    return f"{site.name}: без изменений - {format_price(new_price, site.currency)}", False


def check_all(state: dict[str, Any], notify_everything: bool = False) -> list[tuple[str, bool]]:
    results = []
    for site in load_config():
        try:
            message, important = check_site(site, state)
            results.append((message, important or notify_everything))
        except Exception as exc:  # noqa: BLE001 - bot should continue monitoring other sites.
            results.append((f"{site.name}: не удалось проверить цену: {exc}\n{site.url}", True))
    state["last_check_at"] = utc_now()
    save_json(STATE_PATH, state)
    return results


def registered_chats(state: dict[str, Any]) -> list[str]:
    chats = {str(chat_id) for chat_id in INITIAL_CHAT_IDS}
    chats.update(str(chat_id) for chat_id in state.get("chat_ids", []))
    return sorted(chats)


def remember_chat(state: dict[str, Any], chat_id: str | int) -> None:
    state.setdefault("chat_ids", [])
    if str(chat_id) not in [str(item) for item in state["chat_ids"]]:
        state["chat_ids"].append(str(chat_id))
        save_json(STATE_PATH, state)


def status_text(state: dict[str, Any]) -> str:
    prices = state.get("prices", {})
    if not prices:
        return "Пока нет сохранённых цен. Запустите /check."
    lines = ["Текущие сохранённые цены:"]
    sites = {site.id: site for site in load_config()}
    for site_id, record in prices.items():
        site = sites.get(site_id)
        currency = site.currency if site else "₽"
        name = site.name if site else site_id
        lines.append(f"- {name}: {format_price(record['price'], currency)}")
    return "\n".join(lines)


def handle_command(state: dict[str, Any], chat_id: int, text: str) -> None:
    command = text.split()[0].lower()
    if command in {"/start", "/help"}:
        remember_chat(state, chat_id)
        send_message(
            chat_id,
            "Я отслеживаю цены на сайтах застройщиков.\n"
            "/check - проверить сейчас\n"
            "/list - показать сохранённые цены\n"
            "/chatid - показать ID чата",
        )
    elif command == "/chatid":
        send_message(chat_id, f"ID этого чата: {chat_id}")
    elif command == "/list":
        send_message(chat_id, status_text(state))
    elif command == "/check":
        remember_chat(state, chat_id)
        send_message(chat_id, "Проверяю цены...")
        for message, _ in check_all(state, notify_everything=True):
            send_message(chat_id, message)
    else:
        send_message(chat_id, "Не понял команду. Доступно: /check, /list, /chatid.")


def poll_telegram(state: dict[str, Any]) -> None:
    offset = state.get("telegram_offset")
    payload: dict[str, Any] = {"timeout": "2"}
    if offset is not None:
        payload["offset"] = str(offset)
    data = telegram("getUpdates", payload)
    for update in data.get("result", []):
        state["telegram_offset"] = int(update["update_id"]) + 1
        message = update.get("message") or update.get("channel_post")
        if not message or "text" not in message:
            continue
        chat_id = message["chat"]["id"]
        handle_command(state, chat_id, message["text"].strip())
    save_json(STATE_PATH, state)


def notify_chats(state: dict[str, Any], messages: list[tuple[str, bool]]) -> None:
    important_messages = [message for message, important in messages if important]
    if not important_messages:
        return
    for chat_id in registered_chats(state):
        for message in important_messages:
            send_message(chat_id, message)


def install_signal_handlers() -> None:
    def stop(_signum: int, _frame: Any) -> None:
        global STOP
        STOP = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)


def main() -> int:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN is required.", file=sys.stderr)
        return 2
    if not load_config():
        print(f"No sites configured in {CONFIG_PATH}.", file=sys.stderr)
        return 2

    install_signal_handlers()
    state = load_json(STATE_PATH, {"prices": {}, "chat_ids": INITIAL_CHAT_IDS})
    next_check_at = 0.0
    print("Price bot started.")

    while not STOP:
        try:
            poll_telegram(state)
            now = time.time()
            if now >= next_check_at:
                notify_chats(state, check_all(state))
                next_check_at = now + POLL_INTERVAL_SECONDS
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"Network error: {exc}", file=sys.stderr)
            time.sleep(5)
        except Exception:  # noqa: BLE001 - keep the long-running bot alive.
            traceback.print_exc()
            time.sleep(5)
        time.sleep(1)

    print("Price bot stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
