"""
PaperMind 后端 API
启动: .venv_new/bin/python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations
import asyncio
import os
import json
import base64
import httpx
import threading
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional

from dotenv import load_dotenv
from openai import AsyncOpenAI
from fastapi import FastAPI, Query, Request, UploadFile, File, Form, HTTPException as FastAPIHTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel, Field

PDF_DIR = Path(__file__).parent / "data" / "pdfs"
PDF_DIR.mkdir(parents=True, exist_ok=True)
PDF_SIZE_LIMIT = 50 * 1024 * 1024  # 50 MB
FIGURES_DIR = Path(__file__).parent / "data" / "figures"
FIGURES_DIR.mkdir(parents=True, exist_ok=True)
FIGURE_SIZE_LIMIT = 10 * 1024 * 1024  # 10 MB

from src.database import (
    init_db, save_paper, get_saved_papers, get_saved_paper,
    delete_saved_paper, update_paper_enrichment, save_note, delete_note, get_note_owner, get_notes, save_chat_message,
    get_saved_categories,
    get_chat_history, record_reading, get_reading_history,
    get_profile, save_profile, get_latest_search_run,
    check_rate_limit, increment_rate_limit, get_rate_limit_remaining,
    get_enrichment_cache, save_enrichment_cache,
    increment_recent_events,
    save_feedback, get_user_stats,
    create_project, get_projects, update_project, delete_project, set_paper_project,
    set_paper_has_pdf, get_paper_owner,
    save_card, get_cards, update_card, delete_card, get_card_owner, CARD_TYPES,
    save_quote, get_quotes, delete_quote, get_quote_owner,
    get_or_create_board, update_board, add_board_item, get_board_items,
    update_board_item, get_board_item_owner, delete_board_item, get_board_item,
)
from src.config_store import (
    get_custom_provider, save_custom_provider, get_custom_provider_safe,
)
from llm_router import (
    _LLM_PROVIDERS,
    _get_llm_client,
    _get_llm_slots,
    _has_llm_config,
    _llm_chat_complete,
    _llm_chat_complete_async,
    _llm_complete_async,
)
from memory_service import (
    build_memory_context,
    ensure_memory_core,
    merge_recent_to_core,
    update_memory_recent,
)
from search_service import fetch_and_rank_papers

# 加载 .env
load_dotenv(Path(__file__).parent / ".env")

# Sentry 错误监控（配置 SENTRY_DSN 后生效）
_sentry_dsn = os.environ.get("SENTRY_DSN", "")
if _sentry_dsn:
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration
    sentry_sdk.init(
        dsn=_sentry_dsn,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        traces_sample_rate=0.1,
        send_default_pii=False,
    )

app = FastAPI(title="PaperMind API")

# 生产环境在 .env 中设置 ALLOWED_ORIGINS=https://yourdomain.com
# 不设置则默认允许所有来源（开发用）
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,   # 我们用 X-User-ID header，不需要 cookie
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-User-ID"],
)

# 启动时初始化数据库
init_db()

# 每日限速配置（可在 .env 中覆盖）
DAILY_RECOMMEND_LIMIT = int(os.environ.get("DAILY_RECOMMEND_LIMIT", "5"))
DAILY_CHAT_LIMIT = int(os.environ.get("DAILY_CHAT_LIMIT", "20"))
DAILY_TRANSLATE_LIMIT = int(os.environ.get("DAILY_TRANSLATE_LIMIT", "30"))
# 全局每日 AI 对话熔断（所有用户之和，超了暂停服务）
GLOBAL_DAILY_CHAT_LIMIT = int(os.environ.get("GLOBAL_DAILY_CHAT_LIMIT", "500"))
OWNER_UID = os.environ.get("OWNER_UID", "")
MAX_ENRICH_ATTEMPTS = 5


# ========== Models ==========

class ProfileData(BaseModel):
    focus_areas: str = ""
    exclude_areas: str = ""
    method_interests: str = ""
    current_goal: str = ""
    background: str = ""
    discipline: str = ""
    tracking_days: str = "90"
    interests_summary: str = ""
    interests_summary_is_manual: str = "0"
    # 三层记忆（前端可能传回来）
    memory_core: str = ""
    memory_recent: str = ""


class MemoryActionRequest(BaseModel):
    force: bool = False

class QuotePayload(BaseModel):
    text: str = Field(default="", max_length=4000)
    page: Optional[int] = None
    section: Optional[str] = None
    anchor: dict = Field(default_factory=dict)
    created_at: Optional[str] = None

class ChatRequest(BaseModel):
    paper_title: str = Field(max_length=500)
    paper_abstract: str = Field(default="", max_length=5000)
    message: str = Field(max_length=2000)
    history: list[dict] = []
    paper_rowid: int = 0
    current_page: Optional[int] = None
    current_page_text: str = Field(default="", max_length=12000)
    quote: Optional[QuotePayload] = None

class SummarizeChatRequest(BaseModel):
    paper_title: str
    paper_rowid: int
    messages: list[dict]

class SavePaperRequest(BaseModel):
    paper: dict
    chats: list[dict] = []

class SaveNoteRequest(BaseModel):
    paper_rowid: int
    content: str
    source: str = "manual"
    note_id: int = None

class SaveQuoteRequest(BaseModel):
    paper_rowid: int
    text: str = Field(min_length=1, max_length=4000)
    page: Optional[int] = None
    section: Optional[str] = None
    anchor: dict = Field(default_factory=dict)
    question: str = Field(default="", max_length=2000)
    answer: str = Field(default="", max_length=4000)
    source: str = Field(default="quote", max_length=30)

class BoardPatchRequest(BaseModel):
    sections: Optional[list] = None
    why_reading: Optional[str] = Field(default=None, max_length=1000)

class BoardItemRequest(BaseModel):
    section: str = Field(min_length=1, max_length=40)
    content: str = Field(min_length=1, max_length=8000)
    quote: str = Field(default="", max_length=4000)
    page: Optional[int] = None
    source: str = Field(default="selection", max_length=20)

class BoardItemPatchRequest(BaseModel):
    content: Optional[str] = Field(default=None, max_length=8000)
    section: Optional[str] = Field(default=None, max_length=40)
    sort_order: Optional[int] = None

class FeedbackRequest(BaseModel):
    type: str = "general"
    content: str

class CreateCardRequest(BaseModel):
    paper_rowid: int
    card_type: str = "method"
    title: str = Field(default="", max_length=200)
    content: str = Field(min_length=1, max_length=4000)
    quote: str = Field(default="", max_length=2000)
    page: Optional[int] = None
    source: str = "manual"

class UpdateCardRequest(BaseModel):
    card_type: Optional[str] = None
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = Field(default=None, max_length=4000)

class CustomLLMRequest(BaseModel):
    enabled: bool = True
    preset: str = Field(default="openrouter", max_length=40)
    base_url: str = Field(max_length=300)
    api_key: str = Field(default="", max_length=300)  # 空 = 保留已存的 key
    model: str = Field(default="", max_length=200)

class CustomLLMProbeRequest(BaseModel):
    base_url: str = Field(max_length=300)
    api_key: str = Field(default="", max_length=300)  # 空 = 用已存的 key
    model: str = Field(default="", max_length=200)

class DraftCardRequest(BaseModel):
    paper_title: str = Field(max_length=500)
    paper_abstract: str = Field(default="", max_length=5000)
    card_type: str = "method"
    quote: str = Field(default="", max_length=2000)
    page: Optional[int] = None
    question: str = Field(default="", max_length=2000)
    answer: str = Field(default="", max_length=4000)

class DeepReadGuideRequest(BaseModel):
    paper_title: str = Field(max_length=500)
    paper_abstract: str = Field(default="", max_length=5000)
    page: Optional[int] = None
    page_text: str = Field(default="", max_length=12000)
    mode: str = Field(default="page", max_length=30)

class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""

class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None

class SetPaperProjectRequest(BaseModel):
    project_id: Optional[int] = None


# ========== User ID ==========

def _get_user_id(request: Request) -> str:
    """从请求头获取用户 ID"""
    return request.headers.get("X-User-ID", "anonymous")


def _get_client_ip(request: Request) -> str:
    """获取客户端真实 IP（nginx 反代场景读 X-Forwarded-For）"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _get_owned_paper_or_none(paper_id: int, user_id: str) -> Optional[dict]:
    """只返回当前用户自己的收藏论文。"""
    paper = get_saved_paper(paper_id)
    if not paper:
        return None
    if paper.get("user_id", "") != user_id:
        return None
    return paper


# ========== Settings Routes（简化：只显示内置状态） ==========

@app.get("/api/settings")
def api_get_settings():
    """返回当前 LLM 配置状态（内置链 + 自定义通道）"""
    client, model = _get_llm_client()
    provider_name = ""
    for p in _LLM_PROVIDERS:
        if p["model"] == model:
            provider_name = p["name"]
            break
    custom = get_custom_provider_safe()
    return {
        "provider": provider_name,
        "model": model,
        "base_url": "",
        "api_key_masked": "内置" if client else "未配置",
        "builtin": True,
        "custom": custom,
        "active": ("custom" if (custom.get("enabled") and custom.get("has_key") and custom.get("model")) else "builtin"),
    }

