"""
SQLite 数据库：存储论文、笔记、对话、阅读记录
"""

from __future__ import annotations
import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Optional

DB_PATH = Path(__file__).parent.parent / "data" / "paperdiary.db"


def _ensure_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS saved_papers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            paper_rowid INTEGER,
            title TEXT NOT NULL,
            read_at TEXT NOT NULL,
            duration_seconds INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    _ensure_db()


# ========== Saved Papers ==========

def save_paper(paper: dict) -> int:
    """保存/收藏一篇论文，返回 row id"""
    conn = _ensure_db()
    # 检查是否已收藏
    existing = conn.execute(
        "SELECT id FROM saved_papers WHERE title = ?",
        (paper.get("title", ""),)
    ).fetchone()
    if existing:
        # 更新
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
        (paper_id, pmid, doi, title, abstract, authors, journal, pub_date,
         link, source, category, summary_zh, relevance, saved_at, last_read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
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


def get_saved_papers() -> list[dict]:
    """获取所有收藏的论文，按时间倒序"""
    conn = _ensure_db()
    rows = conn.execute("""
        SELECT sp.*,
               (SELECT COUNT(*) FROM paper_notes WHERE paper_rowid = sp.id) as note_count,
               (SELECT COUNT(*) FROM paper_chats WHERE paper_rowid = sp.id) as chat_count
        FROM saved_papers sp
        ORDER BY sp.saved_at DESC
    """).fetchall()
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

def save_note(paper_rowid: int, content: str) -> int:
    conn = _ensure_db()
    now = datetime.now().isoformat()
    # 检查是否已有笔记
    existing = conn.execute(
        "SELECT id FROM paper_notes WHERE paper_rowid = ?", (paper_rowid,)
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE paper_notes SET content = ?, updated_at = ? WHERE id = ?",
            (content, now, existing["id"])
        )
        conn.commit()
        conn.close()
        return existing["id"]

    cursor = conn.execute(
        "INSERT INTO paper_notes (paper_rowid, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (paper_rowid, content, now, now)
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


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


# ========== Reading History ==========

def record_reading(paper_rowid: int | None, title: str):
    conn = _ensure_db()
    conn.execute(
        "INSERT INTO reading_history (paper_rowid, title, read_at) VALUES (?, ?, ?)",
        (paper_rowid, title, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def get_reading_history(limit: int = 20) -> list[dict]:
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT * FROM reading_history ORDER BY read_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
