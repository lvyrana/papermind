"""
PaperMind 后端 API
启动: .venv_new/bin/python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations
import os
import json
import httpx
import threading
from datetime import datetime, timedelta
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel
from openai import OpenAI

from src.fetch_papers import get_papers as pubmed_get_papers
from src.fetch_semantic_scholar import get_papers as scholar_get_papers
from src.categorize_papers import score_and_categorize_papers
from src.database import (
    init_db, save_paper, get_saved_papers, get_saved_paper,
    delete_saved_paper, save_note, get_notes, save_chat_message,
    get_chat_history, record_reading, get_reading_history,
    get_profile, save_profile, get_saved_titles,
    check_rate_limit, increment_rate_limit, get_rate_limit_remaining,
)

# 加载 .env
load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="PaperMind API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 启动时初始化数据库
init_db()

# 每日推荐次数限制
DAILY_RECOMMEND_LIMIT = 20
OWNER_UID = os.environ.get("OWNER_UID", "")


# ========== Models ==========

class ProfileData(BaseModel):
    focus_areas: str = ""
    exclude_areas: str = ""
    current_goal: str = ""
    background: str = ""
    discipline: str = ""
    tracking_days: str = "7"

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


# ========== User ID ==========

def _get_user_id(request: Request) -> str:
    """从请求头获取用户 ID"""
    return request.headers.get("X-User-ID", "anonymous")


# ========== 内置 LLM（阿里云优先，GLM 备用，DeepSeek 兜底） ==========

_LLM_PROVIDERS = [
    {
        "name": "qwen",
        "api_key": os.environ.get("QWEN_API_KEY", ""),
        "base_url": os.environ.get("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "model": os.environ.get("QWEN_MODEL", "qwen-plus"),
    },
    {
        "name": "glm",
        "api_key": os.environ.get("GLM_API_KEY", ""),
        "base_url": os.environ.get("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
        "model": os.environ.get("GLM_MODEL", "glm-4-flash"),
    },
    {
        "name": "deepseek",
        "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
        "base_url": os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
    },
]


def _get_llm_client() -> tuple[Optional[OpenAI], str]:
    """返回内置 LLM client（GLM 优先，DeepSeek 备用）"""
    for provider in _LLM_PROVIDERS:
        api_key = provider["api_key"].strip()
        if not api_key:
            continue
        try:
            http_client = httpx.Client(
                transport=httpx.HTTPTransport(local_address="0.0.0.0"),
            )
            client = OpenAI(
                api_key=api_key,
                base_url=provider["base_url"],
                http_client=http_client,
            )
            return client, provider["model"]
        except Exception as e:
            print(f"[llm] {provider['name']} 初始化失败: {e}")
            continue
    return None, ""


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


# ========== Settings Routes（简化：只显示内置状态） ==========

@app.get("/api/settings")
def api_get_settings():
    """返回当前 LLM 配置状态"""
    client, model = _get_llm_client()
    provider_name = ""
    for p in _LLM_PROVIDERS:
        if p["model"] == model:
            provider_name = p["name"]
            break
    return {
        "provider": provider_name,
        "model": model,
        "base_url": "",
        "api_key_masked": "内置" if client else "未配置",
        "builtin": True,
    }

@app.post("/api/settings")
def api_save_settings():
    """内置 API 模式下，保存操作为空操作（兼容前端调用）"""
    return {"ok": True, "builtin": True}

@app.post("/api/settings/test")
def api_test_settings():
    result = _llm_complete("请回复两个字：成功", max_tokens=10)
    if result:
        return {"ok": True, "reply": result}
    client, model = _get_llm_client()
    if not client:
        return {"ok": False, "error": "未配置内置 API Key"}
    try:
        client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=5,
        )
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ========== Profile Routes ==========

@app.get("/api/profile")
def api_get_profile(request: Request):
    uid = _get_user_id(request)
    return get_profile(uid)

@app.post("/api/profile")
def api_save_profile(data: ProfileData, request: Request):
    uid = _get_user_id(request)
    save_profile(uid, data.dict())
    return {"ok": True}


# ========== Papers Cache（按用户隔离） ==========

_papers_cache: dict[str, dict] = {}

def _get_user_cache(user_id: str) -> dict:
    if user_id not in _papers_cache:
        _papers_cache[user_id] = {
            "papers": [],
            "fetched_at": None,
            "served_indices": set(),
            "fetching": False,    # 是否正在后台抓取
            "enriching": False,   # 是否正在后台解读
            "enrich_gen": 0,      # 解读代次，防止旧线程清掉新状态
            "current_page": [],   # 当前页 (index, paper) 列表
        }
    return _papers_cache[user_id]


def _generate_search_keywords(profile: dict, client, model: str, saved_titles: list[str] = None) -> list[str]:
    """根据用户画像 + 收藏历史，用 LLM 生成多组搜索关键词"""
    focus = profile.get("focus_areas", "")
    background = profile.get("background", "")
    goal = profile.get("current_goal", "")

    if not (focus or background):
        return []

    exclude = profile.get("exclude_areas", "")

    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if background:
        profile_text += f"研究经历：{background}\n"
    if goal:
        profile_text += f"当前目标：{goal}\n"
    if exclude:
        profile_text += f"明确排除（不要生成相关关键词）：{exclude}\n"

    # 加入收藏历史，帮助 LLM 理解用户真实兴趣
    history_text = ""
    if saved_titles:
        history_text = "\n用户近期收藏/阅读过的论文标题（反映真实兴趣）：\n" + "\n".join(f"- {t}" for t in saved_titles[:10])

    prompt = f"""你是一位学术检索专家。根据以下研究者画像，生成用于 PubMed 检索的英文关键词组合。