@app.post("/api/settings")
def api_save_settings():
    """内置 API 模式下，保存操作为空操作（兼容前端调用）"""
    return {"ok": True, "builtin": True}


@app.get("/api/zotero-plugin/update.json")
def api_zotero_plugin_update():
    """Zotero 插件 update_url 的应答（manifest 必填字段，返回"无更新"即可）"""
    return {"addons": {"papermind-connector@papermind.local": {"updates": []}}}


# ========== 自定义 LLM 通道 ==========

@app.post("/api/settings/custom-llm")
def api_save_custom_llm(data: CustomLLMRequest):
    """保存自定义 API 配置；api_key 传空表示沿用已存的 key"""
    current = get_custom_provider()
    api_key = data.api_key.strip() or current.get("api_key", "")
    base_url = data.base_url.strip().rstrip("/")
    if data.enabled and not (api_key and base_url and data.model.strip()):
        return {"ok": False, "error": "启用自定义通道需要完整填写 API 地址、Key 和模型名。"}
    save_custom_provider({
        "enabled": data.enabled,
        "preset": data.preset.strip() or "custom",
        "base_url": base_url,
        "api_key": api_key,
        "model": data.model.strip(),
    })
    return {"ok": True, "custom": get_custom_provider_safe()}


@app.delete("/api/settings/custom-llm")
def api_delete_custom_llm():
    """清除自定义 API 配置，回到纯内置链"""
    save_custom_provider({})
    return {"ok": True}


@app.post("/api/settings/custom-llm/models")
async def api_list_custom_llm_models(data: CustomLLMProbeRequest):
    """调用 provider 的 /models 接口，列出该账号实际可用的模型"""
    api_key = data.api_key.strip() or get_custom_provider().get("api_key", "")
    base_url = data.base_url.strip().rstrip("/")
    if not (api_key and base_url):
        return {"ok": False, "error": "请先填写 API 地址和 Key。"}
    try:
        # 不固定 transport：自定义通道可能是国外服务，需要走系统代理
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code != 200:
            return {"ok": False, "error": f"HTTP {resp.status_code}：{resp.text[:150]}"}
        payload = resp.json()
        items = payload.get("data", payload if isinstance(payload, list) else [])
        models = sorted({
            (m.get("id") or "").strip()
            for m in items if isinstance(m, dict) and m.get("id")
        })
        if not models:
            return {"ok": False, "error": "该接口没有返回模型列表，请手动填写模型名。"}
        return {"ok": True, "models": models[:500]}
    except Exception as e:
        return {"ok": False, "error": f"获取失败：{str(e)[:150]}"}


@app.post("/api/settings/custom-llm/test")
async def api_test_custom_llm(data: CustomLLMProbeRequest):
    """对填写的配置发一次最小对话请求，验证连通性"""
    api_key = data.api_key.strip() or get_custom_provider().get("api_key", "")
    base_url = data.base_url.strip().rstrip("/")
    model = data.model.strip()
    if not (api_key and base_url and model):
        return {"ok": False, "error": "请先填写 API 地址、Key 和模型名。"}
    client = None
    try:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=30.0)
        started = time.monotonic()
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "回复两个字：正常"}],
            max_tokens=16,
            temperature=0,
        )
        latency_ms = int((time.monotonic() - started) * 1000)
        reply = (resp.choices[0].message.content or "").strip()
        return {"ok": True, "latency_ms": latency_ms, "reply": reply[:60], "model": model}
    except Exception as e:
        return {"ok": False, "error": str(e)[:250]}
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass

@app.post("/api/settings/test")
async def api_test_settings(request: Request):
    uid = _get_user_id(request)
    if not OWNER_UID:
        return {
            "ok": False,
            "error": "服务端尚未配置 OWNER_UID，请先在 .env 中填入你的设备 ID。",
            "needs_owner_uid": True,
        }
    is_owner = OWNER_UID and uid == OWNER_UID
    # 仅 owner 可调用，防止任意用户消耗 token 做连通性测试
    if not is_owner:
        return {"ok": False, "error": "无权限，仅限 owner 设备测试 AI 连通性。"}
    result = await _llm_complete_async("请回复两个字：成功", max_tokens=10, task="chat")
    if result:
        return {"ok": True, "reply": result}
    return {"ok": False, "error": "AI 服务不可用，请检查 API Key 配置"}


# ========== Profile Routes ==========

@app.get("/api/profile")
def api_get_profile(request: Request):
    uid = _get_user_id(request)
    return get_profile(uid)

@app.post("/api/profile")
def api_save_profile(data: ProfileData, request: Request):
    uid = _get_user_id(request)
    previous = get_profile(uid)
    next_profile = data.model_dump()

    # 保留后端管理的记忆字段，不被前端覆盖
    for key in ("memory_core", "memory_recent", "behavior_events_since_recent",
                "last_recent_updated_at", "last_core_merged_at", "core_source"):
        next_profile[key] = previous.get(key, "")

    watched_fields = ("focus_areas", "exclude_areas", "method_interests", "current_goal", "background", "discipline", "tracking_days")
    profile_changed = any((previous.get(field) or "") != (next_profile.get(field) or "") for field in watched_fields)

    if profile_changed:
        # 旧字段保留兼容，但不再参与新记忆逻辑
        next_profile["interests_summary"] = ""
        next_profile["interests_summary_is_manual"] = "0"
        next_profile["interests_summary_updated_at"] = ""
        next_profile["behavior_events_since_summary"] = "0"
    else:
        prev_summary = previous.get("interests_summary", "")
        new_summary = next_profile.get("interests_summary", "")
        next_profile["behavior_events_since_summary"] = previous.get("behavior_events_since_summary", "0")
        if new_summary != prev_summary:
            next_profile["interests_summary_updated_at"] = datetime.now().isoformat()
        else:
            next_profile["interests_summary_updated_at"] = previous.get("interests_summary_updated_at", "")
            next_profile["interests_summary_is_manual"] = previous.get("interests_summary_is_manual", "0")

    save_profile(uid, next_profile)

    if profile_changed:
        _reset_user_cache(uid)

    # 首次生成长期骨架：放后台线程，不阻塞保存响应
    if not previous.get("memory_core", "").strip():
        def _bg_init_core():
            try:
                asyncio.run(ensure_memory_core(uid, get_profile(uid)))
            except Exception as e:
                print(f"[memory] 初始 memory_core 生成失败: {e}")
        threading.Thread(target=_bg_init_core, daemon=True).start()

    return {"ok": True}

@app.post("/api/profile/memory-recent")
async def api_update_memory_recent(data: MemoryActionRequest, request: Request):
    uid = _get_user_id(request)
    return await update_memory_recent(uid, force=data.force)


@app.post("/api/profile/merge-to-core")
async def api_merge_recent_to_core(data: MemoryActionRequest, request: Request):
    uid = _get_user_id(request)
    return await merge_recent_to_core(uid)


@app.post("/api/profile/interests-summary")
async def api_update_interests_summary_compat(data: MemoryActionRequest, request: Request):
    """兼容旧前端调用，内部转到 memory_recent 逻辑。"""
    return await api_update_memory_recent(data, request)


# ========== Papers Cache（按用户隔离） ==========

_papers_cache: dict[str, dict] = {}

def _get_user_cache(user_id: str) -> dict:
    if user_id not in _papers_cache:
        _papers_cache[user_id] = {
            "papers": [],
            "fetched_at": None,
            "served_indices": set(),
            "fetching": False,    # 是否正在后台抓取
            "fetching_since": None,  # 抓取开始时间，用于超时检测
            "enriching": False,   # 是否正在后台解读
            "enrich_gen": 0,      # 解读代次，防止旧线程清掉新状态
            "current_page": [],   # 当前页 (index, paper) 列表
            "pages_history": [],  # 历史页列表，用于回退
            "search_debug": get_latest_search_run(user_id),
        }
    return _papers_cache[user_id]


def _reset_user_cache(user_id: str):
    """画像或时间窗变化后，清空用户推荐缓存，确保新设置立即生效。"""
    cache = _get_user_cache(user_id)
    cache["papers"] = []
    cache["fetched_at"] = None
    cache["served_indices"] = set()
    cache["fetching"] = False
    cache["fetching_since"] = None
    cache["enriching"] = False
    cache["enrich_gen"] = 0
    cache["current_page"] = []
    cache["pages_history"] = []
    cache["search_debug"] = None


def _start_page_enrich(cache: dict, papers: list[dict], profile: dict, uid: str) -> bool:
    """为当前页启动后台解读，避免尾页遗漏。"""
    unenriched = [p for p in papers if not p.get("summary_zh") and p.get("_enrich_attempts", 0) < MAX_ENRICH_ATTEMPTS]
    if not unenriched:
        return False

    client, model = _get_llm_client()
    if not client:
        for paper in papers:
            if not paper.get("summary_zh"):
                paper["summary_status"] = "failed"
        return False

    for paper in unenriched:
        paper["summary_status"] = "pending"

    cache["enrich_gen"] += 1
    gen = cache["enrich_gen"]
    cache["enriching"] = True
    threading.Thread(
        target=_bg_enrich,
        args=(cache, unenriched, profile, uid, gen),
        daemon=True,
    ).start()
    return True


