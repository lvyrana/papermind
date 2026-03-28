"""
PaperDiary 后端 API
启动: .venv_new/bin/python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations
import os
import json
import httpx
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

from src.fetch_papers import get_papers as pubmed_get_papers
from src.fetch_semantic_scholar import get_papers as scholar_get_papers
from src.categorize_papers import categorize_papers, CATEGORIES
from src.config_store import (
    get_api_settings, save_api_settings, get_api_settings_safe,
    get_profile, save_profile,
)
from src.database import (
    init_db, save_paper, get_saved_papers, get_saved_paper,
    delete_saved_paper, save_note, get_notes, save_chat_message,
    get_chat_history, record_reading, get_reading_history,
)

app = FastAPI(title="PaperDiary API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 启动时初始化数据库
init_db()


# ========== Models ==========

class APISettings(BaseModel):
    provider: str
    model: str
    api_key: str
    base_url: str = ""

class ProfileData(BaseModel):
    focus_areas: str = ""
    exclude_areas: str = ""
    current_goal: str = ""
    background: str = ""

class ChatRequest(BaseModel):
    paper_title: str
    paper_abstract: str
    message: str
    history: list[dict] = []
    paper_rowid: int = 0

class SummarizeChatRequest(BaseModel):
    paper_title: str
    paper_rowid: int
    messages: list[dict]

class SavePaperRequest(BaseModel):
    paper: dict

class SaveNoteRequest(BaseModel):
    paper_rowid: int
    content: str


# ========== Provider configs ==========

PROVIDER_DEFAULTS = {
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "model": "openai/gpt-4o-mini"},
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat"},
    "zhipu": {"base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4-flash"},
    "moonshot": {"base_url": "https://api.moonshot.cn/v1", "model": "moonshot-v1-8k"},
    "openai": {"base_url": "", "model": "gpt-4o-mini"},
}


# ========== LLM helper ==========

def _get_llm_client() -> tuple[Optional[OpenAI], str]:
    """返回 (client, model) 或 (None, '')"""
    settings = get_api_settings()
    api_key = settings.get("api_key", "").strip()
    if not api_key:
        return None, ""

    base_url = settings.get("base_url", "").strip() or None
    model = settings.get("model", "gpt-4o-mini")

    provider = settings.get("provider", "")
    needs_proxy = provider in ("openrouter", "openai")

    if needs_proxy:
        proxy_url = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or "http://127.0.0.1:7890"
        http_client = httpx.Client(proxy=proxy_url)
    else:
        http_client = httpx.Client(
            transport=httpx.HTTPTransport(local_address="0.0.0.0"),
        )
    client = OpenAI(api_key=api_key, base_url=base_url, http_client=http_client)
    return client, model


def _llm_complete(prompt: str, max_tokens: int = 800) -> str:
    client, model = _get_llm_client()
    if not client:
        return ""
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=max_tokens,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[llm] 调用失败: {e}")
        return ""


# ========== Settings Routes ==========

@app.get("/api/settings")
def api_get_settings():
    return get_api_settings_safe()

@app.post("/api/settings")
def api_save_settings(data: APISettings):
    provider = data.provider
    base_url = data.base_url.strip()
    if not base_url and provider in PROVIDER_DEFAULTS:
        base_url = PROVIDER_DEFAULTS[provider]["base_url"]
    save_api_settings({
        "provider": provider,
        "model": data.model,
        "api_key": data.api_key,
        "base_url": base_url,
    })
    return {"ok": True}

@app.post("/api/settings/test")
def api_test_settings():
    result = _llm_complete("请回复两个字：成功", max_tokens=10)
    if result:
        return {"ok": True, "reply": result}
    return {"ok": False, "error": "无法连接 API，请检查 Key 和配置"}


# ========== Profile Routes ==========

@app.get("/api/profile")
def api_get_profile():
    return get_profile()

@app.post("/api/profile")
def api_save_profile(data: ProfileData):
    save_profile(data.dict())
    return {"ok": True}


# ========== Papers Cache ==========

# 内存缓存：抓一次，多次换批
_papers_cache: dict = {
    "papers": [],        # 全部已过滤的论文
    "fetched_at": None,  # 上次抓取时间
    "served_indices": set(),  # 已经展示过的论文索引
}


def _fetch_and_cache_papers(keyword_list, days, source, profile):
    """从 PubMed + Semantic Scholar 抓取论文并缓存"""
    all_papers = []

    if source in ("pubmed", "all"):
        try:
            pubmed_papers = pubmed_get_papers(keyword_list, days=days, max_results=50)
            for p in pubmed_papers:
                p["source"] = "pubmed"
            all_papers.extend(pubmed_papers)
        except Exception as e:
            print(f"[api] PubMed 获取失败: {e}")

    if source in ("semantic_scholar", "all"):
        try:
            year_from = (datetime.now() - timedelta(days=days * 4)).strftime("%Y")
            scholar_papers = scholar_get_papers(keyword_list, max_results=30, year_from=year_from)
            all_papers.extend(scholar_papers)
        except Exception as e:
            print(f"[api] Semantic Scholar 获取失败: {e}")

    if not all_papers:
        return []

    # 去重
    seen_titles = set()
    unique_papers = []
    for p in all_papers:
        title_key = p["title"].lower().strip()[:80]
        if title_key not in seen_titles:
            seen_titles.add(title_key)
            unique_papers.append(p)

    # 分类
    unique_papers = categorize_papers(unique_papers)

    # 基于画像过滤
    exclude_areas = [a.strip() for a in profile.get("exclude_areas", "").split("、") if a.strip()]
    if exclude_areas:
        exclude_map = {
            "纯动物实验": "机制研究", "纯分子机制": "机制研究",
            "纯机制研究": "机制研究", "动物实验": "机制研究",
            "药物治疗": "药物治疗", "药代动力学": "药物治疗",
        }
        exclude_cats = set()
        for area in exclude_areas:
            if area in exclude_map:
                exclude_cats.add(exclude_map[area])
            if area in CATEGORIES:
                exclude_cats.add(area)
        if exclude_cats:
            unique_papers = [p for p in unique_papers if p.get("category") not in exclude_cats]

    print(f"[api] 缓存 {len(unique_papers)} 篇论文")
    return unique_papers


# ========== Papers Routes ==========

@app.get("/api/papers")
def api_get_papers(
    keywords: str = Query(default="COPD,chronic obstructive pulmonary disease"),
    days: int = Query(default=7),
    source: str = Query(default="all"),
    refresh: bool = Query(default=False),  # True=换一批新的10篇
    force_fetch: bool = Query(default=False),  # True=重新从网上抓取
):
    """获取 10 篇最相关论文。refresh=换一批，force_fetch=重新抓取"""
    keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
    profile = get_profile()
    cache = _papers_cache

    # 判断是否需要重新抓取
    need_fetch = force_fetch or not cache["papers"]
    if cache["fetched_at"]:
        age = (datetime.now() - cache["fetched_at"]).total_seconds()
        if age > 3600:  # 缓存超过 1 小时自动刷新
            need_fetch = True

    if need_fetch:
        cache["papers"] = _fetch_and_cache_papers(keyword_list, days, source, profile)
        cache["fetched_at"] = datetime.now()
        cache["served_indices"] = set()

    all_papers = cache["papers"]
    if not all_papers:
        return {"papers": [], "total": 0, "remaining": 0}

    # 选 10 篇还没展示过的
    if refresh:
        # 换一批：跳过已展示的
        available = [(i, p) for i, p in enumerate(all_papers) if i not in cache["served_indices"]]
        if not available:
            # 全都展示过了，重置
            cache["served_indices"] = set()
            available = list(enumerate(all_papers))

        selected = available[:10]
    else:
        # 首次加载或 force_fetch：从头选
        selected = list(enumerate(all_papers))[:10]

    # 记录已展示的索引
    for idx, _ in selected:
        cache["served_indices"].add(idx)

    page_papers = [p for _, p in selected]
    remaining = len([i for i in range(len(all_papers)) if i not in cache["served_indices"]])

    # 只对这 10 篇跑 AI 解读
    client, model = _get_llm_client()
    if client and page_papers:
        _enrich_papers_with_llm(page_papers, profile, client, model)

    return {
        "papers": page_papers,
        "total": len(all_papers),
        "remaining": remaining,
    }


def _enrich_papers_with_llm(papers: list[dict], profile: dict, client: OpenAI, model: str):
    """为论文添加详细中文解读和个性化相关性分析"""
    focus = profile.get("focus_areas", "")
    background = profile.get("background", "")
    goal = profile.get("current_goal", "")

    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if background:
        profile_text += f"研究经历：{background}\n"
    if goal:
        profile_text += f"当前目标：{goal}\n"

    # 获取用户阅读历史，用于让 AI 更了解偏好
    history = get_reading_history(limit=10)
    history_text = ""
    if history:
        recent_titles = [h["title"] for h in history[:5]]
        history_text = f"\n用户近期阅读过的论文：\n" + "\n".join(f"- {t}" for t in recent_titles)

    for i, paper in enumerate(papers):
        if i >= 10:
            break
        try:
            prompt = f"""你是一位专业的医学研究解读助手。请对以下英文医学论文进行详细解读。