{profile_text}
{history_text}

要求：
1. 生成 3-5 组关键词，每组是一个用于 PubMed 搜索的英文查询字符串
2. 覆盖研究者关注方向的不同角度和子领域
3. 必须使用英文专业学术术语（PubMed 只支持英文检索）
4. 每组关键词要具体且有针对性，不要太宽泛
5. 可以使用 AND/OR 组合多个术语
6. 如果有收藏历史，参考用户实际感兴趣的论文主题来调整关键词
7. 严格避免生成用户明确排除的领域的关键词

示例输出：["COPD self-management nursing intervention", "pulmonary rehabilitation exercise training", "chronic obstructive pulmonary disease patient education adherence"]

只输出 JSON 数组，不要 markdown 代码块，不要其他文字。"""

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=400,
        )
        raw = (resp.choices[0].message.content or "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        keywords = json.loads(raw)
        print(f"[api] LLM 生成搜索关键词: {keywords}")
        return keywords
    except Exception as e:
        print(f"[api] 关键词生成失败: {e}")
        return []


def _fetch_and_cache_papers(keyword_list, days, source, profile, user_id: str = ""):
    """从 PubMed + Semantic Scholar 抓取论文并缓存"""
    client, model = _get_llm_client()

    # 获取用户收藏标题，用于优化搜索
    saved_titles = get_saved_titles(user_id) if user_id else []

    # 如果有 LLM 且有画像，用 LLM 生成搜索关键词
    smart_queries = []
    if client and (profile.get("focus_areas") or profile.get("background")):
        smart_queries = _generate_search_keywords(profile, client, model, saved_titles)

    # 合并：LLM 生成的关键词 + 用户手动输入的关键词
    all_queries = smart_queries.copy()
    if keyword_list:
        all_queries.append(" OR ".join(keyword_list))

    # 如果 LLM 生成失败且没有手动关键词，用 LLM 翻译画像方向
    if not all_queries and client:
        focus = profile.get("focus_areas", "")
        if focus:
            try:
                tr_resp = client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": f'将以下研究方向翻译为英文学术术语，用逗号分隔，只输出翻译结果：{focus}'}],
                    temperature=0, max_tokens=200,
                )
                translated = (tr_resp.choices[0].message.content or "").strip()
                all_queries = [t.strip() for t in translated.split(",") if t.strip()]
                print(f"[api] 翻译画像关键词: {all_queries}")
            except Exception:
                pass

    if not all_queries:
        print("[api] 无搜索关键词，跳过")
        return []

    all_papers = []

    for query in all_queries:
        query_keywords = [k.strip() for k in query.split(" OR ") if k.strip()] if " OR " in query else [query]

        if source in ("pubmed", "all"):
            try:
                pubmed_papers = pubmed_get_papers(query_keywords, days=days, max_results=30)
                for p in pubmed_papers:
                    p["source"] = "pubmed"
                all_papers.extend(pubmed_papers)
            except Exception as e:
                print(f"[api] PubMed 获取失败 ({query}): {e}")

        if source in ("semantic_scholar", "all"):
            try:
                year_from = (datetime.now() - timedelta(days=days * 4)).strftime("%Y")
                scholar_papers = scholar_get_papers(query_keywords, max_results=20, year_from=year_from)
                all_papers.extend(scholar_papers)
            except Exception as e:
                print(f"[api] Semantic Scholar 获取失败 ({query}): {e}")

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

    print(f"[api] 去重后 {len(unique_papers)} 篇论文")

    # 统一日期格式为 YYYY-MM-DD
    _month_map = {"Jan":"01","Feb":"02","Mar":"03","Apr":"04","May":"05","Jun":"06",
                  "Jul":"07","Aug":"08","Sep":"09","Oct":"10","Nov":"11","Dec":"12"}
    for p in unique_papers:
        d = p.get("pub_date", "")
        parts = d.split("-")
        if len(parts) == 3 and len(parts[1]) == 3 and parts[1] in _month_map:
            p["pub_date"] = f"{parts[0]}-{_month_map[parts[1]]}-{parts[2].zfill(2)}"
        elif len(parts) == 2 and len(parts[1]) == 3 and parts[1] in _month_map:
            p["pub_date"] = f"{parts[0]}-{_month_map[parts[1]]}"

    # LLM 打分 + 动态分类 + 排序（已按分数降序）
    if client:
        unique_papers = score_and_categorize_papers(unique_papers, profile, client, model)
        # 过滤掉分数过低的（3分以下），但至少保留 10 篇
        scored = [p for p in unique_papers if p.get("relevance_score", 5) >= 3]
        if len(scored) >= 10:
            filtered = len(unique_papers) - len(scored)
            unique_papers = scored
            if filtered:
                print(f"[api] 过滤低相关性论文 {filtered} 篇")
        else:
            print(f"[api] 高分论文不足 10 篇，保留全部 {len(unique_papers)} 篇")

    print(f"[api] 最终缓存 {len(unique_papers)} 篇论文")
    return unique_papers


# ========== Papers Routes ==========

def _bg_fetch_and_enrich(cache, keyword_list, days, source, profile, uid):
    """后台线程：抓取论文 + AI 解读"""
    try:
        papers = _fetch_and_cache_papers(keyword_list, days, source, profile, uid)
        cache["papers"] = papers
        cache["fetched_at"] = datetime.now()
        cache["served_indices"] = set()

        # 对前 10 篇做 AI 解读
        unenriched = [p for p in papers[:10] if not p.get("summary_zh")]
        if unenriched:
            client, model = _get_llm_client()
            if client:
                _enrich_papers_with_llm(unenriched, profile, client, model, uid)
        print(f"[api] 后台抓取完成: {len(papers)} 篇")
    except Exception as e:
        print(f"[api] 后台抓取失败: {e}")
    finally:
        cache["fetching"] = False


def _bg_enrich(cache, papers, profile, uid, gen):
    """后台线程：解读当前页论文。gen 用于防止旧线程误清新状态。"""
    try:
        client, model = _get_llm_client()
        if client:
            _enrich_papers_with_llm(papers, profile, client, model, uid)
    except Exception as e:
        print(f"[api] 后台解读失败: {e}")
    finally:
        # 只有当前代次的线程才能清 enriching
        if cache["enrich_gen"] == gen:
            cache["enriching"] = False
        print(f"[api] 后台解读完成 (gen={gen})")


@app.get("/api/papers")
def api_get_papers(
    request: Request,
    keywords: str = Query(default=""),
    days: int = Query(default=0),
    source: str = Query(default="all"),
    refresh: bool = Query(default=False),
    force_fetch: bool = Query(default=False),
    poll: bool = Query(default=False),
):
    """获取论文。首次请求触发后台抓取，前端轮询获取结果。"""
    uid = _get_user_id(request)
    cache = _get_user_cache(uid)

    # 如果前端没传 days，从用户画像读取 tracking_days
    if days <= 0:
        profile_tmp = get_profile(uid)
        days = int(profile_tmp.get("tracking_days") or 7)

    # poll=true: 返回当前页最新状态（不切换、不抓取）
    if poll and cache["current_page"]:
        page = cache["current_page"]
        page_papers = [p for _, p in page]
        all_papers = cache["papers"]
        remaining = len([i for i in range(len(all_papers)) if i not in cache["served_indices"]])
        enriching = cache["enriching"]
        return {
            "papers": page_papers,
            "total": len(all_papers),
            "remaining": remaining,
            "enriching": enriching,
        }

    keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
    profile = get_profile(uid)

    # 正在后台抓取中，返回加载状态
    if cache["fetching"]:
        return {"papers": [], "total": 0, "remaining": 0, "loading": True}

    # Rate limit（owner 不限量）
    is_owner = OWNER_UID and uid == OWNER_UID
    if not is_owner and (force_fetch or (not cache["papers"])):
        remaining_quota = get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT)
        if remaining_quota <= 0:
            return {
                "papers": [],
                "total": 0,
                "remaining": 0,
                "error": f"今日推荐次数已用完（每天 {DAILY_RECOMMEND_LIMIT} 次），明天再来吧",
                "rate_limited": True,
            }

    # 判断是否需要重新抓取
    need_fetch = force_fetch or not cache["papers"]
    if cache["fetched_at"]:
        age = (datetime.now() - cache["fetched_at"]).total_seconds()
        if age > 3600:
            need_fetch = True

    if need_fetch:
        cache["fetching"] = True
        increment_rate_limit(uid, "recommend")
        t = threading.Thread(
            target=_bg_fetch_and_enrich,
            args=(cache, keyword_list, days, source, profile, uid),
            daemon=True,
        )
        t.start()
        return {"papers": [], "total": 0, "remaining": 0, "loading": True}

    all_papers = cache["papers"]
    if not all_papers:
        return {"papers": [], "total": 0, "remaining": 0}

    # 选 10 篇还没展示过的
    all_explored = False
    if refresh:
        available = [(i, p) for i, p in enumerate(all_papers) if i not in cache["served_indices"]]
        if not available:
            all_explored = True
            selected = list(enumerate(all_papers))[:10]
        else:
            selected = available[:10]
    else:
        selected = list(enumerate(all_papers))[:10]

    for idx, _ in selected:
        cache["served_indices"].add(idx)

    # 记住当前页（用于 poll 查询）
    cache["current_page"] = selected

    # 把真实缓存索引附到 paper 上，前端用于恢复单篇
    page_papers = []
    for idx, p in selected:
        p["_cache_index"] = idx
        page_papers.append(p)
    remaining = len([i for i in range(len(all_papers)) if i not in cache["served_indices"]])

    # 对当前页还没解读过的后台补充解读
    unenriched = [p for p in page_papers if not p.get("summary_zh")]
    enriching = False
    if unenriched:
        client, model = _get_llm_client()
        if client:
            cache["enrich_gen"] += 1
            gen = cache["enrich_gen"]
            cache["enriching"] = True
            enriching = True
            threading.Thread(
                target=_bg_enrich,
                args=(cache, unenriched, profile, uid, gen),
                daemon=True,
            ).start()

    return {
        "papers": page_papers,
        "total": len(all_papers),
        "remaining": remaining,
        "all_explored": all_explored,
        "enriching": enriching,
        "daily_remaining": get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT),
    }

@app.get("/api/papers/{index}")
def api_get_paper_by_index(index: int, request: Request):
    """通过索引从缓存获取单篇论文（用于刷新恢复）"""
    uid = _get_user_id(request)
    cache = _get_user_cache(uid)
    papers = cache.get("papers", [])
    if 0 <= index < len(papers):
        return {"paper": papers[index]}
    return {"paper": None}


def _enrich_papers_with_llm(papers: list[dict], profile: dict, client: OpenAI, model: str, user_id: str = ""):
    """为论文添加详细中文解读和个性化相关性分析"""
    focus = profile.get("focus_areas", "")
    background = profile.get("background", "")
    goal = profile.get("current_goal", "")
    discipline = profile.get("discipline", "")

    profile_text = ""
    if discipline:
        profile_text += f"学科领域：{discipline}\n"
    if focus:
        profile_text += f"追踪主题：{focus}\n"
    if background:
        profile_text += f"研究经历：{background}\n"
    if goal:
        profile_text += f"当前目标：{goal}\n"

    # 获取当前用户的阅读历史
    history = get_reading_history(user_id, limit=10)
    history_text = ""
    if history:
        recent_titles = [h["title"] for h in history[:5]]
        history_text = f"\n用户近期阅读过的论文：\n" + "\n".join(f"- {t}" for t in recent_titles)

    for i, paper in enumerate(papers):
        try:
            prompt = f"""你是一位专业的学术论文解读助手。请对以下论文进行详细解读。

