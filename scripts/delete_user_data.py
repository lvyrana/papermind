#!/usr/bin/env python3
"""Preview or delete all PaperMind data owned by one anonymous device ID."""

from __future__ import annotations

import argparse
import re
import sqlite3
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "papermind" / "data" / "paperdiary.db"
DEFAULT_PDF_DIR = REPO_ROOT / "papermind" / "data" / "pdfs"
DEFAULT_FIGURE_DIR = REPO_ROOT / "papermind" / "data" / "figures"
DEFAULT_BACKUP_DIR = REPO_ROOT / "backups"
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

PAPER_CHILD_TABLES = (
    "self_test_sessions",
    "board_items",
    "presentation_boards",
    "paper_quotes",
    "reading_cards",
    "paper_notes",
    "paper_chats",
)
USER_TABLES = (
    "method_gaps",
    "reading_history",
    "search_runs",
    "user_feedback",
    "rate_limits",
    "user_profiles",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="按匿名设备 ID 预览或删除 PaperMind 数据。默认只预览。"
    )
    parser.add_argument("--user-id", required=True, help="设置页专属链接中的完整 UUID")
    parser.add_argument("--confirm", action="store_true", help="执行删除；不加时只预览")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="数据库路径")
    parser.add_argument("--pdf-dir", type=Path, default=DEFAULT_PDF_DIR, help="PDF 目录")
    parser.add_argument("--figure-dir", type=Path, default=DEFAULT_FIGURE_DIR, help="图表截图目录")
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR, help="删除前备份目录")
    return parser.parse_args()


def placeholders(values: list[int]) -> str:
    return ",".join("?" for _ in values)


def count_for_papers(conn: sqlite3.Connection, table: str, paper_ids: list[int]) -> int:
    if not paper_ids:
        return 0
    sql = f"SELECT COUNT(*) FROM {table} WHERE paper_rowid IN ({placeholders(paper_ids)})"
    return int(conn.execute(sql, paper_ids).fetchone()[0])


def collect_summary(conn: sqlite3.Connection, user_id: str) -> dict:
    paper_ids = [
        int(row[0])
        for row in conn.execute("SELECT id FROM saved_papers WHERE user_id = ?", (user_id,))
    ]
    counts = {table: count_for_papers(conn, table, paper_ids) for table in PAPER_CHILD_TABLES}
    counts["saved_papers"] = len(paper_ids)
    counts["projects"] = int(
        conn.execute("SELECT COUNT(*) FROM projects WHERE user_id = ?", (user_id,)).fetchone()[0]
    )
    for table in USER_TABLES:
        counts[table] = int(
            conn.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id = ?", (user_id,)).fetchone()[0]
        )

    figure_names: list[str] = []
    if paper_ids:
        sql = (
            f"SELECT image FROM board_items WHERE paper_rowid IN ({placeholders(paper_ids)}) "
            "AND image != ''"
        )
        figure_names = [str(row[0]) for row in conn.execute(sql, paper_ids)]

    return {"paper_ids": paper_ids, "figure_names": figure_names, "counts": counts}


def print_summary(summary: dict, pdf_dir: Path, figure_dir: Path) -> None:
    print("将处理的数据：")
    for table, count in summary["counts"].items():
        if count:
            print(f"  {table}: {count}")

    pdf_files = [pdf_dir / f"{paper_id}.pdf" for paper_id in summary["paper_ids"]]
    existing_pdfs = [path for path in pdf_files if path.is_file()]
    existing_figures = [
        figure_dir / name
        for name in summary["figure_names"]
        if Path(name).name == name and (figure_dir / name).is_file()
    ]
    print(f"  PDF 文件: {len(existing_pdfs)}")
    print(f"  图表截图: {len(existing_figures)}")


def create_backup(conn: sqlite3.Connection, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = backup_dir / f"pre-delete-{timestamp}.db"
    backup_conn = sqlite3.connect(str(backup_path))
    try:
        conn.backup(backup_conn)
    finally:
        backup_conn.close()
    return backup_path


def delete_database_rows(conn: sqlite3.Connection, user_id: str, paper_ids: list[int]) -> None:
    with conn:
        if paper_ids:
            params = placeholders(paper_ids)
            for table in PAPER_CHILD_TABLES:
                conn.execute(f"DELETE FROM {table} WHERE paper_rowid IN ({params})", paper_ids)
            conn.execute(f"DELETE FROM saved_papers WHERE id IN ({params})", paper_ids)

        for table in USER_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM projects WHERE user_id = ?", (user_id,))


def delete_owned_files(summary: dict, pdf_dir: Path, figure_dir: Path) -> list[Path]:
    failed: list[Path] = []
    paths = [pdf_dir / f"{paper_id}.pdf" for paper_id in summary["paper_ids"]]
    paths.extend(
        figure_dir / name
        for name in summary["figure_names"]
        if Path(name).name == name
    )
    for path in paths:
        if not path.is_file():
            continue
        try:
            path.unlink()
        except OSError:
            failed.append(path)
    return failed


def main() -> int:
    args = parse_args()
    user_id = args.user_id.strip()
    if not UUID_PATTERN.fullmatch(user_id):
        print("拒绝执行：user ID 必须是完整 UUID，且不能使用 anonymous。")
        return 2
    if not args.db.is_file():
        print(f"数据库不存在：{args.db}")
        return 2

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        summary = collect_summary(conn, user_id)
        print_summary(summary, args.pdf_dir, args.figure_dir)
        if not any(summary["counts"].values()):
            print("没有找到该设备 ID 对应的数据。")
            return 0
        if not args.confirm:
            print("\n当前为预览模式，没有删除任何内容。确认无误后追加 --confirm。")
            return 0

        backup_path = create_backup(conn, args.backup_dir)
        print(f"删除前数据库备份：{backup_path}")
        delete_database_rows(conn, user_id, summary["paper_ids"])
        failed = delete_owned_files(summary, args.pdf_dir, args.figure_dir)
        print("该设备 ID 对应的数据库记录已删除。")
        if failed:
            print("以下文件删除失败，请人工检查：")
            for path in failed:
                print(f"  {path}")
            return 1
        print("关联的 PDF 和图表截图已删除。")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
