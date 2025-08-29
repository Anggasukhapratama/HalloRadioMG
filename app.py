from flask import Flask, render_template, Response, jsonify, request, redirect, url_for, session
import requests as pyrequests
import os
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from pymongo import MongoClient, ASCENDING, DESCENDING
from dotenv import load_dotenv
import csv
from io import StringIO
from werkzeug.utils import secure_filename  # ok disisakan walau tak dipakai
from collections import defaultdict
import re
import urllib.parse

# ====== Load .env ======
load_dotenv()

# ====== Konfigurasi dasar Flask ======
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

# ====== Konfigurasi Icecast / Mixxx ======
ICECAST_HOST = os.getenv("ICECAST_HOST", "http://localhost:8000")
MOUNT = os.getenv("ICECAST_MOUNT", "/stream")
ICECAST_URL = f"{ICECAST_HOST}{MOUNT}"

# ====== Konfigurasi Admin sederhana ======
ADMIN_USER = os.getenv("ADMIN_USER", "adminsebayu")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")  # ganti di .env

# ====== Koneksi MongoDB ======
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DBNAME = os.getenv("MONGODB_DBNAME", "haloradio_db")
MONGODB_COLL = os.getenv("MONGODB_COLL", "song_requests")
MONGODB_SCHEDULE_COLL = os.getenv("MONGODB_SCHEDULE_COLL", "schedules")
MONGODB_CHAT_COLL = os.getenv("MONGODB_CHAT_COLL", "chat_messages")
MONGODB_CHATRL_COLL = os.getenv("MONGODB_CHATRL_COLL", "chat_rate_limiter")
MONGODB_PLAYLIST_COLL = os.getenv("MONGODB_PLAYLIST_COLL", "playlist_admin")

mongo_client = MongoClient(MONGODB_URI)
db = mongo_client[MONGODB_DBNAME]

col_requests   = db[MONGODB_COLL]
col_schedules  = db[MONGODB_SCHEDULE_COLL]
col_chat       = db[MONGODB_CHAT_COLL]
col_chat_rl    = db[MONGODB_CHATRL_COLL]
col_playlist   = db[MONGODB_PLAYLIST_COLL]

# ====== Indexes ======
col_requests.create_index([("created_at", DESCENDING)])
col_requests.create_index([("status", ASCENDING), ("created_at", DESCENDING)])
col_requests.create_index([("phone", ASCENDING)])  # opsional

col_schedules.create_index([("start_time", ASCENDING)])
col_schedules.create_index([("end_time", ASCENDING)])

col_chat.create_index([("ts", DESCENDING)])
col_chat.create_index([("ts", DESCENDING), ("name", ASCENDING)])
col_chat_rl.create_index([("ip", ASCENDING), ("ts", DESCENDING)])

# Playlist: urutkan per-hari dengan kunci urutan kustom
col_playlist.create_index([("day", ASCENDING), ("sort_key", ASCENDING), ("start_hhmm", ASCENDING)])


YOUTUBE_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36"
}

def _extract_first_video_id_from_html(html_text: str) -> str | None:
    """
    Coba 2 cara:
    1) JSON initialData: "videoId":"XXXXXXXXXXX"
    2) Fallback: watch?v=XXXXXXXXXXX
    """
    # 1) Cari pola videoId di blob JSON
    m = re.findall(r'"videoId":"([a-zA-Z0-9_-]{11})"', html_text)
    if m:
        # Prefer non-shorts dulu kalau bisa, tapi umumnya sama ID-nya
        return m[0]

    # 2) Fallback: watch?v=ID
    m2 = re.findall(r'watch\?v=([a-zA-Z0-9_-]{11})', html_text)
    if m2:
        return m2[0]

    return None

