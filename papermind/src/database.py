"""
SQLite 数据库：存储论文、笔记、对话、阅读记录
所有数据按 user_id 隔离
"""

from __future__ import annotations
import sqlite3
import json
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional

DB_PATH = Path(__file__).parent.parent / "data" / "paperdiary.db"


def _ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS saved_papers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            paper_id TEXT,
            pmid TEXT,
            doi TEXT,
            title TEXT NOT NULL,
            abstract TEXT,
            authors TEXT,
            journal TEXT,
            pub_date TEXT,
            link TEXT,
            source TEXT,
            category TEXT,
            summary_zh TEXT,
            relevance TEXT,
            saved_at TEXT NOT NULL,
            last_read_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reading_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            paper_rowid INTEGER,
            title TEXT NOT NULL,
            read_at TEXT NOT NULL,
            duration_seconds INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_profiles (
            user_id TEXT PRIMARY KEY,
            focus_areas TEXT DEFAULT '',
            exclude_areas TEXT DEFAULT '',
            method_interests TEXT DEFAULT '',
            current_goal TEXT DEFAULT '',
            background TEXT DEFAULT '',
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rate_limits (
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            date TEXT NOT NULL,
            count INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, action, date)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS search_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'all',
            created_at TEXT NOT NULL,
            trace_json TEXT NOT NULL DEFAULT '{}'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS enrichment_cache (
            paper_key TEXT PRIMARY KEY,
            summary_zh TEXT NOT NULL,
            relevance TEXT NOT NULL DEFAULT '',
            key_findings TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'general',
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reading_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL,
            card_type TEXT NOT NULL DEFAULT 'method',
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            quote TEXT DEFAULT '',
            page INTEGER,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL,
            text TEXT NOT NULL,
            page INTEGER,
            section TEXT NOT NULL DEFAULT '',
            anchor_json TEXT NOT NULL DEFAULT '{}',
            question TEXT NOT NULL DEFAULT '',
            answer TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'chat',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS presentation_boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL UNIQUE,
            sections_json TEXT NOT NULL,
            why_reading TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS board_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_rowid INTEGER NOT NULL,
            section TEXT NOT NULL,
            content TEXT NOT NULL,
            quote TEXT NOT NULL DEFAULT '',
            page INTEGER,
            source TEXT NOT NULL DEFAULT 'selection',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_rowid) REFERENCES saved_papers(id)
        )
    """)

    # 迁移：给 board_items 加 image 列（图表截图文件名）
    try:
        conn.execute("ALTER TABLE board_items ADD COLUMN image TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass

    # 迁移：给 saved_papers 加 project_id 列
    try:
        conn.execute("ALTER TABLE saved_papers ADD COLUMN project_id INTEGER REFERENCES projects(id)")
    except sqlite3.OperationalError:
        pass

    # 迁移：给 saved_papers 加 has_pdf 列
    try:
        conn.execute("ALTER TABLE saved_papers ADD COLUMN has_pdf INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    # 迁移：给旧表加 user_id 列（如果不存在）
    for table in ("saved_papers", "reading_history"):
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # 列已存在

    # 迁移：给 user_profiles 加新列
    for col, default in [
        ("method_interests", "''"),
        ("discipline", "''"),
        ("tracking_days", "'90'"),
        ("interests_summary", "''"),
        ("interests_summary_updated_at", "''"),
        ("interests_summary_is_manual", "'0'"),
        ("behavior_events_since_summary", "'0'"),
        # 三层记忆系统
        ("memory_core", "''"),
        ("memory_recent", "''"),
        ("behavior_events_since_recent", "'0'"),
        ("last_recent_updated_at", "''"),
        ("last_core_merged_at", "''"),
        ("core_source", "''"),
    ]:
        try:
            conn.execute(f"ALTER TABLE user_profiles ADD COLUMN {col} TEXT DEFAULT {default}")
        except sqlite3.OperationalError:
            pass  # 列已存在

    # 迁移：把旧 interests_summary 数据迁移到 memory_core（一次性）
    try:
        conn.execute("""
            UPDATE user_profiles
            SET memory_core = interests_summary,
                core_source = CASE WHEN interests_summary_is_manual = '1' THEN 'manual' ELSE 'auto' END,
                last_core_merged_at = interests_summary_updated_at
            WHERE interests_summary != '' AND (memory_core IS NULL OR memory_core = '')
        """)
        conn.commit()
    except Exception:
        pass

    # 迁移：给 paper_notes 加 source 列（如果不存在）
    try:
        conn.execute("ALTER TABLE paper_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    except sqlite3.OperationalError:
        pass  # 列已存在

    # 迁移：给 paper_quotes 加 section 列（如果不存在）
    try:
        conn.execute("ALTER TABLE paper_quotes ADD COLUMN section TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # 列已存在

    # 索引：加速按 user_id 查询
    conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_papers_user ON saved_papers(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reading_history_user ON reading_history(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_paper_notes_paper ON paper_notes(paper_rowid)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_paper_chats_paper ON paper_chats(paper_rowid)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_search_runs_user_created ON search_runs(user_id, created_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_enrichment_cache_key ON enrichment_cache(paper_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_user_feedback_user ON user_feedback(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_papers_project ON saved_papers(project_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reading_cards_paper ON reading_cards(paper_rowid)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_paper_quotes_paper ON paper_quotes(paper_rowid)")

    conn.commit()
    return conn


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db():
    _ensure_db()


# ========== Rate Limiting ==========

def check_rate_limit(user_id: str, action: str, daily_limit: int) -> bool:
    """检查是否超过频率限制。返回 True 表示允许，False 表示超限"""
    conn = _ensure_db()
    today = date.today().isoformat()
    row = conn.execute(
        "SELECT count FROM rate_limits WHERE user_id = ? AND action = ? AND date = ?",
        (user_id, action, today)
    ).fetchone()
    conn.close()
    if not row:
        return True
    return row["count"] < daily_limit


def increment_rate_limit(user_id: str, action: str):
    """增加计数"""
    conn = _ensure_db()
    today = date.today().isoformat()
    conn.execute("""
        INSERT INTO rate_limits (user_id, action, date, count) VALUES (?, ?, ?, 1)
        ON CONFLICT(user_id, action, date) DO UPDATE SET count = count + 1
    """, (user_id, action, today))
    conn.commit()
    conn.close()


def get_rate_limit_remaining(user_id: str, action: str, daily_limit: int) -> int:
    """获取剩余次数"""
    conn = _ensure_db()
    today = date.today().isoformat()
    row = conn.execute(
        "SELECT count FROM rate_limits WHERE user_id = ? AND action = ? AND date = ?",
        (user_id, action, today)
    ).fetchone()
    conn.close()
    used = row["count"] if row else 0
    return max(0, daily_limit - used)


# ========== User Profiles ==========

def get_profile(user_id: str) -> dict:
    """获取用户研究画像"""
    defaults = {
        "focus_areas": "",
        "exclude_areas": "",
        "method_interests": "",
        "current_goal": "",
        "background": "",
        "discipline": "",
        "tracking_days": "90",
        "interests_summary": "",
        "interests_summary_updated_at": "",
        "interests_summary_is_manual": "0",
        "behavior_events_since_summary": "0",
        # 三层记忆
        "memory_core": "",
        "memory_recent": "",
        "behavior_events_since_recent": "0",
        "last_recent_updated_at": "",
        "last_core_merged_at": "",
        "core_source": "",
    }
    conn = _ensure_db()
    row = conn.execute("SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    if row:
        for k in defaults:
            try:
                defaults[k] = row[k] or defaults[k]
            except (IndexError, KeyError):
                pass
    return defaults


def save_profile(user_id: str, profile: dict):
    """保存用户研究画像"""
    conn = _ensure_db()
    conn.execute("""
        INSERT INTO user_profiles (user_id, focus_areas, exclude_areas, method_interests, current_goal, background,
                                   discipline, tracking_days, interests_summary, interests_summary_updated_at,
                                   interests_summary_is_manual, behavior_events_since_summary,
                                   memory_core, memory_recent, behavior_events_since_recent,
                                   last_recent_updated_at, last_core_merged_at, core_source,
                                   updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            focus_areas = excluded.focus_areas,
            exclude_areas = excluded.exclude_areas,
            method_interests = excluded.method_interests,
            current_goal = excluded.current_goal,
            background = excluded.background,
            discipline = excluded.discipline,
            tracking_days = excluded.tracking_days,
            interests_summary = excluded.interests_summary,
            interests_summary_updated_at = excluded.interests_summary_updated_at,
            interests_summary_is_manual = excluded.interests_summary_is_manual,
            behavior_events_since_summary = excluded.behavior_events_since_summary,
            memory_core = excluded.memory_core,
            memory_recent = excluded.memory_recent,
            behavior_events_since_recent = excluded.behavior_events_since_recent,
            last_recent_updated_at = excluded.last_recent_updated_at,
            last_core_merged_at = excluded.last_core_merged_at,
            core_source = excluded.core_source,
            updated_at = excluded.updated_at
    """, (
        user_id,
        profile.get("focus_areas", ""),
        profile.get("exclude_areas", ""),
        profile.get("method_interests", ""),
        profile.get("current_goal", ""),
        profile.get("background", ""),
        profile.get("discipline", ""),
        profile.get("tracking_days", "90"),
        profile.get("interests_summary", ""),
        profile.get("interests_summary_updated_at", ""),
        profile.get("interests_summary_is_manual", "0"),
        profile.get("behavior_events_since_summary", "0"),
        profile.get("memory_core", ""),
        profile.get("memory_recent", ""),
        profile.get("behavior_events_since_recent", "0"),
        profile.get("last_recent_updated_at", ""),
        profile.get("last_core_merged_at", ""),
        profile.get("core_source", ""),
        datetime.now().isoformat(),
    ))
    conn.commit()
    conn.close()


def increment_recent_events(user_id: str) -> int:
    """递增 memory_recent 的行为计数器，返回新值"""
    conn = _ensure_db()
    conn.execute(
        "INSERT INTO user_profiles (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING",
        (user_id, datetime.now().isoformat()),
    )
    conn.execute(
        "UPDATE user_profiles SET behavior_events_since_recent = COALESCE(behavior_events_since_recent, 0) + 1 WHERE user_id = ?",
        (user_id,),
    )
    conn.commit()
    row = conn.execute("SELECT behavior_events_since_recent FROM user_profiles WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    return int(row[0]) if row else 0


def reset_recent_events(user_id: str):
    """recent 更新后归零计数器"""
    conn = _ensure_db()
    conn.execute("UPDATE user_profiles SET behavior_events_since_recent = '0' WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()


def save_search_run(user_id: str, source: str, trace: dict) -> int:
    """保存一次检索轨迹，便于后续排查召回问题。"""
    conn = _ensure_db()
    now = datetime.now().isoformat()
    cursor = conn.execute(
        "INSERT INTO search_runs (user_id, source, created_at, trace_json) VALUES (?, ?, ?, ?)",
        (user_id, source or "all", now, json.dumps(trace, ensure_ascii=False)),
    )
    # 每个用户只保留最近 30 次，避免调试日志无限增长。
    conn.execute(
        """
        DELETE FROM search_runs
        WHERE user_id = ?
          AND id NOT IN (
              SELECT id FROM search_runs
              WHERE user_id = ?
              ORDER BY created_at DESC, id DESC
              LIMIT 30
          )
        """,
        (user_id, user_id),
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_latest_search_run(user_id: str = "") -> Optional[dict]:
    """获取最近一次检索轨迹。"""
    conn = _ensure_db()
    row = conn.execute(
        """
        SELECT id, source, created_at, trace_json
        FROM search_runs
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    conn.close()
    if not row:
        return None

    try:
        trace = json.loads(row["trace_json"] or "{}")
    except json.JSONDecodeError:
        trace = {}
    trace["run_id"] = row["id"]
    trace["created_at"] = trace.get("created_at") or row["created_at"]
    trace["source_requested"] = trace.get("source_requested") or row["source"]
    return trace


# ========== Saved Papers ==========

def save_paper(paper: dict, user_id: str = "") -> int:
    """保存/收藏一篇论文，返回 row id"""
    conn = _ensure_db()
    existing = conn.execute(
        "SELECT id FROM saved_papers WHERE title = ? AND user_id = ?",
        (paper.get("title", ""), user_id)
    ).fetchone()
    if existing:
        conn.execute("""
            UPDATE saved_papers SET
                summary_zh = COALESCE(?, summary_zh),
                relevance = COALESCE(?, relevance),
                last_read_at = ?
            WHERE id = ?
        """, (paper.get("summary_zh"), paper.get("relevance"),
              datetime.now().isoformat(), existing["id"]))
        conn.commit()
        conn.close()
        return existing["id"]

    cursor = conn.execute("""
        INSERT INTO saved_papers
        (user_id, paper_id, pmid, doi, title, abstract, authors, journal, pub_date,
         link, source, category, summary_zh, relevance, saved_at, last_read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        user_id,
        paper.get("paper_id", ""),
        paper.get("pmid", ""),
        paper.get("doi", ""),
        paper.get("title", ""),
        paper.get("abstract", ""),
        paper.get("authors", ""),
        paper.get("journal", ""),
        paper.get("pub_date", ""),
        paper.get("link", ""),
        paper.get("source", ""),
        paper.get("category", ""),
        paper.get("summary_zh", ""),
        paper.get("relevance", ""),
        datetime.now().isoformat(),
        datetime.now().isoformat(),
    ))
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_saved_papers(user_id: str = "") -> list[dict]:
    """获取用户收藏的论文"""
    conn = _ensure_db()
    rows = conn.execute("""
        SELECT sp.*,
               (SELECT COUNT(*) FROM paper_notes WHERE paper_rowid = sp.id) as note_count,
               (SELECT COUNT(*) FROM paper_chats WHERE paper_rowid = sp.id) as chat_count
        FROM saved_papers sp
        WHERE sp.user_id = ?
        ORDER BY sp.saved_at DESC
    """, (user_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_saved_paper(paper_id: int) -> Optional[dict]:
    conn = _ensure_db()
    row = conn.execute("SELECT * FROM saved_papers WHERE id = ?", (paper_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_saved_paper(paper_id: int):
    conn = _ensure_db()
    conn.execute("DELETE FROM paper_notes WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM paper_chats WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM reading_cards WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM paper_quotes WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM board_items WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM presentation_boards WHERE paper_rowid = ?", (paper_id,))
    conn.execute("DELETE FROM saved_papers WHERE id = ?", (paper_id,))
    conn.commit()
    conn.close()


def update_paper_enrichment(paper_id: int, summary_zh: str, relevance: str, category: str = ""):
    """更新收藏论文的 AI 解读字段"""
    conn = _ensure_db()
    conn.execute(
        """UPDATE saved_papers SET
               summary_zh = COALESCE(NULLIF(?, ''), summary_zh),
               relevance  = COALESCE(NULLIF(?, ''), relevance),
               category   = COALESCE(NULLIF(?, ''), category)
           WHERE id = ?""",
        (summary_zh, relevance, category, paper_id),
    )
    conn.commit()
    conn.close()


# ========== Notes ==========

def save_note(paper_rowid: int, content: str, source: str = "manual", note_id: int = None) -> int:
    conn = _ensure_db()
    now = datetime.now().isoformat()

    # 更新已有笔记（按 id）
    if note_id:
        conn.execute(
            "UPDATE paper_notes SET content = ?, updated_at = ? WHERE id = ?",
            (content, now, note_id)
        )
        conn.commit()
        conn.close()
        return note_id

    # 每次新增一条（无论 source）
    cursor = conn.execute(
        "INSERT INTO paper_notes (paper_rowid, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (paper_rowid, content, source, now, now)
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_note_owner(note_id: int) -> str:
    """返回笔记所属论文的 user_id，用于归属校验"""
    conn = _ensure_db()
    row = conn.execute(
        "SELECT sp.user_id FROM paper_notes pn JOIN saved_papers sp ON pn.paper_rowid = sp.id WHERE pn.id = ?",
        (note_id,)
    ).fetchone()
    conn.close()
    return row["user_id"] if row else ""


def delete_note(note_id: int) -> bool:
    conn = _ensure_db()
    conn.execute("DELETE FROM paper_notes WHERE id = ?", (note_id,))
    conn.commit()
    conn.close()
    return True


def get_notes(paper_rowid: int) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM paper_notes WHERE paper_rowid = ? ORDER BY created_at DESC",
        (paper_rowid,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ========== Reading Cards ==========

CARD_TYPES = ("method", "finding", "critique", "transfer")


def save_card(paper_rowid: int, card_type: str, title: str, content: str,
              quote: str = "", page: int = None, source: str = "manual") -> int:
    conn = _ensure_db()
    now = datetime.now().isoformat()
    if card_type not in CARD_TYPES:
        card_type = "method"
    cursor = conn.execute(
        """INSERT INTO reading_cards (paper_rowid, card_type, title, content, quote, page, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (paper_rowid, card_type, title, content, quote, page, source, now, now)
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_cards(paper_rowid: int) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM reading_cards WHERE paper_rowid = ? ORDER BY created_at ASC",
        (paper_rowid,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_card(card_id: int, card_type: str = None, title: str = None,
                content: str = None) -> bool:
    conn = _ensure_db()
    updates, params = [], []
    if card_type is not None and card_type in CARD_TYPES:
        updates.append("card_type = ?")
        params.append(card_type)
    if title is not None:
        updates.append("title = ?")
        params.append(title)
    if content is not None:
        updates.append("content = ?")
        params.append(content)
    if not updates:
        conn.close()
        return False
    updates.append("updated_at = ?")
    params.append(datetime.now().isoformat())
    params.append(card_id)
    conn.execute(f"UPDATE reading_cards SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return True


def delete_card(card_id: int):
    conn = _ensure_db()
    conn.execute("DELETE FROM reading_cards WHERE id = ?", (card_id,))
    conn.commit()
    conn.close()


def get_card_owner(card_id: int) -> str:
    """返回卡片所属论文的 user_id，用于归属校验"""
    conn = _ensure_db()
    row = conn.execute(
        "SELECT sp.user_id FROM reading_cards rc JOIN saved_papers sp ON rc.paper_rowid = sp.id WHERE rc.id = ?",
        (card_id,)
    ).fetchone()
    conn.close()
    return row["user_id"] if row else ""


# ========== Paper Quotes ==========

def _quote_row_to_dict(row) -> dict:
    data = dict(row)
    raw_anchor = data.pop("anchor_json", "{}") or "{}"
    try:
        data["anchor"] = json.loads(raw_anchor)
    except Exception:
        data["anchor"] = {}
    return data


def save_quote(paper_rowid: int, text: str, page: int = None, section: str = "", anchor: dict = None,
               question: str = "", answer: str = "", source: str = "chat") -> dict:
    conn = _ensure_db()
    now = datetime.now().isoformat()
    anchor_json = json.dumps(anchor or {}, ensure_ascii=False)
    cursor = conn.execute(
        """INSERT INTO paper_quotes
              (paper_rowid, text, page, section, anchor_json, question, answer, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (paper_rowid, text, page, section or "", anchor_json, question, answer, source, now, now)
    )
    row_id = cursor.lastrowid
    row = conn.execute("SELECT * FROM paper_quotes WHERE id = ?", (row_id,)).fetchone()
    conn.commit()
    conn.close()
    return _quote_row_to_dict(row)


def get_quotes(paper_rowid: int) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM paper_quotes WHERE paper_rowid = ? ORDER BY created_at ASC",
        (paper_rowid,)
    ).fetchall()
    conn.close()
    return [_quote_row_to_dict(r) for r in rows]


def get_quote_owner(quote_id: int) -> str:
    conn = _ensure_db()
    row = conn.execute(
        "SELECT sp.user_id FROM paper_quotes pq JOIN saved_papers sp ON pq.paper_rowid = sp.id WHERE pq.id = ?",
        (quote_id,)
    ).fetchone()
    conn.close()
    return row["user_id"] if row else ""


def delete_quote(quote_id: int) -> bool:
    conn = _ensure_db()
    conn.execute("DELETE FROM paper_quotes WHERE id = ?", (quote_id,))
    conn.commit()
    conn.close()
    return True


# ========== Presentation Board（组会汇报板）==========

# 板块用稳定英文 key 存储，中文名只是展示层默认值（用户可改名）
DEFAULT_BOARD_SECTIONS = [
    {"key": "background", "title": "研究背景"},
    {"key": "question", "title": "研究问题"},
    {"key": "methods", "title": "方法"},
    {"key": "results", "title": "关键结果"},
    {"key": "critique", "title": "批判与局限"},
    {"key": "implications", "title": "对我的启发"},
    {"key": "discussion", "title": "讨论问题"},
]

BOARD_ITEM_SOURCES = ("selection", "deep_read", "card", "chat", "manual", "figure")


def get_or_create_board(paper_rowid: int, why_reading: str = "") -> dict:
    """惰性建板：收藏过的论文第一次访问汇报板时自动创建默认结构"""
    conn = _ensure_db()
    row = conn.execute(
        "SELECT * FROM presentation_boards WHERE paper_rowid = ?", (paper_rowid,)
    ).fetchone()
    if not row:
        now = datetime.now().isoformat()
        conn.execute(
            """INSERT INTO presentation_boards (paper_rowid, sections_json, why_reading, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (paper_rowid, json.dumps(DEFAULT_BOARD_SECTIONS, ensure_ascii=False), why_reading or "", now, now)
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM presentation_boards WHERE paper_rowid = ?", (paper_rowid,)
        ).fetchone()
    conn.close()
    d = dict(row)
    try:
        d["sections"] = json.loads(d.pop("sections_json"))
    except (json.JSONDecodeError, TypeError):
        d["sections"] = list(DEFAULT_BOARD_SECTIONS)
    return d


def update_board(paper_rowid: int, sections: list = None, why_reading: str = None):
    conn = _ensure_db()
    now = datetime.now().isoformat()
    if sections is not None:
        conn.execute(
            "UPDATE presentation_boards SET sections_json = ?, updated_at = ? WHERE paper_rowid = ?",
            (json.dumps(sections, ensure_ascii=False), now, paper_rowid)
        )
    if why_reading is not None:
        conn.execute(
            "UPDATE presentation_boards SET why_reading = ?, updated_at = ? WHERE paper_rowid = ?",
            (why_reading, now, paper_rowid)
        )
    conn.commit()
    conn.close()


def add_board_item(paper_rowid: int, section: str, content: str, quote: str = "",
                   page: int = None, source: str = "selection", image: str = "") -> dict:
    if source not in BOARD_ITEM_SOURCES:
        source = "manual"
    conn = _ensure_db()
    now = datetime.now().isoformat()
    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), 0) FROM board_items WHERE paper_rowid = ? AND section = ?",
        (paper_rowid, section)
    ).fetchone()[0]
    cursor = conn.execute(
        """INSERT INTO board_items (paper_rowid, section, content, quote, page, source, sort_order, image, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (paper_rowid, section, content, quote or "", page, source, max_order + 1, image or "", now, now)
    )
    row = conn.execute("SELECT * FROM board_items WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    return dict(row)


def get_board_item(item_id: int) -> Optional[dict]:
    conn = _ensure_db()
    row = conn.execute("SELECT * FROM board_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_board_items(paper_rowid: int) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM board_items WHERE paper_rowid = ? ORDER BY section, sort_order, created_at",
        (paper_rowid,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_board_item(item_id: int, content: str = None, section: str = None, sort_order: int = None):
    conn = _ensure_db()
    now = datetime.now().isoformat()
    if content is not None:
        conn.execute("UPDATE board_items SET content = ?, updated_at = ? WHERE id = ?", (content, now, item_id))
    if section is not None:
        conn.execute("UPDATE board_items SET section = ?, updated_at = ? WHERE id = ?", (section, now, item_id))
    if sort_order is not None:
        conn.execute("UPDATE board_items SET sort_order = ?, updated_at = ? WHERE id = ?", (sort_order, now, item_id))
    conn.commit()
    conn.close()


def get_board_item_owner(item_id: int) -> str:
    conn = _ensure_db()
    row = conn.execute(
        "SELECT sp.user_id FROM board_items bi JOIN saved_papers sp ON bi.paper_rowid = sp.id WHERE bi.id = ?",
        (item_id,)
    ).fetchone()
    conn.close()
    return row["user_id"] if row else ""


def delete_board_item(item_id: int):
    conn = _ensure_db()
    conn.execute("DELETE FROM board_items WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()


# ========== Chat History ==========

def save_chat_message(paper_rowid: int, role: str, content: str):
    conn = _ensure_db()
    conn.execute(
        "INSERT INTO paper_chats (paper_rowid, role, content, created_at) VALUES (?, ?, ?, ?)",
        (paper_rowid, role, content, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def get_chat_history(paper_rowid: int) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT role, content, created_at FROM paper_chats WHERE paper_rowid = ? ORDER BY created_at ASC",
        (paper_rowid,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_recent_chats(user_id: str, limit: int = 30) -> list[dict]:
    """获取用户所有论文的最近对话（用于兴趣摘要生成）"""
    conn = _ensure_db()
    rows = conn.execute(
        """SELECT pc.role, pc.content, pc.created_at
           FROM paper_chats pc
           JOIN saved_papers sp ON pc.paper_rowid = sp.id
           WHERE sp.user_id = ?
           ORDER BY pc.created_at DESC
           LIMIT ?""",
        (user_id, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_recent_chats_since(user_id: str, days: int = 14, limit: int = 40) -> list[dict]:
    """获取近 N 天跨论文对话，按时间倒序。"""
    conn = _ensure_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        """SELECT pc.role, pc.content, pc.created_at
           FROM paper_chats pc
           JOIN saved_papers sp ON pc.paper_rowid = sp.id
           WHERE sp.user_id = ? AND pc.created_at >= ?
           ORDER BY pc.created_at DESC
           LIMIT ?""",
        (user_id, since, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ========== Reading History ==========

def record_reading(paper_rowid: int | None, title: str, user_id: str = ""):
    conn = _ensure_db()
    conn.execute(
        "INSERT INTO reading_history (user_id, paper_rowid, title, read_at) VALUES (?, ?, ?, ?)",
        (user_id, paper_rowid, title, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def get_reading_history(user_id: str = "", limit: int = 20) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM reading_history WHERE user_id = ? ORDER BY read_at DESC LIMIT ?",
        (user_id, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_reading_history_since(user_id: str = "", days: int = 14, limit: int = 20) -> list[dict]:
    conn = _ensure_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        "SELECT * FROM reading_history WHERE user_id = ? AND read_at >= ? ORDER BY read_at DESC LIMIT ?",
        (user_id, since, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ========== 收藏关键词提取（用于优化推荐） ==========

def get_saved_titles(user_id: str, limit: int = 30) -> list[str]:
    """获取用户收藏论文的标题，用于优化推荐"""
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT title FROM saved_papers WHERE user_id = ? ORDER BY saved_at DESC LIMIT ?",
        (user_id, limit)
    ).fetchall()
    conn.close()
    return [r["title"] for r in rows]


def get_saved_titles_since(user_id: str, days: int = 14, limit: int = 40) -> list[str]:
    """获取近 N 天收藏论文标题，用于近期变化观察。"""
    conn = _ensure_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        "SELECT title FROM saved_papers WHERE user_id = ? AND saved_at >= ? ORDER BY saved_at DESC LIMIT ?",
        (user_id, since, limit)
    ).fetchall()
    conn.close()
    return [r["title"] for r in rows]


def get_saved_categories(user_id: str) -> dict:
    """获取用户收藏论文的分类分布，用于兴趣摘要"""
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT category, COUNT(*) as cnt FROM saved_papers WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY cnt DESC",
        (user_id,)
    ).fetchall()
    conn.close()
    return {r["category"]: r["cnt"] for r in rows}


# ========== User Feedback ==========

def save_feedback(user_id: str, feedback_type: str, content: str) -> int:
    conn = _ensure_db()
    cursor = conn.execute(
        "INSERT INTO user_feedback (user_id, type, content, created_at) VALUES (?, ?, ?, ?)",
        (user_id, feedback_type, content, datetime.now().isoformat())
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_user_stats(user_id: str) -> dict:
    """返回用户收藏论文数、笔记数、AI 对话次数（用于设置页展示）"""
    conn = _ensure_db()
    paper_count = conn.execute(
        "SELECT COUNT(*) as cnt FROM saved_papers WHERE user_id = ?", (user_id,)
    ).fetchone()["cnt"]
    note_count = conn.execute(
        """SELECT COUNT(*) as cnt FROM paper_notes pn
           JOIN saved_papers sp ON pn.paper_rowid = sp.id
           WHERE sp.user_id = ?""", (user_id,)
    ).fetchone()["cnt"]
    chat_count = conn.execute(
        """SELECT COUNT(*) as cnt FROM paper_chats pc
           JOIN saved_papers sp ON pc.paper_rowid = sp.id
           WHERE sp.user_id = ? AND pc.role = 'user'""", (user_id,)
    ).fetchone()["cnt"]
    conn.close()
    return {"papers": paper_count, "notes": note_count, "chats": chat_count}


# ========== Projects ==========

def create_project(user_id: str, name: str, description: str = "") -> int:
    conn = _ensure_db()
    cursor = conn.execute(
        "INSERT INTO projects (user_id, name, description, created_at) VALUES (?, ?, ?, ?)",
        (user_id, name, description, datetime.now().isoformat())
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_projects(user_id: str) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute("""
        SELECT p.*,
               (SELECT COUNT(*) FROM saved_papers sp WHERE sp.project_id = p.id AND sp.user_id = ?) as paper_count
        FROM projects p
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC
    """, (user_id, user_id)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_project(project_id: int, name: str = None, description: str = None) -> bool:
    conn = _ensure_db()
    updates = []
    params = []
    if name is not None:
        updates.append("name = ?")
        params.append(name)
    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if not updates:
        conn.close()
        return False
    params.append(project_id)
    conn.execute(f"UPDATE projects SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return True


def delete_project(project_id: int):
    conn = _ensure_db()
    conn.execute("UPDATE saved_papers SET project_id = NULL WHERE project_id = ?", (project_id,))
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()
    conn.close()


def set_paper_project(paper_id: int, project_id: Optional[int]):
    conn = _ensure_db()
    conn.execute("UPDATE saved_papers SET project_id = ? WHERE id = ?", (project_id, paper_id))
    conn.commit()
    conn.close()


def set_paper_has_pdf(paper_id: int, has_pdf: bool):
    conn = _ensure_db()
    conn.execute("UPDATE saved_papers SET has_pdf = ? WHERE id = ?", (1 if has_pdf else 0, paper_id))
    conn.commit()
    conn.close()


def get_paper_owner(paper_id: int) -> Optional[str]:
    """返回论文所属的 user_id，用于权限校验"""
    conn = _ensure_db()
    row = conn.execute("SELECT user_id FROM saved_papers WHERE id = ?", (paper_id,)).fetchone()
    conn.close()
    return row["user_id"] if row else None


# ========== Enrichment Cache ==========

def _paper_cache_key(paper: dict) -> str:
    """生成论文唯一缓存键：优先 PMID，其次 DOI"""
    pmid = (paper.get("pmid") or "").strip()
    doi = (paper.get("doi") or "").strip()
    if pmid:
        return f"pmid:{pmid}"
    if doi:
        return f"doi:{doi}"
    return ""


def get_enrichment_cache(paper: dict) -> Optional[dict]:
    """查找论文的 enrichment 缓存，命中返回 dict，否则 None"""
    key = _paper_cache_key(paper)
    if not key:
        return None
    conn = _ensure_db()
    row = conn.execute(
        "SELECT summary_zh, relevance, key_findings FROM enrichment_cache WHERE paper_key = ?",
        (key,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    try:
        findings = json.loads(row["key_findings"])
    except (json.JSONDecodeError, TypeError):
        findings = []
    return {
        "summary_zh": row["summary_zh"],
        "relevance": row["relevance"],
        "key_findings": findings,
    }


def save_enrichment_cache(paper: dict, summary_zh: str, relevance: str, key_findings: list):
    """保存论文 enrichment 结果到缓存"""
    key = _paper_cache_key(paper)
    if not key or not summary_zh:
        return
    conn = _ensure_db()
    conn.execute("""
        INSERT INTO enrichment_cache (paper_key, summary_zh, relevance, key_findings, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(paper_key) DO UPDATE SET
            summary_zh = excluded.summary_zh,
            relevance = excluded.relevance,
            key_findings = excluded.key_findings,
            created_at = excluded.created_at
    """, (key, summary_zh, relevance, json.dumps(key_findings, ensure_ascii=False),
          datetime.now().isoformat()))
    conn.commit()
    conn.close()
