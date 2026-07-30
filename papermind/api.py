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
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

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
    init_db, save_paper, get_saved_papers, get_saved_paper, touch_last_read,
    delete_saved_paper, update_paper_enrichment, save_note, delete_note, get_note_owner, get_notes, save_chat_message,
    get_saved_categories,
    get_chat_history, record_reading, get_reading_history,
    get_profile, save_profile, get_latest_search_run,
    check_rate_limit, increment_rate_limit, get_rate_limit_remaining,
    get_enrichment_cache, save_enrichment_cache,
    increment_recent_events,
    save_feedback, get_user_stats, get_portrait, mark_exported,
    get_deep_reading_signals, update_memory_fields, wipe_memory,
    get_stated_memory, save_stated_memory,
    get_self_test, init_self_test, update_self_test,
    get_paper_page_ocr, save_paper_page_ocr,
    record_method_gap, get_method_gaps,
    create_project, get_projects, update_project, delete_project, set_paper_project,
    set_paper_has_pdf,
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
    update_stated_memory,
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
    allow_credentials=False,   # 跨域仍用 header；cookie 仅作为同源 PDF/图片请求的回退。
    allow_methods=["GET", "POST", "DELETE", "PATCH", "HEAD"],
    allow_headers=["Content-Type", "X-User-ID", "Authorization"],
)

# 启动时初始化数据库
init_db()

# 每日限速配置（可在 .env 中覆盖）
DAILY_RECOMMEND_LIMIT = int(os.environ.get("DAILY_RECOMMEND_LIMIT", "5"))
DAILY_CHAT_LIMIT = int(os.environ.get("DAILY_CHAT_LIMIT", "20"))
DAILY_TRANSLATE_LIMIT = int(os.environ.get("DAILY_TRANSLATE_LIMIT", "30"))
# 全局每日 AI 对话熔断（所有用户之和，超了暂停服务）
GLOBAL_DAILY_CHAT_LIMIT = int(os.environ.get("GLOBAL_DAILY_CHAT_LIMIT", "500"))
OWNER_UID = os.environ.get("OWNER_UID", "").strip().lower()
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
    # 全篇已提取的页文字（按页标注）。只给当前页时，AI 无法交叉核对跨页的数字
    paper_pages: str = Field(default="", max_length=30000)
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

class OcrSelectionRequest(BaseModel):
    image_data_url: str = Field(max_length=6_000_000)
    scope: str = Field(default="selection", max_length=20)
    paper_rowid: Optional[int] = Field(default=None, ge=1)
    page_number: Optional[int] = Field(default=None, ge=1, le=500)

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
    """读取并校验匿名设备 ID；同源媒体请求可从 cookie 回退。"""
    headers = getattr(request, "headers", {})
    cookies = getattr(request, "cookies", {})
    user_id = (headers.get("X-User-ID", "") or cookies.get("papermind-uid", "")).strip().lower()
    try:
        parsed = UUID(user_id)
    except (ValueError, AttributeError):
        raise FastAPIHTTPException(status_code=401, detail="valid device id required")
    if str(parsed) != user_id or parsed.version != 4:
        raise FastAPIHTTPException(status_code=401, detail="valid device id required")
    return user_id


