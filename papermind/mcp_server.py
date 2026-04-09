"""
PaperMind MCP Server
让外部 AI（如 Open Claw）按需查询 PaperMind 中的研究上下文。

提供 3 个工具：
- get_research_profile: 获取研究者画像
- search_readings: 按关键词搜索阅读/收藏的论文
- get_paper_detail: 获取某篇论文的笔记和 AI 对话记录

所有工具都按 user_id 隔离数据，不会跨用户读取。

启动: python mcp_server.py
"""

import sqlite3
import json
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

DB_PATH = Path(__file__).parent / "data" / "paperdiary.db"

mcp = FastMCP(
    "papermind",
    host="0.0.0.0",
    port=18794,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[
            "localhost:*", "127.0.0.1:*", "[::1]:*",
            "host.docker.internal:*",
        ],
        allowed_origins=[
            "http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*",
            "http://host.docker.internal:*",
        ],
    ),
)


def _get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


@mcp.tool()
def get_research_profile(user_id: str = "") -> str:
    """获取研究者画像，包括研究方向、排除领域、当前目标和研究经历。

    Args:
        user_id: 用户 ID。如果不指定，返回最近更新画像的用户。
    """
    conn = _get_db()
    try:
        if user_id:
            row = conn.execute(
                "SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)
            ).fetchone()
        else:
            # 按 updated_at 降序取最近活跃的用户（而非 rowid）
            row = conn.execute(
                "SELECT * FROM user_profiles ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()

        if not row:
            return json.dumps({"error": "未找到研究者画像"}, ensure_ascii=False)

        profile = {
            "user_id": row["user_id"],
            "focus_areas": row["focus_areas"] or "",
            "exclude_areas": row["exclude_areas"] or "",
            "current_goal": row["current_goal"] or "",
            "background": row["background"] or "",
        }
        return json.dumps(profile, ensure_ascii=False, indent=2)
    finally:
        conn.close()


@mcp.tool()
def search_readings(query: str, user_id: str = "", limit: int = 10) -> str:
    """按关键词搜索用户阅读过或收藏过的论文。
    搜索范围包括论文标题、摘要、分类标签。
    返回匹配的论文列表，包含标题、摘要、分类、日期和笔记数。

    Args:
        query: 搜索关键词（中英文均可，多个词用空格分隔）
        user_id: 用户 ID。如果不指定，使用最近活跃用户。
        limit: 最多返回多少篇（默认 10）
    """
    conn = _get_db()
    try:
        # 如果未指定 user_id，取最近活跃用户
        if not user_id:
            profile_row = conn.execute(
                "SELECT user_id FROM user_profiles ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
            if profile_row:
                user_id = profile_row["user_id"]

        keywords = [k.strip() for k in query.split() if k.strip()]
        if not keywords:
            return json.dumps({"error": "请提供搜索关键词"}, ensure_ascii=False)

        # 构建模糊搜索条件
        conditions = ["sp.user_id = ?"]
        params = [user_id]
        for kw in keywords:
            conditions.append(
                "(sp.title LIKE ? OR sp.abstract LIKE ? OR sp.category LIKE ? OR sp.summary_zh LIKE ?)"
            )
            pattern = f"%{kw}%"
            params.extend([pattern, pattern, pattern, pattern])

        where_clause = " AND ".join(conditions)

        rows = conn.execute(f"""
            SELECT sp.id as paper_id, sp.title, sp.abstract, sp.category, sp.pub_date,
                   sp.summary_zh, sp.relevance, sp.source, sp.saved_at,
                   (SELECT COUNT(*) FROM paper_notes pn WHERE pn.paper_rowid = sp.id) as note_count,
                   (SELECT COUNT(*) FROM paper_chats pc WHERE pc.paper_rowid = sp.id) as chat_count
            FROM saved_papers sp
            WHERE {where_clause}
            ORDER BY sp.saved_at DESC
            LIMIT ?
        """, params + [limit]).fetchall()

        # 也搜索阅读历史（按 user_id 过滤）
        reading_conditions = ["rh.user_id = ?"]
        reading_params = [user_id]
        for kw in keywords:
            reading_conditions.append("rh.title LIKE ?")
            reading_params.append(f"%{kw}%")

        reading_rows = conn.execute(f"""
            SELECT rh.title, rh.read_at FROM reading_history rh
            WHERE {" AND ".join(reading_conditions)}
            ORDER BY rh.read_at DESC
            LIMIT ?
        """, reading_params + [limit]).fetchall()

        results = []
        for r in rows:
            paper = {
                "paper_id": r["paper_id"],
                "title": r["title"],
                "category": r["category"] or "",
                "pub_date": r["pub_date"] or "",
                "summary_zh": r["summary_zh"] or "",
                "relevance": r["relevance"] or "",
                "note_count": r["note_count"],
                "chat_count": r["chat_count"],
                "saved_at": r["saved_at"] or "",
                "source": "收藏",
            }
            # 只在需要时包含摘要（太长了）
            if r["abstract"]:
                paper["abstract_preview"] = r["abstract"][:300]
            results.append(paper)

        # 补充阅读历史中未被收藏但匹配的
        saved_titles = {r["title"].lower() for r in rows}
        for r in reading_rows:
            if r["title"].lower() not in saved_titles:
                results.append({
                    "title": r["title"],
                    "read_at": r["read_at"],
                    "source": "阅读历史（未收藏）",
                })

        if not results:
            return json.dumps(
                {"message": f"未找到与 '{query}' 相关的论文记录"},
                ensure_ascii=False
            )

        return json.dumps(results, ensure_ascii=False, indent=2)
    finally:
        conn.close()


@mcp.tool()
def get_paper_detail(paper_id: int, user_id: str = "") -> str:
    """获取某篇收藏论文的完整详情，包括笔记内容和 AI 对话记录。

    Args:
        paper_id: 论文 ID（从 search_readings 结果中获取）
        user_id: 用户 ID。必须与论文归属一致，防止跨用户读取。
                 如果不指定，使用最近活跃用户。
    """
    conn = _get_db()
    try:
        # 如果未指定 user_id，取最近活跃用户
        if not user_id:
            profile_row = conn.execute(
                "SELECT user_id FROM user_profiles ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
            if profile_row:
                user_id = profile_row["user_id"]

        # 校验论文归属
        paper = conn.execute(
            "SELECT * FROM saved_papers WHERE id = ? AND user_id = ?",
            (paper_id, user_id)
        ).fetchone()

        if not paper:
            return json.dumps(
                {"error": f"未找到 paper_id={paper_id} 的论文（或无权访问）"},
                ensure_ascii=False,
            )

        # 获取笔记
        notes = conn.execute(
            "SELECT content, created_at FROM paper_notes WHERE paper_rowid = ? ORDER BY created_at DESC",
            (paper_id,)
        ).fetchall()

        # 获取对话历史
        chats = conn.execute(
            "SELECT role, content, created_at FROM paper_chats WHERE paper_rowid = ? ORDER BY created_at ASC",
            (paper_id,)
        ).fetchall()

        result = {
            "title": paper["title"],
            "authors": paper["authors"] or "",
            "journal": paper["journal"] or "",
            "pub_date": paper["pub_date"] or "",
            "abstract": paper["abstract"] or "",
            "category": paper["category"] or "",
            "summary_zh": paper["summary_zh"] or "",
            "relevance": paper["relevance"] or "",
            "link": paper["link"] or "",
            "notes": [
                {"content": n["content"], "created_at": n["created_at"]}
                for n in notes
            ],
            "conversations": [
                {"role": c["role"], "content": c["content"], "time": c["created_at"]}
                for c in chats
            ],
        }

        return json.dumps(result, ensure_ascii=False, indent=2)
    finally:
        conn.close()


if __name__ == "__main__":
    # 用 uvicorn 启动 SSE 模式，端口 18794
    import uvicorn
    app = mcp.sse_app()
    uvicorn.run(app, host="0.0.0.0", port=18794)