# ========== Papers Routes ==========

def _bg_fetch_and_enrich(cache, keyword_list, days, source, profile, uid):
    """后台线程：抓取论文 + AI 解读"""
    try:
        papers, search_debug = fetch_and_rank_papers(keyword_list, days, source, profile, uid)
        cache["papers"] = papers
        cache["fetched_at"] = datetime.now()
        cache["served_indices"] = set()
        cache["current_page"] = []
        cache["pages_history"] = []
        cache["search_debug"] = search_debug

        unenriched = [p for p in papers[:10] if not p.get("summary_zh")]
        print(f"[api] 准备解读: {len(papers)} 篇论文, 前10中未解读 {len(unenriched)} 篇")
        if unenriched:
            client, model = _get_llm_client()
            print(f"[api] LLM client 可用: {client is not None}, model={model}")
            if client:
                _enrich_papers_with_llm(unenriched, profile, uid)
        print(f"[api] 后台抓取完成: {len(papers)} 篇")
    except Exception as e:
        import traceback
        print(f"[api] 后台抓取失败: {e}")
        traceback.print_exc()
    finally:
        cache["fetching"] = False
        cache["fetching_since"] = None


def _bg_enrich(cache, papers, profile, uid, gen):
    """后台线程：解读当前页论文。gen 用于防止旧线程误清新状态。"""
    try:
        client, model = _get_llm_client()
        if client:
            _enrich_papers_with_llm(papers, profile, uid)
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
    back: bool = Query(default=False),
):
    """获取论文。首次请求触发后台抓取，前端轮询获取结果。"""
    uid = _get_user_id(request)
    client_ip = _get_client_ip(request)
    cache = _get_user_cache(uid)

    # 如果前端没传 days，从用户画像读取 tracking_days
    if days <= 0:
        profile_tmp = get_profile(uid)
        days = int(profile_tmp.get("tracking_days") or 90)

    # poll=true: 返回当前页最新状态（不切换、不抓取）
    if poll and cache["current_page"]:
        page = cache["current_page"]
        page_papers = [p for _, p in page]
        profile = get_profile(uid)
        if not cache["enriching"]:
            _start_page_enrich(cache, page_papers, profile, uid)
        all_papers = cache["papers"]
        remaining = len([i for i in range(len(all_papers)) if i not in cache["served_indices"]])
        enriching = cache["enriching"]
        return {
            "papers": page_papers,
            "total": len(all_papers),
            "remaining": remaining,
            "enriching": enriching,
            "can_go_back": len(cache.get("pages_history", [])) > 0,
            "search_debug": cache.get("search_debug"),
        }

    # back=true: 回退到上一批
    if back and cache.get("pages_history"):
        prev_page = cache["pages_history"].pop()
        # 把当前页从 served_indices 移除（回退），再换回上一页
        for idx, _ in cache["current_page"]:
            cache["served_indices"].discard(idx)
        cache["current_page"] = prev_page
        all_papers = cache["papers"]
        page_papers = []
        for idx, p in prev_page:
            p["_cache_index"] = idx
            page_papers.append(p)
        remaining = len([i for i in range(len(all_papers)) if i not in cache["served_indices"]])
        back_profile = get_profile(uid)
        enriching = _start_page_enrich(cache, page_papers, back_profile, uid)
        return {
            "papers": page_papers,
            "total": len(all_papers),
            "remaining": remaining,
            "all_explored": False,
            "enriching": enriching,
            "can_go_back": len(cache["pages_history"]) > 0,
            "search_debug": cache.get("search_debug"),
        }

    keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
    profile = get_profile(uid)

    # 正在后台抓取中，返回加载状态（超时 5 分钟或 force_fetch 时自动解锁）
    if cache["fetching"]:
        fetching_since = cache.get("fetching_since")
        timed_out = fetching_since and (datetime.now() - fetching_since).total_seconds() > 300
        if not force_fetch and not timed_out:
            return {"papers": [], "total": 0, "remaining": 0, "loading": True, "search_debug": cache.get("search_debug")}
        # 超时或强制解锁：重置 fetching 状态，允许重新发起抓取
        cache["fetching"] = False
        cache["fetching_since"] = None

    # 判断是否需要重新抓取
    need_fetch = force_fetch or not cache["papers"]
    if cache["fetched_at"]:
        age = (datetime.now() - cache["fetched_at"]).total_seconds()
        if age > 3600:
            need_fetch = True

    # Rate limit（owner 不限量）：只对用户主动「重新抓取」计费，
    # 缓存重建（服务重启 / 缓存过期）不消耗配额
    is_owner = OWNER_UID and uid == OWNER_UID
    if not is_owner and force_fetch:
        remaining_quota = get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT)
        ip_remaining = get_rate_limit_remaining(f"ip:{client_ip}", "recommend", DAILY_RECOMMEND_LIMIT)
        if remaining_quota <= 0 or ip_remaining <= 0:
            return {
                "papers": cache.get("papers") or [],
                "total": len(cache.get("papers") or []),
                "remaining": 0,
                "error": f"今日推荐批次已用完（每天 {DAILY_RECOMMEND_LIMIT} 批），明天再来吧",
                "rate_limited": True,
                "search_debug": cache.get("search_debug"),
            }

    if need_fetch:
        # 画像为空时拒绝抓取，不扣配额
        has_profile = any([
            (profile.get("focus_areas") or "").strip(),
            (profile.get("method_interests") or "").strip(),
            (profile.get("background") or "").strip(),
            (profile.get("current_goal") or "").strip(),
        ])
        if not has_profile:
            return {
                "papers": [], "total": 0, "remaining": 0,
                "needs_profile": True,
                "error": "还没有填写研究方向，推荐无法生成。请先完善研究画像。",
                "search_debug": cache.get("search_debug"),
            }
        cache["fetching"] = True
        cache["fetching_since"] = datetime.now()
        if force_fetch and not is_owner:
            increment_rate_limit(uid, "recommend")
            increment_rate_limit(f"ip:{client_ip}", "recommend")
        t = threading.Thread(
            target=_bg_fetch_and_enrich,
            args=(cache, keyword_list, days, source, profile, uid),
            daemon=True,
        )
        t.start()
        return {"papers": [], "total": 0, "remaining": 0, "loading": True, "search_debug": cache.get("search_debug")}

    all_papers = cache["papers"]
    if not all_papers:
        return {"papers": [], "total": 0, "remaining": 0, "search_debug": cache.get("search_debug")}

    # 选 10 篇还没展示过的
    all_explored = False
    if refresh:
        # 换一批前先把当前页存入历史
        if cache["current_page"]:
            cache.setdefault("pages_history", []).append(cache["current_page"])
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
    enriching = _start_page_enrich(cache, page_papers, profile, uid)

    return {
        "papers": page_papers,
        "total": len(all_papers),
        "remaining": remaining,
        "all_explored": all_explored,
        "enriching": enriching,
        "can_go_back": len(cache.get("pages_history", [])) > 0,
        "daily_remaining": get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT),
        "search_debug": cache.get("search_debug"),
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


def _extract_json_object(raw: str) -> dict:
    """尽量从模型返回中提取 JSON 对象，容忍前后多余文字。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        fragment = text[start:end + 1]
        parsed = json.loads(fragment)
        return parsed if isinstance(parsed, dict) else {}

    raise ValueError("json object not found")


def _build_understanding_profile_text(profile: dict) -> str:
    parts = []
    if profile.get("discipline"):
        parts.append(f"学科领域：{profile['discipline']}")
    if profile.get("focus_areas"):
        parts.append(f"追踪主题：{profile['focus_areas']}")
    if profile.get("method_interests"):
        parts.append(f"方法兴趣：{profile['method_interests']}")
    if profile.get("background"):
        parts.append(f"补充说明：{profile['background']}")
    memory_context = build_memory_context(profile)
    if memory_context:
        parts.append(memory_context)
    return "\n".join(parts)


def _enrich_single_paper(paper: dict, profile_text: str, cache_control: bool = False):
    """为单篇论文生成 AI 解读（可并发调用）。"""
    # ---- enrichment 缓存命中 → 跳过 LLM ----
    cached = get_enrichment_cache(paper)
    if cached and cached.get("summary_zh"):
        paper["summary_zh"] = cached["summary_zh"]
        paper["relevance"] = cached.get("relevance", "")
        paper["key_findings"] = cached.get("key_findings", [])
        paper["summary_status"] = "done"
        return

    paper["_enrich_attempts"] = paper.get("_enrich_attempts", 0) + 1
    paper["summary_status"] = "pending"
    try:
        system_content = f"""你是一位专业的学术论文解读助手。请对用户提供的论文进行详细解读。

{f"研究者背景（仅供参考，不要在输出中罗列这些关键词）：{chr(10)}{profile_text}" if profile_text else ""}

请用 JSON 格式输出以下内容：