def _get_client_ip(request: Request) -> str:
    """获取客户端真实 IP（nginx 反代场景读 X-Forwarded-For）"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _require_owner(request: Request) -> str:
    """主机级配置只允许 OWNER_UID 管理；本地未配置时保持开发兼容。"""
    uid = _get_user_id(request)
    if OWNER_UID and uid != OWNER_UID:
        raise FastAPIHTTPException(status_code=403, detail="owner device required")
    return uid


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
def api_get_settings(request: Request):
    """返回当前 LLM 配置状态（内置链 + 自定义通道）"""
    uid = _get_user_id(request)
    can_manage = not OWNER_UID or uid == OWNER_UID
    client, model = _get_llm_client()
    provider_name = ""
    for p in _LLM_PROVIDERS:
        if p["model"] == model:
            provider_name = p["name"]
            break
    custom = get_custom_provider_safe() if can_manage else {}
    return {
        "provider": provider_name,
        "model": model,
        "base_url": "",
        "api_key_masked": "内置" if client else "未配置",
        "builtin": True,
        "custom": custom,
        "active": ("custom" if (custom.get("enabled") and custom.get("has_key") and custom.get("model")) else "builtin"),
        "can_manage": can_manage,
    }

@app.post("/api/settings")
def api_save_settings(request: Request):
    """内置 API 模式下，保存操作为空操作（兼容前端调用）"""
    _require_owner(request)
    return {"ok": True, "builtin": True}


@app.get("/api/zotero-plugin/update.json")
def api_zotero_plugin_update():
    """返回当前 Zotero 插件版本和安装包校验值。"""
    plugin_dir = Path(__file__).resolve().parent.parent / "zotero-plugin"
    manifest_path = plugin_dir / "manifest.json"
    xpi_path = plugin_dir / "papermind-connector.xpi"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        zotero_manifest = manifest["applications"]["zotero"]
        digest = hashlib.sha256(xpi_path.read_bytes()).hexdigest()
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        raise FastAPIHTTPException(status_code=503, detail="plugin package unavailable") from exc

    return {
        "addons": {
            zotero_manifest["id"]: {
                "updates": [{
                    "version": manifest["version"],
                    "update_link": "https://papermindapp.com/api/zotero-plugin/papermind-connector.xpi",
                    "update_hash": f"sha256:{digest}",
                    "applications": {
                        "zotero": {
                            "strict_min_version": zotero_manifest["strict_min_version"],
                            "strict_max_version": zotero_manifest["strict_max_version"],
                        },
                    },
                }],
            },
        },
    }


@app.get("/api/zotero-plugin/papermind-connector.xpi")
def api_zotero_plugin_download():
    """提供 Zotero 插件安装包；该路径不接触任何用户数据。"""
    xpi_path = Path(__file__).resolve().parent.parent / "zotero-plugin" / "papermind-connector.xpi"
    if not xpi_path.is_file():
        raise FastAPIHTTPException(status_code=404, detail="plugin package not found")
    return FileResponse(
        xpi_path,
        media_type="application/x-xpinstall",
        filename="papermind-connector.xpi",
    )


# ========== 自定义 LLM 通道 ==========

@app.post("/api/settings/custom-llm")
def api_save_custom_llm(data: CustomLLMRequest, request: Request):
    """保存自定义 API 配置；api_key 传空表示沿用已存的 key"""
    _require_owner(request)
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
def api_delete_custom_llm(request: Request):
    """清除自定义 API 配置，回到纯内置链"""
    _require_owner(request)
    save_custom_provider({})
    return {"ok": True}


@app.post("/api/settings/custom-llm/models")
async def api_list_custom_llm_models(data: CustomLLMProbeRequest, request: Request):
    """调用 provider 的 /models 接口，列出该账号实际可用的模型"""
    _require_owner(request)
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
async def api_test_custom_llm(data: CustomLLMProbeRequest, request: Request):
    """对填写的配置发一次最小对话请求，验证连通性"""
    _require_owner(request)
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


# ── 记忆面板：可见 + 可改 + 可删 ────────────────────────────────
# 记忆是 papermind 的卖点，但不可见、不可纠正的记忆是负担而不是卖点。
# 面板里显示什么，AI 就拿到什么（见 _build_understanding_profile_text）。

class MemoryPatchRequest(BaseModel):
    memory_core: Optional[str] = Field(default=None, max_length=4000)
    memory_recent: Optional[str] = Field(default=None, max_length=4000)


@app.get("/api/memory")
async def api_get_memory(request: Request):
    """读取记忆面板：两段记忆 + 它们是从哪些行为学来的。"""
    uid = _get_user_id(request)
    profile = get_profile(uid)
    signals = get_deep_reading_signals(uid, days=90, limit=40)
    return {
        "ok": True,
        "memory_core": profile.get("memory_core") or "",
        "memory_recent": profile.get("memory_recent") or "",
        "stated": get_stated_memory(uid),
        "updated_at": profile.get("updated_at") or "",
        # 出处：让用户知道这些话是根据什么长出来的
        "learned_from": {
            "papers": len(signals.get("papers") or []),
            "cards": len(signals.get("cards") or []),
            "questions": len(signals.get("questions") or []),
            "window_days": 90,
        },
    }


@app.patch("/api/memory")
async def api_patch_memory(data: MemoryPatchRequest, request: Request):
    """改写或清空记忆。传空字符串即删除该段。"""
    uid = _get_user_id(request)
    if data.memory_core is None and data.memory_recent is None:
        return {"ok": False, "error": "没有要更新的内容。"}
    update_memory_fields(
        uid,
        memory_core=None if data.memory_core is None else data.memory_core.strip(),
        memory_recent=None if data.memory_recent is None else data.memory_recent.strip(),
    )
    profile = get_profile(uid)
    return {
        "ok": True,
        "memory_core": profile.get("memory_core") or "",
        "memory_recent": profile.get("memory_recent") or "",
    }


@app.delete("/api/memory")
async def api_wipe_memory(request: Request):
    """清空全部记忆，连同早年画像表单残留的字段一起清。"""
    uid = _get_user_id(request)
    wipe_memory(uid, include_legacy_profile=True)
    return {"ok": True, "memory_core": "", "memory_recent": ""}


class StatedDeleteRequest(BaseModel):
    text: str = Field(max_length=200)


@app.post("/api/memory/stated/delete")
async def api_delete_stated(data: StatedDeleteRequest, request: Request):
    """删掉「你说过的」里的某一条。"""
    uid = _get_user_id(request)
    items = [it for it in get_stated_memory(uid) if (it.get("text") or "") != data.text]
    save_stated_memory(uid, items)
    return {"ok": True, "stated": items}


@app.post("/api/memory/refresh-stated")
async def api_refresh_stated(request: Request):
    """从最近对话里重新提取「你说过的」。"""
    uid = _get_user_id(request)
    result = await update_stated_memory(uid)
    return {"ok": True, "stated": get_stated_memory(uid), "detail": result}


@app.post("/api/memory/rebuild-core")
async def api_rebuild_memory_core(request: Request):
    """按当前精读历史重新长一遍长期记忆（先清空，再由行为生成）。"""
    uid = _get_user_id(request)
    update_memory_fields(uid, memory_core="")
    core, created = await ensure_memory_core(uid, get_profile(uid))
    if not core:
        return {"ok": False, "error": "精读记录还不够，先读几篇、沉淀几张卡片再来。"}
    return {"ok": True, "memory_core": core, "created": created}


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


def _build_understanding_profile_text(profile: dict, uid: str = "") -> str:
    """喂给 AI 的用户背景 = 用户在记忆面板里看得见的那两项，别的一律不给。

    以前还会拼进 discipline / focus_areas / method_interests / background —— 这些
    表单入口早已隐藏，用户既看不到也改不了，AI 却一直拿它当「你是谁」，
    于是出现「结合你关注的护理资源效率」这种用户根本不认的断言。
    所见即所得：面板里改了什么，AI 拿到的就变什么；删空了就什么都不拿。
    """
    return build_memory_context(profile, get_stated_memory(uid) if uid else [])


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
    profile_text = _build_understanding_profile_text(profile, uid)

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

def _detect_reading_language(*texts: str) -> str:
    """Use the supplied paper text to choose Chinese-first or English-assisted guidance."""
    sample = " ".join(text for text in texts if text)[:8000]
    cjk_count = len(re.findall(r"[\u4e00-\u9fff]", sample))
    latin_count = len(re.findall(r"[A-Za-z]", sample))
    if cjk_count >= 20 and cjk_count >= latin_count * 0.25:
        return "zh"
    return "en"

@app.post("/api/deep-read/guide")
async def api_deep_read_guide(data: DeepReadGuideRequest, request: Request):
    """按论文语言生成逐页、摘要、选段或路线图精读带读。"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID

    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天恢复。"}
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"ok": False, "error": f"你今天的 AI 次数已用完（每天 {DAILY_CHAT_LIMIT} 次）。"}
    if not _has_llm_config(task="chat"):
        return {"ok": False, "error": "AI 服务暂不可用"}

    profile_text = _build_understanding_profile_text(get_profile(uid), uid)
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

    reading_language = _detect_reading_language(
        data.paper_title or "", data.paper_abstract or "", source_text
    )
    is_chinese = reading_language == "zh"

    if mode == "map":
        terminology_instruction = (
            "列 4-6 个最影响理解的关键概念、变量或方法词，结合本文语境解释。"
            if is_chinese else
            "列 4-6 个最影响理解的英文术语或方法词，用中文解释，并说明它在这篇里大概扮演什么角色。"
        )
        task_instruction = f"""请输出一份“精读路线图”，严格使用下面这些小标题：

**这篇论文先抓什么**
用 3-4 句话说明研究问题、对象/暴露/结局、核心设计，以及为什么值得读。

**论文骨架**
按 Introduction / Methods / Results / Discussion 拆出每一部分读的时候要找什么，不要泛泛总结。

**精读顺序**
给出 5 步阅读路线：先读哪里、再读哪里、每一步要确认什么。

**先弄懂的词**
{terminology_instruction}

**读完后要能回答**
列 4 个检查问题，帮助用户判断自己是否真的读懂。"""
    elif mode == "selection":
        if is_chinese:
            selection_breakdown = """**论证拆开读**
把选段拆成 3-5 个逻辑块：原文片段 + 这部分在论证中承担什么作用。不要改写成空泛摘要。

**关键词与证据**
解释 2-4 个最影响理解的概念、变量、统计表达、限定条件或数字。"""
        else:
            selection_breakdown = """**句子拆开读**
把英文拆成 3-5 个语义块：英文片段 + 中文解释 + 这个片段在句子里起什么作用。

**关键词**
解释 2-4 个最容易卡住的词、变量、统计表达或连接词。"""
        task_instruction = f"""请专门带读用户选中的句子或片段，严格使用下面这些小标题：

**原句在说什么**
先用一句中文说清这段话的主干意思，不要机械复述。

{selection_breakdown}

**为什么重要**
说明这句话对理解研究设计、结果、因果边界或作者论证有什么作用。

**可以继续追问**
给 2 个非常具体的追问。"""
    elif mode == "page":
        language_block = (
            """**关键论证拆解**
挑 2-4 个最关键的信息块，说明原文在提出什么主张、用了什么证据、有哪些限定条件。"""
            if is_chinese else
            """**英文句子拆解**
挑 2-4 个最关键、最容易读卡的英文短语或句子片段：英文片段 + 中文拆解。不要整页翻译。"""
        )
        task_instruction = f"""请按“当前页陪读”的方式输出，严格使用下面这些小标题：

**这一页在全文的位置**
判断这一页更像 Introduction / Methods / Results / Discussion / 图表说明中的哪一类，并说明它承担什么任务。

**逐段带读**
按页面里的自然段落或信息块拆成 3-5 点：每点先说“这一块在讲什么”，再说“读的时候要抓什么”。

{language_block}

**术语、变量和数字**
解释这一页里真正影响理解的术语、变量、统计量或比较关系，尽量保留数字和方向。

**暂停自测**
给 3 个检查问题，让用户读完这一页能判断自己是否懂了。

**下一步读法**
告诉用户下一页/下一段最应该盯住什么。"""
    else:
        keyword_heading = "关键概念与方法词" if is_chinese else "英文关键词"
        keyword_instruction = (
            "挑 3-5 个摘要里的关键概念、变量或方法词，结合本文语境解释。"
            if is_chinese else
            "挑 3-5 个摘要里的关键英文短语，说明怎么理解。"
        )
        task_instruction = f"""请按“摘要精读”的方式输出，严格使用下面这些小标题：

**研究问题**
用 2-3 句话讲清这篇到底想回答什么。

**方法怎么读**
把对象、暴露/干预、结局、设计和统计方法拆开说。

**结果先抓什么**
列 3 条最关键的发现，保留方向、数字和边界。

**{keyword_heading}**
{keyword_instruction}

**读正文前的问题**
列 3 个进入正文前要带着的问题。"""

    reading_context = (
        "正在阅读中文论文。不要把篇幅浪费在翻译或中文词句释义上，重点检查研究逻辑、方法、证据、数字、限定条件和可迁移启发。"
        if is_chinese else
        "正在阅读英文论文。除了研究逻辑、方法和证据，还要降低术语与长句障碍，但不要机械翻译整页。"
    )
    prompt = f"""你是一位耐心的论文精读老师，正在带一位有研究经验的中文研究者读论文。
目标不是泛泛总结，也不是代替用户读完；目标是带用户抓住研究逻辑、术语、数字、证据边界和可以迁移到自己研究中的启发。
{reading_context}
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
        return {"ok": True, "guide": guide, "source": source_label, "language": reading_language}
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
    touch_last_read(paper_id)  # 记录本次打开，供首页「在读状态」判定
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
    if data.project_id is not None:
        projects = get_projects(uid)
        if not any(project["id"] == data.project_id for project in projects):
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
def api_get_paper_pdf(paper_id: int, request: Request):
    """获取已上传的论文 PDF"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_id, uid):
        raise FastAPIHTTPException(status_code=403, detail="forbidden")
    pdf_path = PDF_DIR / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise FastAPIHTTPException(status_code=404, detail="PDF not found")
    return FileResponse(str(pdf_path), media_type="application/pdf",
                        headers={"Content-Disposition": "inline; filename=paper.pdf"})


