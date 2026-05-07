"""
PaperMind 后端 API
启动: .venv_new/bin/python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations
import asyncio
import os
import json
import httpx
import threading
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel, Field

from src.database import (
    init_db, save_paper, get_saved_papers, get_saved_paper,
    delete_saved_paper, update_paper_enrichment, save_note, delete_note, get_note_owner, get_notes, save_chat_message,
    get_saved_categories,
    get_chat_history, record_reading, get_reading_history,
    get_profile, save_profile, get_saved_titles_since, get_all_recent_chats_since,
    get_reading_history_since, get_latest_search_run,
    check_rate_limit, increment_rate_limit, get_rate_limit_remaining,
    get_enrichment_cache, save_enrichment_cache,
    increment_recent_events, reset_recent_events,
    save_feedback, get_user_stats,
    create_project, get_projects, update_project, delete_project, set_paper_project,
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

class ChatRequest(BaseModel):
    paper_title: str = Field(max_length=500)
    paper_abstract: str = Field(default="", max_length=5000)
    message: str = Field(max_length=2000)
    history: list[dict] = []
    paper_rowid: int = 0

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

class FeedbackRequest(BaseModel):
    type: str = "general"
    content: str

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
                asyncio.run(_ensure_memory_core(uid, get_profile(uid)))
            except Exception as e:
                print(f"[memory] 初始 memory_core 生成失败: {e}")
        threading.Thread(target=_bg_init_core, daemon=True).start()

    return {"ok": True}

_RECENT_EVENT_THRESHOLD = 8
_RECENT_TIME_THRESHOLD = 7 * 86400
_RECENT_WINDOW_DAYS = 7
_AUTO_CORE_REFRESH_DAYS = 14


def _has_profile_seed(profile: dict) -> bool:
    return any(
        (profile.get(key) or "").strip()
        for key in ("focus_areas", "method_interests", "background", "current_goal", "exclude_areas", "discipline")
    )


def _build_memory_context(profile: dict) -> str:
    parts = []
    core = (profile.get("memory_core") or "").strip()
    recent = (profile.get("memory_recent") or "").strip()
    if core:
        parts.append(f"---\n系统观察（辅助参考，低于以上明确输入）：\n长期研究画像：{core}")
    if recent:
        parts.append(f"近期关注变化：{recent}")
    return "\n".join(parts)


def _collect_recent_memory_signals(uid: str, days: int = _RECENT_WINDOW_DAYS) -> dict:
    recent_titles = get_saved_titles_since(uid, days=days, limit=40)
    recent_chats = get_all_recent_chats_since(uid, days=days, limit=40)
    recent_questions = [m["content"] for m in recent_chats if m.get("role") == "user"][:20]
    reading_history = get_reading_history_since(uid, days=days, limit=20)
    recent_reads = [item.get("title", "") for item in reading_history if item.get("title")][:15]
    return {
        "recent_titles": recent_titles,
        "recent_questions": recent_questions,
        "recent_reads": recent_reads,
    }


def _has_recent_signals(signals: dict) -> bool:
    return any(signals.get(key) for key in ("recent_titles", "recent_questions", "recent_reads"))


def _enforce_recent_length(text: str, max_chars: int = 180) -> str:
    """对 recent 做硬长度限制，避免模型输出失控过长。"""
    cleaned = re.sub(r"\s+", " ", (text or "")).strip()
    if len(cleaned) <= max_chars:
        return cleaned

    cut = max(
        cleaned.rfind(mark, 0, max_chars + 1)
        for mark in ("。", "；", "！", "？")
    )
    if cut >= max_chars // 2:
        return cleaned[:cut + 1].strip()

    shortened = cleaned[:max_chars].rstrip("，,；;、 ")
    if not shortened.endswith(("。", "！", "？")):
        shortened += "。"
    return shortened


async def _ensure_memory_core(uid: str, profile: dict) -> tuple[str, bool]:
    existing = (profile.get("memory_core") or "").strip()
    if existing:
        return existing, False
    if not _has_profile_seed(profile):
        return "", False

    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")
    exclude = profile.get("exclude_areas", "")
    discipline = profile.get("discipline", "")
    current_goal = profile.get("current_goal", "")

    prompt = f"""请根据以下用户的明确画像，生成一段稳定的长期研究画像（memory_core）。

明确输入：
- 研究方向：{focus or '（未填）'}
- 方法兴趣：{method_interests or '（未填）'}
- 当前目标：{current_goal or '（未填）'}
- 补充说明：{background or '（未填）'}
- 不想看的内容：{exclude or '（未填）'}
- 学科领域：{discipline or '（未填）'}