@app.route("/api/tools/yt/find_first")
def yt_find_first():
    """
    Param:
      - q   : kata kunci pencarian (mis. 'Nothing To Do Bancali')
      - url : (opsional) kalau user kirim link /results?search_query=...
    Return: { ok:True, url:'https://www.youtube.com/watch?v=ID', id:'ID' }
    """
    q = (request.args.get("q") or "").strip()
    url_in = (request.args.get("url") or "").strip()

    if not q and url_in:
        try:
            u = urllib.parse.urlparse(url_in)
            if u.netloc.endswith("youtube.com") and u.path.startswith("/results"):
                qs = urllib.parse.parse_qs(u.query or "")
                qlist = qs.get("search_query", [])
                if qlist:
                    q = qlist[0]
        except Exception:
            pass

    if not q:
        return jsonify({"ok": False, "error": "Butuh parameter q atau url results."}), 400

    try:
        yurl = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(q)
        resp = pyrequests.get(yurl, headers=YOUTUBE_UA, timeout=8)
        resp.raise_for_status()
        vid = _extract_first_video_id_from_html(resp.text)
        if not vid:
            return jsonify({"ok": False, "error": "Tidak ketemu video dari pencarian."}), 404
        return jsonify({"ok": True, "id": vid, "url": f"https://www.youtube.com/watch?v={vid}"})
    except pyrequests.exceptions.Timeout:
        return jsonify({"ok": False, "error": "Timeout ke YouTube."}), 504
    except Exception as e:
        print("yt_find_first error:", e)
        return jsonify({"ok": False, "error": "Gagal mengambil hasil YouTube."}), 502

# ====== Util auth admin ======
def is_admin():
    return session.get("is_admin") is True

def admin_required(fn):
    from functools import wraps
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return redirect(url_for("admin_login"))
        return fn(*args, **kwargs)
    return wrapper

