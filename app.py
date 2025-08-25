# app.py
from flask import Flask, render_template, Response, jsonify, request, redirect, url_for, session
import requests as pyrequests
import os
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from pymongo import MongoClient, ASCENDING, DESCENDING
from dotenv import load_dotenv

# ====== Load .env (opsional, direkomendasikan) ======
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
# Contoh MONGODB_URI lokal: "mongodb://localhost:27017"
# Contoh Atlas: "mongodb+srv://user:pass@cluster0.xxxxxx.mongodb.net"
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DBNAME = os.getenv("MONGODB_DBNAME", "haloradio_db")
MONGODB_COLL = os.getenv("MONGODB_COLL", "song_requests")
MONGODB_SCHEDULE_COLL = os.getenv("MONGODB_SCHEDULE_COLL", "schedules")
MONGODB_CHAT_COLL = os.getenv("MONGODB_CHAT_COLL", "chat_messages")
MONGODB_CHATRL_COLL = os.getenv("MONGODB_CHATRL_COLL", "chat_rate_limiter")  # koleksi rate-limit (opsional)

mongo_client = MongoClient(MONGODB_URI)
db = mongo_client[MONGODB_DBNAME]

col_requests  = db[MONGODB_COLL]
col_schedules = db[MONGODB_SCHEDULE_COLL]
col_chat      = db[MONGODB_CHAT_COLL]
col_chat_rl   = db[MONGODB_CHATRL_COLL]

# Indexes
col_requests.create_index([("created_at", DESCENDING)])
col_requests.create_index([("status", ASCENDING), ("created_at", DESCENDING)])

col_schedules.create_index([("start_time", ASCENDING)])
col_schedules.create_index([("end_time", ASCENDING)])

col_chat.create_index([("ts", DESCENDING)])
col_chat.create_index([("ts", DESCENDING), ("name", ASCENDING)])
col_chat_rl.create_index([("ip", ASCENDING), ("ts", DESCENDING)])

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

# ====== Rate-limit & Moderasi Chat ======
# ubah sesuai kebutuhan
RATE_MAX_MSGS = int(os.getenv("CHAT_RATE_MAX_MSGS", "10"))       # 10 pesan
RATE_WINDOW_S = int(os.getenv("CHAT_RATE_WINDOW_SECONDS", "60")) # tiap 60 detik

BAD_WORDS = set(
    w.strip().lower() for w in os.getenv("CHAT_BAD_WORDS", "bodoh,kasar1,kasar2").split(",") if w.strip()
)

def get_client_ip():
    # Jika di belakang reverse proxy (nginx), gunakan X-Forwarded-For
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "0.0.0.0"

def check_rate_limit(ip: str, max_msgs: int = RATE_MAX_MSGS, per_seconds: int = RATE_WINDOW_S) -> bool:
    """
    True jika MASIH BOLEH kirim (belum melewati limit).
    """
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
    # pastikan ada templates/welcome.html
    return render_template("welcome.html")

@app.route("/radio")
def radio_page():
    # pastikan ada templates/radio.html
    return render_template("radio.html")

@app.route("/stream")
def stream_proxy():
    """
    Reverse proxy: meneruskan audio stream dari Icecast ke client.
    """
    try:
        r = pyrequests.get(ICECAST_URL, stream=True, timeout=10)
        content_type = r.headers.get("content-type", "audio/mpeg")
        return Response(r.iter_content(chunk_size=1024), content_type=content_type)
    except pyrequests.exceptions.RequestException as e:
        print(f"Error connecting to Icecast: {e}")
        return "Server radio sedang tidak aktif. Silakan coba lagi nanti.", 503

@app.route("/stats")
def stats():
    """
    Ambil metadata & jumlah pendengar dari Icecast /status-json.xsl
    Mengembalikan JSON: { listeners, now_playing, bitrate, content_type, mount }
    """
    try:
        resp = pyrequests.get(f"{ICECAST_HOST}/status-json.xsl", timeout=5)
        data = resp.json()
        sources = data.get("icestats", {}).get("source", [])

        # Jika hanya satu mount, Icecast kadang mengembalikan dict, normalkan ke list
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
            now_playing = title  # sering sudah "Artist - Title" dari Mixxx
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