@app.head("/api/library/{paper_id}/pdf")
def api_head_paper_pdf(paper_id: int, request: Request):
    """前端用 HEAD 探测是否已上传本地 PDF（FastAPI 的 GET 不自动支持 HEAD）"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_id, uid):
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
    if note_id_param and get_note_owner(note_id_param) != uid:
        return {"ok": False, "error": "not found"}
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
def api_get_board_figure(paper_rowid: int, name: str, request: Request):
    """图表图片；同源 img 请求使用设备 cookie 校验归属。"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
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
    mark_exported(paper_rowid)
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

def _looks_like_garbled_selection(value: str) -> bool:
    text = re.sub(r"\s+", "", str(value or ""))
    if len(text) < 12:
        return False
    if re.search(r"[\x7f-\x9f\ufffd]", text):
        return True
    suspicious = len(re.findall(r"[\\\[\]\^_`{|}~]", text))
    return suspicious >= 4 and suspicious / len(text) > 0.06


def _validated_selection_image(data_url: str) -> str:
    match = re.fullmatch(
        r"data:image/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)",
        str(data_url or ""),
    )
    if not match:
        raise ValueError("invalid image data")
    image_bytes = base64.b64decode(match.group(1), validate=True)
    if not image_bytes or len(image_bytes) > 4 * 1024 * 1024:
        raise ValueError("image too large")
    return data_url