# ====== Helper waktu (kirim UTC Z) ======
def to_utc_iso(dt: datetime) -> str:
    """Pastikan keluar selalu UTC ISO 'Z'."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    s = dt.isoformat()
    if s.endswith("+00:00"):
        s = s[:-6] + "Z"
    return s

# ====== Rate-limit & Moderasi Chat ======
RATE_MAX_MSGS = int(os.getenv("CHAT_RATE_MAX_MSGS", "10"))
RATE_WINDOW_S = int(os.getenv("CHAT_RATE_WINDOW_SECONDS", "60"))
BAD_WORDS = set(
    w.strip().lower() for w in os.getenv("CHAT_BAD_WORDS", "bodoh,kasar1,kasar2").split(",") if w.strip()
)

def get_client_ip():
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "0.0.0.0"

def check_rate_limit(ip: str, max_msgs: int = RATE_MAX_MSGS, per_seconds: int = RATE_WINDOW_S) -> bool:
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(seconds=per_seconds)
    count = col_chat_rl.count_documents({"ip": ip, "ts": {"$gte": window_start}})
    return count < max_msgs

def add_rate_event(ip: str):
    col_chat_rl.insert_one({"ip": ip, "ts": datetime.now(timezone.utc)})

def is_bad(text: str) -> bool:
    t = (text or "").lower()
    return any(w in t for w in BAD_WORDS) if BAD_WORDS else False

# ====== ROUTES: Public ======
@app.route("/")
def home():
    # pastikan file template/welcome.html ada; jika tidak, arahkan ke /radio
    try:
        return render_template("welcome.html")
    except:
        return redirect(url_for("radio_page"))

@app.route("/radio")
def radio_page():
    return render_template("radio.html")

@app.route("/stream")
def stream_proxy():
    try:
        r = pyrequests.get(ICECAST_URL, stream=True, timeout=10)
        content_type = r.headers.get("content-type", "audio/mpeg")
        return Response(r.iter_content(chunk_size=1024), content_type=content_type)
    except pyrequests.exceptions.RequestException as e:
        print(f"Error connecting to Icecast: {e}")
        return "Server radio sedang tidak aktif. Silakan coba lagi nanti.", 503

@app.route("/stats")
def stats():
    try:
        resp = pyrequests.get(f"{ICECAST_HOST}/status-json.xsl", timeout=5)
        data = resp.json()
        sources = data.get("icestats", {}).get("source", [])

        if isinstance(sources, dict):
            sources = [sources]

        selected = None
        for s in sources:
            listenurl = s.get("listenurl", "")
            mount_name = s.get("mount") or ""
            if listenurl.endswith(MOUNT) or mount_name == MOUNT:
                selected = s
                break

        if not selected and sources:
            selected = sources[0]

        if not selected:
            return jsonify({
                "listeners": 0,
                "now_playing": "-",
                "bitrate": None,
                "content_type": None,
                "mount": MOUNT
            }), 200

        title = selected.get("title") or ""
        artist = selected.get("artist") or ""
        server_name = selected.get("server_name") or ""

        if title:
            now_playing = title
        elif artist and server_name:
            now_playing = f"{artist} - {server_name}"
        else:
            now_playing = title or artist or server_name or "-"

        return jsonify({
            "listeners": selected.get("listeners", 0),
            "now_playing": now_playing,
            "bitrate": selected.get("bitrate"),
            "content_type": selected.get("content_type"),
            "mount": selected.get("listenurl") or selected.get("mount") or MOUNT
        })
    except Exception as e:
        print("Stats error:", e)
        return jsonify({
                "listeners": 0,
                "now_playing": "-",
                "bitrate": None,
                "content_type": None,
                "mount": MOUNT
        }), 200

# ====== API: Music Search (Deezer) ======
@app.route("/api/music/search")
def music_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": True, "data": []})
    try:
        dz = pyrequests.get("https://api.deezer.com/search", params={"q": q}, timeout=6)
        dz.raise_for_status()
        raw = dz.json() or {}
        data = []
        for tr in (raw.get("data") or [])[:15]:
            title  = (tr.get("title") or "").strip()
            artist = (tr.get("artist", {}) or {}).get("name") or ""
            album  = (tr.get("album", {}) or {}).get("title") or ""
            cover  = (tr.get("album", {}) or {}).get("cover_medium") or \
                     (tr.get("album", {}) or {}).get("cover") or ""
            preview = tr.get("preview") or ""
            data.append({
                "title": title,
                "artist": artist,
                "album": album,
                "cover": cover,
                "preview": preview
            })
        return jsonify({"ok": True, "data": data})
    except pyrequests.exceptions.Timeout:
        return jsonify({"ok": False, "error": "Timeout ke Deezer."}), 504
    except Exception as e:
        print("Deezer search error:", e)
        return jsonify({"ok": False, "error": "Gagal mengambil data Deezer."}), 502

# ====== API: User Request Lagu ======
@app.route("/api/request_song", methods=["POST"])
def api_request_song():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    title = (data.get("title") or "").strip()

    if not name or not title or not phone:
        return jsonify({"ok": False, "error": "Nama, Nomor HP, dan Judul Lagu wajib diisi."}), 400

    norm = ''.join(ch for ch in phone if ch.isdigit())
    if len(norm) < 9:
        return jsonify({"ok": False, "error": "Nomor HP tidak valid."}), 400

    doc = {
        "name": name,
        "phone": phone,
        "title": title,
        "status": "New",
        "created_at": datetime.now(timezone.utc)
    }
    res = col_requests.insert_one(doc)
    return jsonify({"ok": True, "id": str(res.inserted_id)})

# ====== ROUTES: Admin (Login/Logout + Halaman UI) ======
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        user = request.form.get("username")
        pwd = request.form.get("password")
        if user == ADMIN_USER and pwd == ADMIN_PASSWORD:
            session["is_admin"] = True
            # PERBAIKAN: arahkan ke halaman Requests (endpoint UI yang ada)
            return redirect(url_for("admin_requests_page"))
        return render_template("admin_login.html", error="Username/Password salah.")
    return render_template("admin_login.html")

@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))

# Halaman root admin diarahkan ke Requests
@app.route("/admin")
@admin_required
def admin_root():
    return redirect(url_for("admin_requests_page"))

@app.route("/admin/requests")
@admin_required
def admin_requests_page():
    return render_template("admin/requests.html")

@app.route("/admin/schedules")
@admin_required
def admin_schedules_page():
    return render_template("admin/schedules.html")

@app.route("/admin/playlist")
@admin_required
def admin_playlist_page():
    return render_template("admin/playlist.html")

@app.route("/admin/chat")
@admin_required
def admin_chat_page():
    return render_template("admin/chat.html")

@app.route("/admin/ytlinker")
@admin_required
def admin_ytlinker_page():
    return render_template("admin/ytlinker.html")

# ====== API Admin: Requests ======
@app.route("/api/admin/requests")
@admin_required
def admin_requests():
    status = request.args.get("status")
    q = {}
    if status:
        q["status"] = status
    items = []
    for d in col_requests.find(q).sort("created_at", DESCENDING):
        created_at = d.get("created_at")
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name", ""),
            "phone": d.get("phone", ""),
            "title": d.get("title", ""),
            "status": d.get("status", "New"),
            "created_at": to_utc_iso(created_at)
        })
    return jsonify({"ok": True, "items": items})

@app.route("/api/admin/requests/<req_id>/status", methods=["POST"])
@admin_required
def admin_update_status(req_id):
    data = request.get_json(silent=True) or {}
    status = (data.get("status") or "").strip()
    if status not in {"New", "In-Progress", "Done"}:
        return jsonify({"ok": False, "error": "Status tidak valid."}), 400
    try:
        oid = ObjectId(req_id)
    except Exception:
        return jsonify({"ok": False, "error": "ID tidak valid."}), 400
    result = col_requests.update_one({"_id": oid}, {"$set": {"status": status}})
    if result.matched_count == 0:
        return jsonify({"ok": False, "error": "ID tidak ditemukan."}), 404
    return jsonify({"ok": True})

@app.route("/api/admin/requests/new_count")
@admin_required
def admin_new_count():
    count = col_requests.count_documents({"status": "New"})
    return jsonify({"ok": True, "count": count})

# ====== API: Jadwal Siaran ======
@app.route("/api/admin/schedules", methods=["GET", "POST"])
@admin_required
def admin_schedules():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        title = (data.get("title") or "").strip()
        host = (data.get("host") or "").strip()
        description = (data.get("description") or "").strip()
        start_time = data.get("start_time")  # ISO UTC
        end_time = data.get("end_time")      # ISO UTC
        if not title or not start_time or not end_time:
            return jsonify({"ok": False, "error": "Title, start_time, end_time wajib diisi."}), 400
        try:
            st = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            et = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
            if et <= st:
                return jsonify({"ok": False, "error": "End time harus setelah start time."}), 400
        except Exception:
            return jsonify({"ok": False, "error": "Format waktu tidak valid (ISO 8601)."}), 400

        doc = {
            "title": title,
            "host": host,
            "description": description,
            "start_time": st.astimezone(timezone.utc),
            "end_time": et.astimezone(timezone.utc),
        }
        ins = col_schedules.insert_one(doc)
        return jsonify({"ok": True, "id": str(ins.inserted_id)})

    items = []
    for d in col_schedules.find().sort("start_time", DESCENDING):
        st = d.get("start_time")
        et = d.get("end_time")
        items.append({
            "_id": str(d["_id"]),
            "title": d.get("title", ""),
            "host": d.get("host", ""),
            "description": d.get("description", ""),
            "start_time": to_utc_iso(st),
            "end_time": to_utc_iso(et),
        })
    return jsonify({"ok": True, "items": items})

@app.route("/api/admin/schedules/<sid>", methods=["DELETE"])
@admin_required
def admin_schedule_delete(sid):
    try:
        oid = ObjectId(sid)
    except Exception:
        return jsonify({"ok": False, "error": "ID tidak valid."}), 400
    res = col_schedules.delete_one({"_id": oid})
    if res.deleted_count == 0:
        return jsonify({"ok": False, "error": "ID tidak ditemukan."}), 404
    return jsonify({"ok": True})

# Public now/upcoming
@app.route("/api/schedules/now")
def schedules_now():
    now = datetime.now(timezone.utc)
    d = col_schedules.find_one({"start_time": {"$lte": now}, "end_time": {"$gt": now}})
    if not d:
        return jsonify({"ok": True, "item": None})
    st = d.get("start_time"); et = d.get("end_time")
    item = {
        "_id": str(d["_id"]),
        "title": d.get("title", ""),
        "host": d.get("host", ""),
        "description": d.get("description", ""),
        "start_time": to_utc_iso(st),
        "end_time": to_utc_iso(et),
    }
    return jsonify({"ok": True, "item": item})

@app.route("/api/schedules/upcoming")
def schedules_upcoming():
    try:
        limit = int(request.args.get("limit", 5))
    except Exception:
        limit = 5
    limit = max(1, min(limit, 50))
    now = datetime.now(timezone.utc)
    items = []
    for d in col_schedules.find({"start_time": {"$gte": now}}).sort("start_time", ASCENDING).limit(limit):
        st = d.get("start_time"); et = d.get("end_time")
        items.append({
            "_id": str(d["_id"]),
            "title": d.get("title", ""),
            "host": d.get("host", ""),
            "description": d.get("description", ""),
            "start_time": to_utc_iso(st),
            "end_time": to_utc_iso(et),
        })
    return jsonify({"ok": True, "items": items})

# ====== API: Chat Global ======
@app.route("/api/chat/messages")
def chat_messages():
    since = request.args.get("since")
    try:
        limit = min(int(request.args.get("limit", 50)), 200)
    except Exception:
        limit = 50

    q = {}
    if since:
        try:
            dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            q["ts"] = {"$gt": dt}
        except Exception:
            pass

    cursor = col_chat.find(q).sort("ts", ASCENDING if since else DESCENDING).limit(limit)
    items = []
    for d in cursor:
        ts = d.get("ts") or datetime.now(timezone.utc)
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name") or "Anon",
            "text": d.get("text") or "",
            "ts": to_utc_iso(ts),
            "flagged": bool(d.get("flagged", False))
        })
    if not since:
        items.reverse()
    return jsonify({"ok": True, "items": items})

@app.route("/api/chat/send", methods=["POST"])
def chat_send():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    text = (data.get("text") or "").strip()

    if not text:
        return jsonify({"ok": False, "error": "Pesan kosong."}), 400
    if len(text) > 500:
        return jsonify({"ok": False, "error": "Pesan terlalu panjang (maks 500)."}), 400

    ip = get_client_ip()
    if not check_rate_limit(ip):
        return jsonify({"ok": False, "error": "Terlalu sering mengirim. Coba lagi sebentar."}), 429
    add_rate_event(ip)

    flagged = is_bad(text)
    doc = {
        "ip": ip,
        "name": (name[:60] if name else "Anon"),
        "text": text,
        "ts": datetime.now(timezone.utc),
        "flagged": flagged,
    }
    col_chat.insert_one(doc)
    return jsonify({"ok": True})

# ====== API: Moderasi Chat (Admin) ======
@app.route("/api/admin/chat", methods=["GET"])
@admin_required
def admin_chat_list():
    try:
        limit = min(int(request.args.get("limit", 100)), 500)
    except Exception:
        limit = 100
    flagged_only = request.args.get("flagged") == "1"

    q = {}
    if flagged_only:
        q["flagged"] = True

    items = []
    for d in col_chat.find(q).sort("ts", DESCENDING).limit(limit):
        ts = d.get("ts") or datetime.now(timezone.utc)
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name") or "Anon",
            "text": d.get("text") or "",
            "ip": d.get("ip", ""),
            "flagged": bool(d.get("flagged", False)),
            "ts": to_utc_iso(ts)
        })
    return jsonify({"ok": True, "items": items})

@app.route("/api/admin/chat/<cid>", methods=["DELETE"])
@admin_required
def admin_chat_delete(cid):
    try:
        oid = ObjectId(cid)
    except Exception:
        return jsonify({"ok": False, "error": "ID tidak valid."}), 400
    res = col_chat.delete_one({"_id": oid})
    if res.deleted_count == 0:
        return jsonify({"ok": False, "error": "Pesan tidak ditemukan."}), 404
    return jsonify({"ok": True})

# ====== API: Playlist (Admin ONLY) ======
# Model: { _id, day(0=Senin..6=Minggu), start_hhmm, end_hhmm, program, tracks, sort_key }
@app.route("/api/admin/playlist", methods=["GET", "POST"])
@admin_required
def admin_playlist():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        try:
            day = int(data.get("day"))
        except Exception:
            return jsonify({"ok": False, "error": "Hari tidak valid."}), 400

        start_hhmm = (data.get("start_hhmm") or "").strip()
        end_hhmm   = (data.get("end_hhmm") or "").strip()
        program    = (data.get("program") or "").strip()
        tracks     = (data.get("tracks") or "").strip()

        if day < 0 or day > 6:
            return jsonify({"ok": False, "error": "Hari harus 0..6."}), 400
        if not start_hhmm or not end_hhmm or not program:
            return jsonify({"ok": False, "error": "Mulai, Selesai, dan Program wajib diisi."}), 400

        def hhmm_to_minutes(s):
            try:
                hh, mm = s.split(":")
                return int(hh)*60 + int(mm)
            except Exception:
                return None
        s_min = hhmm_to_minutes(start_hhmm)
        e_min = hhmm_to_minutes(end_hhmm)
        if s_min is None or e_min is None:
            return jsonify({"ok": False, "error": "Format waktu harus HH:MM."}), 400
        if e_min <= s_min:
            return jsonify({"ok": False, "error": "Selesai harus setelah Mulai."}), 400

        # hitung sort_key berikutnya untuk hari tsb
        last_doc = col_playlist.find({"day": day}).sort("sort_key", DESCENDING).limit(1)
        last_doc = next(last_doc, None)
        next_key = (int(last_doc.get("sort_key", -1)) + 1) if last_doc else 0

        doc = {
            "day": day,
            "start_hhmm": start_hhmm,
            "end_hhmm": end_hhmm,
            "program": program,
            "tracks": tracks,
            "sort_key": next_key,
        }
        ins = col_playlist.insert_one(doc)
        return jsonify({"ok": True, "id": str(ins.inserted_id)})

    # GET
    items = []
    for d in col_playlist.find().sort([("day", ASCENDING), ("sort_key", ASCENDING), ("start_hhmm", ASCENDING)]):
        items.append({
            "_id": str(d["_id"]),
            "day": int(d.get("day", 0)),
            "start_hhmm": d.get("start_hhmm", ""),
            "end_hhmm": d.get("end_hhmm", ""),
            "program": d.get("program", ""),
            "tracks": d.get("tracks", ""),
            "sort_key": int(d.get("sort_key", 0)),
        })
    return jsonify({"ok": True, "items": items})

@app.route("/api/admin/playlist/<pid>", methods=["DELETE"])
@admin_required
def admin_playlist_delete(pid):
    try:
        oid = ObjectId(pid)
    except Exception:
        return jsonify({"ok": False, "error": "ID tidak valid."}), 400
    res = col_playlist.delete_one({"_id": oid})
    if res.deleted_count == 0:
        return jsonify({"ok": False, "error": "Item tidak ditemukan."}), 404
    return jsonify({"ok": True})

# ====== Reorder playlist ======
@app.route("/api/admin/playlist/reorder", methods=["POST"])
@admin_required
def admin_playlist_reorder():
    data = request.get_json(silent=True) or {}
    try:
        day = int(data.get("day"))
        ids = list(data.get("ids") or [])
        if day < 0 or day > 6 or not ids:
            raise ValueError
    except Exception:
        return jsonify({"ok": False, "error": "Payload tidak valid."}), 400

    for idx, sid in enumerate(ids):
        try:
            col_playlist.update_one({"_id": ObjectId(sid)}, {"$set": {"sort_key": idx, "day": day}})
        except Exception:
            pass
    return jsonify({"ok": True, "count": len(ids)})

# ====== CSV Export / Import untuk PLAYLIST (versi "pretty") ======
DAY_NAMES = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu']
DAY_ALIASES = {
    # Indo
    'senin':0,'selasa':1,'rabu':2,'kamis':3,'jumat':4,"jum'at":4,'jumaat':4,
    'sabtu':5,'minggu':6,'ahad':6,
    # Eng
    'mon':0,'monday':0,'tue':1,'tuesday':1,'wed':2,'wednesday':2,
    'thu':3,'thursday':3,'fri':4,'friday':4,'sat':5,'saturday':5,
    'sun':6,'sunday':6,
}

def _parse_day_index(val: str) -> int:
    """
    Terima:
      - angka 1..7 (Senin=1) -> dikonversi ke 0..6
      - angka 0..6 -> dipakai langsung
      - nama hari (indo/english) -> map ke 0..6
    """
    s = (str(val) if val is not None else "").strip()
    if s == "":
        raise ValueError("day kosong")
    if s.isdigit():
        n = int(s)
        if 1 <= n <= 7:
            return n - 1
        if 0 <= n <= 6:
            return n
        raise ValueError("day harus 1..7 atau 0..6")
    key = s.lower()
    if key in DAY_ALIASES:
        return DAY_ALIASES[key]
    raise ValueError(f"day/day_name tidak dikenali: {val}")

def _hhmm_ok(s: str) -> bool:
    return bool(re.match(r"^\d{2}:\d{2}$", s or ""))

@app.route("/api/admin/playlist/csv", methods=["GET"])
@admin_required
def playlist_export_csv():
    """
    Export playlist.
    - style=pretty  -> tanpa 'id', ada 'no' (1..), 'day' 1..7, 'day_name'
    - style=raw     -> dengan 'id'
    """
    style = (request.args.get("style") or "pretty").lower()
    si = StringIO()
    w = csv.writer(si)

    items = list(col_playlist.find().sort([("day", ASCENDING), ("sort_key", ASCENDING), ("start_hhmm", ASCENDING)]))

    if style == "raw":
        w.writerow(["id","day","day_name","start_hhmm","end_hhmm","program","tracks"])
        for d in items:
            day = int(d.get("day", 0))
            w.writerow([
                str(d["_id"]),
                day, DAY_NAMES[day],
                d.get("start_hhmm",""), d.get("end_hhmm",""),
                d.get("program",""), (d.get("tracks","") or "").replace("\r\n","\n")
            ])
        fname = "haloradio_playlist_raw.csv"
    else:
        w.writerow(["no","day","day_name","start_hhmm","end_hhmm","program","tracks"])
        for i, d in enumerate(items, start=1):
            day0 = int(d.get("day", 0))
            w.writerow([
                i,
                day0 + 1, DAY_NAMES[day0],
                d.get("start_hhmm",""), d.get("end_hhmm",""),
                d.get("program",""), (d.get("tracks","") or "").replace("\r\n","\n")
            ])
        fname = "haloradio_playlist.csv"

    return Response(si.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={fname}"})

@app.route("/api/admin/playlist/csv", methods=["POST"])
@admin_required
def playlist_import_csv():
    """
    Import CSV playlist (tanpa id juga bisa).
    Kolom (case-insensitive):
      - no (opsional)
      - day (1..7 atau 0..6) ATAU day_name (Senin/Monday/...)
      - start_hhmm, end_hhmm (HH:MM)
      - program, tracks
      - id (opsional; kalau ada → upsert by id)
    Form:
      - mode: append (default) | replace
    """
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "File CSV tidak ditemukan."}), 400

    mode = (request.form.get("mode") or "append").lower().strip()
    content = request.files["file"].stream.read().decode("utf-8", errors="replace")

    try:
        reader = csv.DictReader(StringIO(content))
    except Exception:
        return jsonify({"ok": False, "error": "CSV tidak bisa dibaca."}), 400

    if mode == "replace":
        col_playlist.delete_many({})

    # siapkan counter sort_key per day untuk penambahan baru (append)
    next_key = defaultdict(int)
    if mode != "replace":
        for d in range(0,7):
            last = col_playlist.find({"day": d}).sort("sort_key", DESCENDING).limit(1)
            last = next(last, None)
            next_key[d] = (int(last.get("sort_key", -1)) + 1) if last else 0

    inserted = updated = 0
    line = 1
    for row in reader:
        line += 1
        r = { (k or "").lower().strip(): (v or "").strip() for k,v in row.items() }

        # day → 0..6
        try:
            if "day" in r and r["day"] != "":
                day0 = _parse_day_index(r["day"])
            elif "day_name" in r and r["day_name"] != "":
                day0 = _parse_day_index(r["day_name"])
            else:
                raise ValueError("butuh 'day' (1..7) atau 'day_name'")
        except ValueError as e:
            return jsonify({"ok": False, "error": f"Baris {line}: {e}"}), 400

        start_hhmm = r.get("start_hhmm","")
        end_hhmm   = r.get("end_hhmm","")
        if not (_hhmm_ok(start_hhmm) and _hhmm_ok(end_hhmm)):
            return jsonify({"ok": False, "error": f"Baris {line}: waktu harus HH:MM."}), 400
        sh, sm = map(int, start_hhmm.split(":"))
        eh, em = map(int, end_hhmm.split(":"))
        if eh*60+em <= sh*60+sm:
            return jsonify({"ok": False, "error": f"Baris {line}: end harus setelah start."}), 400

        program = r.get("program","")
        if not program:
            return jsonify({"ok": False, "error": f"Baris {line}: 'program' wajib diisi."}), 400
        tracks  = r.get("tracks","")

        rid = r.get("id","")
        if rid:
            # upsert by id (sort_key dipertahankan)
            try:
                oid = ObjectId(rid)
                res = col_playlist.update_one(
                    {"_id": oid},
                    {"$set": {
                        "day": day0, "start_hhmm": start_hhmm, "end_hhmm": end_hhmm,
                        "program": program, "tracks": tracks
                    }},
                    upsert=True
                )
                if res.matched_count: updated += 1
                else: inserted += 1
            except Exception:
                col_playlist.insert_one({
                    "day": day0, "start_hhmm": start_hhmm, "end_hhmm": end_hhmm,
                    "program": program, "tracks": tracks,
                    "sort_key": next_key[day0]
                })
                next_key[day0] += 1
                inserted += 1
        else:
            col_playlist.insert_one({
                "day": day0, "start_hhmm": start_hhmm, "end_hhmm": end_hhmm,
                "program": program, "tracks": tracks,
                "sort_key": next_key[day0]
            })
            next_key[day0] += 1
            inserted += 1

    return jsonify({"ok": True, "mode": mode, "inserted": inserted, "updated": updated})

# ====== Main ======
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