论文标题：{paper['title']}
论文摘要：{paper['abstract'][:1200]}

{f"研究者背景：{chr(10)}{profile_text}" if profile_text else ""}
{history_text}

请用 JSON 格式输出以下内容：

{{
  "summary_zh": "详细中文解读（5-8句话，包含：研究背景与目的、研究方法、主要发现、临床意义或应用价值。语言专业但易懂，像在给同行讲解这篇论文的核心内容）",
  "relevance": "与研究者的关联分析（2-3句话，具体说明这篇论文的哪些内容与研究者的方向、经历或当前目标有关，能给研究者带来什么启发或参考）",
  "key_findings": ["核心发现1", "核心发现2", "核心发现3"]
}}

只输出 JSON，不加其他文字。"""

            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=800,
            )
            raw = (resp.choices[0].message.content or "").strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            result = json.loads(raw)
            paper["summary_zh"] = result.get("summary_zh", "")
            paper["relevance"] = result.get("relevance", "")
            paper["key_findings"] = result.get("key_findings", [])
        except Exception as e:
            print(f"[api] 论文 {i+1} LLM 处理失败: {e}")
            paper["summary_zh"] = ""
            paper["relevance"] = ""
            paper["key_findings"] = []


# ========== Library / 收藏库 Routes ==========

@app.post("/api/library/save")
def api_save_to_library(data: SavePaperRequest):
    """收藏一篇论文"""
    row_id = save_paper(data.paper)
    return {"ok": True, "id": row_id}

@app.get("/api/library")
def api_get_library():
    """获取收藏库列表"""
    papers = get_saved_papers()
    return {"papers": papers}

@app.get("/api/library/{paper_id}")
def api_get_library_paper(paper_id: int):
    """获取收藏的论文详情 + 笔记 + 对话"""
    paper = get_saved_paper(paper_id)
    if not paper:
        return {"error": "not found"}
    notes = get_notes(paper_id)
    chats = get_chat_history(paper_id)
    return {"paper": paper, "notes": notes, "chats": chats}

@app.delete("/api/library/{paper_id}")
def api_delete_from_library(paper_id: int):
    """取消收藏"""
    delete_saved_paper(paper_id)
    return {"ok": True}


# ========== Notes Routes ==========

@app.post("/api/notes")
def api_save_note(data: SaveNoteRequest):
    """保存笔记"""
    note_id = save_note(data.paper_rowid, data.content)
    return {"ok": True, "id": note_id}

@app.get("/api/notes/{paper_rowid}")
def api_get_notes(paper_rowid: int):
    """获取某篇论文的笔记"""
    notes = get_notes(paper_rowid)
    return {"notes": notes}


# ========== Chat Route ==========

@app.post("/api/chat")
def api_chat(data: ChatRequest):
    """和 AI 讨论一篇论文"""
    profile = get_profile()
    profile_text = ""
    if profile.get("focus_areas"):
        profile_text += f"研究方向：{profile['focus_areas']}\n"
    if profile.get("background"):
        profile_text += f"研究经历：{profile['background']}\n"
    if profile.get("current_goal"):
        profile_text += f"当前目标：{profile['current_goal']}\n"

    # 获取该论文的历史笔记
    notes_context = ""
    if data.paper_rowid:
        notes = get_notes(data.paper_rowid)
        if notes:
            notes_context = f"\n用户关于这篇论文的笔记：\n{notes[0]['content'][:500]}"

    system_prompt = f"""你是一位专业的学术研究助手。用户正在阅读一篇论文，请基于论文内容和用户的研究背景来回答问题。