@app.post("/api/ocr/selection")
async def api_ocr_selection(data: OcrSelectionRequest, request: Request):
    """识别选区或论文页面；页面模式只缓存文字，不保存图片。"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID
    if data.scope == "page" and data.paper_rowid:
        if not _get_owned_paper_or_none(data.paper_rowid, uid):
            return {"ok": False, "error": "not found"}
        if not data.page_number:
            return {"ok": False, "error": "缺少页码。"}
    try:
        image_data_url = _validated_selection_image(data.image_data_url)
    except (ValueError, TypeError):
        return {"ok": False, "error": "选区图像无效，请重新划选。"}

    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天恢复。"}
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"ok": False, "error": f"你今天的 AI 次数已用完（每天 {DAILY_CHAT_LIMIT} 次）。"}
    if not _has_llm_config(task="ocr"):
        return {"ok": False, "error": "当前模型不支持选区文字识别。"}

    is_page = data.scope == "page"
    instruction = (
        "请按阅读顺序逐字识别这一页实际出现的正文，只输出识别结果。"
        "保留标题、中文标点和段落顺序，不要总结、改写、补充或解释。"
        if is_page
        else
        "请逐字识别图片中实际出现的文字，只输出识别结果。"
        "保留原有中文标点和段落顺序，不要总结、改写、补充或解释。"
    )
    raw, _, model = await _llm_chat_complete_async(
        [{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": image_data_url},
                },
                {
                    "type": "text",
                    "text": instruction,
                },
            ],
        }],
        max_tokens=4000 if is_page else 1800,
        temperature=0,
        task="ocr",
    )
    text = re.sub(r"^```(?:text)?\s*|\s*```$", "", raw or "", flags=re.IGNORECASE).strip()
    if not text or _looks_like_garbled_selection(text):
        return {"ok": False, "error": "未能可靠识别这段文字，请缩短选区后重试。"}

    if is_page and data.paper_rowid and data.page_number:
        save_paper_page_ocr(data.paper_rowid, data.page_number, text, model)

    increment_rate_limit("__global__", "chat")
    if not is_owner:
        increment_rate_limit(uid, "chat")
    return {"ok": True, "text": text, "model": model}


@app.get("/api/papers/{paper_rowid}/ocr-pages")
def api_get_paper_ocr_pages(paper_rowid: int, request: Request):
    """返回当前用户这篇论文已缓存的逐页 OCR 文本。"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
        return {"ok": False, "error": "not found"}
    return {"ok": True, "pages": get_paper_page_ocr(paper_rowid)}


