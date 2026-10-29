"""Dispatcher between your phone and the open Claude Code sessions, over ntfy.

  listen   long-running process: routes your phone messages to inbox/<sid>.jsonl, keeps
           registry.json (stable #N per open session) and pushes an alert when a session
           has been waiting for you at the terminal for 2 minutes
  send     sends a message (and optionally a file) to the phone as #N
  list     prints the registry (debugging)

Standard library only. Configuration (environment variables):
  NTFY_URL            ntfy server, default https://ntfy.sh
  NTFY_TOPIC          the topic; when unset, read from <APPROVAL_DIR>/topic.txt
  APPROVAL_DIR        data folder, default ~/.claude/approval-channel
  SESSION_STATUS_DIR  status files written by the `sessions` mod, default ~/.claude/session-status

The topic name is the only access control on a public ntfy server: it never appears in the
log or on stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ALIVE_MS = 180_000
STALE_S = 24 * 3600
ALERT_AFTER_S = 120
READ_S = 10
MAX_MESSAGE = 3500
MAX_FILE = 15 * 1024 * 1024
SIGN = {"working": "●", "waiting": "◆", "done": "✓"}
RE_HASH = re.compile(r"^#(\d{1,2})\b[\s:,.\-]*(.*)$", re.DOTALL)
RE_NUMBER = re.compile(r"^(\d{1,2})(?:\s+(.*))?$", re.DOTALL)  # without #: only number + space ("3:00", "1.5" stay text)
RE_SID = re.compile(r"[0-9a-f-]{36}")
MAX_TEXT = 4000
OLD_MESSAGE_S = 600  # after a restart, since= also brings old messages; #N numbers may have been reused meanwhile
CONFIRM_PAUSE_S = 30
OLD_REQUEST_S = 3600

_registry_lock = threading.Lock()
_log_lock = threading.Lock()
_last_confirmation: dict[str, float] = {}


# ---------------------------------------------------------------- paths and config


def data_dir() -> Path:
    return Path(os.environ.get("APPROVAL_DIR") or Path.home() / ".claude" / "approval-channel")


def status_dir() -> Path:
    return Path(os.environ.get("SESSION_STATUS_DIR") or Path.home() / ".claude" / "session-status")


def ntfy_url() -> str:
    return (os.environ.get("NTFY_URL") or "https://ntfy.sh").rstrip("/")


def topic() -> str:
    t = os.environ.get("NTFY_TOPIC") or (data_dir() / "topic.txt").read_text(encoding="utf-8")
    t = t.strip()
    if not t:
        raise RuntimeError("no ntfy topic configured (NTFY_TOPIC or topic.txt)")
    return t


def log(text: str) -> None:
    try:
        d = data_dir()
        d.mkdir(parents=True, exist_ok=True)
        with _log_lock, open(d / "dispatcher.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
    except OSError:
        pass


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    for i in range(10):  # on Windows os.replace fails while another process holds the file open
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == 9:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def _int(x) -> int:
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------- sessions + registry


def read_sessions(now_ms: int | None = None) -> dict[str, dict]:
    """The live sessions (same rule as the sessions mod: not ended, seen <= 180 s ago)."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    alive: dict[str, dict] = {}
    d = status_dir()
    if not d.is_dir():
        return alive
    for f in d.glob("*.json"):
        try:
            if now_ms / 1000 - f.stat().st_mtime > STALE_S:
                continue
            s = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(s, dict) or s.get("ended") is True:
            continue
        if now_ms - _int(s.get("seenAt")) > ALIVE_MS:
            continue
        sid = s.get("id") or f.stem
        if not isinstance(sid, str) or not RE_SID.fullmatch(sid):  # the sid ends up in file names
            continue
        alive[sid] = s
    return alive