{{
  "summary_zh": "详细中文解读（4-6句话，包含：研究背景与目的、研究方法、主要发现、意义。语言专业但易懂）",
  "relevance": "这篇论文对研究者的启发（1-2句话，80字以内，尽量简洁。只基于论文实际内容来写，不要罗列研究者画像中的关键词，也不要因为用户之前读过类似方向就硬说相关。如果论文没有直接涉及某个方向就不要提它。重点说：论文的什么发现或方法能给研究者带来什么具体启发）",
  "key_findings": ["核心发现1", "核心发现2", "核心发现3"]
}}

只输出 JSON，不加其他文字。
如提供了"用户修正后的偏好"，请综合以上信息，优先考虑研究者明确输入和用户修正后的偏好；但相关性判断仍必须以论文实际内容为依据。"""

        system_msg = {"role": "system", "content": system_content}
        if cache_control:
            system_msg["cache_control"] = {"type": "ephemeral"}

        user_msg = {"role": "user", "content": f"论文标题：{paper['title']}\n论文摘要：{paper['abstract'][:1200]}"}

        raw, _, _ = _llm_chat_complete(
            [system_msg, user_msg],
            max_tokens=800,
            temperature=0.3,
            task="enrich",
        )
        if not raw:
            raise RuntimeError("empty response")
        result = _extract_json_object(raw)
        paper["summary_zh"] = result.get("summary_zh", "")
        paper["relevance"] = result.get("relevance", "")
        paper["key_findings"] = result.get("key_findings", [])
        paper["summary_status"] = "done" if paper["summary_zh"] else "pending"
        if paper["summary_zh"]:
            save_enrichment_cache(paper, paper["summary_zh"], paper["relevance"], paper["key_findings"])
    except Exception as e:
        print(f"[api] 论文 LLM 处理失败，尝试简化重试: {e}")
        try:
            retry_prompt = f"""请只输出 JSON，为这篇论文生成简洁中文解读。

论文标题：{paper['title']}
论文摘要：{paper.get('abstract', '')[:900]}

JSON 格式：
{{
  "summary_zh": "3-4句话，概括研究对象、方法、主要发现和意义",
  "relevance": "1-2句话，80字以内，说明这篇论文对研究者的启发；如果直接关联有限，就明确写直接关联有限"
}}
"""
            retry_raw, _, _ = _llm_chat_complete(
                [{"role": "user", "content": retry_prompt}],
                max_tokens=500,
                temperature=0.2,
                task="enrich",
            )
            if not retry_raw:
                raise RuntimeError("empty response")
            retry_result = _extract_json_object(retry_raw)
            paper["summary_zh"] = retry_result.get("summary_zh", "")
            paper["relevance"] = retry_result.get("relevance", "")
            paper["key_findings"] = []
            paper["summary_status"] = "done" if paper["summary_zh"] else "pending"
            if paper["summary_zh"]:
                save_enrichment_cache(paper, paper["summary_zh"], paper["relevance"], paper["key_findings"])
        except Exception as retry_error:
            print(f"[api] 论文简化重试仍失败: {retry_error}")
            paper["summary_zh"] = ""
            paper["relevance"] = ""
            paper["key_findings"] = []
            paper["summary_status"] = "failed" if paper.get("_enrich_attempts", 0) >= MAX_ENRICH_ATTEMPTS else "pending"


def _enrich_papers_with_llm(papers: list[dict], profile: dict, user_id: str = ""):
    """为论文添加详细中文解读和个性化相关性分析（并发执行）"""
    print(f"[api] _enrich_papers_with_llm 入口: {len(papers)} 篇论文")
    profile_text = _build_understanding_profile_text(profile)

    is_qwen = any("qwen" in p["name"] for p in _get_llm_slots() if p["api_key"].strip())
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(_enrich_single_paper, p, profile_text, is_qwen) for p in papers]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception:
                pass


# ========== 翻译 ==========

class TranslateRequest(BaseModel):
    text: str

@app.post("/api/translate")
async def api_translate(data: TranslateRequest, request: Request):
    """将英文文本翻译为中文"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID

    if not is_owner and not check_rate_limit(uid, "translate", DAILY_TRANSLATE_LIMIT):
        return {"ok": False, "error": f"今日翻译次数已用完（每天 {DAILY_TRANSLATE_LIMIT} 次），明天再来吧。"}

    if not _has_llm_config(task="translate"):
        return {"ok": False, "error": "未配置 API"}
    try:
        translated, _, _ = await _llm_chat_complete_async(
            [{"role": "user", "content": f"请将以下英文学术文本准确翻译为中文，保持专业术语的准确性，只输出翻译结果：\n\n{data.text[:3000]}"}],
            max_tokens=2000,
            temperature=0.2,
            task="translate",
        )
        if not translated:
            raise RuntimeError("empty response")
        if not is_owner:
            increment_rate_limit(uid, "translate")
        return {"ok": True, "translated": translated}
    except Exception as e:
        print(f"[api] 翻译失败: {e}")
        return {"ok": False, "error": "翻译失败，请稍后重试"}


# ========== Deep Reading Guide ==========

@app.post("/api/deep-read/guide")
async def api_deep_read_guide(data: DeepReadGuideRequest, request: Request):
    """生成面向英文阅读困难用户的逐页/摘要精读带读。"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID

    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天恢复。"}
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"ok": False, "error": f"你今天的 AI 次数已用完（每天 {DAILY_CHAT_LIMIT} 次）。"}
    if not _has_llm_config(task="chat"):
        return {"ok": False, "error": "AI 服务暂不可用"}

    profile_text = _build_understanding_profile_text(get_profile(uid))
    mode = (data.mode or "page").strip().lower()
    source_text = ""
    if mode == "selection":
        source_label = f"第 {data.page} 页选中句子" if data.page else "选中句子"
        source_text = (data.page_text or "").strip()
    elif mode == "page":
        source_label = f"第 {data.page} 页原文" if data.page else "当前页原文"
        source_text = (data.page_text or "").strip()
    elif mode == "map":
        source_label = "论文精读路线图"
        source_text = (data.paper_abstract or "").strip()
    else:
        source_label = "论文摘要"
        source_text = (data.paper_abstract or "").strip()

    if not source_text and mode in {"page", "selection"}:
        source_text = (data.paper_abstract or "").strip()
        source_label = "论文摘要"
    if not source_text:
        return {"ok": False, "error": "还没有可精读的文本。请先上传并加载 PDF，或确认论文有摘要。"}

    if mode == "map":
        task_instruction = """请输出一份“精读路线图”，严格使用下面这些小标题：

**这篇论文先抓什么**
用 3-4 句话说明研究问题、对象/暴露/结局、核心设计，以及为什么值得读。

**论文骨架**
按 Introduction / Methods / Results / Discussion 拆出每一部分读的时候要找什么，不要泛泛总结。

**精读顺序**
给出 5 步阅读路线：先读哪里、再读哪里、每一步要确认什么。

**先弄懂的词**
列 4-6 个最影响理解的英文术语或方法词，用中文解释，并说明它在这篇里大概扮演什么角色。

**读完后要能回答**
列 4 个检查问题，帮助用户判断自己是否真的读懂。"""
    elif mode == "selection":
        task_instruction = """请专门带读用户选中的英文句子/片段，严格使用下面这些小标题：

**原句在说什么**
先用一句中文说清这句话的主干意思，不要整段机械翻译。

**句子拆开读**
把英文拆成 3-5 个语义块：英文片段 + 中文解释 + 这个片段在句子里起什么作用。

**关键词**
解释 2-4 个最容易卡住的词、变量、统计表达或连接词。

**为什么重要**
说明这句话对理解研究设计、结果、因果边界或作者论证有什么作用。

**可以继续追问**
给 2 个非常具体的追问。"""
    elif mode == "page":
        task_instruction = """请按“当前页陪读”的方式输出，严格使用下面这些小标题：

**这一页在全文的位置**
判断这一页更像 Introduction / Methods / Results / Discussion / 图表说明中的哪一类，并说明它承担什么任务。

**逐段带读**
按页面里的自然段落或信息块拆成 3-5 点：每点先说“这一块在讲什么”，再说“读的时候要抓什么”。

**英文句子拆解**
挑 2-4 个最关键、最容易读卡的英文短语或句子片段：英文片段 + 中文拆解。不要整页翻译。

**术语、变量和数字**
解释这一页里真正影响理解的术语、变量、统计量或比较关系，尽量保留数字和方向。

**暂停自测**
给 3 个检查问题，让用户读完这一页能判断自己是否懂了。

**下一步读法**
告诉用户下一页/下一段最应该盯住什么。"""
    else:
        task_instruction = """请按“摘要精读”的方式输出，严格使用下面这些小标题：

**研究问题**
用 2-3 句话讲清这篇到底想回答什么。

**方法怎么读**
把对象、暴露/干预、结局、设计和统计方法拆开说。

**结果先抓什么**
列 3 条最关键的发现，保留方向、数字和边界。

**英文关键词**
挑 3-5 个摘要里的关键英文短语，说明怎么理解。

**读正文前的问题**
列 3 个进入正文前要带着的问题。"""

    prompt = f"""你是一位耐心的论文精读老师，正在带一位英文阅读吃力但有研究经验的中文研究者读论文。