用中文回答，专业但亲切，像一位有经验的研究伙伴在交流。

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1200]}

{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}
{notes_context}

回答要求：
- 结合用户的研究背景来分析
- 如果用户问方法学问题，给出具体的方法学评价
- 如果用户问相关性，联系用户的研究方向给出具体建议
- 适当引用论文中的数据或发现来支持观点"""

    client, model = _get_llm_client()
    if not client:
        return {"reply": "请先在设置中配置 API Key", "ok": False}

    messages = [{"role": "system", "content": system_prompt}]
    for msg in data.history[-8:]:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    messages.append({"role": "user", "content": data.message})

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.4,
            max_tokens=800,
        )
        reply = (resp.choices[0].message.content or "").strip()

        # 如果已收藏，持久化对话
        if data.paper_rowid:
            save_chat_message(data.paper_rowid, "user", data.message)
            save_chat_message(data.paper_rowid, "assistant", reply)

        return {"reply": reply, "ok": True}
    except Exception as e:
        return {"reply": f"AI 回复失败: {str(e)}", "ok": False}


# ========== Chat Summary → Notes ==========

@app.post("/api/chat/summarize")
def api_summarize_chat(data: SummarizeChatRequest):
    """将对话总结为笔记并保存"""
    if not data.messages or not data.paper_rowid:
        return {"ok": False, "error": "缺少对话内容或论文ID"}

    # 构建对话文本
    chat_text = "\n".join(
        f"{'用户' if m.get('role') == 'user' else 'AI'}：{m.get('content', '')}"
        for m in data.messages
    )

    prompt = f"""请将以下关于论文「{data.paper_title}」的讨论对话总结为一段简洁的研究笔记。

要求：
- 用第一人称（"我"）写
- 提炼出对话中的关键洞察、对研究的启发、值得记录的要点
- 语言简洁，像研究日记
- 如果对话中有方法学讨论、研究思路、或下一步想法，重点保留
- 200-400字

对话内容：
{chat_text[:3000]}

只输出笔记内容，不加标题或前缀。"""

    result = _llm_complete(prompt, max_tokens=600)
    if not result:
        return {"ok": False, "error": "AI 总结失败"}

    # 获取已有笔记，追加而不是覆盖
    existing_notes = get_notes(data.paper_rowid)
    if existing_notes:
        combined = existing_notes[0]["content"] + "\n\n---\n\n" + "💬 AI 对话笔记：\n" + result
        save_note(data.paper_rowid, combined)
    else:
        save_note(data.paper_rowid, "💬 AI 对话笔记：\n" + result)

    return {"ok": True, "note": result}


# ========== Reading History ==========

@app.post("/api/reading-history")
def api_record_reading(data: dict):
    """记录阅读行为"""
    record_reading(data.get("paper_rowid"), data.get("title", ""))
    return {"ok": True}

@app.get("/api/reading-history")
def api_get_reading_history():
    history = get_reading_history(limit=20)
    return {"history": history}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