@app.post("/api/cards")
def api_create_card(data: CreateCardRequest, request: Request):
    """创建阅读卡片（需验证归属）"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(data.paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    if data.card_type not in CARD_TYPES:
        return {"ok": False, "error": "invalid card_type"}
    if data.quote and _looks_like_garbled_selection(data.quote):
        return {
            "ok": False,
            "error": "选区文字无法可靠提取，请重新划选并等待文字识别完成。",
        }
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
    if data.quote and _looks_like_garbled_selection(data.quote):
        return {
            "ok": False,
            "error": "选区文字无法可靠提取，请重新划选并等待文字识别完成。",
        }

    if not check_rate_limit("__global__", "chat", GLOBAL_DAILY_CHAT_LIMIT):
        return {"ok": False, "error": "今日 AI 服务使用量已达上限，明天恢复。"}
    if not is_owner and not check_rate_limit(uid, "chat", DAILY_CHAT_LIMIT):
        return {"ok": False, "error": f"你今天的 AI 次数已用完（每天 {DAILY_CHAT_LIMIT} 次）。"}
    if not _has_llm_config(task="chat"):
        return {"ok": False, "error": "AI 服务暂不可用"}

    card_type = data.card_type if data.card_type in CARD_TYPES else "method"
    profile = get_profile(uid)
    profile_text = _build_understanding_profile_text(profile, uid)

    context_parts = []
    if data.quote:
        page_note = f"（第 {data.page} 页）" if data.page else ""
        context_parts.append(f"用户在原文划选的段落{page_note}：\n\"{data.quote}\"")
    if data.question:
        context_parts.append(f"用户的追问：{data.question}")
    if data.answer:
        context_parts.append(f"AI 此前的回答：{data.answer[:2000]}")
    context = "\n\n".join(context_parts) if context_parts else "（用户没有提供划选段落，请基于论文摘要提炼）"

    abstract_context = (
        ""
        if data.quote
        else f"\n论文摘要：{data.paper_abstract[:1500]}"
    )
    evidence_rule = (
        "用户提供了划选原文。卡片只能概括该段原文，不得从论文摘要、常识或其他段落补充"
        "原文未出现的指标、数字、步骤或结论。"
        if data.quote
        else "用户未提供划选原文，可基于论文摘要提炼。"
    )

    system_prompt = f"""你是一位学术阅读助手，帮用户把读到的内容沉淀为一张「{CARD_TYPE_LABELS[card_type]}」。
{CARD_TYPE_GUIDES[card_type]}

论文标题：{data.paper_title}
{abstract_context}

证据边界：{evidence_rule}

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


# ========== 苏格拉底自测 ==========
#
# 设计立场（见 handoff）：它是诊断工具，不是老师。唯一职责是照出盲点。
# - 只提问，不教学；填平盲点交给对话
# - 判定必须分档（solid/partial/off），宁可较真不可捧场
# - 每条反馈必须带原文锚点，且锚点由后端逐字校验——不靠模型自觉
# - 一根问到底但三问收口，由后端计数强制，不由模型决定

MAX_PROBES_PER_PILLAR = 3          # 三问收口
SELF_TEST_DAILY_LIMIT = int(os.environ.get("SELF_TEST_DAILY_LIMIT", "300"))  # 保险丝，正常用不到


class SelfTestAskRequest(BaseModel):
    pillar_key: str
    paper_title: str = ""
    paper_abstract: str = ""
    current_page_text: str = Field(default="", max_length=60_000)


class SelfTestAnswerRequest(BaseModel):
    pillar_key: str
    answer: str
    paper_title: str = ""
    paper_abstract: str = ""
    current_page_text: str = Field(default="", max_length=60_000)


class SelfTestHandoffRequest(BaseModel):
    pillar_key: str
    paper_title: str = ""
    current_page: Optional[int] = None


def _self_test_guard(uid: str) -> Optional[dict]:
    """自测不占用每日对话额度；仅保留一个高上限做成本熔断。"""
    if not _has_llm_config(task="chat"):
        return {"ok": False, "error": "AI 服务暂不可用"}
    is_owner = OWNER_UID and uid == OWNER_UID
    if not is_owner and not check_rate_limit(uid, "self_test", SELF_TEST_DAILY_LIMIT):
        return {"ok": False, "error": "自测调用次数已达今日上限。"}
    return None


def _build_source_context(paper_rowid: int, abstract: str, page_text: str) -> tuple[str, str]:
    """出题依据：三来源混合 + 可引用原文。

    只考卡片 = 只考你已经会的，所以显式标注来源并要求优先从 ②③ 出题。
    返回 (给模型看的来源说明, 可用于锚点校验的原文全文)
    """
    cards = get_cards(paper_rowid)
    quotes = get_quotes(paper_rowid)
    readable_quotes = [
        quote for quote in quotes
        if not _looks_like_garbled_selection(quote.get("text") or "")
    ]
    board = get_or_create_board(paper_rowid)
    board_items = get_board_items(paper_rowid)

    # ② 划了但没做卡片的段落
    card_quotes = " ".join(
        (card.get("quote") or "")
        for card in cards
        if not _looks_like_garbled_selection(card.get("quote") or "")
    )
    orphan_quotes = [
        quote for quote in readable_quotes
        if quote.get("text") and quote["text"][:30] not in card_quotes
    ]

    # ③ 完全没碰的板块
    filled = {it["section"] for it in board_items}
    untouched = [s["title"] for s in (board.get("sections") or []) if s["key"] not in filled]

    parts = []
    if cards:
        parts.append("① 用户已做的卡片（检验有没有真懂，别只考这些）：\n" + "\n".join(
            f"- [{c.get('card_type')}] {c.get('title') or ''}：{(c.get('content') or '')[:160]}" for c in cards[:10]))
    if orphan_quotes:
        parts.append("② 用户划了但没做成卡片的段落（**优先从这里出题，检验遗漏**）：\n" + "\n".join(
            f"- p.{q.get('page') or '?'}：{q['text'][:180]}" for q in orphan_quotes[:8]))
    if untouched:
        parts.append("③ 完全没碰过的板块（**优先从这里出题，检验盲区**）：" + "、".join(untouched))
    if not parts:
        parts.append("用户还没有任何卡片或划词，请直接基于原文出题。")

    # 可引用原文：优先使用带页码标记的 PDF 全文，否则降级用摘要 + 卡片 + 划词
    corpus = page_text.strip()
    if _looks_like_garbled_selection(corpus):
        corpus = ""
    if len(corpus) < 200:
        fallback = [abstract or ""]
        fallback += [(c.get("content") or "") for c in cards]
        fallback += [(q.get("text") or "") for q in readable_quotes]
        corpus = "\n".join(x for x in fallback if x)
    return "\n\n".join(parts), corpus[:30_000]