目标不是泛泛总结，也不是代替用户读完；目标是降低英文障碍，带用户抓住研究逻辑、句子结构、术语、数字和证据边界。
不要写“本文探讨了”这种空话。要像真人陪读一样，告诉用户读这一段时眼睛应该看哪里、脑子里应该确认什么。

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1200]}
{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}

正在精读：{source_label}
原文：
{source_text[:6000]}

请用中文输出，控制在 650-1000 字。
{task_instruction}"""

    try:
        guide, _, _ = await _llm_chat_complete_async(
            [{"role": "user", "content": prompt}],
            max_tokens=1400,
            temperature=0.25,
            task="chat",
        )
        if not guide:
            return {"ok": False, "error": "AI 服务当前不可用，请稍后再试。"}

        increment_rate_limit("__global__", "chat")
        if not is_owner:
            increment_rate_limit(uid, "chat")
        return {"ok": True, "guide": guide, "source": source_label}
    except Exception as e:
        print(f"[api] deep-read/guide 失败: {e}")
        return {"ok": False, "error": "精读生成失败，请稍后重试。"}


# ========== Library / 收藏库 Routes ==========

class LookupPaperRequest(BaseModel):
    query: str


def _bg_enrich_saved_paper(row_id: int, paper: dict, profile: dict, uid: str):
    """后台为手动添加的论文生成 AI 解读，并更新数据库。"""
    try:
        papers = [dict(paper)]
        _enrich_papers_with_llm(papers, profile, uid)
        enriched = papers[0]
        # 同时补充分类标签
        category = ""
        try:
            from src.categorize_papers import score_and_categorize_papers as _categorize
            client, model = _get_llm_client()
            if client:
                _categorize([enriched], profile, client, model, llm_call=_llm_chat_complete)
                category = enriched.get("category", "")
        except Exception:
            pass
        update_paper_enrichment(
            row_id,
            enriched.get("summary_zh", ""),
            enriched.get("relevance", ""),
            category,
        )
        print(f"[api] 手动添加论文解读完成 row_id={row_id}")
    except Exception as e:
        print(f"[api] 手动添加论文解读失败: {e}")


@app.post("/api/library/save")
def api_save_to_library(data: SavePaperRequest, request: Request):
    """收藏一篇论文"""
    uid = _get_user_id(request)
    row_id = save_paper(data.paper, uid)
    increment_recent_events(uid)  # 收藏 = 关键行为

    # 首次收藏时，把未收藏阶段暂存在前端的对话记录迁移到后端
    existing_chats = get_chat_history(row_id)
    if not existing_chats and data.chats:
        for msg in data.chats:
            role = msg.get("role", "")
            content = (msg.get("content", "") or "").strip()
            if role not in {"user", "assistant"} or not content:
                continue
            save_chat_message(row_id, role, content)

    # 手动添加的论文（无 summary_zh）触发后台解读
    if not data.paper.get("summary_zh") and data.paper.get("abstract"):
        profile = get_profile(uid)
        t = threading.Thread(
            target=_bg_enrich_saved_paper,
            args=(row_id, data.paper, profile, uid),
            daemon=True,
        )
        t.start()

    return {"ok": True, "id": row_id}


@app.post("/api/lookup-paper")
def api_lookup_paper(data: LookupPaperRequest, request: Request):
    """按 PMID / DOI / 标题关键词搜索论文（不保存，供手动添加预览）"""
    from src.fetch_papers import fetch_paper_details, search_pmids
    query = data.query.strip()
    if not query:
        return {"papers": []}

    try:
        # 纯数字 → PMID
        if re.match(r'^\d{5,9}$', query):
            papers = fetch_paper_details([query])
        # DOI
        elif re.match(r'^10\.\d{4,}/', query):
            pmids = search_pmids(f'"{query}"[doi]', max_results=3)
            papers = fetch_paper_details(pmids[:3]) if pmids else []
        # 标题搜索
        else:
            pmids = search_pmids(f'{query}[ti]', max_results=5)
            if not pmids:
                pmids = search_pmids(f'{query}[tiab]', max_results=5)
            papers = fetch_paper_details(pmids[:3]) if pmids else []
    except Exception as e:
        print(f"[api] lookup-paper 失败: {e}")
        return {"papers": [], "error": "查询失败，请稍后重试"}

    return {"papers": papers}

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
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        return {"error": "not found"}
    notes = get_notes(paper_id)
    chats = get_chat_history(paper_id)
    return {"paper": paper, "notes": notes, "chats": chats}

@app.delete("/api/library/{paper_id}")
def api_delete_from_library(paper_id: int, request: Request):
    """取消收藏（需验证归属）；同步清理 PDF 与图表文件"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    delete_saved_paper(paper_id)
    try:
        (PDF_DIR / f"{paper_id}.pdf").unlink(missing_ok=True)
        for f in FIGURES_DIR.glob(f"{paper_id}-*"):
            f.unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True}


@app.patch("/api/library/{paper_id}/project")
def api_set_paper_project(paper_id: int, data: SetPaperProjectRequest, request: Request):
    """设置论文所属项目（project_id=null 表示移出项目）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    set_paper_project(paper_id, data.project_id)
    return {"ok": True}


# ========== Paper PDF Upload ==========

@app.post("/api/library/{paper_id}/pdf")
async def api_upload_paper_pdf(paper_id: int, request: Request, file: UploadFile = File(...)):
    """上传论文 PDF 文件，存储在服务器本地"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        raise FastAPIHTTPException(status_code=404, detail="not found")
    if not file.content_type or "pdf" not in file.content_type.lower():
        raise FastAPIHTTPException(status_code=415, detail="只支持 PDF 文件")
    content = await file.read(PDF_SIZE_LIMIT + 1)
    if len(content) > PDF_SIZE_LIMIT:
        raise FastAPIHTTPException(status_code=413, detail="文件超过 50MB 限制")
    # 校验 PDF magic bytes
    if not content.startswith(b"%PDF"):
        raise FastAPIHTTPException(status_code=415, detail="文件不是有效的 PDF")
    pdf_path = PDF_DIR / f"{paper_id}.pdf"
    pdf_path.write_bytes(content)
    set_paper_has_pdf(paper_id, True)
    return {"ok": True, "size": len(content)}


@app.get("/api/library/{paper_id}/pdf")
def api_get_paper_pdf(paper_id: int, uid: str = Query(default="")):
    """获取已上传的论文 PDF"""
    owner = get_paper_owner(paper_id)
    if not owner or owner != uid:
        raise FastAPIHTTPException(status_code=403, detail="forbidden")
    pdf_path = PDF_DIR / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise FastAPIHTTPException(status_code=404, detail="PDF not found")
    return FileResponse(str(pdf_path), media_type="application/pdf",
                        headers={"Content-Disposition": "inline; filename=paper.pdf"})


@app.head("/api/library/{paper_id}/pdf")
def api_head_paper_pdf(paper_id: int, uid: str = Query(default="")):
    """前端用 HEAD 探测是否已上传本地 PDF（FastAPI 的 GET 不自动支持 HEAD）"""
    owner = get_paper_owner(paper_id)
    if not owner or owner != uid:
        raise FastAPIHTTPException(status_code=403, detail="forbidden")
    pdf_path = PDF_DIR / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise FastAPIHTTPException(status_code=404, detail="PDF not found")
    return PlainTextResponse("", media_type="application/pdf")