# ====== API: User Request Lagu (MongoDB) ======
@app.route("/api/request_song", methods=["POST"])
def api_request_song():
    """
    Body JSON: { "name": "...", "title": "..." }
    Simpan ke MongoDB dengan status 'New'
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    title = (data.get("title") or "").strip()

    if not name or not title:
        return jsonify({"ok": False, "error": "Nama dan Judul Lagu wajib diisi."}), 400

    doc = {
        "name": name,
        "title": title,
        "status": "New",
        "created_at": datetime.now(timezone.utc)
    }
    res = col_requests.insert_one(doc)
    return jsonify({"ok": True, "id": str(res.inserted_id)})

# ====== ROUTES: Admin ======
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        user = request.form.get("username")
        pwd = request.form.get("password")
        if user == ADMIN_USER and pwd == ADMIN_PASSWORD:
            session["is_admin"] = True
            return redirect(url_for("admin_dashboard"))
        return render_template("admin_login.html", error="Username/Password salah.")
    return render_template("admin_login.html")

@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))

@app.route("/admin")
@admin_required
def admin_dashboard():
    # pastikan ada templates/admin.html
    return render_template("admin.html")

# API Admin: ambil daftar request (dengan filter status opsional)
@app.route("/api/admin/requests")
@admin_required
def admin_requests():
    status = request.args.get("status")  # None, "New", "In-Progress", "Done"
    q = {}
    if status:
        q["status"] = status

    items = []
    for d in col_requests.find(q).sort("created_at", DESCENDING):
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name", ""),
            "title": d.get("title", ""),
            "status": d.get("status", "New"),
            "created_at": d.get("created_at", datetime.now(timezone.utc)).isoformat()
        })
    return jsonify({"ok": True, "items": items})

# API Admin: update status request
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

# API Admin: total unread/new untuk badge notifikasi
@app.route("/api/admin/requests/new_count")
@admin_required
def admin_new_count():
    count = col_requests.count_documents({"status": "New"})
    return jsonify({"ok": True, "count": count})

# ====== API: Jadwal Siaran ======
# Model dokumen: {
#   _id, title, host, description, start_time (UTC ISO), end_time (UTC ISO)
# }

@app.route("/api/admin/schedules", methods=["GET", "POST"])
@admin_required
def admin_schedules():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        title = (data.get("title") or "").strip()
        host = (data.get("host") or "").strip()
        description = (data.get("description") or "").strip()
        start_time = data.get("start_time")  # ISO string in UTC
        end_time = data.get("end_time")      # ISO string in UTC
        if not title or not start_time or not end_time:
            return jsonify({"ok": False, "error": "Title, start_time, end_time wajib diisi."}), 400
        try:
            st = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            et = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
            if et <= st:
                return jsonify({"ok": False, "error": "End time harus setelah start time."}), 400
        except Exception:
            return jsonify({"ok": False, "error": "Format waktu tidak valid (gunakan ISO 8601)."}), 400

        doc = {
            "title": title,
            "host": host,
            "description": description,
            "start_time": st,
            "end_time": et,
        }
        ins = col_schedules.insert_one(doc)
        return jsonify({"ok": True, "id": str(ins.inserted_id)})

    # GET list semua jadwal (terbaru di atas)
    items = []
    for d in col_schedules.find().sort("start_time", DESCENDING):
        items.append({
            "_id": str(d["_id"]),
            "title": d.get("title", ""),
            "host": d.get("host", ""),
            "description": d.get("description", ""),
            "start_time": d.get("start_time").isoformat(),
            "end_time": d.get("end_time").isoformat(),
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

# Public endpoints untuk user menampilkan jadwal yang relevan
@app.route("/api/schedules/now")
def schedules_now():
    now = datetime.now(timezone.utc)
    d = col_schedules.find_one({"start_time": {"$lte": now}, "end_time": {"$gt": now}})
    if not d:
        return jsonify({"ok": True, "item": None})
    item = {
        "_id": str(d["_id"]),
        "title": d.get("title", ""),
        "host": d.get("host", ""),
        "description": d.get("description", ""),
        "start_time": d.get("start_time").isoformat(),
        "end_time": d.get("end_time").isoformat(),
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
        items.append({
            "_id": str(d["_id"]),
            "title": d.get("title", ""),
            "host": d.get("host", ""),
            "description": d.get("description", ""),
            "start_time": d.get("start_time").isoformat(),
            "end_time": d.get("end_time").isoformat(),
        })
    return jsonify({"ok": True, "items": items})

# ====== API: Chat Global ======
@app.route("/api/chat/messages")
def chat_messages():
    """
    Query:
      - since (ISO string, optional)
      - limit (int, optional, default 50, maks 200)
    """
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
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name") or "Anon",
            "text": d.get("text") or "",
            "ts": (d.get("ts") or datetime.now(timezone.utc)).isoformat(),
            "flagged": bool(d.get("flagged", False))
        })
    if not since:
        items.reverse()
    return jsonify({"ok": True, "items": items})

@app.route("/api/chat/send", methods=["POST"])
def chat_send():
    """
    Body JSON: {name?, text}
    Rate-limit: default 10 pesan / 60 detik per IP (ubah via env)
    """
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
    """
    Query:
      - flagged: '1' hanya yang di-flag
      - limit: default 100, maks 500
    """
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
        items.append({
            "_id": str(d["_id"]),
            "name": d.get("name") or "Anon",
            "text": d.get("text") or "",
            "ip": d.get("ip", ""),
            "flagged": bool(d.get("flagged", False)),
            "ts": (d.get("ts") or datetime.now(timezone.utc)).isoformat()
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

# ====== API: Deezer Search (rekomendasi & preview 30 detik) ======
@app.route("/api/music/search")
def api_music_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": True, "data": []})
    try:
        # Deezer public API tidak butuh API key
        r = pyrequests.get("https://api.deezer.com/search", params={"q": q}, timeout=8)
        j = r.json()
        data = []
        for it in (j.get("data") or [])[:15]:  # batasi 15 item
            data.append({
                "id": it.get("id"),
                "title": it.get("title"),
                "artist": it.get("artist", {}).get("name"),
                "album": it.get("album", {}).get("title"),
                "cover": it.get("album", {}).get("cover_medium"),
                "preview": it.get("preview"),
                "link": it.get("link"),
            })
        return jsonify({"ok": True, "data": data})
    except Exception as e:
        print("Deezer error:", e)
        return jsonify({"ok": False, "error": "Gagal memanggil Deezer."}), 500

# ====== Main ======
if __name__ == "__main__":
    # Jalankan Flask
    app.run(host="0.0.0.0", port=5000, debug=True)