def _verify_anchor(quote: str, corpus: str) -> bool:
    """锚点逐字校验：模型给的原文引用必须真的出现在原文里。

    「没有锚点的反馈一律不可信」的机器执行版——校验不过就降级，不靠模型自觉。
    """
    q = re.sub(r"\s+", "", quote or "")
    c = re.sub(r"\s+", "", corpus or "")
    return len(q) >= 6 and q in c


def _find_anchor_page(quote: str, corpus: str) -> Optional[int]:
    """根据逐字锚点反查正文页码，不信任模型自行填写的页码。"""
    compact_quote = re.sub(r"\s+", "", quote or "")
    if len(compact_quote) < 6:
        return None
    page_blocks = re.findall(
        r"\[第\s*(\d+)\s*页\]\s*(.*?)(?=\n\s*\[第\s*\d+\s*页\]|\Z)",
        corpus or "",
        flags=re.DOTALL,
    )
    for page, text in page_blocks:
        if compact_quote in re.sub(r"\s+", "", text):
            return int(page)
    return None


@app.get("/api/self-test/{paper_rowid}")
async def api_get_self_test(paper_rowid: int, request: Request):
    """拉自测会话；不存在则用五个核心问题建一个。"""
    uid = _get_user_id(request)
    if not _get_owned_paper_or_none(paper_rowid, uid):
        return {"ok": False, "error": "not found"}
    sessions = get_self_test(paper_rowid) or init_self_test(paper_rowid)
    return {"ok": True, "pillars": sessions, "gaps": get_method_gaps(uid, limit=10)}


@app.post("/api/self-test/{paper_rowid}/ask")
async def api_self_test_ask(paper_rowid: int, data: SelfTestAskRequest, request: Request):
    """出题 / 追问下一层。"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    blocked = _self_test_guard(uid)
    if blocked:
        return blocked

    sessions = get_self_test(paper_rowid) or init_self_test(paper_rowid)
    current = next((s for s in sessions if s["pillar_key"] == data.pillar_key), None)
    if not current:
        return {"ok": False, "error": "invalid pillar"}
    if current["turn_count"] >= MAX_PROBES_PER_PILLAR:
        return {"ok": True, "closed": True, "pillar": current}

    sources, corpus = _build_source_context(
        paper_rowid, data.paper_abstract or paper.get("abstract", ""), data.current_page_text)
    history = "\n".join(
        f"{'提问' if t.get('role') == 'ai' else '用户'}：{t.get('text', '')}" for t in current["turns"])

    system_prompt = f"""你在对用户做苏格拉底式提问，检验他是否真读懂了这篇论文。

你是诊断工具，不是老师：
- 只提问，不讲解、不补课、不给答案
- 一次只问一个问题，问得具体，能用一两句话回答
- 用中文，口语化，像同行随口一问，不要学术腔

当前核心问题：{current['pillar_name']}（{current['pillar_short']}）
论文标题：{data.paper_title or paper.get('title', '')}

出题依据（**优先从标②③的地方出题**，只考卡片等于只考他已经会的）：
{sources}

可引用的原文：
{corpus[:20_000]}