@app.delete("/api/library/{paper_id}/pdf")
def api_delete_paper_pdf(paper_id: int, request: Request):
    """删除已上传的论文 PDF"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        raise FastAPIHTTPException(status_code=404, detail="not found")
    pdf_path = PDF_DIR / f"{paper_id}.pdf"
    if pdf_path.exists():
        pdf_path.unlink()
    set_paper_has_pdf(paper_id, False)
    return {"ok": True}


# ========== Projects Routes ==========

@app.get("/api/projects")
def api_get_projects(request: Request):
    uid = _get_user_id(request)
    return {"projects": get_projects(uid)}


@app.post("/api/projects")
def api_create_project(data: CreateProjectRequest, request: Request):
    uid = _get_user_id(request)
    project_id = create_project(uid, data.name, data.description)
    return {"ok": True, "id": project_id}


@app.patch("/api/projects/{project_id}")
def api_update_project(project_id: int, data: UpdateProjectRequest, request: Request):
    uid = _get_user_id(request)
    projects = get_projects(uid)
    if not any(p["id"] == project_id for p in projects):
        return {"ok": False, "error": "not found"}
    update_project(project_id, data.name, data.description)
    return {"ok": True}


@app.delete("/api/projects/{project_id}")
def api_delete_project(project_id: int, request: Request):
    uid = _get_user_id(request)
    projects = get_projects(uid)
    if not any(p["id"] == project_id for p in projects):
        return {"ok": False, "error": "not found"}
    delete_project(project_id)
    return {"ok": True}


# ========== Notes Routes ==========

@app.post("/api/notes")
def api_save_note(data: SaveNoteRequest, request: Request):
    """保存笔记（需验证归属）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(data.paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    source = getattr(data, "source", "manual")
    note_id_param = getattr(data, "note_id", None)
    note_id = save_note(data.paper_rowid, data.content, source=source, note_id=note_id_param)
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

@app.delete("/api/notes/{note_id}")
def api_delete_note(note_id: int, request: Request):
    """删除一条笔记（需验证归属）"""
    uid = _get_user_id(request)
    if get_note_owner(note_id) != uid:
        return {"ok": False, "error": "not found"}
    delete_note(note_id)
    return {"ok": True}


# ========== Paper Quote Routes ==========

@app.get("/api/quotes/{paper_rowid}")
def api_get_quotes(paper_rowid: int, request: Request):
    """获取某篇论文的结构化 quote（需验证归属）"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
        return {"quotes": []}
    return {"quotes": get_quotes(paper_rowid)}


@app.post("/api/quotes")
def api_save_quote(data: SaveQuoteRequest, request: Request):
    """保存一条结构化 quote，用于刷新后恢复高亮和追问记录。"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(data.paper_rowid, uid):
        return {"ok": False, "error": "not found"}
    quote = save_quote(
        paper_rowid=data.paper_rowid,
        text=data.text,
        page=data.page,
        section=data.section or "",
        anchor=data.anchor,
        question=data.question,
        answer=data.answer,
        source=data.source or "quote",
    )
    increment_recent_events(uid)
    return {"ok": True, "quote": quote}


@app.delete("/api/quotes/{quote_id}")
def api_delete_quote(quote_id: int, request: Request):
    """删除一条结构化 quote（需验证归属）"""
    uid = _get_user_id(request)
    if get_quote_owner(quote_id) != uid:
        return {"ok": False, "error": "not found"}
    delete_quote(quote_id)
    return {"ok": True}


# ========== Presentation Board Routes（组会汇报板）==========

@app.get("/api/board/{paper_rowid}")
def api_get_board(paper_rowid: int, request: Request):
    """汇报板结构 + 全部条目；首次访问惰性创建，why_reading 默认取推荐理由"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    board = get_or_create_board(paper_rowid, why_reading=paper.get("relevance") or "")
    return {
        "ok": True,
        "sections": board["sections"],
        "why_reading": board["why_reading"],
        "items": get_board_items(paper_rowid),
    }


@app.patch("/api/board/{paper_rowid}")
def api_patch_board(paper_rowid: int, data: BoardPatchRequest, request: Request):
    """修改板块结构（增删改名）或 why_reading"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
        return {"ok": False, "error": "not found"}
    if data.sections is not None:
        cleaned = [
            {"key": str(s.get("key", ""))[:40], "title": str(s.get("title", ""))[:60]}
            for s in data.sections
            if isinstance(s, dict) and s.get("key") and s.get("title")
        ]
        if not cleaned:
            return {"ok": False, "error": "sections empty"}
        update_board(paper_rowid, sections=cleaned)
    if data.why_reading is not None:
        update_board(paper_rowid, why_reading=data.why_reading)
    return {"ok": True}


@app.post("/api/board/{paper_rowid}/items")
def api_add_board_item(paper_rowid: int, data: BoardItemRequest, request: Request):
    """投递条目到板块（划词/带读/卡片/对话/手动）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    get_or_create_board(paper_rowid, why_reading=paper.get("relevance") or "")
    item = add_board_item(
        paper_rowid, data.section, data.content,
        quote=data.quote, page=data.page, source=data.source,
    )
    increment_recent_events(uid)
    return {"ok": True, "item": item}


@app.patch("/api/board/items/{item_id}")
def api_patch_board_item(item_id: int, data: BoardItemPatchRequest, request: Request):
    uid = _get_user_id(request)
    if get_board_item_owner(item_id) != uid:
        return {"ok": False, "error": "not found"}
    update_board_item(item_id, content=data.content, section=data.section, sort_order=data.sort_order)
    return {"ok": True}


@app.delete("/api/board/items/{item_id}")
def api_delete_board_item(item_id: int, request: Request):
    uid = _get_user_id(request)
    if get_board_item_owner(item_id) != uid:
        return {"ok": False, "error": "not found"}
    item = get_board_item(item_id)
    delete_board_item(item_id)
    # 图表条目同步删除图片文件
    if item and item.get("image"):
        try:
            (FIGURES_DIR / item["image"]).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/board/{paper_rowid}/figures")
async def api_add_board_figure(
    paper_rowid: int, request: Request,
    file: UploadFile = File(...),
    section: str = Form(...),
    page: Optional[int] = Form(None),
    caption: str = Form(""),
):
    """图表截图入板：保存 PNG + 创建 source=figure 的条目"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    content = await file.read()
    if len(content) > FIGURE_SIZE_LIMIT:
        return {"ok": False, "error": "图片超过 10MB"}
    if not content[:8] == b"\x89PNG\r\n\x1a\n" and not content[:3] == b"\xff\xd8\xff":
        return {"ok": False, "error": "仅支持 PNG/JPEG"}
    ext = "png" if content[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    name = f"{paper_rowid}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.{ext}"
    (FIGURES_DIR / name).write_bytes(content)
    get_or_create_board(paper_rowid, why_reading=paper.get("relevance") or "")
    item = add_board_item(
        paper_rowid, section,
        content=caption or (f"图表（P.{page}）" if page else "图表"),
        page=page, source="figure", image=name,
    )
    increment_recent_events(uid)
    return {"ok": True, "item": item}


@app.get("/api/board/{paper_rowid}/figures/{name}")
def api_get_board_figure(paper_rowid: int, name: str, request: Request, uid: str = Query("")):
    """图表图片；<img> 无法带 header，允许 ?uid= 查询参数鉴权（沿用深链模式）"""
    user = _get_user_id(request)
    if user == "anonymous" and uid:
        user = uid
    if not _get_owned_paper_or_none(paper_rowid, user):
        return PlainTextResponse("not found", status_code=404)
    # 防路径穿越 + 校验归属前缀
    if not re.fullmatch(r"[\w.-]+", name) or not name.startswith(f"{paper_rowid}-"):
        return PlainTextResponse("not found", status_code=404)
    path = FIGURES_DIR / name
    if not path.exists():
        return PlainTextResponse("not found", status_code=404)
    media = "image/png" if name.endswith(".png") else "image/jpeg"
    return FileResponse(path, media_type=media)


@app.get("/api/board/{paper_rowid}/export/marp")
def api_export_board_marp(paper_rowid: int, request: Request):
    """导出 Marp Markdown（白底黑字极简）；空板块出占位页——骨架即进度"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return PlainTextResponse("not found", status_code=404)
    board = get_or_create_board(paper_rowid, why_reading=paper.get("relevance") or "")
    items = get_board_items(paper_rowid)
    by_section: dict = {}
    for it in items:
        by_section.setdefault(it["section"], []).append(it)

    def esc(s: str) -> str:
        return (s or "").replace("\r", "").strip()

    # pub_date 格式不定（"2026-09" / "09/2026"），正则提取四位年份
    year_m = re.search(r"\b(19|20)\d{2}\b", paper.get("pub_date") or "")
    year = year_m.group(0) if year_m else ""
    lines = [
        "---",
        "marp: true",
        "paginate: true",
        "style: |",
        "  section { background: #ffffff; color: #111111; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; }",
        "  h1, h2 { color: #000000; }",
        "  blockquote { color: #555555; border-left: 3px solid #999999; font-size: 0.8em; }",
        "---",
        "",
        f"# {esc(paper.get('title'))}",
        "",
        f"**{esc(paper.get('authors'))}**",
        "",
        f"{esc(paper.get('journal'))}{' · ' + year if year else ''}{' · DOI: ' + esc(paper.get('doi')) if paper.get('doi') else ''}",
        "",
        f"> 为什么读这篇：{esc(board['why_reading']) or '（待填入）'}",
        "",
        "汇报人：＿＿＿＿　　日期：＿＿＿＿",
    ]
    for sec in board["sections"]:
        lines += ["", "---", "", f"## {sec['title']}", ""]
        sec_items = by_section.get(sec["key"], [])
        if not sec_items:
            lines.append("（待填入）")
            continue
        for it in sec_items:
            # 图表条目：base64 内联进 md，导出文件单独可用（Marp 支持 data URI）
            if it.get("image"):
                fig_path = FIGURES_DIR / it["image"]
                if fig_path.exists():
                    mime = "image/png" if it["image"].endswith(".png") else "image/jpeg"
                    b64 = base64.b64encode(fig_path.read_bytes()).decode()
                    lines.append(f"![h:420](data:{mime};base64,{b64})")
                    lines.append("")
                    lines.append(esc(it["content"]))
                    continue
            # bullet 内换行需两空格缩进续行，否则破坏 Markdown 列表结构
            content = esc(it["content"]).replace("\n", "\n  ")
            lines.append(f"- {content}")
            quote = esc(it.get("quote") or "")
            # 划词条目 quote 即 content，重复输出没有信息量，只留页码
            if quote and quote != esc(it["content"]):
                page_tag = f"（P.{it['page']}）" if it.get("page") else ""
                lines.append(f"  > {quote[:300]}{page_tag}")
            elif it.get("page"):
                lines.append(f"  > P.{it['page']}")
    md = "\n".join(lines) + "\n"
    return PlainTextResponse(
        md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="board-{paper_rowid}.md"'},
    )


# ========== Reading Cards Routes ==========

CARD_TYPE_LABELS = {
    "method": "方法卡",
    "finding": "发现卡",
    "critique": "批判卡",
    "transfer": "迁移卡",
}

CARD_TYPE_GUIDES = {
    "method": "提炼这篇论文的方法学要点：研究设计、样本策略、测量工具、统计/分析方法。写清楚每一步做了什么、为什么这样做。",
    "finding": "提炼核心发现：主要结果、关键数据（效应量、置信区间等具体数字）、结论。",
    "critique": "提炼值得批判性思考的点：局限性、潜在偏倚、样本或方法的不足、结论是否被数据支撑。",
    "transfer": "提炼可迁移的启发：这个方法/思路能否用到用户自己的研究里，具体怎么用，需要注意什么。",
}


@app.post("/api/cards")
def api_create_card(data: CreateCardRequest, request: Request):
    """创建阅读卡片（需验证归属）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(data.paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    if data.card_type not in CARD_TYPES:
        return {"ok": False, "error": "invalid card_type"}
    card_id = save_card(
        data.paper_rowid, data.card_type, data.title, data.content,
        quote=data.quote, page=data.page, source=data.source,
    )
    increment_recent_events(uid)  # 沉淀卡片 = 关键行为
    return {"ok": True, "id": card_id}


@app.get("/api/cards/{paper_rowid}")
def api_get_cards(paper_rowid: int, request: Request):
    """获取某篇论文的全部卡片（需验证归属）"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
        return {"cards": []}
    return {"cards": get_cards(paper_rowid)}


@app.patch("/api/cards/{card_id}")
def api_update_card(card_id: int, data: UpdateCardRequest, request: Request):
    """编辑卡片（需验证归属）"""
    uid = _get_user_id(request)
    if get_card_owner(card_id) != uid:
        return {"ok": False, "error": "not found"}
    update_card(card_id, card_type=data.card_type, title=data.title, content=data.content)
    return {"ok": True}


@app.delete("/api/cards/{card_id}")
def api_delete_card(card_id: int, request: Request):
    """删除卡片（需验证归属）"""
    uid = _get_user_id(request)
    if get_card_owner(card_id) != uid:
        return {"ok": False, "error": "not found"}
    delete_card(card_id)
    return {"ok": True}


@app.post("/api/cards/draft")
async def api_draft_card(data: DraftCardRequest, request: Request):
    """AI 起草一张卡片（不落库，前端展示可编辑草稿）"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID

    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天恢复。"}
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"ok": False, "error": f"你今天的 AI 次数已用完（每天 {DAILY_CHAT_LIMIT} 次）。"}
    if not _has_llm_config(task="chat"):
        return {"ok": False, "error": "AI 服务暂不可用"}

    card_type = data.card_type if data.card_type in CARD_TYPES else "method"
    profile = get_profile(uid)
    profile_text = _build_understanding_profile_text(profile)

    context_parts = []
    if data.quote:
        page_note = f"（第 {data.page} 页）" if data.page else ""
        context_parts.append(f"用户在原文划选的段落{page_note}：\n\"{data.quote}\"")
    if data.question:
        context_parts.append(f"用户的追问：{data.question}")
    if data.answer:
        context_parts.append(f"AI 此前的回答：{data.answer[:2000]}")
    context = "\n\n".join(context_parts) if context_parts else "（用户没有提供划选段落，请基于论文摘要提炼）"

    system_prompt = f"""你是一位学术阅读助手，帮用户把读到的内容沉淀为一张「{CARD_TYPE_LABELS[card_type]}」。
{CARD_TYPE_GUIDES[card_type]}

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1500]}

{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}

严格按以下 JSON 格式输出，不要输出其他内容：
{{"title": "一句话卡片标题（15 字以内）", "content": "卡片正文，100-250 字，可用简短列表，聚焦具体细节和数字，不要空话"}}"""

    try:
        raw, _, _ = await _llm_chat_complete_async(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": context},
            ],
            max_tokens=700,
            temperature=0.3,
            task="chat",
        )
        if not raw:
            return {"ok": False, "error": "AI 服务当前不可用，请稍后再试。"}

        increment_rate_limit("__global__", "chat")
        if not is_owner:
            increment_rate_limit(uid, "chat")

        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return {"ok": False, "error": "AI 输出格式异常，请重试。"}
        parsed = json.loads(match.group(0))
        title = str(parsed.get("title", "")).strip()
        content = str(parsed.get("content", "")).strip()
        if not content:
            return {"ok": False, "error": "AI 输出为空，请重试。"}
        return {"ok": True, "title": title, "content": content, "card_type": card_type}
    except json.JSONDecodeError:
        return {"ok": False, "error": "AI 输出解析失败，请重试。"}
    except Exception as e:
        print(f"[api] cards/draft 失败: {e}")
        return {"ok": False, "error": "起草失败，请稍后重试。"}


# ========== Chat Route ==========

@app.post("/api/chat")
async def api_chat(data: ChatRequest, request: Request):
    """和 AI 讨论一篇论文"""
    uid = _get_user_id(request)
    if data.paper_rowid and not _get_owned_paper_or_none(data.paper_rowid, uid):
        return {"reply": "未找到这篇论文，或你没有权限访问它。", "ok": False}

    is_owner = OWNER_UID and uid == OWNER_UID

    # 全局熔断：所有用户对话总量超限时暂停服务
    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"reply": "今日 AI 对话服务使用量已达上限，明天零点后恢复，感谢理解。", "ok": False, "rate_limited": True}

    # 用户级限速（owner 不限）
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"reply": f"你今天的 AI 对话次数已用完（每天 {DAILY_CHAT_LIMIT} 次），明天再来吧。", "ok": False, "rate_limited": True}

    profile = get_profile(uid)
    profile_text = _build_understanding_profile_text(profile)

    # 获取该论文的历史笔记
    notes_context = ""
    if data.paper_rowid:
        notes = get_notes(data.paper_rowid)
        if notes:
            notes_context = f"\n用户关于这篇论文的笔记：\n{notes[0]['content'][:500]}"

    page_context = ""
    current_page_text = (data.current_page_text or "").strip()
    if current_page_text:
        page_label = f"第 {data.current_page} 页" if data.current_page else "当前页"
        page_context = f"""
用户当前正在看的页面：{page_label}
当前页 PDF 文字层内容（可能包含图题、图注、坐标轴文字和正文；这不是视觉识别，若图像细节不足，应说明只能依据文字层/图注判断）：
{current_page_text[:5000]}
"""

    system_prompt = f"""你是一位学术研究伙伴。用户正在阅读一篇论文，请基于论文内容和用户的研究背景来回答问题。
用中文回答，专业但亲切，像同事在聊天，不像在写报告。

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1200]}

{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}
{notes_context}
{page_context}

回答要求：
- 直接回答问题，控制在 150-250 字
- 不要用 ### 标题分层，可以用 **加粗** 强调关键词
- 可以用短列表，但不要超过 3 条
- 结合用户研究背景给出具体建议
- 引用论文数据时给出具体数字"""
    if page_context:
        system_prompt += """
- 如果用户问 Fig/Figure/图/表/这张图/这一页/上面这个，优先根据当前页文字层、图题和图注解释；不要直接说“我看不见图”，除非当前页文字也不足
- 对图表问题，要先说明这张图想比较什么，再解释各 panel/坐标轴/颜色/组别代表什么，最后讲它支持了什么结论"""

    if not _has_llm_config(task="chat"):
        return {"reply": "AI 服务暂不可用，请稍后重试", "ok": False}

    messages = [{"role": "system", "content": system_prompt}]
    for msg in data.history[-8:]:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})

    user_content = data.message
    if data.quote and data.quote.text:
        page_note = f" p.{data.quote.page}" if data.quote.page else ""
        user_content = f"[引用{page_note}] \"{data.quote.text}\"\n\n{data.message}"
    messages.append({"role": "user", "content": user_content})

    try:
        reply, _, _ = await _llm_chat_complete_async(
            messages,
            max_tokens=600,
            temperature=0.4,
            task="chat",
        )
        if not reply:
            return {"reply": "所有 AI 服务当前不可用（可能是配额耗尽），请稍后再试。", "ok": False}

        # 计入限速
        increment_rate_limit("__global__", "chat")
        if not is_owner:
            increment_rate_limit(uid, "chat")

        # 如果已收藏，持久化对话
        saved_quote = None
        if data.paper_rowid:
            save_chat_message(data.paper_rowid, "user", user_content)
            save_chat_message(data.paper_rowid, "assistant", reply)
            if data.quote and data.quote.text:
                saved_quote = save_quote(
                    paper_rowid=data.paper_rowid,
                    text=data.quote.text,
                    page=data.quote.page,
                    section=data.quote.section or "",
                    anchor=data.quote.anchor,
                    question=data.message,
                    answer=reply,
                    source="chat",
                )
            increment_recent_events(uid)  # 对话 = 关键行为

        return {"reply": reply, "ok": True, "quote": saved_quote}
    except Exception as e:
        print(f"[api] chat 失败: {e}")
        return {"reply": "AI 回复失败，请稍后重试。", "ok": False}


