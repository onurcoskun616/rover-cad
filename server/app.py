"""
Rover CNC · LLM Chatbot Backend
Flask + Flask-SocketIO + SQLite
"""

try:
    import eventlet
    eventlet.monkey_patch()
except ImportError:
    pass

import os
import re
import json
import uuid
import sqlite3
import logging
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "rover_cnc.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"
PROMPT_PATH = BASE_DIR / "llm_system_prompt.txt"
ENV_PATH = BASE_DIR / ".env"

def load_dotenv():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v

load_dotenv()

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai")  # "openai" | "anthropic"
LLM_MODEL = os.getenv("LLM_MODEL", "qwen/qwen3-32b")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://openrouter.ai/api/v1")
LLM_MAX_HISTORY = int(os.getenv("LLM_MAX_HISTORY", "20"))

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "rover-cnc-secret")
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("rover-cnc")

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.close()
    log.info("Database initialized at %s", DB_PATH)


def load_system_prompt():
    with open(PROMPT_PATH, encoding="utf-8") as f:
        return f.read()


init_db()
SYSTEM_PROMPT = load_system_prompt()
log.info("Database and system prompt loaded")

# ---------------------------------------------------------------------------
# LLM client — supports OpenAI-compatible APIs (OpenRouter, Qwen, etc.)
# ---------------------------------------------------------------------------