严格输出 JSON，不要其他内容：
{{"question": "你要问的问题（40 字以内，具体、可回答）"}}"""

    user_msg = f"这是已经问过的：\n{history}\n\n请追问下一层，要抓住他上一个回答里含糊的地方。" if history else "请出第一个问题。"

    try:
        raw, _, _ = await _llm_chat_complete_async(
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_msg}],
            max_tokens=300, temperature=0.6, task="chat",
        )
        match = re.search(r"\{.*\}", raw or "", re.DOTALL)
        question = str(json.loads(match.group(0)).get("question", "")).strip() if match else ""
        if not question:
            return {"ok": False, "error": "出题失败，请重试。"}
    except (json.JSONDecodeError, AttributeError):
        return {"ok": False, "error": "AI 输出解析失败，请重试。"}
    except Exception as e:
        print(f"[api] self-test/ask 失败: {e}")
        return {"ok": False, "error": "出题失败，请稍后重试。"}

    turns = current["turns"] + [{
        "role": "ai", "text": question,
        "probe": current["turn_count"] > 0, "n": current["turn_count"] + 1,
    }]
    new_state = "vague" if current["state"] == "untouched" else current["state"]
    update_self_test(paper_rowid, data.pillar_key,
                     state=new_state, turns=turns, turn_count=current["turn_count"] + 1)
    return {"ok": True, "question": question, "turn_count": current["turn_count"] + 1,
            "state": new_state, "turns": turns}


@app.post("/api/self-test/{paper_rowid}/answer")
async def api_self_test_answer(paper_rowid: int, data: SelfTestAnswerRequest, request: Request):
    """提交回答 → 三档判定 + 原文锚点（后端校验）+ 三问收口。"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}
    if not (data.answer or "").strip():
        return {"ok": False, "error": "回答不能为空"}
    blocked = _self_test_guard(uid)
    if blocked:
        return blocked

    sessions = get_self_test(paper_rowid) or init_self_test(paper_rowid)
    current = next((s for s in sessions if s["pillar_key"] == data.pillar_key), None)
    if not current:
        return {"ok": False, "error": "invalid pillar"}

    _, corpus = _build_source_context(
        paper_rowid, data.paper_abstract or paper.get("abstract", ""), data.current_page_text)
    asked = next((t["text"] for t in reversed(current["turns"]) if t.get("role") == "ai"), "")

    system_prompt = f"""你在判定用户对一篇论文的理解是否站得住。你是诊断工具，不是老师。

铁律（违反即失败）：
1. 禁止捧场。不得出现「很好的观察」「说得对」「不错」这类评价性开场，直接说结论。
2. 宁可较真，不可捧场。判 solid 的门槛要高：他必须真的答到点上，而不是复述或含糊带过。
3. anchor_quote 必须逐字摘自下面的原文，不得改写、不得凭记忆生成。

三档怎么分（重要）：
- solid：他对这篇论文的判断站得住。**允许他引用原文之外的方法学常识**（如 MCID、偏倚类型、
  统计前提）——只要该常识本身正确、且与原文不矛盾，这恰恰说明他读进去了，判 solid。
- partial：方向对，但漏了关键一块。在 gap 里写清漏的是什么。
- off：他的说法与原文矛盾，或对这篇论文的理解有明确错误，或只是复述没有判断。

注意：不要因为「原文没写这句话」就判 off——那是在惩罚他动用背景知识。
只有当他说的东西**与原文冲突**或**理解错了**，才判 off。

论文标题：{data.paper_title or paper.get('title', '')}
当前核心问题：{current['pillar_name']}
你问他的是：{asked}

原文（判定和锚点只能依据这里）：
{corpus[:24_000]}

严格输出 JSON，不要其他内容：
{{"verdict": "solid|partial|off",
  "gap": "partial/off 时写清缺的具体是哪一块（40 字内）；solid 时为空字符串",
  "anchor_quote": "支持判定的原文原句，逐字摘录，60 字以内",
  "anchor_page": 页码数字或 null,
  "next_probe": "若还需追问下一层，写问题；否则 null",
  "gap_term": "若暴露了某个方法学概念没掌握，写该术语（如 倾向评分匹配 PSM）；否则 null"}}"""

    try:
        raw, _, _ = await _llm_chat_complete_async(
            [{"role": "system", "content": system_prompt},
             {"role": "user", "content": f"他的回答：{data.answer.strip()}"}],
            max_tokens=600, temperature=0.2, task="chat",
        )
        match = re.search(r"\{.*\}", raw or "", re.DOTALL)
        parsed = json.loads(match.group(0)) if match else {}
    except (json.JSONDecodeError, AttributeError):
        return {"ok": False, "error": "AI 输出解析失败，请重试。"}
    except Exception as e:
        print(f"[api] self-test/answer 失败: {e}")
        return {"ok": False, "error": "判定失败，请稍后重试。"}

    verdict = parsed.get("verdict") if parsed.get("verdict") in ("solid", "partial", "off") else "partial"
    anchor_quote = str(parsed.get("anchor_quote") or "").strip()
    gap = str(parsed.get("gap") or "").strip()

    # 锚点逐字校验：编造的锚点一律剥掉，并把 solid 降级——没有锚点的反馈不可信
    anchor_ok = _verify_anchor(anchor_quote, corpus)
    anchor_page = _find_anchor_page(anchor_quote, corpus) if anchor_ok else None
    if not anchor_ok:
        anchor_quote = ""
        if verdict == "solid":
            verdict = "partial"
            gap = gap or "这个说法在原文里没有找到直接依据。"

    gap_term = str(parsed.get("gap_term") or "").strip()
    if gap_term and verdict != "solid":
        record_method_gap(uid, gap_term, paper_rowid)

    turn_count = current["turn_count"]
    next_probe = str(parsed.get("next_probe") or "").strip()
    # 三问收口由后端计数强制，不由模型决定
    closed = verdict == "solid" or turn_count >= MAX_PROBES_PER_PILLAR or not next_probe
    state = "solid" if verdict == "solid" else "vague"

    turns = current["turns"] + [
        {"role": "me", "text": data.answer.strip()},
        {"role": "ai", "text": gap or ("站住了。" if verdict == "solid" else ""),
         "verdict": verdict, "anchor_quote": anchor_quote,
         "anchor_page": anchor_page, "judged": True},
    ]
    if not closed and next_probe:
        turns.append({"role": "ai", "text": next_probe, "probe": True, "n": turn_count + 1})
        turn_count += 1

    update_self_test(paper_rowid, data.pillar_key, state=state, turns=turns, turn_count=turn_count)
    return {
        "ok": True, "verdict": verdict, "gap": gap,
        "anchor_quote": anchor_quote, "anchor_page": anchor_page,
        "anchor_verified": anchor_ok,
        "next_probe": None if closed else next_probe,
        "closed": closed, "state": state, "turns": turns,
        "can_make_card": verdict == "solid",   # 只有站住了的回答才允许沉成卡片
    }