# ========== Chat Summary → Notes ==========

@app.post("/api/chat/summarize")
async def api_summarize_chat(data: SummarizeChatRequest, request: Request):
    """将对话总结为笔记并保存（需验证归属）"""
    if not data.messages or not data.paper_rowid:
        return {"ok": False, "error": "缺少对话内容或论文ID"}
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(data.paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}

    # 构建对话文本
    chat_text = "\n".join(
        f"{'用户' if m.get('role') == 'user' else 'AI'}：{m.get('content', '')}"
        for m in data.messages
    )

    prompt = f"""请将以下关于论文「{data.paper_title}」的讨论对话总结为结构化研究笔记。

要求：
- 提取 3-5 个关键收获，每条 1-2 句话
- 保留具体数据、方法名、统计结果等细节
- 如有方法学讨论、研究思路、下一步想法，单独列出
- 用编号列表格式，语言简洁专业
- 控制在 300-500 字

对话内容：
{chat_text[:3000]}

只输出笔记正文，不加标题或前缀。"""

    # 全局熔断同样适用
    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天零点后恢复。"}

    result = await _llm_complete_async(prompt, max_tokens=1200, task="summary")
    if not result:
        return {"ok": False, "error": "AI 总结失败"}

    increment_rate_limit("__global__", "chat")

    # 每次总结作为独立笔记保存，不追加到已有笔记
    save_note(data.paper_rowid, result, source="chat_summary")

    return {"ok": True, "note": result}