论文标题：{paper['title']}
论文摘要：{paper['abstract'][:1200]}

{f"研究者背景（仅供参考，不要在输出中罗列这些关键词）：{chr(10)}{profile_text}" if profile_text else ""}
{history_text}

请用 JSON 格式输出以下内容：

{{
  "summary_zh": "详细中文解读（4-6句话，包含：研究背景与目的、研究方法、主要发现、意义。语言专业但易懂）",
  "relevance": "这篇论文对研究者的启发（1-2句话。只基于论文实际内容来写，不要罗列研究者画像中的关键词。如果论文没有直接涉及某个方向就不要提它。重点说：论文的什么发现或方法能给研究者带来什么具体启发）",
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


# ========== 翻译 ==========

class TranslateRequest(BaseModel):
    text: str

@app.post("/api/translate")
def api_translate(data: TranslateRequest):
    """将英文文本翻译为中文"""
    client, model = _get_llm_client()
    if not client:
        return {"ok": False, "error": "未配置 API"}
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": f"请将以下英文学术文本准确翻译为中文，保持专业术语的准确性，只输出翻译结果：\n\n{data.text[:3000]}"}],
            temperature=0.2,
            max_tokens=2000,
        )
        translated = (resp.choices[0].message.content or "").strip()
        return {"ok": True, "translated": translated}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ========== Library / 收藏库 Routes ==========

@app.post("/api/library/save")
def api_save_to_library(data: SavePaperRequest, request: Request):
    """收藏一篇论文"""
    uid = _get_user_id(request)
    row_id = save_paper(data.paper, uid)
    return {"ok": True, "id": row_id}

@app.get("/api/library")
def api_get_library(request: Request):
    """获取收藏库列表"""
    uid = _get_user_id(request)
    papers = get_saved_papers(uid)
    return {"papers": papers}

@app.get("/api/library/{paper_id}")
def api_get_library_paper(paper_id: int, request: Request):
    """获取收藏的论文详情 + 笔记 + 对话"""
    uid = _get_user_id(request)
    paper = get_saved_paper(paper_id)
    if not paper or paper.get("user_id", "") != uid:
        return {"error": "not found"}
    notes = get_notes(paper_id)
    chats = get_chat_history(paper_id)
    return {"paper": paper, "notes": notes, "chats": chats}

@app.delete("/api/library/{paper_id}")
def api_delete_from_library(paper_id: int, request: Request):
    """取消收藏（需验证归属）"""
    uid = _get_user_id(request)
    paper = get_saved_paper(paper_id)
    if not paper or paper.get("user_id", "") != uid:
        return {"ok": False, "error": "not found"}
    delete_saved_paper(paper_id)
    return {"ok": True}


# ========== Notes Routes ==========

@app.post("/api/notes")
def api_save_note(data: SaveNoteRequest, request: Request):
    """保存笔记（需验证归属）"""
    uid = _get_user_id(request)
    paper = get_saved_paper(data.paper_rowid)
    if not paper or paper.get("user_id", "") != uid:
        return {"ok": False, "error": "not found"}
    note_id = save_note(data.paper_rowid, data.content)
    return {"ok": True, "id": note_id}

@app.get("/api/notes/{paper_rowid}")
def api_get_notes(paper_rowid: int, request: Request):
    """获取某篇论文的笔记（需验证归属）"""
    uid = _get_user_id(request)
    paper = get_saved_paper(paper_rowid)
    if not paper or paper.get("user_id", "") != uid:
        return {"notes": []}
    notes = get_notes(paper_rowid)
    return {"notes": notes}


# ========== Chat Route ==========

@app.post("/api/chat")
def api_chat(data: ChatRequest, request: Request):
    """和 AI 讨论一篇论文"""
    uid = _get_user_id(request)
    profile = get_profile(uid)
    profile_text = ""
    if profile.get("discipline"):
        profile_text += f"学科领域：{profile['discipline']}\n"
    if profile.get("focus_areas"):
        profile_text += f"追踪主题：{profile['focus_areas']}\n"
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
- 简洁精炼，控制在 300-500 字左右
- 结合用户的研究背景来分析
- 如果用户问方法学问题，给出具体的方法学评价
- 如果用户问相关性，联系用户的研究方向给出具体建议
- 适当引用论文中的数据或发现来支持观点"""

    client, model = _get_llm_client()
    if not client:
        return {"reply": "AI 服务暂不可用，请稍后重试", "ok": False}

    messages = [{"role": "system", "content": system_prompt}]
    for msg in data.history[-8:]:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    messages.append({"role": "user", "content": data.message})

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.4,
            max_tokens=1000,
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
- 300-500字

对话内容：
{chat_text[:3000]}

只输出笔记内容，不加标题或前缀。"""

    result = _llm_complete(prompt, max_tokens=1000)
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
def api_record_reading(data: dict, request: Request):
    """记录阅读行为"""
    uid = _get_user_id(request)
    record_reading(data.get("paper_rowid"), data.get("title", ""), uid)
    return {"ok": True}

@app.get("/api/reading-history")
def api_get_reading_history(request: Request):
    uid = _get_user_id(request)
    history = get_reading_history(uid, limit=20)
    return {"history": history}


# ========== Export / Download ==========

def _paper_to_ris(paper: dict) -> str:
    """将论文转换为 RIS 格式（兼容 Zotero/EndNote/Mendeley）"""
    lines = ["TY  - JOUR"]
    lines.append(f"TI  - {paper.get('title', '')}")
    # 作者
    authors_str = paper.get("authors", "")
    if authors_str:
        for author in authors_str.replace(" 等", "").split(", "):
            author = author.strip()
            if author:
                lines.append(f"AU  - {author}")
    lines.append(f"JO  - {paper.get('journal', '')}")
    lines.append(f"PY  - {paper.get('pub_date', '')[:4]}")
    lines.append(f"DA  - {paper.get('pub_date', '')}")
    if paper.get("doi"):
        lines.append(f"DO  - {paper['doi']}")
    if paper.get("pmid"):
        lines.append(f"AN  - {paper['pmid']}")
    if paper.get("link"):
        lines.append(f"UR  - {paper['link']}")
    if paper.get("abstract"):
        lines.append(f"AB  - {paper['abstract']}")
    lines.append("ER  - ")
    return "\n".join(lines)


def _paper_to_bibtex(paper: dict) -> str:
    """将论文转换为 BibTeX 格式"""
    # 生成 cite key
    first_author = paper.get("authors", "unknown").split(",")[0].split()
    last_name = first_author[-1] if first_author else "unknown"
    year = paper.get("pub_date", "0000")[:4]
    cite_key = f"{last_name.lower()}{year}"

    lines = [f"@article{{{cite_key},"]
    lines.append(f"  title = {{{paper.get('title', '')}}},")
    lines.append(f"  author = {{{paper.get('authors', '')}}},")
    lines.append(f"  journal = {{{paper.get('journal', '')}}},")
    lines.append(f"  year = {{{year}}},")
    if paper.get("doi"):
        lines.append(f"  doi = {{{paper['doi']}}},")
    if paper.get("pmid"):
        lines.append(f"  pmid = {{{paper['pmid']}}},")
    if paper.get("link"):
        lines.append(f"  url = {{{paper['link']}}},")
    if paper.get("abstract"):
        abstract = paper["abstract"].replace("{", "\\{").replace("}", "\\}")
        lines.append(f"  abstract = {{{abstract}}},")
    lines.append("}")
    return "\n".join(lines)


@app.get("/api/export/ris/{paper_id}")
def api_export_ris(paper_id: int):
    """导出收藏论文为 RIS 格式"""
    paper = get_saved_paper(paper_id)
    if not paper:
        return PlainTextResponse("Not found", status_code=404)
    ris = _paper_to_ris(paper)
    return PlainTextResponse(
        ris,
        media_type="application/x-research-info-systems",
        headers={"Content-Disposition": f'attachment; filename="paper_{paper_id}.ris"'},
    )


@app.get("/api/export/bibtex/{paper_id}")
def api_export_bibtex(paper_id: int):
    """导出收藏论文为 BibTeX 格式"""
    paper = get_saved_paper(paper_id)
    if not paper:
        return PlainTextResponse("Not found", status_code=404)
    bib = _paper_to_bibtex(paper)
    return PlainTextResponse(
        bib,
        media_type="application/x-bibtex",
        headers={"Content-Disposition": f'attachment; filename="paper_{paper_id}.bib"'},
    )


@app.post("/api/export/ris-direct")
def api_export_ris_direct(data: SavePaperRequest):
    """导出未收藏论文为 RIS 格式（直接传论文数据）"""
    ris = _paper_to_ris(data.paper)
    return PlainTextResponse(
        ris,
        media_type="application/x-research-info-systems",
        headers={"Content-Disposition": 'attachment; filename="paper.ris"'},
    )


@app.post("/api/export/bibtex-direct")
def api_export_bibtex_direct(data: SavePaperRequest):
    """导出未收藏论文为 BibTeX 格式"""
    bib = _paper_to_bibtex(data.paper)
    return PlainTextResponse(
        bib,
        media_type="application/x-bibtex",
        headers={"Content-Disposition": 'attachment; filename="paper.bib"'},
    )


@app.get("/api/pdf-url")
def api_get_pdf_url(doi: str = Query(default=""), pmid: str = Query(default="")):
    """通过 Unpaywall 查找免费 PDF 链接"""
    pdf_url = None

    # 1. 尝试 Unpaywall（需要 DOI）
    if doi:
        try:
            resp = httpx.get(
                f"https://api.unpaywall.org/v2/{doi}",
                params={"email": "papermind@example.com"},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                best = data.get("best_oa_location") or {}
                pdf_url = best.get("url_for_pdf") or best.get("url")
        except Exception as e:
            print(f"[pdf] Unpaywall 查询失败: {e}")

    # 2. 尝试 PubMed Central（需要 PMID）
    if not pdf_url and pmid:
        try:
            resp = httpx.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi",
                params={"dbfrom": "pubmed", "id": pmid, "cmd": "prlinks", "retmode": "json"},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                linksets = data.get("linksets", [])
                for ls in linksets:
                    for idurllist in ls.get("idurllist", []):
                        for obj_url in idurllist.get("objurls", []):
                            url = obj_url.get("url", {}).get("value", "")
                            if url:
                                pdf_url = url
                                break
        except Exception as e:
            print(f"[pdf] PMC 查询失败: {e}")

    if pdf_url:
        return {"ok": True, "url": pdf_url}
    return {"ok": False, "error": "未找到免费全文，可尝试通过原文链接访问"}


# ========== 静态文件服务（生产模式） ==========

_dist = Path(__file__).resolve().parent.parent / "web" / "dist"

if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """SPA fallback: 非 API 路由都返回 index.html"""
        file_path = _dist / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_dist / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
