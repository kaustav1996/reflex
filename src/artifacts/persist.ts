/**
 * SQLite persistence for backends on Render's free plan, whose disk is wiped on spin-down and
 * redeploy. The backend is started under a small Python sidecar that restores the database from
 * Netlify Blobs on boot and snapshots it back whenever it changes (sqlite3 online backup → gzip →
 * signed-URL PUT). Ported from the Cowork appdata sidecar; only the store changed.
 *
 * Env inside the container: REFLEX_APPDATA_URL (blob REST address), REFLEX_APPDATA_TOKEN (Netlify
 * token), REFLEX_DB_PATH (default ./data.db), REFLEX_APPDATA_INTERVAL (seconds, default 5).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendSpec } from "./manifest.js";

export const PERSIST_FILE = ".reflex-persist.py";

export const PERSIST_PY = `#!/usr/bin/env python3
"""Reflex persistence sidecar: keeps this app's SQLite database safe across container restarts.

Usage (set by the Reflex deploy pipeline):  python3 .reflex-persist.py -- "<your start command>"
Env: REFLEX_APPDATA_URL, REFLEX_APPDATA_TOKEN, REFLEX_DB_PATH (default ./data.db), REFLEX_APPDATA_INTERVAL (s, default 5)
Store: Netlify Blobs. GET reads the blob directly; PUT asks the API for a signed upload URL first.
"""
import gzip, hashlib, json, os, signal, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.request

URL = os.environ.get("REFLEX_APPDATA_URL", "")
TOKEN = os.environ.get("REFLEX_APPDATA_TOKEN", "")
DB = os.environ.get("REFLEX_DB_PATH", "./data.db")
INTERVAL = float(os.environ.get("REFLEX_APPDATA_INTERVAL", "5"))
cmd = " ".join(sys.argv[sys.argv.index("--") + 1:]) if "--" in sys.argv else " ".join(sys.argv[1:])
AUTH = {"Authorization": "Bearer " + TOKEN, "User-Agent": "reflex-persist/1"}

def log(m): print("[reflex-persist] " + m, flush=True)

def restore():
    if os.path.exists(DB) and os.path.getsize(DB) > 0:
        log("local database present; not restoring"); return
    try:
        req = urllib.request.Request(URL, headers=AUTH)
        with urllib.request.urlopen(req, timeout=60) as r: raw = gzip.decompress(r.read())
        d = os.path.dirname(os.path.abspath(DB))
        if d: os.makedirs(d, exist_ok=True)
        with open(DB, "wb") as f: f.write(raw)
        log("restored %d bytes" % len(raw))
    except urllib.error.HTTPError as e:
        log("no saved data yet" if e.code == 404 else "restore failed: HTTP %d" % e.code)
    except Exception as e:
        log("restore failed: %s" % e)

def upload(data):
    req = urllib.request.Request(URL, method="PUT", headers=dict(AUTH, Accept="application/json;type=signed-url"))
    with urllib.request.urlopen(req, timeout=60) as r: signed = json.loads(r.read().decode("utf8"))["url"]
    put = urllib.request.Request(signed, data=data, method="PUT", headers={"Content-Type": "application/gzip", "Cache-Control": "max-age=0, stale-while-revalidate=60"})
    with urllib.request.urlopen(put, timeout=120): pass

_last_hash = None
_last_stat = None
def _stat():
    out = []
    for p in (DB, DB + "-wal"):
        try: s = os.stat(p); out.append((s.st_mtime_ns, s.st_size))
        except FileNotFoundError: out.append(None)
    return tuple(out)

def snapshot(force=False):
    global _last_hash, _last_stat
    if not os.path.exists(DB): return
    st = _stat()
    if not force and st == _last_stat: return
    fd, tmp = tempfile.mkstemp(suffix=".db"); os.close(fd)
    try:
        src = sqlite3.connect(DB, timeout=10); dst = sqlite3.connect(tmp)
        with dst: src.backup(dst)
        dst.close(); src.close()
        with open(tmp, "rb") as f: raw = f.read()
    finally:
        try: os.remove(tmp)
        except OSError: pass
    _last_stat = st
    h = hashlib.sha256(raw).hexdigest()
    if h == _last_hash: return
    data = gzip.compress(raw, 6)
    upload(data)
    _last_hash = h
    log("saved %d bytes (%d gzipped)" % (len(raw), len(data)))

if not URL or not TOKEN:
    log("no REFLEX_APPDATA_URL/TOKEN; running the app without persistence")
    os.execvp("/bin/sh", ["/bin/sh", "-c", "exec " + cmd])

restore()
child = subprocess.Popen(["/bin/sh", "-c", "exec " + cmd])
stopping = False
def _term(sig, frame):
    global stopping
    stopping = True
    try: child.send_signal(sig)
    except Exception: pass
signal.signal(signal.SIGTERM, _term); signal.signal(signal.SIGINT, _term)

while child.poll() is None:
    time.sleep(INTERVAL)
    try: snapshot()
    except Exception as e: log("save failed: %s" % e)
try: snapshot(force=True)
except Exception as e: log("final save failed: %s" % e)
sys.exit(child.returncode or 0)
`;

/** Write the sidecar next to the backend code so it ships in the repo Render builds. */
export function writeSidecar(backendDir: string): string {
	const file = join(backendDir, PERSIST_FILE);
	writeFileSync(file, PERSIST_PY);
	return file;
}

/** Wrap the backend's start command so it runs under the sidecar when python3 exists (it does on Render's images). */
export function withPersistence(spec: BackendSpec, appdata: { url: string; token: string; dbPath: string }): BackendSpec {
	const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
	const start = `if command -v python3 >/dev/null 2>&1; then exec python3 ${PERSIST_FILE} -- ${q(spec.start)}; else ${spec.start}; fi`;
	return { ...spec, start, env: { ...spec.env, REFLEX_APPDATA_URL: appdata.url, REFLEX_APPDATA_TOKEN: appdata.token, REFLEX_DB_PATH: appdata.dbPath } };
}