# ========== Reading History ==========

@app.post("/api/reading-history")
def api_record_reading(data: dict, request: Request):
    """记录阅读行为"""
    uid = _get_user_id(request)
    record_reading(data.get("paper_rowid"), data.get("title", ""), uid)
    increment_recent_events(uid)  # 阅读 = 关键行为
    return {"ok": True}

@app.get("/api/reading-history")
def api_get_reading_history(request: Request):
    uid = _get_user_id(request)
    history = get_reading_history(uid, limit=20)
    return {"history": history}


# ========== 全量数据导出 ==========

@app.get("/api/export/notes-markdown")
def api_export_notes_markdown(request: Request):
    """将用户所有有笔记的论文导出为 Markdown 文本"""
    from fastapi.responses import Response as FastAPIResponse
    uid = _get_user_id(request)
    papers = get_saved_papers(uid)

    lines = ["# PaperMind 笔记导出\n"]
    lines.append(f"导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    lines.append("---\n")

    exported = 0
    for paper in papers:
        notes = get_notes(paper["id"])
        if not notes:
            continue
        exported += 1
        lines.append(f"\n## {paper['title']}\n")
        if paper.get("journal"):
            lines.append(f"**期刊**：{paper['journal']}")
        if paper.get("pub_date"):
            lines.append(f"  |  **发表**：{paper['pub_date']}")
        if paper.get("category"):
            lines.append(f"  |  **分类**：{paper['category']}")
        lines.append("\n")
        if paper.get("summary_zh"):
            lines.append(f"**中文摘要**：{paper['summary_zh']}\n")
        lines.append("\n### 笔记\n")
        for note in reversed(notes):  # 按时间正序
            source_label = {
                "manual": "手动",
                "chat_summary": "对话总结",
                "chat_single": "对话摘录",
            }.get(note.get("source", ""), "")
            ts = note.get("created_at", "")[:10]
            lines.append(f"*{ts}{' · ' + source_label if source_label else ''}*\n")
            lines.append(f"{note['content']}\n")
        lines.append("\n---\n")

    if exported == 0:
        lines = ["# PaperMind 笔记导出\n\n暂无笔记内容。\n"]

    content = "\n".join(lines)
    filename = f"papermind-notes-{datetime.now().strftime('%Y%m%d')}.md"
    return FastAPIResponse(
        content=content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
def api_get_pdf_url(
    doi: str = Query(default=""),
    pmid: str = Query(default=""),
    pmcid: str = Query(default=""),
):
    """查找开放获取全文 PDF 链接（PMCID 直链 → Unpaywall → PMC ID 转换）"""
    import requests as _req
    pdf_url = None

    # 1. 已有 PMCID，直接构造 PMC PDF URL
    if pmcid:
        cid = pmcid if pmcid.upper().startswith("PMC") else f"PMC{pmcid}"
        pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{cid}/pdf/"

    # 2. 通过 PMID 查询 PMCID（PMC ID Converter API）
    if not pdf_url and pmid:
        try:
            resp = _req.get(
                "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/",
                params={"tool": "papermind", "email": "hello@papermindapp.com",
                        "ids": pmid, "format": "json"},
                timeout=10,
                allow_redirects=True,
            )
            if resp.status_code == 200:
                records = resp.json().get("records", [])
                if records and records[0].get("pmcid"):
                    cid = records[0]["pmcid"]
                    pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{cid}/pdf/"
        except Exception as e:
            print(f"[pdf] PMC ID 转换失败: {e}")

    # 3. Unpaywall（需要 DOI）
    if not pdf_url and doi:
        try:
            resp = _req.get(
                f"https://api.unpaywall.org/v2/{doi}",
                params={"email": "hello@papermindapp.com"},
                timeout=10,
                allow_redirects=True,
            )
            if resp.status_code == 200:
                data = resp.json()
                best = data.get("best_oa_location") or {}
                pdf_url = best.get("url_for_pdf") or best.get("url")
        except Exception as e:
            print(f"[pdf] Unpaywall 查询失败: {e}")

    if pdf_url:
        from urllib.parse import quote as _quote
        proxy_url = f"/api/pdf-proxy?url={_quote(pdf_url, safe='')}"
        return {"ok": True, "url": proxy_url, "original_url": pdf_url}
    return {"ok": False, "error": "未找到免费全文，可尝试通过原文链接访问"}


@app.get("/api/pdf-proxy")
async def proxy_pdf(url: str = Query(...)):
    """代理 OA PDF，解决浏览器 iframe CORS 限制。若最终内容非 PDF，返回 302 redirect 让浏览器直接访问。"""
    from fastapi.responses import StreamingResponse, RedirectResponse
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise FastAPIHTTPException(status_code=400, detail="Only HTTPS URLs allowed")

    # 先做 HEAD 请求，确认最终 URL 和 Content-Type
    try:
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; PaperMind/1.0)"},
        ) as client:
            head = await client.head(url)
            content_type = head.headers.get("content-type", "")
            final_url = str(head.url)  # 重定向后的最终 URL
    except Exception as e:
        raise FastAPIHTTPException(status_code=502, detail=f"HEAD failed: {e}")

    # 不是 PDF → 让前端直接跳转到原始 URL
    if "pdf" not in content_type.lower():
        return RedirectResponse(url=final_url, status_code=302)

    # 是 PDF → 流式代理返回
    async def stream_pdf():
        async with httpx.AsyncClient(
            timeout=60,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; PaperMind/1.0)"},
        ) as client:
            async with client.stream("GET", url) as r:
                async for chunk in r.aiter_bytes(chunk_size=32768):
                    yield chunk

    return StreamingResponse(
        stream_pdf(),
        media_type="application/pdf",
        headers={"Content-Disposition": "inline; filename=paper.pdf"},
    )


# ========== 用量 & 用户反馈 ==========

@app.get("/api/usage")
async def api_get_usage(request: Request):
    """返回当日各功能使用量"""
    uid = _get_user_id(request)
    recommend_remaining = get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT)
    chat_remaining = get_rate_limit_remaining(uid, "chat", DAILY_CHAT_LIMIT)
    translate_remaining = get_rate_limit_remaining(uid, "translate", DAILY_TRANSLATE_LIMIT)
    return {
        "recommend": {"used": DAILY_RECOMMEND_LIMIT - recommend_remaining, "limit": DAILY_RECOMMEND_LIMIT},
        "chat":      {"used": DAILY_CHAT_LIMIT - chat_remaining,           "limit": DAILY_CHAT_LIMIT},
        "translate": {"used": DAILY_TRANSLATE_LIMIT - translate_remaining, "limit": DAILY_TRANSLATE_LIMIT},
    }

@app.get("/api/stats")
async def api_get_stats(request: Request):
    """返回用户收藏/笔记/对话统计"""
    uid = _get_user_id(request)
    return get_user_stats(uid)

@app.post("/api/feedback")
async def api_post_feedback(data: FeedbackRequest, request: Request):
    """存储用户反馈"""
    uid = _get_user_id(request)
    if not data.content.strip():
        return {"ok": False, "error": "内容不能为空"}
    save_feedback(uid, data.type, data.content.strip())
    return {"ok": True}


# ========== 静态文件服务（生产模式） ==========

_dist = Path(__file__).resolve().parent.parent / "web" / "dist"
_dist_assets = _dist / "assets"

if _dist.exists() and _dist_assets.exists():
    app.mount("/assets", StaticFiles(directory=_dist_assets), name="static-assets")

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