def read_registry() -> dict[str, dict]:
    try:
        r = json.loads((data_dir() / "registry.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(r, dict):
        return {}
    return {k: v for k, v in r.items()
            if k.isdigit() and isinstance(v, dict) and isinstance(v.get("sid"), str) and RE_SID.fullmatch(v["sid"])}


def allocate(old: dict[str, dict], alive: dict[str, dict]) -> dict[str, dict]:
    """Stable numbers: a live session keeps its number; new ones take the lowest free positive integer."""
    new: dict[str, dict] = {}
    old_number = {v.get("sid"): k for k, v in old.items()}
    for sid, s in alive.items():
        k = old_number.get(sid)
        if k is not None and k not in new:
            new[k] = _entry(sid, s)
    for sid in sorted(set(alive) - {v["sid"] for v in new.values()}):
        n = 1
        while str(n) in new:
            n += 1
        new[str(n)] = _entry(sid, alive[sid])
    return dict(sorted(new.items(), key=lambda kv: int(kv[0])))


def _entry(sid: str, s: dict) -> dict:
    return {"sid": sid, "task": str(s.get("task") or ""), "state": str(s.get("state") or ""),
            "lastAction": str(s.get("lastAction") or ""), "changedAt": _int(s.get("changedAt"))}


def update_registry(now_ms: int | None = None) -> dict[str, dict]:
    with _registry_lock:
        reg = allocate(read_registry(), read_sessions(now_ms))
        write_atomic(data_dir() / "registry.json", json.dumps(reg, ensure_ascii=False, indent=1))
        return reg


def session_number(reg: dict[str, dict], sid: str) -> str | None:
    return next((k for k, v in reg.items() if v.get("sid") == sid), None)


def list_text(reg: dict[str, dict]) -> str:
    if not reg:
        return "No open session."
    return "\n".join(f"#{k} {SIGN.get(v['state'], '·')} {v['state']} «{v['task']}» · {v['lastAction']}"
                     for k, v in reg.items())


# ---------------------------------------------------------------- ntfy


def publish(title: str, message: str, priority: int | None = None) -> None:
    body = {"topic": topic(), "title": title, "message": message, "tags": ["robot"]}
    if priority:
        body["priority"] = priority
    request = urllib.request.Request(ntfy_url() + "/", data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(request, timeout=30).close()


def reply(message: str) -> None:
    try:
        publish("dispatcher", message)
    except OSError as e:
        log(f"ntfy reply error: {e}")


# ---------------------------------------------------------------- routing


def parse(text: str) -> tuple:
    t = text.strip()
    if t.lower() in ("?", "list"):
        return ("list",)
    m = RE_HASH.match(t) or RE_NUMBER.match(t)
    if m:
        return ("number", m.group(1).lstrip("0") or "0", (m.group(2) or "").strip())
    return ("free", t)


def is_from_user(ev: dict) -> bool:
    """Our own messages carry a title and the robot tag; what the user types on the phone has neither."""
    return (ev.get("event") == "message" and not (ev.get("title") or "").strip()
            and "robot" not in (ev.get("tags") or []))


def deliver(n: str, entry: dict, text: str, message_id: str) -> str | None:
    sid = entry["sid"]
    d = data_dir()
    (d / "inbox").mkdir(parents=True, exist_ok=True)
    with open(d / "inbox" / f"{sid}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"id": message_id, "ts": int(time.time()), "text": text}, ensure_ascii=False) + "\n")
    try:
        (d / "requests" / f"{sid}.json").unlink()
    except FileNotFoundError:
        pass
    log(f"routed to #{n} ({sid[:8]}, {entry['state']}): {text[:200]!r}")
    now = time.time()
    if now - _last_confirmation.get(sid, 0) < CONFIRM_PAUSE_S:
        return None  # several messages in a row get a single confirmation
    if entry["state"] in ("working", "waiting"):
        _last_confirmation[sid] = now
    if entry["state"] == "working":
        return f"→ #{n} is working; it will reply when done"
    if entry["state"] == "waiting":
        return f"→ #{n} is blocked on a terminal dialog; the message goes in once that is answered"
    return None


def event_text(ev: dict) -> tuple[str, str | None]:
    """(the message text, the reply to send right away); empty text = nothing to deliver."""
    text = (ev.get("message") or "").strip()
    if text == "triggered" and not ev.get("attachment"):
        text = ""  # ntfy puts "triggered" in place of a message sent empty
    if ev.get("attachment"):
        text = (text + f" [attachment: {ev['attachment'].get('url', '')}]").strip()
    if not text:
        return "", None
    text = text[:MAX_TEXT]
    age = time.time() - float(ev.get("time") or time.time())
    if age > OLD_MESSAGE_S:
        log(f"old message ({int(age // 60)} min), not delivered: {text[:200]!r}")
        return "", f"Old message (from {int(age // 60)} min ago), not delivered: resend it if it still applies: «{text[:200]}»"
    return text, None


def process(ev: dict) -> str | None:
    """One event from the stream -> the reply to send on ntfy (or None). Delivery happens here."""
    if not is_from_user(ev):
        return None
    text, answer = event_text(ev)
    if not text:
        return answer
    reg = update_registry()
    p = parse(text)
    if p[0] == "list":
        return list_text(reg)
    if p[0] == "number" and (p[1] in reg or text.lstrip().startswith("#")):
        n, rest = p[1], p[2]
        if n not in reg:
            return f"There is no #{n}.\n{list_text(reg)}"
        if not rest:
            return f"Write the message too: #{n} text"
        return deliver(n, reg[n], rest, ev.get("id", ""))
    rest = text.strip()  # a number without # that is not a session ("21:00 works") is ordinary text
    requests = data_dir() / "requests"
    with_request = [k for k, v in reg.items() if (requests / f"{v['sid']}.json").is_file()]
    if len(with_request) == 1:
        n = with_request[0]
    elif not with_request and len(reg) == 1:
        n = next(iter(reg))
    elif not reg:
        return "No open session."
    else:
        candidates = with_request or list(reg)
        return "Which one? " + " · ".join(f"#{k} «{reg[k]['task']}»" for k in candidates) + " — write #N text"
    return deliver(n, reg[n], rest, ev.get("id", ""))


# ---------------------------------------------------------------- listen


def stream_once() -> None:
    """One connection to the stream; processes until it closes. Exceptions go up to the backoff loop."""
    d = data_dir()
    f_id = d / "last_id.txt"
    url = f"{ntfy_url()}/{urllib.parse.quote(topic())}/json"
    if f_id.is_file() and f_id.read_text(encoding="utf-8").strip():
        url += "?since=" + urllib.parse.quote(f_id.read_text(encoding="utf-8").strip())
    with urllib.request.urlopen(url, timeout=120) as r:
        for line in r:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            if ev.get("event") != "message":
                continue
            try:
                answer = process(ev)
                if answer:
                    reply(answer)
            except Exception as e:  # one broken message does not stop the stream
                log(f"error on message {ev.get('id')}: {e!r}")
            write_atomic(f_id, str(ev.get("id", "")))


class Alerts:
    """An alert counts as sent only after it went out; a failed one is retried next round. A refusal by
    ntfy (HTTP 4xx, e.g. 413) is retried at most MAX_ATTEMPTS times, so it does not repeat forever; a
    network or server outage (fails within milliseconds, so 5 rounds = 50 s) is retried until
    OUTAGE_DEADLINE_S after the first failure."""

    MAX_ATTEMPTS = 5
    OUTAGE_DEADLINE_S = 1800

    def __init__(self) -> None:
        self.sent: set[str] = set()
        self.failures: dict[str, int] = {}
        self.first_error: dict[str, float] = {}

    def due(self, reg: dict[str, dict], now_s: float | None = None) -> list[tuple[str, str, str]]:
        """(key, title, message) for each alert to send; the key then goes to mark_sent() or mark_failed()."""
        now_s = time.time() if now_s is None else now_s
        out = []
        for n, v in reg.items():
            key = f"{v['sid']}:{v['changedAt']}"
            if v["state"] == "waiting" and now_s - v["changedAt"] / 1000 >= ALERT_AFTER_S and key not in self.sent:
                out.append((key, f"#{n} · {v['task'][:60]}", f"waiting for you at the terminal: {v['lastAction']}"))
        return out

    def mark_sent(self, key: str) -> None:
        self.sent.add(key)
        self.failures.pop(key, None)
        self.first_error.pop(key, None)

    def mark_failed(self, key: str, refused: bool = True, now_s: float | None = None) -> bool:
        """True when the attempts are used up (the alert is not retried). refused = ntfy answered 4xx."""
        now_s = time.time() if now_s is None else now_s
        self.failures[key] = self.failures.get(key, 0) + 1
        first = self.first_error.setdefault(key, now_s)
        if (self.failures[key] < self.MAX_ATTEMPTS) if refused else (now_s - first < self.OUTAGE_DEADLINE_S):
            return False
        self.mark_sent(key)
        return True

    @staticmethod
    def is_refusal(e: BaseException) -> bool:
        return isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429

    def send(self, reg: dict[str, dict], now_s: float | None = None) -> None:
        """One round: each alert separately, so one that fails does not lose the others."""
        now_s = time.time() if now_s is None else now_s
        for key, title, message in self.due(reg, now_s):
            try:
                publish(title, message, priority=4)
            except Exception as e:
                refused, n = self.is_refusal(e), self.failures.get(key, 0) + 1
                outage = int(now_s - self.first_error.get(key, now_s))
                gave_up = self.mark_failed(key, refused, now_s)
                how = f"{n}/{self.MAX_ATTEMPTS}" if refused else f"attempt {n}, {outage}/{self.OUTAGE_DEADLINE_S} s"
                log(f"alert not sent ({how}{', giving up' if gave_up else ''}): {title}: {e!r}")
                continue
            self.mark_sent(key)
            log(f"alert: {title}: {message}")


def clean_requests(reg: dict[str, dict]) -> None:
    """Requests of sessions closed for over an hour have nobody left to receive them."""
    alive = {v["sid"] for v in reg.values()}
    for f in (data_dir() / "requests").glob("*.json"):
        try:
            if f.stem not in alive and time.time() - f.stat().st_mtime > OLD_REQUEST_S:
                f.unlink()
        except OSError:
            pass


def registry_loop() -> None:
    alerts = Alerts()
    while True:
        try:
            reg = update_registry()
            clean_requests(reg)
            alerts.send(reg)
        except Exception as e:
            log(f"registry/alert error: {e!r}")
        time.sleep(READ_S)


_lock_file = None


def take_lock() -> bool:
    global _lock_file
    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    f = open(d / "dispatcher.lock", "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return False
    _lock_file = f
    return True


def listen() -> int:
    if not take_lock():
        log("another instance is already listening; exiting")
        return 0
    log("listen started")
    threading.Thread(target=registry_loop, daemon=True).start()
    pause = 5
    while True:
        try:
            stream_once()
            pause = 5
            log("stream closed by the server; reconnecting")
        except Exception as e:
            log(f"stream error: {e!r}; reconnecting in {pause} s")
        time.sleep(pause)
        pause = min(pause * 2, 60)


# ---------------------------------------------------------------- send


def truncate(message: str) -> str:
    return message if len(message) <= MAX_MESSAGE else message[:MAX_MESSAGE] + "\n…(the rest is in the session)"


def attachment_limit() -> int:
    """The server's per-file limit (anonymous ntfy.sh = 2 MiB); if /v1/account does not answer -> 15 MiB."""
    try:
        with urllib.request.urlopen(ntfy_url() + "/v1/account", timeout=10) as r:
            return int(json.load(r)["limits"]["attachment_file_size"]) or MAX_FILE
    except (OSError, ValueError, KeyError, TypeError):
        return MAX_FILE


def upload(path: Path, title: str, message: str, priority: int | None = None) -> None:
    q = {"title": title, "message": message, "filename": path.name, "tags": "robot"}
    if priority:
        q["priority"] = str(priority)
    request = urllib.request.Request(f"{ntfy_url()}/{urllib.parse.quote(topic())}?{urllib.parse.urlencode(q)}",
                                     data=path.read_bytes(), method="PUT")
    urllib.request.urlopen(request, timeout=300).close()


def mb(n: int) -> str:
    return f"{n / 1e6:.1f} MB"


def send(a: argparse.Namespace) -> str:
    reg = read_registry()
    n = session_number(reg, a.session)
    note = ""
    if n is None:
        title = f"session {a.session[:8]}"
        note = " (is the dispatcher running?)"
    else:
        title = f"#{n} · {(a.title or reg[n].get('task') or '')[:60]}"
    message = truncate(a.message)
    detail = ""
    if a.file:
        path = Path(a.file)
        if not path.is_file():
            raise RuntimeError(f"file not found: {path}")
        limit = attachment_limit()
        if path.stat().st_size > limit:
            raise RuntimeError(f"{path.name} is {mb(path.stat().st_size)}, over the ntfy limit of {mb(limit)}")
        upload(path, title, message, a.priority)
        detail = f" ({path.name} {mb(path.stat().st_size)})"
    else:
        publish(title, message, priority=a.priority)
    if a.request and RE_SID.fullmatch(a.session):
        write_atomic(data_dir() / "requests" / f"{a.session}.json",
                     json.dumps({"ts": int(time.time()), "message": message}, ensure_ascii=False))
    log(f"sent {title}{detail}{' with request' if a.request else ''}")
    return f"sent to the phone as {('#' + n) if n else title}{detail}{note}"


# ---------------------------------------------------------------- main


def priority(x: str) -> int:
    n = int(x)
    if not 1 <= n <= 5:
        raise argparse.ArgumentTypeError("priority is between 1 and 5")
    return n


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    p = argparse.ArgumentParser(prog="dispatcher")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("listen")
    s = sub.add_parser("send")
    s.add_argument("--session", required=True)
    s.add_argument("--message", required=True)
    s.add_argument("--file")
    s.add_argument("--request", action="store_true", help="a reply is expected: unaddressed messages go to this session")
    s.add_argument("--title")
    s.add_argument("--priority", type=priority)
    sub.add_parser("list")
    a = p.parse_args(argv)
    if a.cmd == "listen":
        return listen()
    try:
        if a.cmd == "send":
            print(send(a))
        else:
            print(list_text(read_registry()))
        return 0
    except Exception as e:
        log(f"{a.cmd} error: {e}")
        print(f"error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