def call_llm(messages: list[dict]) -> str:
    """Call LLM via OpenAI-compatible chat completions endpoint."""
    import urllib.request

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LLM_API_KEY}",
    }

    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "max_tokens": 2048,
        "temperature": 0.3,
    }
    if "openrouter" in LLM_BASE_URL and "qwen" in LLM_MODEL.lower():
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    req = urllib.request.Request(
        f"{LLM_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        log.error("LLM call failed: %s", e)
        return f"LLM hatası: {e}"


def call_llm_anthropic(messages: list[dict]) -> str:
    """Call Anthropic Claude API."""
    import urllib.request

    system_msgs = [m["content"] for m in messages if m["role"] == "system"]
    chat_msgs = [m for m in messages if m["role"] != "system"]

    headers = {
        "Content-Type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
    }

    payload = {
        "model": LLM_MODEL,
        "max_tokens": 2048,
        "system": "\n\n".join(system_msgs),
        "messages": chat_msgs,
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
            return data["content"][0]["text"]
    except Exception as e:
        log.error("Anthropic call failed: %s", e)
        return f"LLM hatası: {e}"


def call_model(messages: list[dict]) -> str:
    if LLM_PROVIDER == "anthropic":
        return call_llm_anthropic(messages)
    return call_llm(messages)

# ---------------------------------------------------------------------------
# G-code extraction from LLM response
# ---------------------------------------------------------------------------

GCODE_RE = re.compile(r"<gcode>(.*?)</gcode>", re.DOTALL)


def extract_gcode_blocks(text: str) -> list[str]:
    return [block.strip() for block in GCODE_RE.findall(text)]


def strip_gcode_for_summary(text: str) -> str:
    """Remove <gcode> blocks from text, keep natural language only."""
    return GCODE_RE.sub("[G-code operasyonu]", text).strip()

# ---------------------------------------------------------------------------
# G-code safety net for the free-text LLM path
#
# Every deterministic shape (delik, cep, kanal, altıgen cep, örnek parçalar,
# ...) is now generated client-side by a parametric toolpath function that
# always produces well-formed, geometrically-correct G-code — the LLM only
# supplies the numbers. This chat path is what's left over: genuinely novel
# requests with no matching deterministic generator, where the LLM writes
# the G-code text — coordinates and all — itself. Nothing else validates
# that text before it reaches the simulator or gets saved as "the"
# operation, which is exactly how a line like "G1 X-15 -25 Z57 F200"
# (missing the Y before -25 — silently misinterpreted by real controllers)
# made it into a saved session. Mirrors the same two checks
# camAssistantService.js's trusted epilogue runs on FreeCAD's own toolpath
# (collisionCheckPy, plus basic command well-formedness) instead of trusting
# generated G-code blindly.
# ---------------------------------------------------------------------------

GCODE_WORD_RE = re.compile(r"([A-Za-z])\s*([+-]?\d*\.?\d+)")


def validate_gcode_syntax(gcode_text: str) -> list[str]:
    """Flag lines with a token that isn't a valid <letter><number> G-code
    word — e.g. a coordinate missing its axis letter, which real controllers
    either reject or silently misinterpret rather than erroring cleanly."""
    problems = []
    for lineno, raw in enumerate(gcode_text.splitlines(), 1):
        line = re.sub(r"\([^)]*\)", "", raw.split(";", 1)[0]).strip()
        if not line:
            continue
        residual = GCODE_WORD_RE.sub("", line).strip()
        if residual:
            problems.append(
                f"Satır {lineno}: eksen harfi eksik/tanınmayan token "
                f"{residual!r} — \"{raw.strip()}\""
            )
    return problems


def validate_gcode_collision_mill(gcode_text: str, stock: dict, tool_start: dict) -> list[str]:
    """Sample straight-line G0 rapid segments against the stock's bounding
    box, same approach as camAssistantService.js's collisionCheckPy: a rapid
    whose path dips into material is a crash risk regardless of where it's
    headed. Only meaningful for mill (X/Y/Z); lathe gets syntax checks only."""
    w = float(stock.get("w", 200) or 200)
    d = float(stock.get("d", 140) or 140)
    h = float(stock.get("h", 60) or 60)
    x_lo, x_hi = -w / 2, w / 2
    y_lo, y_hi = -d / 2, d / 2
    z_hi = h

    def inside(x, y, z, margin=0.05):
        return (x_lo - margin <= x <= x_hi + margin and
                y_lo - margin <= y <= y_hi + margin and
                -margin <= z <= z_hi + margin)

    px = float(tool_start.get("x", 0) or 0)
    py = float(tool_start.get("y", 0) or 0)
    pz = float(tool_start.get("z", z_hi + 20) or (z_hi + 20))

    problems = []
    for lineno, raw in enumerate(gcode_text.splitlines(), 1):
        line = re.sub(r"\([^)]*\)", "", raw.split(";", 1)[0]).strip()
        m = re.match(r"^(G0?0|G0?1)\b", line, re.IGNORECASE)
        if not m:
            continue
        is_rapid = m.group(1).upper() in ("G0", "G00")
        words = {L.upper(): float(v) for L, v in GCODE_WORD_RE.findall(line)}
        nx, ny, nz = words.get("X", px), words.get("Y", py), words.get("Z", pz)
        if is_rapid and px is not None and min(pz, nz) <= z_hi + 0.5:
            dist = ((nx - px) ** 2 + (ny - py) ** 2 + (nz - pz) ** 2) ** 0.5
            if dist > 0.5:
                steps = min(15, max(3, int(dist // 3)))
                for s in range(1, steps):
                    t = s / steps
                    sx, sy, sz = px + (nx - px) * t, py + (ny - py) * t, pz + (nz - pz) * t
                    if inside(sx, sy, sz):
                        problems.append(
                            f"Satır {lineno}: hızlı hareket (G0) parçanın içinden "
                            f"geçiyor (X{sx:.1f} Y{sy:.1f} Z{sz:.1f}) — \"{raw.strip()}\""
                        )
                        break
        px, py, pz = nx, ny, nz
    return problems


def validate_gcode_block(gcode_text: str, machine_type: str, stock: dict, tool_start: dict) -> list[str]:
    problems = validate_gcode_syntax(gcode_text)
    if not problems and machine_type == "mill":
        problems += validate_gcode_collision_mill(gcode_text, stock, tool_start)
    return problems

# ---------------------------------------------------------------------------
# Session & conversation management
# ---------------------------------------------------------------------------

def create_session(machine_type: str = "mill") -> dict:
    conn = get_db()
    session_key = uuid.uuid4().hex[:12]
    conn.execute(
        "INSERT INTO sessions (session_key, machine_type) VALUES (?, ?)",
        (session_key, machine_type),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    conn.close()
    return dict(row)


def get_or_create_session(session_key: str, machine_type: str = "mill") -> dict:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    if row:
        conn.close()
        return dict(row)
    conn.execute(
        "INSERT INTO sessions (session_key, machine_type) VALUES (?, ?)",
        (session_key, machine_type),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    conn.close()
    return dict(row)


def save_message(session_id: int, role: str, content: str, summary: str = None,
                 has_gcode: bool = False):
    conn = get_db()
    conn.execute(
        "INSERT INTO conversations (session_id, role, content, summary, has_gcode) "
        "VALUES (?, ?, ?, ?, ?)",
        (session_id, role, content, summary, int(has_gcode)),
    )
    conn.commit()
    conn.close()


def save_operation(session_id: int, gcode_raw: str, description: str = ""):
    conn = get_db()
    op_idx = conn.execute(
        "SELECT COALESCE(MAX(op_index), -1) + 1 FROM operations WHERE session_id = ?",
        (session_id,),
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO operations (session_id, gcode_raw, description, op_index) "
        "VALUES (?, ?, ?, ?)",
        (session_id, gcode_raw, description, op_idx),
    )
    conn.commit()
    conn.close()
    return op_idx


def get_all_operations(session_id: int) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM operations WHERE session_id = ? ORDER BY op_index",
        (session_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_latest_operation(session_id: int) -> dict | None:
    """Most recent operation for a session. A `session_key` lives indefinitely
    in the browser's localStorage, so get_all_operations() can span days/weeks
    of unrelated testing (different stock sizes, even lathe ops mixed with
    mill ops) — .nc exports must reflect only the operation the user just ran,
    not that whole history."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM operations WHERE session_id = ? ORDER BY op_index DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def build_llm_context(session_id: int, machine_state: dict) -> list[dict]:
    """Build message list for LLM. Uses summaries for old messages with G-code."""
    conn = get_db()
    rows = conn.execute(
        "SELECT role, content, summary, has_gcode FROM conversations "
        "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, LLM_MAX_HISTORY),
    ).fetchall()
    conn.close()

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    state_block = (
        f"\n\n## Mevcut Makine Durumu\n"
        f"```json\n{json.dumps(machine_state, ensure_ascii=False)}\n```"
    )
    messages[0]["content"] += state_block

    for row in reversed(rows):
        role = row["role"]
        if role == "system":
            continue
        if row["has_gcode"] and row["summary"]:
            messages.append({"role": role, "content": row["summary"]})
        else:
            messages.append({"role": role, "content": row["content"]})

    return messages


def update_session_stock(session_id: int, machine_state: dict):
    conn = get_db()
    stock = machine_state.get("stock", {})
    mt = machine_state.get("machineType", "mill")
    if mt == "mill":
        conn.execute(
            "UPDATE sessions SET stock_w=?, stock_d=?, stock_h=?, machine_type=?, "
            "updated_at=datetime('now') WHERE id=?",
            (stock.get("w", 200), stock.get("d", 140), stock.get("h", 60),
             mt, session_id),
        )
    else:
        conn.execute(
            "UPDATE sessions SET stock_r=?, stock_len=?, machine_type=?, "
            "updated_at=datetime('now') WHERE id=?",
            (stock.get("r", 45), stock.get("len", 200), mt, session_id),
        )
    conn.commit()
    conn.close()

# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    log.info("Client connected: %s", request.sid)
    emit("connected", {"status": "ok"})


@socketio.on("disconnect")
def on_disconnect():
    log.info("Client disconnected: %s", request.sid)


@socketio.on("init_session")
def on_init_session(data):
    machine_type = data.get("machineType", "mill")
    session_key = data.get("sessionKey", "")
    if session_key:
        session = get_or_create_session(session_key, machine_type)
    else:
        session = create_session(machine_type)
    emit("session_ready", {
        "sessionId": session["id"],
        "sessionKey": session["session_key"],
    })


@socketio.on("chat_message")
def on_chat_message(data):
    """
    Receive user message + machine state, call LLM, return response.
    data = {
        sessionKey: str,
        message: str,
        machineState: { machineType, stock, tool, spindleRpm, feed, ... }
    }
    """
    session_key = data.get("sessionKey", "")
    user_msg = data.get("message", "").strip()
    machine_state = data.get("machineState", {})

    if not user_msg:
        emit("chat_response", {"error": "Boş mesaj"})
        return

    session = get_or_create_session(
        session_key, machine_state.get("machineType", "mill")
    )
    session_id = session["id"]

    update_session_stock(session_id, machine_state)

    save_message(session_id, "user", user_msg)

    llm_messages = build_llm_context(session_id, machine_state)

    stock = machine_state.get("stock", {})
    mt = machine_state.get("machineType", "mill")
    if mt == "mill":
        stock_tag = (f"[STOK: {stock.get('w')}x{stock.get('d')}x{stock.get('h')}mm | "
                     f"X: -{stock.get('w',0)/2}..+{stock.get('w',0)/2}, "
                     f"Y: -{stock.get('d',0)/2}..+{stock.get('d',0)/2}, "
                     f"Z üst: {stock.get('h')}, güvenli Z: {stock.get('h',0)+10}]")
    else:
        stock_tag = (f"[STOK: çap={stock.get('r',0)*2}mm, uzunluk={stock.get('len')}mm]")

    llm_messages.append({"role": "user", "content": f"{user_msg}\n\n{stock_tag}"})

    emit("chat_typing", {"typing": True})

    try:
        llm_response = call_model(llm_messages)
    except Exception as e:
        log.error("LLM error: %s", e)
        emit("chat_response", {"error": str(e)})
        return

    tool_start = machine_state.get("tool", {}) or {}
    gcode_blocks = extract_gcode_blocks(llm_response)

    # Deterministic safety net: unlike the parametric generators (delik/cep/
    # kanal/örnek parça — all client-side, no LLM involved), this path is the
    # LLM writing raw G-code coordinates itself. Validate every block before
    # it's ever run or saved; give the LLM ONE chance to fix a rejected block
    # with the exact problem lines fed back, same bounded-retry shape as
    # camAssistantService.js's FreeCAD code-gen retry loop.
    valid_blocks, rejected_notes = [], []
    for block in gcode_blocks:
        problems = validate_gcode_block(block, mt, stock, tool_start)
        if not problems:
            valid_blocks.append(block)
            continue
        retry_msg = (
            "Ürettiğin G-code güvenlik/sözdizimi kontrolünden geçemedi, "
            "aşağıdaki sorunları düzelterek SADECE düzeltilmiş <gcode> bloğunu "
            "tekrar üret:\n- " + "\n- ".join(problems)
        )
        try:
            fixed_response = call_model(
                llm_messages + [
                    {"role": "assistant", "content": llm_response},
                    {"role": "user", "content": retry_msg},
                ]
            )
            fixed_blocks = extract_gcode_blocks(fixed_response)
            fixed_block = fixed_blocks[0] if fixed_blocks else None
        except Exception as e:
            log.error("LLM retry error: %s", e)
            fixed_block = None
        fixed_problems = validate_gcode_block(fixed_block, mt, stock, tool_start) if fixed_block else problems
        if fixed_block and not fixed_problems:
            valid_blocks.append(fixed_block)
        else:
            rejected_notes.append(fixed_problems or problems)

    has_gcode = len(valid_blocks) > 0
    summary = strip_gcode_for_summary(llm_response) if has_gcode else None

    save_message(session_id, "assistant", llm_response, summary=summary,
                 has_gcode=has_gcode)

    op_indices = []
    for block in valid_blocks:
        idx = save_operation(session_id, block, summary or "")
        op_indices.append(idx)

    display_text = GCODE_RE.sub("", llm_response).strip()
    if rejected_notes:
        flat = [p for group in rejected_notes for p in group][:6]
        display_text += (
            "\n\n⚠ Üretilen G-code güvenlik kontrolünden geçemedi, ÇALIŞTIRILMADI:\n- "
            + "\n- ".join(flat)
        )

    emit("chat_response", {
        "text": display_text,
        "gcodeBlocks": valid_blocks,
        "opIndices": op_indices,
        "hasGcode": has_gcode,
    })


@socketio.on("get_master_gcode")
def on_get_master_gcode(data):
    session_key = data.get("sessionKey", "")
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    if not row:
        emit("master_gcode", {"gcode": "", "count": 0})
        return
    conn.close()

    op = get_latest_operation(row["id"])
    if not op:
        emit("master_gcode", {"gcode": "", "count": 0})
        return

    lines = [
        f"(Rover CNC · Exported {datetime.now().strftime('%Y-%m-%d %H:%M')})",
        f"(Session: {session_key})",
        f"(--- Op {op['op_index']}: {op['description'][:60]} ---)",
        op["gcode_raw"],
        "",
        "M30",
    ]

    emit("master_gcode", {
        "gcode": "\n".join(lines),
        "count": 1,
    })

# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "db": str(DB_PATH)})


@app.route("/api/session/<session_key>/operations")
def list_operations(session_key):
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "session not found"}), 404
    ops = get_all_operations(row["id"])
    conn.close()
    return jsonify(ops)


@app.route("/api/session/<session_key>/export")
def export_nc(session_key):
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM sessions WHERE session_key = ?", (session_key,)
    ).fetchone()
    if not row:
        conn.close()
        return "session not found", 404
    conn.close()

    op = get_latest_operation(row["id"])
    lines = [
        f"(Rover CNC · {datetime.now().strftime('%Y-%m-%d %H:%M')})",
        f"(Session: {session_key})",
        "",
    ]
    if op:
        lines.append(f"(--- Op {op['op_index']} ---)")
        lines.append(op["gcode_raw"])
        lines.append("")
    lines.append("M30")

    from flask import Response
    return Response(
        "\n".join(lines),
        mimetype="text/plain",
        headers={"Content-Disposition": f"attachment; filename=rover_{session_key}.nc"},
    )

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5050"))
    is_dev = os.getenv("RENDER") is None
    log.info("Starting Rover CNC backend on :%d", port)
    socketio.run(app, host="0.0.0.0", port=port,
                 debug=is_dev, allow_unsafe_werkzeug=is_dev)