@app.post("/api/self-test/{paper_rowid}/handoff")
async def api_self_test_handoff(paper_rowid: int, data: SelfTestHandoffRequest, request: Request):
    """「不确定 · 转到对话」：带上下文过去 + 标记待澄清（保留回程）。"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_rowid, uid)
    if not paper:
        return {"ok": False, "error": "not found"}

    sessions = get_self_test(paper_rowid) or init_self_test(paper_rowid)
    current = next((s for s in sessions if s["pillar_key"] == data.pillar_key), None)
    if not current:
        return {"ok": False, "error": "invalid pillar"}

    asked = next((t["text"] for t in reversed(current["turns"]) if t.get("role") == "ai"), "")
    page_hint = f" p.{data.current_page}" if data.current_page else ""
    prompt = f"你在读的这篇{page_hint}问到「{current['pillar_name']}」：{asked} 你想先搞懂什么？"
    chips = [f"{current['pillar_name']}是什么意思", "这段原文在说什么", "举个例子说明"]

    # 自测停在这等着——标 asked，不算失败也不算结束
    update_self_test(paper_rowid, data.pillar_key, state="asked")
    return {"ok": True, "prompt": prompt, "chips": chips, "state": "asked"}


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
    profile_text = _build_understanding_profile_text(profile, uid)

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

    # 全篇文字：让 AI 能跨页核对同一指标（图注 AUC vs 表格 AUC 这类矛盾）
    paper_context = ""
    paper_pages = (data.paper_pages or "").strip()
    if paper_pages:
        paper_context = f"""
【本篇已提取的全文（按页标注，可能不含未浏览过的页）】
回答前请把相关的表、图注、正文放在一起看；**同一个指标在不同页出现时必须先核对是否一致**。
{paper_pages[:24000]}
"""

    system_prompt = f"""你是一位学术研究伙伴。用户正在阅读一篇论文，请基于论文内容和用户的研究背景来回答问题。
用中文回答，专业但亲切，像同事在聊天，不像在写报告。

论文标题：{data.paper_title}
论文摘要：{data.paper_abstract[:1200]}

{f"用户研究背景：{chr(10)}{profile_text}" if profile_text else ""}
{notes_context}
{paper_context}
{page_context}

回答要求：
- 直接回答问题，控制在 150-250 字
- 不要用 ### 标题分层，可以用 **加粗** 强调关键词
- 可以用短列表，但不要超过 3 条
- 结合用户研究背景给出具体建议
- 引用论文数据时给出具体数字

说人话，但**说人话 ≠ 说浅话**：
- 术语要当场用一句大白话解释，但**解释完必须回到这篇论文的具体数字上**
- 不要停在打比方。类比只是台阶，落点必须是「这篇的这个数字意味着什么」
- 不要堆砌罗列。一次讲透一件事，好过五件事各说一句

**分清两种信号，别搞反：**
- 用户说「挖深一点 / 说具体点 / 太浅了 / 这我知道」→ **要更深**：给机制、给
  条件、给数字之间的关系、给这个做法的代价和适用边界。**不要再打比方、不要重复已说过的**
- 用户说「太难了 / 说人话 / 完全没概念」→ 才降低难度，挑一个点讲透

**读数字必须较真（这是你最容易失职的地方）：**
- 论文里同一个指标在不同地方出现时，**先核对是否一致**；发现对不上（如图里的 AUC
  和表里的 AUC 不同）必须**主动指出来**并给出可能解释，绝不能挑一个当结论
- 不要把某个指标夸成万能。AUC 高只说明排序能力强，它与「会不会误报」是两回事——
  误报要看精确度/阈值。类似地，准确度在低发生率事件上天然虚高
- **只承认你真的看到的东西**。你读的是 PDF 文字层，看不到颜色、线条、形状。
  不要描述「红色实线」「蓝色柱子」这类你无从得知的视觉细节；
  可以说「图注标了 X」，然后据此推断"""
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
    paper_rowid = data.get("paper_rowid")
    if paper_rowid and not _get_owned_paper_or_none(paper_rowid, uid):
        return {"ok": False, "error": "not found"}
    record_reading(paper_rowid, data.get("title", ""), uid)
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
def api_export_ris(paper_id: int, request: Request):
    """导出收藏论文为 RIS 格式"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
    if not paper:
        return PlainTextResponse("Not found", status_code=404)
    ris = _paper_to_ris(paper)
    return PlainTextResponse(
        ris,
        media_type="application/x-research-info-systems",
        headers={"Content-Disposition": f'attachment; filename="paper_{paper_id}.ris"'},
    )


@app.get("/api/export/bibtex/{paper_id}")
def api_export_bibtex(paper_id: int, request: Request):
    """导出收藏论文为 BibTeX 格式"""
    uid = _get_user_id(request)
    paper = _get_owned_paper_or_none(paper_id, uid)
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

@app.get("/api/portrait")
async def api_get_portrait(request: Request):
    """书架画像卡：由精读行为聚合的只读摘要（主题分布 + 卡片构成）"""
    uid = _get_user_id(request)
    return get_portrait(uid)


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
