#!/usr/bin/env python3
"""Local server for the MIDI review editor.

    python3 serve.py [port]      -> http://localhost:8765

Serves editor/ and a tiny JSON API over work/<name>/:
  GET  /api/projects              list projects that have proposals.json
  GET  /api/project/<name>        proposals.json + review.json state + AI replies
  GET  /api/status/<name>         proposals mtime, AI replies, whether Claude is working
  POST /api/review/<name>         save editor state -> work/<name>/review.json
  POST /api/export/<name>         save state, render work/<name>/<name>.clean.mid, return it
  POST /api/reassess/<name>       run headless Claude Code on the open "ask the AI" notes
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(ROOT, "work")
EDITOR = os.path.join(ROOT, "editor")
JOBS = {}  # name -> {"proc": Popen, "started": t}

REASSESS_PROMPT = (
    "Use the clean-midi skill (.claude/skills/clean-midi/SKILL.md), section 'Reassess requests from the editor', "
    "for project work/{name}. Handle every open request, then stop. Be concise in your final message."
)


def safe_name(name):
    name = unquote(name)
    if "/" in name or name.startswith(".") or not os.path.isdir(os.path.join(WORK, name)):
        raise FileNotFoundError(name)
    return name


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def status(name):
    wd = os.path.join(WORK, name)
    job = JOBS.get(name)
    running = bool(job and job["proc"].poll() is None)
    log = ""
    lp = os.path.join(wd, "ai_log.txt")
    if os.path.exists(lp):
        with open(lp, errors="replace") as f:
            log = f.read()[-1500:]
    return dict(
        proposals_mtime=os.path.getmtime(os.path.join(wd, "proposals.json")),
        replies=load_json(os.path.join(wd, "ai_replies.json"), {}),
        running=running,
        exit_code=None if running or not job else job["proc"].returncode,
        log=log,
        claude_available=bool(shutil.which("claude")),
    )


def start_reassess(name):
    job = JOBS.get(name)
    if job and job["proc"].poll() is None:
        return False, "Claude is already working on this project"
    exe = shutil.which("claude")
    if not exe:
        return False, "claude CLI not found on PATH; run /clean-midi reassess in your Claude Code session instead"
    wd = os.path.join(WORK, name)
    log = open(os.path.join(wd, "ai_log.txt"), "w")
    log.write(f"[{time.strftime('%H:%M:%S')}] starting Claude Code (headless)\n")
    log.flush()
    proc = subprocess.Popen(
        [exe, "-p", REASSESS_PROMPT.format(name=name),
         "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
         "Bash(python3 pipeline/look.py:*)", "Bash(python3 pipeline/propose.py:*)",
         "Bash(python3 pipeline/analyze.py:*)", "Bash(python3 pipeline/render.py:*)",
         "--permission-mode", "acceptEdits"],
        cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    JOBS[name] = dict(proc=proc, started=time.time())
    threading.Thread(target=lambda: (proc.wait(), log.close()), daemon=True).start()
    return True, "started"


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=EDITOR, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else "") and "/api/status" not in str(args[0]):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path == "/api/projects":
                out = []
                for d in sorted(os.listdir(WORK)):
                    pp = os.path.join(WORK, d, "proposals.json")
                    if os.path.exists(pp):
                        out.append(dict(name=d, mtime=os.path.getmtime(pp),
                                        reviewed=os.path.exists(os.path.join(WORK, d, "review.json"))))
                return self.send_json(out)
            if self.path.startswith("/api/project/"):
                name = safe_name(self.path.split("/", 3)[3])
                P = load_json(os.path.join(WORK, name, "proposals.json"), None)
                P["review"] = load_json(os.path.join(WORK, name, "review.json"), None)
                P["status"] = status(name)
                return self.send_json(P)
            if self.path.startswith("/api/status/"):
                return self.send_json(status(safe_name(self.path.split("/", 3)[3])))
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        try:
            parts = self.path.split("/")
            if len(parts) != 4 or parts[1] != "api" or parts[2] not in ("review", "export", "reassess"):
                return self.send_json({"error": "bad path"}, 404)
            name = safe_name(parts[3])
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            state = json.loads(body or b"{}")
            if state:
                with open(os.path.join(WORK, name, "review.json"), "w") as f:
                    json.dump(state, f, indent=1)
            if parts[2] == "review":
                return self.send_json({"ok": True})
            if parts[2] == "reassess":
                ok, msg = start_reassess(name)
                return self.send_json({"ok": ok, "message": msg}, 200 if ok else 409)
            r = subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "render.py"),
                                os.path.join(WORK, name)], capture_output=True, text=True)
            if r.returncode:
                return self.send_json({"error": r.stderr[-2000:]}, 500)
            mid = os.path.join(WORK, name, f"{name}.clean.mid")
            data = open(mid, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/midi")
            self.send_header("Content-Disposition", f'attachment; filename="{name}.clean.mid"')
            self.send_header("X-Render-Log", r.stdout.replace("\n", " | ")[:4000])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"MIDI review editor: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