要求：
- 这是一段长期骨架，不要写“最近”“近期”等短期词
- 总结稳定的研究主线、方法偏好、不偏好内容、阅读时常关注的角度
- 语言像内部研究备忘录，简洁、稳、可长期复用
- 控制在 140-220 字
- 只输出正文，不要标题"""

    core, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=450,
        temperature=0.3,
        task="summary",
    )
    core = (core or "").strip()
    if not core:
        return "", False

    updated_profile = {
        **profile,
        "memory_core": core,
        "core_source": "auto_initial",
        "last_core_merged_at": datetime.now().isoformat(),
    }
    save_profile(uid, updated_profile)
    return core, True


async def _maybe_auto_refresh_memory_core(uid: str, profile: dict) -> bool:
    if not (profile.get("memory_core") or "").strip():
        return False
    if not (profile.get("memory_recent") or "").strip():
        return False

    core_source = profile.get("core_source", "")
    # auto_initial：第一次有了真实行为数据（recent）就立刻刷新，不等 14 天
    if core_source != "auto_initial":
        last_merged = profile.get("last_core_merged_at", "")
        if last_merged:
            try:
                if (datetime.now() - datetime.fromisoformat(last_merged)).total_seconds() < _AUTO_CORE_REFRESH_DAYS * 86400:
                    return False
            except Exception:
                pass

    prompt = f"""请根据用户当前的长期研究画像和近期关注变化，温和更新一版长期研究画像（memory_core）。

当前长期研究画像：
{profile.get("memory_core", "")}

近期关注变化：
{profile.get("memory_recent", "")}

用户明确画像（优先级最高）：
- 研究方向：{profile.get("focus_areas", "") or '（未填）'}
- 方法兴趣：{profile.get("method_interests", "") or '（未填）'}
- 当前目标：{profile.get("current_goal", "") or '（未填）'}
- 补充说明：{profile.get("background", "") or '（未填）'}
- 不想看的内容：{profile.get("exclude_areas", "") or '（未填）'}

要求：
- 保持长期骨架稳定，不要被短期噪音带偏
- 只有当近期变化已经明显稳定，才吸收进长期画像
- 输出 140-220 字
- 只输出正文，不要标题"""

    core, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=450,
        temperature=0.25,
        task="summary",
    )
    core = (core or "").strip()
    if not core:
        return False

    updated_profile = {
        **profile,
        "memory_core": core,
        "core_source": "auto_refresh",
        "last_core_merged_at": datetime.now().isoformat(),
    }
    save_profile(uid, updated_profile)
    return True


@app.post("/api/profile/memory-recent")
async def api_update_memory_recent(data: MemoryActionRequest, request: Request):
    """更新近期关注变化：保留已有 recent，并在近 7 天行为基础上增量修正。"""
    uid = _get_user_id(request)
    profile = get_profile(uid)

    _, core_generated = await _ensure_memory_core(uid, profile)
    if core_generated:
        profile = get_profile(uid)

    signals = _collect_recent_memory_signals(uid, days=_RECENT_WINDOW_DAYS)
    if not _has_recent_signals(signals):
        return {"ok": True, "skipped": True, "reason": "no_recent_signals", "core_generated": core_generated}

    events = int(profile.get("behavior_events_since_recent") or 0)
    has_recent = bool((profile.get("memory_recent") or "").strip())
    last_updated = profile.get("last_recent_updated_at", "")
    time_elapsed = 0
    if last_updated:
        try:
            time_elapsed = (datetime.now() - datetime.fromisoformat(last_updated)).total_seconds()
        except Exception:
            pass

    should_generate = bool(data.force)
    if not should_generate:
        if not has_recent:
            if events > 0 or not (profile.get("memory_core") or "").strip():
                should_generate = True
        elif events >= _RECENT_EVENT_THRESHOLD:
            should_generate = True
        elif time_elapsed >= _RECENT_TIME_THRESHOLD and events > 0:
            should_generate = True

    if not should_generate:
        return {"ok": True, "skipped": True, "core_generated": core_generated}

    prompt = f"""请基于已有的近期关注变化和最近 { _RECENT_WINDOW_DAYS } 天的新行为，更新一版 memory_recent。

长期研究画像（稳定骨架）：
{profile.get("memory_core", "") or '（暂无）'}

已有近期关注变化：
{profile.get("memory_recent", "") or '（暂无）'}

最近 { _RECENT_WINDOW_DAYS } 天收藏的论文标题：
{chr(10).join(f'- {t}' for t in signals["recent_titles"][:20]) if signals["recent_titles"] else '（暂无）'}

最近 { _RECENT_WINDOW_DAYS } 天跨论文提问：
{chr(10).join(f'- {q}' for q in signals["recent_questions"][:15]) if signals["recent_questions"] else '（暂无）'}

最近 { _RECENT_WINDOW_DAYS } 天阅读轨迹：
{chr(10).join(f'- {t}' for t in signals["recent_reads"][:12]) if signals["recent_reads"] else '（暂无）'}

用户当前明确画像（优先级最高）：
- 研究方向：{profile.get("focus_areas", "") or '（未填）'}
- 方法兴趣：{profile.get("method_interests", "") or '（未填）'}
- 当前目标：{profile.get("current_goal", "") or '（未填）'}
- 补充说明：{profile.get("background", "") or '（未填）'}

