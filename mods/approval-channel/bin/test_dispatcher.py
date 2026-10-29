import json
import sys
import threading
import time
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import dispatcher as d  # noqa: E402


def S(name: str) -> str:
    """A sid with the real shape (36 hex chars and dashes), in the same order as the name."""
    h = name.encode().hex().ljust(32, "0")[:32]
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


class FakeNtfy:
    def __init__(self):
        self.published, self.puts, self.streams = [], [], []
        self.lines = []  # the lines served on the next stream GET
        self.post_status = 200  # another code = ntfy refuses the message (e.g. 413)


@pytest.fixture
def server():
    st = FakeNtfy()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _body(self):
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))

        def do_POST(self):
            body = json.loads(self._body().decode("utf-8"))
            if st.post_status != 200:
                self.send_response(st.post_status); self.end_headers(); return
            st.published.append(body)
            self.send_response(200); self.end_headers(); self.wfile.write(b"{}")

        def do_PUT(self):
            st.puts.append((self.path, len(self._body())))
            self.send_response(200); self.end_headers(); self.wfile.write(b"{}")

        def do_GET(self):
            st.streams.append(self.path)
            self.send_response(200); self.end_headers()
            for line in st.lines:
                self.wfile.write((json.dumps(line, ensure_ascii=False) + "\n").encode("utf-8"))
            st.lines = []

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    st.url = f"http://127.0.0.1:{srv.server_address[1]}"
    yield st
    srv.shutdown()


@pytest.fixture
def env(tmp_path, monkeypatch, server):
    data, status = tmp_path / "approval", tmp_path / "status"
    data.mkdir(); status.mkdir()
    (data / "topic.txt").write_text("topic-test", encoding="utf-8")
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    monkeypatch.setenv("APPROVAL_DIR", str(data))
    monkeypatch.setenv("SESSION_STATUS_DIR", str(status))
    monkeypatch.setenv("NTFY_URL", server.url)
    d._last_confirmation.clear()
    return Namespace(data=data, status=status, srv=server)


def session(m, sid, state="working", task="task", **extra):
    sid = S(sid)
    now = int(time.time() * 1000)
    s = {"id": sid, "root": "D:/x", "state": state, "task": task, "lastAction": "last", "files": {},
         "seenAt": now, "changedAt": now, **extra}
    (m.status / f"{sid}.json").write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")


def ev(text, **kw):
    return {"event": "message", "id": kw.pop("id", "m1"), "message": text, **kw}


