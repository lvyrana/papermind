"""
SQLite 数据库：存储论文、笔记、对话、阅读记录
所有数据按 user_id 隔离
"""

from __future__ import annotations
import sqlite3
import json
from pathlib import Path
from datetime import datetime, date
from typing import Optional

DB_PATH = Path(__file__).parent.parent / "data" / "paperdiary.db"


def _ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
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
        ("tracking_days", "'30'"),
        ("interests_summary", "''"),
        ("interests_summary_updated_at", "''"),
        ("interests_summary_is_manual", "'0'"),
    ]:
        try:
            conn.execute(f"ALTER TABLE user_profiles ADD COLUMN {col} TEXT DEFAULT {default}")
        except sqlite3.OperationalError:
            pass  # 列已存在

    # 迁移：给 paper_notes 加 source 列（如果不存在）
    try:
        conn.execute("ALTER TABLE paper_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    except sqlite3.OperationalError:
        pass  # 列已存在

    # 索引：加速按 user_id 查询
    conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_papers_user ON saved_papers(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reading_history_user ON reading_history(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_paper_notes_paper ON paper_notes(paper_rowid)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_paper_chats_paper ON paper_chats(paper_rowid)")

    conn.commit()
    return conn


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
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
        "tracking_days": "30",
        "interests_summary": "",
        "interests_summary_updated_at": "",
        "interests_summary_is_manual": "0",
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
                                   interests_summary_is_manual, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            updated_at = excluded.updated_at
    """, (
        user_id,
        profile.get("focus_areas", ""),
        profile.get("exclude_areas", ""),
        profile.get("method_interests", ""),
        profile.get("current_goal", ""),
        profile.get("background", ""),
        profile.get("discipline", ""),
        profile.get("tracking_days", "30"),
        profile.get("interests_summary", ""),
        profile.get("interests_summary_updated_at", ""),
        profile.get("interests_summary_is_manual", "0"),
        datetime.now().isoformat(),
    ))
    conn.commit()
    conn.close()


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
    conn.execute("DELETE FROM saved_papers WHERE id = ?", (paper_id,))
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


def get_saved_categories(user_id: str) -> dict:
    """获取用户收藏论文的分类分布，用于兴趣摘要"""
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT category, COUNT(*) as cnt FROM saved_papers WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY cnt DESC",
        (user_id,)
    ).fetchall()
    conn.close()
    return {r["category"]: r["cnt"] for r in rows}