要求：
- 这是近期增量，不要重复长期骨架里已经稳定存在的内容
- 只写最近新增或最近明显变强的关注点，不要把长期画像换句话再写一遍
- 尽量保留仍然成立的近期变化，再吸收新增观察
- 允许压缩重写，但不要无故丢失仍然有效的近期关注
- 控制在 100-180 字
- 最多写 2-4 个增量点，整体保持短、轻、像提醒
- 只输出正文，不要标题"""

    recent, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=500,
        temperature=0.3,
        task="summary",
    )
    recent = _enforce_recent_length(recent or "", max_chars=180)
    if not recent:
        return {"ok": False, "error": "近期关注变化生成失败"}

    updated_profile = {
        **profile,
        "memory_recent": recent,
        "last_recent_updated_at": datetime.now().isoformat(),
    }
    save_profile(uid, updated_profile)
    reset_recent_events(uid)
    refreshed_profile = get_profile(uid)
    auto_merged = await _maybe_auto_refresh_memory_core(uid, refreshed_profile)
    latest = get_profile(uid)
    return {
        "ok": True,
        "recent": latest.get("memory_recent", ""),
        "core": latest.get("memory_core", ""),
        "core_generated": core_generated,
        "core_auto_updated": auto_merged,
    }


@app.post("/api/profile/merge-to-core")
async def api_merge_recent_to_core(data: MemoryActionRequest, request: Request):
    """用户手动确认：把近期关注变化吸收到长期研究画像。"""
    uid = _get_user_id(request)
    profile = get_profile(uid)

    _, core_generated = await _ensure_memory_core(uid, profile)
    if core_generated:
        profile = get_profile(uid)

    if not (profile.get("memory_recent") or "").strip():
        return {"ok": True, "skipped": True, "reason": "no_recent"}

    prompt = f"""请把用户的近期关注变化吸收到长期研究画像中，生成一版新的 memory_core。

当前长期研究画像：
{profile.get("memory_core", "") or '（暂无）'}

近期关注变化：
{profile.get("memory_recent", "")}

用户明确画像（优先级最高）：
- 研究方向：{profile.get("focus_areas", "") or '（未填）'}
- 方法兴趣：{profile.get("method_interests", "") or '（未填）'}
- 当前目标：{profile.get("current_goal", "") or '（未填）'}
- 补充说明：{profile.get("background", "") or '（未填）'}
- 不想看的内容：{profile.get("exclude_areas", "") or '（未填）'}

要求：
- 产出稳定、长期可复用的研究骨架
- 吸收近期中已经相对稳定的变化
- 语言专业、简洁，像内部研究画像
- 控制在 140-220 字
- 只输出正文，不要标题"""

    core, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=450,
        temperature=0.25,
        task="summary",
    )
    core = (core or "").strip()
    if not core:
        return {"ok": False, "error": "长期研究画像更新失败"}

    updated_profile = {
        **profile,
        "memory_core": core,
        "memory_recent": "",  # 已吸收进 core，清空 recent
        "core_source": "manual_confirmed",
        "last_core_merged_at": datetime.now().isoformat(),
        "last_recent_updated_at": "",
    }
    save_profile(uid, updated_profile)
    reset_recent_events(uid)
    latest = get_profile(uid)
    return {"ok": True, "core": latest.get("memory_core", ""), "recent": ""}


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

    # 正在后台抓取中，返回加载状态
    if cache["fetching"]:
        return {"papers": [], "total": 0, "remaining": 0, "loading": True, "search_debug": cache.get("search_debug")}

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
    memory_context = _build_memory_context(profile)
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
    """取消收藏（需验证归属）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    delete_saved_paper(paper_id)
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

    system_prompt = f"""你是一位学术研究伙伴。用户正在阅读一篇论文，请基于论文内容和用户的研究背景来回答问题。
用中文回答，专业但亲切，像同事在聊天，不像在写报告。

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1200]}

{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}
{notes_context}

回答要求：
- 直接回答问题，控制在 150-250 字
- 不要用 ### 标题分层，可以用 **加粗** 强调关键词
- 可以用短列表，但不要超过 3 条
- 结合用户研究背景给出具体建议
- 引用论文数据时给出具体数字"""

    if not _has_llm_config(task="chat"):
        return {"reply": "AI 服务暂不可用，请稍后重试", "ok": False}

    messages = [{"role": "system", "content": system_prompt}]
    for msg in data.history[-8:]:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    messages.append({"role": "user", "content": data.message})

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
        if data.paper_rowid:
            save_chat_message(data.paper_rowid, "user", data.message)
            save_chat_message(data.paper_rowid, "assistant", reply)
            increment_recent_events(uid)  # 对话 = 关键行为

        return {"reply": reply, "ok": True}
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