def inbox(m, sid):
    f = m.data / "inbox" / f"{S(sid)}.jsonl"
    return [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []


def test_parse():
    assert d.parse("3 do this") == ("number", "3", "do this")
    assert d.parse("#3: do this") == ("number", "3", "do this")
    assert d.parse("#12") == ("number", "12", "")
    assert d.parse("do this") == ("free", "do this")
    assert d.parse(" ? ") == ("list",)
    assert d.parse("List") == ("list",)
    assert d.parse("123 x")[0] == "free"
    assert d.parse("3:00 works") == ("free", "3:00 works")
    assert d.parse("1.5 kg is enough") == ("free", "1.5 kg is enough")
    assert d.parse("3") == ("number", "3", "")


def test_allocation_and_reuse(env):
    for s in ("a", "b", "c"):
        session(env, s)
    r = d.update_registry()
    assert {k: v["sid"] for k, v in r.items()} == {"1": S("a"), "2": S("b"), "3": S("c")}
    session(env, "b", ended=True)
    r = d.update_registry()
    assert {k: v["sid"] for k, v in r.items()} == {"1": S("a"), "3": S("c")}
    session(env, "z")
    r = d.update_registry()
    assert r["2"]["sid"] == S("z") and r["3"]["sid"] == S("c")
    # dead because seenAt is old
    session(env, "a", seenAt=int(time.time() * 1000) - 200_000)
    assert "1" not in d.update_registry()


def test_own_messages_are_ignored(env):
    session(env, "a")
    assert d.process(ev("hello", title="#1 · x")) is None
    assert d.process(ev("hello", tags=["robot"])) is None
    assert d.process({"event": "keepalive"}) is None
    assert inbox(env, "a") == []
    d.process(ev("hello", attachment={"url": "http://f/x.jpg"}))
    assert inbox(env, "a")[0]["text"] == "hello [attachment: http://f/x.jpg]"


def test_routing_with_number(env):
    session(env, "a"); session(env, "b")
    d.update_registry()
    assert d.process(ev("#2 do something", id="X")).startswith("→ #2 is working")
    assert inbox(env, "b") == [{"id": "X", "ts": inbox(env, "b")[0]["ts"], "text": "do something"}]
    assert d.process(ev("#7 x")).startswith("There is no #7.")
    assert d.process(ev("7 x")).startswith("Which one? ")  # no # and no session 7: ordinary text
    assert d.process(ev("2")) == "Write the message too: #2 text"
    assert "#1 ● working «task»" in d.process(ev("?"))


def test_routing_without_number(env):
    session(env, "a")
    assert d.process(ev("only one")) is not None and inbox(env, "a")[0]["text"] == "only one"
    d.process(ev("21:00 works"))
    assert inbox(env, "a")[1]["text"] == "21:00 works"
    session(env, "b", task="other")
    r = d.process(ev("to whom"))
    assert r.startswith("Which one? #1 «task» · #2 «other»")
    (env.data / "requests").mkdir()
    (env.data / "requests" / f"{S('b')}.json").write_text('{"ts":1,"message":"q"}', encoding="utf-8")
    d.process(ev("for b"))
    assert inbox(env, "b")[0]["text"] == "for b"
    assert not (env.data / "requests" / f"{S('b')}.json").exists()


def test_no_sessions(env):
    assert d.process(ev("?")) == "No open session."


def test_confirmations_by_state(env):
    session(env, "a", state="waiting"); session(env, "b", state="done")
    assert "blocked on a terminal dialog" in d.process(ev("1 x"))
    assert d.process(ev("2 x")) is None
    assert inbox(env, "b")[0]["text"] == "x"


def test_alert_once_per_episode():
    al = d.Alerts()
    now = 1_000_000.0
    reg = {"1": {"sid": "a", "task": "t" * 80, "state": "waiting", "lastAction": "Allow?", "changedAt": int((now - 130) * 1000)}}
    out = al.due(reg, now)
    assert out == [(f"a:{reg['1']['changedAt']}", "#1 · " + "t" * 60, "waiting for you at the terminal: Allow?")]
    assert len(al.due(reg, now + 10)) == 1  # not sent yet: still due
    al.mark_sent(out[0][0])
    assert al.due(reg, now + 10) == []
    reg["1"]["changedAt"] = int((now - 5) * 1000)
    assert al.due(reg, now) == []  # new episode, still under 120 s
    assert len(al.due(reg, now + 120)) == 1


def test_limit_from_server(env):
    assert d.attachment_limit() == d.MAX_FILE  # the fake server has no valid /v1/account JSON


def test_truncate():
    assert d.truncate("a" * 3500) == "a" * 3500
    assert d.truncate("a" * 4000) == "a" * 3500 + "\n…(the rest is in the session)"


def test_send_text(env, capsys):
    session(env, "long-sid-123", task="Writing the dispatcher")
    d.update_registry()
    assert d.main(["send", "--session", S("long-sid-123"), "--message", "done ăîșț", "--request"]) == 0
    p = env.srv.published[-1]
    assert p == {"topic": "topic-test", "title": "#1 · Writing the dispatcher", "message": "done ăîșț", "tags": ["robot"]}
    assert capsys.readouterr().out.strip() == "sent to the phone as #1"
    assert json.loads((env.data / "requests" / f"{S('long-sid-123')}.json").read_text(encoding="utf-8"))["message"] == "done ăîșț"
    d.main(["send", "--session", "unknown99", "--message", "x"])
    assert env.srv.published[-1]["title"] == "session unknown9"
    assert "is the dispatcher running?" in capsys.readouterr().out
    assert "topic-test" not in (env.data / "dispatcher.log").read_text(encoding="utf-8")


def test_send_file(env, capsys, tmp_path):
    session(env, "a", task="Report")
    d.update_registry()
    f = tmp_path / "report.pdf"
    f.write_bytes(b"x" * 1000)
    assert d.main(["send", f"--session={S('a')}", "--message=Approve?", f"--file={f}", "--priority=4"]) == 0
    path, size = env.srv.puts[-1]
    assert path.startswith("/topic-test?") and "filename=report.pdf" in path and "priority=4" in path and size == 1000
    assert "(report.pdf 0.0 MB)" in capsys.readouterr().out
    assert d.main(["send", f"--session={S('a')}", "--message=x", f"--file={tmp_path / 'missing.png'}"]) == 1
    assert "file not found" in capsys.readouterr().out


def test_topic_from_environment(env, monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "topic-from-env")
    session(env, "a")
    d.update_registry()
    d.main(["send", f"--session={S('a')}", "--message=y"])
    assert env.srv.published[-1]["topic"] == "topic-from-env"


def test_since_on_reconnect(env):
    session(env, "a")
    env.srv.lines = [{"event": "open"}, ev("first", id="ID1"), {"event": "keepalive"}]
    d.stream_once()
    assert env.srv.streams[0] == "/topic-test/json"
    assert (env.data / "last_id.txt").read_text() == "ID1"
    env.srv.lines = [ev("second", id="ID2")]
    d.stream_once()
    assert env.srv.streams[1] == "/topic-test/json?since=ID1"
    assert [x["text"] for x in inbox(env, "a")] == ["first", "second"]


def test_a_live_session_number_does_not_eat_the_time(env):
    for x in ("a", "b", "c"):
        session(env, x)
    (env.data / "requests").mkdir()
    (env.data / "requests" / f"{S('c')}.json").write_text('{"ts":1,"message":"q"}', encoding="utf-8")
    d.process(ev("3:00 works"))
    assert inbox(env, "c")[0]["text"] == "3:00 works"


def test_old_empty_and_broken_data(env):
    session(env, "a")
    assert d.process(ev("#1 yes", time=time.time() - 700)).startswith("Old message")
    (env.data / "requests").mkdir()
    (env.data / "requests" / f"{S('a')}.json").write_text('{"ts":1,"message":"q"}', encoding="utf-8")
    assert d.process(ev("   ")) is None
    assert d.process(ev("triggered")) is None
    assert inbox(env, "a") == [] and (env.data / "requests" / f"{S('a')}.json").exists()
    # a sid with a path and a broken registry: ignored, routing goes on
    (env.status / "bad.json").write_text(json.dumps({"id": "../../bad", "seenAt": int(time.time() * 1000)}), encoding="utf-8")
    (env.status / "x.json").write_text(json.dumps({"id": S("x"), "seenAt": "x"}), encoding="utf-8")
    (env.data / "registry.json").write_text('{"1": null, "x": {}, "2": {"sid": "../y"}}', encoding="utf-8")
    assert [v["sid"] for v in d.update_registry().values()] == [S("a")]
    d.process(ev("works"))
    assert inbox(env, "a")[0]["text"] == "works"


def test_single_confirmation_for_messages_in_a_row(env):
    session(env, "a")
    assert d.process(ev("one", id="1")).startswith("→ #1 is working")
    assert d.process(ev("two", id="2")) is None
    assert [x["text"] for x in inbox(env, "a")] == ["one", "two"]


def test_invalid_priority(env):
    with pytest.raises(SystemExit):
        d.main(["send", "--session=x", "--message=a", "--priority=7"])
    assert env.srv.published == []


def test_unsent_alert_is_retried(env, monkeypatch):
    al = d.Alerts()
    reg = {"1": {"sid": "a", "task": "t", "state": "waiting", "lastAction": "Allow?", "changedAt": 0},
           "2": {"sid": "b", "task": "u", "state": "waiting", "lastAction": "Run?", "changedAt": 0}}
    monkeypatch.setenv("NTFY_URL", "http://127.0.0.1:1")  # ntfy down
    al.send(reg, now_s=1000.0)
    assert env.srv.published == [] and al.failures == {"a:0": 1, "b:0": 1}  # both attempted
    monkeypatch.setenv("NTFY_URL", env.srv.url)  # ntfy is back
    al.send(reg, now_s=1010.0)
    assert [p["title"] for p in env.srv.published] == ["#1 · t", "#2 · u"] and al.failures == {}
    al.send(reg, now_s=1020.0)
    assert len(env.srv.published) == 2  # once per episode
    log = (env.data / "dispatcher.log").read_text(encoding="utf-8")
    assert log.count("alert not sent (attempt 1, 0/1800 s)") == 2 and "topic-test" not in log


def test_network_outage_is_retried_for_30_minutes(env, monkeypatch):
    """A network outage fails within milliseconds: a round every READ_S must not give up after 5 rounds."""
    al = d.Alerts()
    reg = {"1": {"sid": "a", "task": "t", "state": "waiting", "lastAction": "Allow?", "changedAt": 0}}
    publish = d.publish

    def no_network(*_a, **_k):
        raise d.urllib.error.URLError(OSError("getaddrinfo failed"))
    monkeypatch.setattr(d, "publish", no_network)
    for step in range(0, 600, d.READ_S):  # 10 min of outage, 60 rounds
        al.send(reg, now_s=1000.0 + step)
    assert al.failures == {"a:0": 60} and "a:0" not in al.sent
    monkeypatch.setattr(d, "publish", publish)  # the network is back
    al.send(reg, now_s=1600.0)
    assert [p["title"] for p in env.srv.published] == ["#1 · t"] and al.failures == {}
    reg["1"]["changedAt"] = 5  # another episode; the outage lasts more than 30 min: give up
    monkeypatch.setattr(d, "publish", no_network)
    al.send(reg, now_s=2000.0)
    al.send(reg, now_s=2000.0 + d.Alerts.OUTAGE_DEADLINE_S - 1)
    assert "a:5" not in al.sent
    al.send(reg, now_s=2000.0 + d.Alerts.OUTAGE_DEADLINE_S)
    assert "a:5" in al.sent and al.failures == {}
    assert "1800/1800 s, giving up" in (env.data / "dispatcher.log").read_text(encoding="utf-8")


def test_ntfy_refusal_is_retried_at_most_5_times(env):
    al = d.Alerts()
    reg = {"1": {"sid": "a", "task": "t", "state": "waiting", "lastAction": "Allow?", "changedAt": 0}}
    env.srv.post_status = 413  # always refused
    for _ in range(7):
        al.send(reg, now_s=2000.0)
    assert al.failures == {} and "a:0" in al.sent and env.srv.published == []
    log = (env.data / "dispatcher.log").read_text(encoding="utf-8")
    assert log.count("alert not sent") == 5 and "5/5, giving up" in log
    assert d.Alerts.is_refusal(d.urllib.error.HTTPError("u", 429, "", {}, None)) is False  # too many: outage, not refusal
