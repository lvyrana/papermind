"""
PaperMind 后端 API
启动: .venv_new/bin/python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations
import os
import json
import httpx
import threading
import re
import time
from datetime import datetime, timedelta
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel, Field
from openai import OpenAI

from src.fetch_papers import get_papers as pubmed_get_papers, build_query as build_pubmed_query
from src.fetch_semantic_scholar import get_papers as scholar_get_papers
from src.categorize_papers import score_and_categorize_papers
from src.database import (
    init_db, save_paper, get_saved_papers, get_saved_paper,
    delete_saved_paper, update_paper_enrichment, save_note, delete_note, get_note_owner, get_notes, save_chat_message,
    get_saved_categories,
    get_chat_history, record_reading, get_reading_history,
    get_profile, save_profile, get_saved_titles, save_search_run, get_latest_search_run,
    check_rate_limit, increment_rate_limit, get_rate_limit_remaining,
)

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
DAILY_RECOMMEND_LIMIT = int(os.environ.get("DAILY_RECOMMEND_LIMIT", "8"))
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
    tracking_days: str = "30"
    interests_summary: str = ""
    interests_summary_is_manual: str = "0"

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


# ========== User ID ==========

def _get_user_id(request: Request) -> str:
    """从请求头获取用户 ID"""
    return request.headers.get("X-User-ID", "anonymous")


def _get_owned_paper_or_none(paper_id: int, user_id: str) -> Optional[dict]:
    """只返回当前用户自己的收藏论文。"""
    paper = get_saved_paper(paper_id)
    if not paper:
        return None
    if paper.get("user_id", "") != user_id:
        return None
    return paper


# ========== 内置 LLM（阿里云优先，GLM 备用，DeepSeek 兜底） ==========

_LLM_PROVIDERS = [
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

def _get_qwen_models() -> list[str]:
    primary = os.environ.get("QWEN_MODEL", "qwen-plus").strip()
    fallback_raw = os.environ.get("QWEN_FALLBACK_MODELS", "")
    fallback_models = [m.strip() for m in fallback_raw.split(",") if m.strip()]
    models: list[str] = []
    for model in [primary, *fallback_models]:
        if model and model not in models:
            models.append(model)
    return models


def _get_llm_slots() -> list[dict]:
    slots: list[dict] = []

    qwen_api_key = os.environ.get("QWEN_API_KEY", "").strip()
    if qwen_api_key:
        qwen_base_url = os.environ.get("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        for model in _get_qwen_models():
            slots.append({
                "name": "qwen",
                "api_key": qwen_api_key,
                "base_url": qwen_base_url,
                "model": model,
            })

    slots.extend(_LLM_PROVIDERS)
    return slots


def _build_llm_client(provider: dict) -> OpenAI:
    http_client = httpx.Client(
        transport=httpx.HTTPTransport(local_address="0.0.0.0"),
        timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0),
    )
    return OpenAI(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        http_client=http_client,
        timeout=60.0,
    )


def _get_llm_client() -> tuple[Optional[OpenAI], str]:
    """返回当前首选内置 LLM client（用于状态展示等轻量场景）"""
    for provider in _get_llm_slots():
        api_key = provider["api_key"].strip()
        if not api_key:
            continue
        try:
            client = _build_llm_client(provider)
            return client, provider["model"]
        except Exception as e:
            print(f"[llm] {provider['name']} 初始化失败: {e}")
            continue
    return None, ""


def _llm_chat_complete(messages: list[dict], max_tokens: int = 800, temperature: float = 0.3) -> tuple[str, str, str]:
    last_error = ""
    for provider in _get_llm_slots():
        api_key = provider["api_key"].strip()
        if not api_key:
            print(f"[llm] 跳过 {provider['name']} / {provider['model']}（未配置 key）")
            continue
        name = f"{provider['name']} / {provider['model']}"
        try:
            client = _build_llm_client(provider)
            resp = client.chat.completions.create(
                model=provider["model"],
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            content = (resp.choices[0].message.content or "").strip()
            if content:
                print(f"[llm] ✓ {name}")
                return content, provider["name"], provider["model"]
            else:
                print(f"[llm] {name} 返回空内容，尝试下一个")
                last_error = "empty content"
                continue
        except Exception as e:
            last_error = str(e)
            print(f"[llm] ✗ {name}: {e}")
            continue
    print(f"[llm] 所有 provider 失败，最后错误: {last_error}")
    return "", "", ""


def _llm_complete(prompt: str, max_tokens: int = 800) -> str:
    content, _, _ = _llm_chat_complete(
        [{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.3,
    )
    return content


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
def api_test_settings(request: Request):
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
    result = _llm_complete("请回复两个字：成功", max_tokens=10)
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
    next_profile = data.dict()
    watched_fields = ("focus_areas", "exclude_areas", "method_interests", "current_goal", "background", "discipline", "tracking_days")
    profile_changed = any((previous.get(field) or "") != (next_profile.get(field) or "") for field in watched_fields)

    if profile_changed:
        # 画像方向一变，旧行为摘要很容易把新方向"硬拉回去"，清空并等待重新生成。
        next_profile["interests_summary"] = ""
        next_profile["interests_summary_is_manual"] = "0"
        next_profile["interests_summary_updated_at"] = ""
    else:
        # 摘要字段由前端携带：如果内容变了则更新时间戳，否则沿用已有元数据
        prev_summary = previous.get("interests_summary", "")
        new_summary = next_profile.get("interests_summary", "")
        if new_summary != prev_summary:
            next_profile["interests_summary_updated_at"] = datetime.now().isoformat()
        else:
            next_profile["interests_summary_updated_at"] = previous.get("interests_summary_updated_at", "")
            next_profile["interests_summary_is_manual"] = previous.get("interests_summary_is_manual", "0")

    save_profile(uid, next_profile)

    if profile_changed:
        _reset_user_cache(uid)

    return {"ok": True}

@app.post("/api/profile/interests-summary")
def api_update_interests_summary(request: Request):
    """根据用户行为生成兴趣摘要，存入 profile.interests_summary"""
    uid = _get_user_id(request)
    profile = get_profile(uid)

    # 用户手动编辑过摘要，不自动覆盖
    if profile.get("interests_summary_is_manual") == "1":
        return {"ok": True, "skipped": True, "summary": profile.get("interests_summary", "")}

    # 24 小时内不重复生成
    last_updated = profile.get("interests_summary_updated_at", "")
    if last_updated:
        try:
            from datetime import timezone
            last_dt = datetime.fromisoformat(last_updated)
            if (datetime.now() - last_dt).total_seconds() < 86400:
                return {"ok": True, "skipped": True}
        except Exception:
            pass

    client, model = _get_llm_client()
    if not client:
        return {"ok": False, "error": "AI 不可用"}

    saved_titles = get_saved_titles(uid)
    if not saved_titles:
        return {"ok": True, "skipped": True}

    # 获取分类分布
    category_dist = get_saved_categories(uid)
    category_text = "、".join(f"{k}({v}篇)" for k, v in list(category_dist.items())[:8]) if category_dist else "（暂无）"

    # 获取最近对话中用户的提问
    recent_questions = []
    try:
        from src.database import get_all_recent_chats
        recent_chats = get_all_recent_chats(uid, limit=30)
        recent_questions = [m["content"] for m in recent_chats if m.get("role") == "user"][:15]
    except Exception:
        pass

    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")

    prompt = f"""根据以下用户行为数据，生成一段 150-200 字的用户兴趣画像摘要。

用户研究背景：
研究方向：{focus}
方法兴趣：{method_interests}
研究经历：{background}

近期收藏的论文（反映真实兴趣）：
{chr(10).join(f'- {t}' for t in saved_titles[:15])}

收藏论文的分类分布：{category_text}

近期对话中的提问（反映关注点）：
{chr(10).join(f'- {q}' for q in recent_questions) if recent_questions else '（暂无）'}

要求：
- 总结用户真正关注的细分方向（从收藏、分类和提问行为推断，而非只看填写的画像）
- 指出用户常问的问题类型（方法学？临床意义？可复制性？）
- 语言简洁，像一段内部备忘录
- 只输出摘要正文，不加标题"""

    try:
        summary, _, _ = _llm_chat_complete(
            [{"role": "user", "content": prompt}],
            max_tokens=400,
            temperature=0.3,
        )
        if not summary:
            raise RuntimeError("empty response")
        updated_profile = {**profile, "interests_summary": summary, "interests_summary_updated_at": datetime.now().isoformat(), "interests_summary_is_manual": "0"}
        save_profile(uid, updated_profile)
        return {"ok": True, "summary": summary}
    except Exception as e:
        print(f"[api] interests-summary 生成失败: {e}")
        return {"ok": False, "error": "摘要生成失败，请稍后重试"}


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


def _parse_pub_date(pub_date: str) -> Optional[datetime]:
    """尽量把论文日期解析成 datetime，用于严格的时间窗过滤。"""
    if not pub_date:
        return None

    text = pub_date.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    normalized = re.sub(r"\s+", "-", text.replace("/", "-"))
    month_map = {
        "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
        "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
    }
    for month_name, month_num in month_map.items():
        normalized = normalized.replace(month_name, month_num)

    for fmt in ("%Y-%m-%d", "%Y-%m"):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue

    match = re.search(r"(20\d{2})", text)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y")
        except ValueError:
            return None
    return None


def _filter_papers_by_days(papers: list[dict], days: int) -> list[dict]:
    """按真实日期过滤论文，避免超出用户设定的追踪周期。"""
    cutoff = datetime.now() - timedelta(days=days)
    filtered = []
    dropped = 0
    for paper in papers:
        parsed_date = _parse_pub_date(paper.get("pub_date", ""))
        if parsed_date and parsed_date < cutoff:
            dropped += 1
            continue
        filtered.append(paper)
    if dropped:
        print(f"[api] 按 {days} 天时间窗过滤掉 {dropped} 篇旧论文")
    return filtered


def _split_profile_terms(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[，,、/；;]+", text or "") if part.strip()]


def _dedupe_terms(terms: list[str]) -> list[str]:
    seen = set()
    result = []
    for term in terms:
        key = (term or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(term.strip())
    return result


def _expand_exclude_terms(raw_terms: list[str]) -> list[str]:
    """把用户排除词扩展成更容易命中的中英文关键词。"""
    alias_map = {
        "药物研究": ["drug", "drugs", "medication", "pharmacologic", "pharmacological", "pharmacotherapy", "pharmaceutical"],
        "药物治疗": ["drug therapy", "medication", "pharmacologic", "pharmacological", "pharmacotherapy"],
        "药物合成": ["drug synthesis", "synthesis", "compound synthesis", "pharmaceutical synthesis"],
        "基础研究": ["basic science", "basic research", "mechanism", "molecular", "cellular", "animal model"],
        "动物实验": ["animal", "mice", "mouse", "rat", "rats", "murine"],
        "分子机制": ["molecular mechanism", "mechanism", "signaling pathway", "gene expression"],
    }
    expanded: list[str] = []
    for term in raw_terms:
        expanded.append(term)
        expanded.extend(alias_map.get(term, []))
        expanded.extend(alias_map.get(term.lower(), []))
    return _dedupe_terms(expanded)


def _paper_matches_exclude(paper: dict, exclude_terms: list[str]) -> bool:
    if not exclude_terms:
        return False
    haystack = " ".join([
        paper.get("title", ""),
        paper.get("abstract", ""),
        " ".join(paper.get("publication_types", []) or []),
    ]).lower()
    for term in exclude_terms:
        token = (term or "").strip().lower()
        if token and token in haystack:
            return True
    return False


def _is_low_value_publication(paper: dict) -> bool:
    """过滤 reply/comment/editorial/letter 等低价值条目，以及无摘要条目。"""
    publication_types = [t.lower() for t in (paper.get("publication_types", []) or [])]
    low_value_types = {
        "comment",
        "editorial",
        "letter",
        "news",
        "published erratum",
        "retraction of publication",
    }
    if any(pt in low_value_types for pt in publication_types):
        return True

    title = (paper.get("title", "") or "").strip().lower()
    low_value_prefixes = (
        "reply",
        "reply to",
        "comment on",
        "editorial",
        "letter to the editor",
    )
    if any(title.startswith(prefix) for prefix in low_value_prefixes):
        return True

    abstract = (paper.get("abstract", "") or "").strip()
    if paper.get("has_abstract") is False:
        return True
    if abstract in {"", "（无摘要）", "(no abstract)"}:
        return True

    return False


def _build_broader_queries(profile: dict) -> list[str]:
    """当首轮检索过窄时，构造更宽的主题查询作为兜底。"""
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    if not focus_terms:
        return []

    broad_queries = []
    for term in focus_terms[:4]:
        broad_queries.append(term)
    # 去重并保持顺序
    seen = set()
    result = []
    for query in broad_queries:
        key = query.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(query)
    return result[:6]


def _normalize_focus_terms(focus: str) -> list[str]:
    """把常见中文研究主题映射到更稳定的英文检索词。"""
    alias_map = {
        "慢阻肺": "COPD",
        "肺癌": "lung cancer",
        "肺康复": "pulmonary rehabilitation",
        "慢病护理": "chronic disease nursing",
        "护理": "nursing",
        "解释性现象学": "interpretative phenomenological analysis",
        "现象学": "phenomenological study",
        "质性研究": "qualitative research",
        "扎根理论": "grounded theory",
        "主题分析": "thematic analysis",
    }
    terms = _split_profile_terms(focus)
    normalized = []
    for term in terms:
        normalized.append(alias_map.get(term, term))
    return normalized


def _normalize_method_terms(methods: str, keep_unknown: bool = True) -> list[str]:
    """把方法兴趣转换成稳定的英文方法术语。"""
    alias_map = {
        "解释性现象学": "interpretative phenomenological analysis",
        "ipa": "interpretative phenomenological analysis",
        "现象学": "phenomenological study",
        "质性研究": "qualitative research",
        "定性研究": "qualitative research",
        "扎根理论": "grounded theory",
        "主题分析": "thematic analysis",
        "机器学习": "machine learning",
        "预测模型": "prediction model",
        "孟德尔随机化": "mendelian randomization",
        "中介效应": "mediation analysis",
    }
    normalized = []
    for term in _split_profile_terms(methods):
        mapped = alias_map.get(term.lower(), alias_map.get(term))
        if mapped:
            normalized.append(mapped)
        elif keep_unknown:
            normalized.append(term)
    return _dedupe_terms(normalized)


def _build_method_aware_queries(profile: dict) -> list[str]:
    """基于主题和方法兴趣，构造一批带主题锚点的确定性查询。"""
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    method_terms = _normalize_method_terms(profile.get("method_interests", ""))
    method_terms.extend(_normalize_method_terms(profile.get("focus_areas", ""), keep_unknown=False))
    method_terms = _dedupe_terms(method_terms)

    if not (focus_terms or method_terms):
        return []

    has_qualitative_family = any(term in method_terms for term in (
        "qualitative research",
        "interpretative phenomenological analysis",
        "phenomenological study",
        "grounded theory",
        "thematic analysis",
    ))

    method_templates = method_terms.copy()
    if has_qualitative_family:
        method_templates.extend([
            "qualitative research",
            "qualitative study",
            "patient experience",
            "lived experience",
        ])
    method_templates = _dedupe_terms(method_templates)

    query_groups: list[str] = []

    for focus in focus_terms[:4]:
        query_groups.append(focus)
        if method_templates:
            for method in method_templates[:3]:
                query_groups.append(f"{focus} {method}")

    return _dedupe_terms(query_groups)[:8]


def _generate_search_keywords(profile: dict, client, model: str) -> list[str]:
    """根据当前用户画像，用 LLM 生成多组搜索关键词。"""
    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")

    if not (focus or method_interests or background):
        return []

    exclude = profile.get("exclude_areas", "")
    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if method_interests:
        profile_text += f"方法兴趣：{method_interests}\n"
    if background:
        profile_text += f"补充说明：{background}\n"
    if exclude:
        profile_text += f"明确排除（不要生成相关关键词）：{exclude}\n"

    # 结构化字段不完整时，提示 LLM 从自然语言深度提取
    sparse_focus = len((focus or "").strip()) < 10
    sparse_hint = ""
    if sparse_focus and background:
        sparse_hint = (
            "\n注意：该用户的「研究方向」填写较少，请重点从「补充说明」的自然语言中，"
            "提取以下要素并转化为检索词：\n"
            "- 疾病 / 症状 / 临床问题（如：带状疱疹、COPD、术后疼痛）\n"
            "- 目标人群（如：老年患者、住院患者、护理人员）\n"
            "- 干预方式 / 研究内容（如：中医干预、康复护理、自我管理）\n"
            "- 研究设计偏好（如：综述、RCT、质性研究）\n"
            "将上述要素组合成多组有效的 PubMed 英文检索词。\n"
        )

    prompt = f"""你是一位学术检索专家。根据以下研究者画像，生成用于 PubMed 检索的英文关键词组合。

    {profile_text}
    {sparse_hint}
要求：
1. 生成 4-6 组关键词，每组是一个用于 PubMed 搜索的英文查询字符串
2. 每组关键词控制在 2-4 个词以内，不要堆砌过多词汇
3. 覆盖研究者关注方向的不同角度：至少 2 组聚焦疾病/临床场景，1-2 组聚焦方法，不要每组都把所有关键词堆在一起
4. 必须使用英文专业学术术语（PubMed 只支持英文检索）
5. 可以使用 AND/OR 组合，但每组词之间不需要全部 AND，允许适度宽泛
6. 严格避免生成用户明确排除的领域的关键词
7. 如果研究者明确写了方法兴趣，请至少生成 1-2 组能体现这些方法兴趣的查询，但不要完全脱离研究主题
8. 明确输入的研究方向和方法兴趣优先级最高，始终以研究方向为核心组织检索
9. 每一组查询都必须保留至少一个"研究主题锚点"（疾病、人群、场景、护理问题等），不能只剩方法词，例如不能只写 qualitative research、thematic analysis、patient experience 这类宽泛查询
10. 学科领域仅用于后续解读和排序，不参与本轮检索词生成；请不要因为学科领域自动补入 nursing、patient、caregiver、self-management 等语境词，除非它们来自研究方向、方法兴趣或补充说明本身

示例输出：["COPD self-management", "lung cancer mortality prediction", "COPD exacerbation readmission risk", "symptom management quality of life", "machine learning hospital readmission"]

只输出 JSON 数组，不要 markdown 代码块，不要其他文字。"""

    try:
        raw, _, _ = _llm_chat_complete(
            [{"role": "user", "content": prompt}],
            max_tokens=400,
            temperature=0.3,
        )
        if not raw:
            raise RuntimeError("empty response")
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        keywords = json.loads(raw)
        print(f"[api] LLM 生成搜索关键词: {keywords}")
        return keywords
    except Exception as e:
        print(f"[api] 关键词生成失败: {e}")
        return []


def _clean_query_text(query: str) -> str:
    return re.sub(r"\s+", " ", (query or "").replace("\n", " ")).strip().strip(",;")


def _query_has_focus_anchor(query: str, focus_terms: list[str]) -> bool:
    english_focus_terms = [term for term in focus_terms if re.search(r"[A-Za-z]", term or "")]
    if not english_focus_terms:
        return True
    lower_query = query.lower()
    return any(term.lower() in lower_query for term in english_focus_terms)


def _is_overly_generic_query(query: str, method_terms: list[str]) -> bool:
    lower_query = query.lower()
    generic_queries = {
        "qualitative research",
        "qualitative study",
        "patient experience",
        "lived experience",
        "grounded theory",
        "thematic analysis",
        "phenomenological study",
        "interpretative phenomenological analysis",
        "nursing",
        "nursing patient experience",
    }
    if lower_query in generic_queries:
        return True

    generic_tokens = {
        "qualitative", "research", "study", "patient", "experience", "lived",
        "grounded", "theory", "thematic", "analysis", "phenomenological",
        "interpretative", "nursing", "care", "caregiver",
    }
    generic_tokens.update(
        token
        for term in method_terms
        for token in re.findall(r"[a-z0-9-]+", term.lower())
    )
    tokens = re.findall(r"[a-z0-9-]+", lower_query)
    return bool(tokens) and all(token in generic_tokens for token in tokens)


def _sanitize_generated_queries(raw_queries: list[str], profile: dict) -> tuple[list[str], list[dict]]:
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    method_terms = _normalize_method_terms(profile.get("method_interests", ""))
    dropped: list[dict] = []
    sanitized: list[str] = []

    for raw_query in raw_queries or []:
        query = _clean_query_text(raw_query)
        if not query:
            continue
        if not _query_has_focus_anchor(query, focus_terms):
            dropped.append({"query": query, "reason": "missing_focus_anchor"})
            continue
        if _is_overly_generic_query(query, method_terms):
            dropped.append({"query": query, "reason": "too_generic"})
            continue
        sanitized.append(query)

    return _dedupe_terms(sanitized), dropped


def _build_query_specs(profile: dict, keyword_list: list[str], smart_queries: list[str]) -> tuple[list[dict], list[dict]]:
    query_specs: list[dict] = []
    dropped_queries: list[dict] = []

    sanitized_llm, dropped = _sanitize_generated_queries(smart_queries, profile)
    dropped_queries.extend([{**item, "origin": "llm"} for item in dropped])
    for query in sanitized_llm:
        query_specs.append({"query": query, "origin": "llm"})

    if keyword_list:
        manual_query = " OR ".join(_dedupe_terms(keyword_list))
        if manual_query:
            query_specs.append({"query": manual_query, "origin": "manual"})

    if len(query_specs) < 3:
        for query in _build_method_aware_queries(profile):
            query_specs.append({"query": query, "origin": "deterministic"})

    if len(query_specs) < 3:
        for query in _build_broader_queries(profile):
            query_specs.append({"query": query, "origin": "broad_fallback"})

    deduped_specs = []
    seen = set()
    for spec in query_specs:
        query = _clean_query_text(spec.get("query", ""))
        key = query.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_specs.append({**spec, "query": query})

    return deduped_specs[:6], dropped_queries


def _round_robin_sources(papers: list[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = {}
    for paper in papers:
        buckets.setdefault(paper.get("source", "unknown"), []).append(paper)

    if len(buckets) <= 1:
        return papers

    source_order = sorted(buckets.keys(), key=lambda key: (-len(buckets[key]), key))
    mixed: list[dict] = []
    while True:
        progressed = False
        for source in source_order:
            if buckets[source]:
                mixed.append(buckets[source].pop(0))
                progressed = True
        if not progressed:
            break
    return mixed


def _fetch_and_cache_papers(keyword_list, days, source, profile, user_id: str = ""):
    """从 PubMed + Semantic Scholar 抓取论文并缓存，同时记录检索轨迹。"""
    client, model = _get_llm_client()
    trace = {
        "created_at": datetime.now().isoformat(),
        "source_requested": source,
        "input_keywords": keyword_list or [],
        "profile_snapshot": {
            "discipline": profile.get("discipline", ""),
            "focus_areas": profile.get("focus_areas", ""),
            "method_interests": profile.get("method_interests", ""),
            "exclude_areas": profile.get("exclude_areas", ""),
            "tracking_days": str(days),
        },
        "llm_queries_raw": [],
        "translated_queries_raw": [],
        "dropped_queries": [],
        "queries": [],
        "totals": {},
        "final_source_counts": {},
    }

    # 如果有 LLM 且有画像，用 LLM 生成搜索关键词
    smart_queries = []
    if client and (profile.get("focus_areas") or profile.get("method_interests") or profile.get("background")):
        smart_queries = _generate_search_keywords(profile, client, model)
    trace["llm_queries_raw"] = smart_queries

    query_specs, dropped_queries = _build_query_specs(profile, keyword_list, smart_queries)
    trace["dropped_queries"] = dropped_queries

    # 如果 LLM 生成失败且没有足够查询，用翻译后的确定性词兜底
    if len(query_specs) < 2 and client:
        focus = profile.get("focus_areas", "")
        method_interests = profile.get("method_interests", "")
        fallback_seed = ", ".join(part for part in [focus, method_interests] if part)
        if fallback_seed:
            try:
                translated, _, _ = _llm_chat_complete(
                    [{"role": "user", "content": f'将以下研究方向和方法兴趣翻译为英文学术术语，用逗号分隔，只输出翻译结果：{fallback_seed}'}],
                    max_tokens=200,
                    temperature=0,
                )
                translated_queries = [t.strip() for t in translated.split(",") if t.strip()]
                trace["translated_queries_raw"] = translated_queries
                print(f"[api] 翻译画像关键词: {translated_queries}")
                translated_specs, translated_dropped = _build_query_specs(profile, [], translated_queries)
                trace["dropped_queries"].extend([{**item, "origin": "translated_fallback"} for item in translated_dropped])
                for spec in translated_specs:
                    query_specs.append({**spec, "origin": "translated_fallback"})
            except Exception:
                pass

    deduped_specs = []
    seen_queries = set()
    for spec in query_specs:
        query = _clean_query_text(spec.get("query", ""))
        key = query.lower()
        if not key or key in seen_queries:
            continue
        seen_queries.add(key)
        deduped_specs.append({**spec, "query": query})
    query_specs = deduped_specs[:6]

    if not query_specs:
        print("[api] 无搜索关键词，跳过")
        trace["totals"] = {"query_count": 0, "raw_papers": 0, "final_papers": 0}
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    all_papers = []
    scholar_query_count = 0

    for spec in query_specs:
        query = spec["query"]
        origin = spec.get("origin", "unknown")
        query_keywords = [k.strip() for k in query.split(" OR ") if k.strip()] if " OR " in query else [query]
        query_trace = {
            "query": query,
            "origin": origin,
            "query_keywords": query_keywords,
            "pubmed_query": build_pubmed_query(query_keywords, days) if source in ("pubmed", "all") else "",
            "semantic_query": " ".join(query_keywords) if source in ("semantic_scholar", "all") else "",
            "sources": [],
        }

        if source in ("pubmed", "all"):
            try:
                pubmed_papers = pubmed_get_papers(query_keywords, days=days, max_results=30)
                for p in pubmed_papers:
                    p["source"] = "pubmed"
                    p.setdefault("_matched_queries", []).append(query)
                all_papers.extend(pubmed_papers)
                query_trace["sources"].append({"source": "pubmed", "status": "ok", "count": len(pubmed_papers)})
            except Exception as e:
                print(f"[api] PubMed 获取失败 ({query}): {e}")
                query_trace["sources"].append({"source": "pubmed", "status": "error", "count": 0, "error": str(e)})

        if source in ("semantic_scholar", "all"):
            try:
                if scholar_query_count >= 4:
                    print("[api] Semantic Scholar 查询已达本轮上限，跳过剩余查询")
                    query_trace["sources"].append({"source": "semantic_scholar", "status": "skipped_limit", "count": 0})
                else:
                    # 往前多推 1 年，避免最新论文在 S2 尚无摘要导致全部被过滤
                    year_from = (datetime.now() - timedelta(days=max(days, 30) + 365)).strftime("%Y")
                    scholar_papers = scholar_get_papers(query_keywords, max_results=15, year_from=year_from)
                    for p in scholar_papers:
                        p.setdefault("_matched_queries", []).append(query)
                    all_papers.extend(scholar_papers)
                    scholar_query_count += 1
                    query_trace["sources"].append({"source": "semantic_scholar", "status": "ok", "count": len(scholar_papers)})
                    time.sleep(0.6)
            except Exception as e:
                print(f"[api] Semantic Scholar 获取失败 ({query}): {e}")
                query_trace["sources"].append({"source": "semantic_scholar", "status": "error", "count": 0, "error": str(e)})
        trace["queries"].append(query_trace)

    if not all_papers:
        trace["totals"] = {
            "query_count": len(query_specs),
            "raw_papers": 0,
            "after_dedupe": 0,
            "after_saved_filter": 0,
            "after_day_filter": 0,
            "final_papers": 0,
        }
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    # 去重
    seen_titles = set()
    unique_papers = []
    for p in all_papers:
        title_key = p["title"].lower().strip()[:80]
        if title_key not in seen_titles:
            seen_titles.add(title_key)
            unique_papers.append(p)

    print(f"[api] 去重后 {len(unique_papers)} 篇论文")
    trace["totals"]["query_count"] = len(query_specs)
    trace["totals"]["raw_papers"] = len(all_papers)
    trace["totals"]["after_dedupe"] = len(unique_papers)

    # 过滤已收藏论文（避免推荐用户已保存的）
    if saved_titles and user_id:
        saved_set = {t.lower().strip()[:80] for t in saved_titles}
        before = len(unique_papers)
        unique_papers = [p for p in unique_papers if p["title"].lower().strip()[:80] not in saved_set]
        filtered_saved = before - len(unique_papers)
        if filtered_saved:
            print(f"[api] 过滤已收藏论文 {filtered_saved} 篇")
    trace["totals"]["after_saved_filter"] = len(unique_papers)

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

    unique_papers = _filter_papers_by_days(unique_papers, days)
    trace["totals"]["after_day_filter"] = len(unique_papers)
    if not unique_papers:
        print("[api] 时间窗过滤后无论文")
        trace["totals"]["final_papers"] = 0
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    before_low_value = len(unique_papers)
    unique_papers = [p for p in unique_papers if not _is_low_value_publication(p)]
    filtered_low_value = before_low_value - len(unique_papers)
    trace["totals"]["after_low_value_filter"] = len(unique_papers)
    if filtered_low_value:
        print(f"[api] 过滤低价值/无摘要文献 {filtered_low_value} 篇")
    if not unique_papers:
        print("[api] 低价值文献过滤后无论文")
        trace["totals"]["final_papers"] = 0
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    raw_exclude_terms = _split_profile_terms(profile.get("exclude_areas", ""))
    exclude_terms = _expand_exclude_terms(raw_exclude_terms)
    if exclude_terms:
        before_exclude = len(unique_papers)
        unique_papers = [p for p in unique_papers if not _paper_matches_exclude(p, exclude_terms)]
        filtered_exclude = before_exclude - len(unique_papers)
        trace["totals"]["after_exclude_filter"] = len(unique_papers)
        if filtered_exclude:
            print(f"[api] 按排除词硬过滤 {filtered_exclude} 篇")
        if not unique_papers:
            print("[api] 排除词过滤后无论文")
            trace["totals"]["final_papers"] = 0
            trace["run_id"] = save_search_run(user_id, source, trace)
            return [], trace

    # LLM 打分 + 动态分类 + 排序（已按分数降序）
    if client:
        unique_papers = score_and_categorize_papers(unique_papers, profile, client, model)
        scored = [p for p in unique_papers if p.get("relevance_score", 5) >= 3]
        if len(scored) >= 8:
            filtered = len(unique_papers) - len(scored)
            unique_papers = scored
            if filtered:
                print(f"[api] 过滤低相关性论文 {filtered} 篇")
        else:
            target_count = min(10, len(unique_papers))
            borderline = [
                p for p in unique_papers
                if 2 <= p.get("relevance_score", 5) < 3
            ][: max(target_count - len(scored), 0)]
            unique_papers = scored + borderline
            unique_papers.sort(key=lambda p: p.get("relevance_score", 0), reverse=True)
            print(f"[api] 高分论文不足 8 篇，保留 {len(unique_papers)} 篇不重复的中高相关论文")

    if source == "all":
        unique_papers = _round_robin_sources(unique_papers)

    for paper in unique_papers:
        paper.pop("_matched_queries", None)

    final_source_counts: dict[str, int] = {}
    for paper in unique_papers:
        paper_source = paper.get("source", "unknown")
        final_source_counts[paper_source] = final_source_counts.get(paper_source, 0) + 1
    trace["final_source_counts"] = final_source_counts
    trace["totals"]["final_papers"] = len(unique_papers)
    trace["run_id"] = save_search_run(user_id, source, trace)

    print(f"[api] 最终缓存 {len(unique_papers)} 篇论文")
    return unique_papers, trace


# ========== Papers Routes ==========

def _bg_fetch_and_enrich(cache, keyword_list, days, source, profile, uid):
    """后台线程：抓取论文 + AI 解读"""
    try:
        papers, search_debug = _fetch_and_cache_papers(keyword_list, days, source, profile, uid)
        cache["papers"] = papers
        cache["fetched_at"] = datetime.now()
        cache["served_indices"] = set()
        cache["current_page"] = []
        cache["pages_history"] = []   # 新批次开始，旧翻页历史全部作废
        cache["search_debug"] = search_debug

        # 对前 10 篇做 AI 解读
        unenriched = [p for p in papers[:10] if not p.get("summary_zh")]
        if unenriched:
            client, model = _get_llm_client()
            if client:
                _enrich_papers_with_llm(unenriched, profile, uid)
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

    # Rate limit（owner 不限量）：所有会触发新抓取的路径统一检查
    is_owner = OWNER_UID and uid == OWNER_UID
    if not is_owner and need_fetch:
        remaining_quota = get_rate_limit_remaining(uid, "recommend", DAILY_RECOMMEND_LIMIT)
        if remaining_quota <= 0:
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
        increment_rate_limit(uid, "recommend")
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


def _enrich_papers_with_llm(papers: list[dict], profile: dict, user_id: str = ""):
    """为论文添加详细中文解读和个性化相关性分析"""
    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")
    discipline = profile.get("discipline", "")
    interests_summary = profile.get("interests_summary", "")
    is_manual = profile.get("interests_summary_is_manual", "0") == "1"

    profile_text = ""
    if discipline:
        profile_text += f"学科领域：{discipline}\n"
    if focus:
        profile_text += f"追踪主题：{focus}\n"
    if method_interests:
        profile_text += f"方法兴趣（仅辅助参考）：{method_interests}\n"
    if background:
        profile_text += f"补充说明：{background}\n"
    # 只有用户手动编辑过的摘要才注入 AI 解读，避免自动生成内容影响相关性判断
    if is_manual and interests_summary:
        profile_text += f"---\n用户修正后的偏好（高于系统自动观察，但低于以上明确输入）：{interests_summary}\n"

    for i, paper in enumerate(papers):
        paper["_enrich_attempts"] = paper.get("_enrich_attempts", 0) + 1
        paper["summary_status"] = "pending"
        try:
            prompt = f"""你是一位专业的学术论文解读助手。请对以下论文进行详细解读。

论文标题：{paper['title']}
论文摘要：{paper['abstract'][:1200]}

    {f"研究者背景（仅供参考，不要在输出中罗列这些关键词）：{chr(10)}{profile_text}" if profile_text else ""}

    请用 JSON 格式输出以下内容：

{{
  "summary_zh": "详细中文解读（4-6句话，包含：研究背景与目的、研究方法、主要发现、意义。语言专业但易懂）",
  "relevance": "这篇论文对研究者的启发（1-2句话。只基于论文实际内容来写，不要罗列研究者画像中的关键词，也不要因为用户之前读过类似方向就硬说相关。如果论文没有直接涉及某个方向就不要提它。重点说：论文的什么发现或方法能给研究者带来什么具体启发）",
  "key_findings": ["核心发现1", "核心发现2", "核心发现3"]
}}

    只输出 JSON，不加其他文字。
    如提供了"用户修正后的偏好"，请综合以上信息，优先考虑研究者明确输入和用户修正后的偏好；但相关性判断仍必须以论文实际内容为依据。"""

            raw, _, _ = _llm_chat_complete(
                [{"role": "user", "content": prompt}],
                max_tokens=800,
                temperature=0.3,
            )
            if not raw:
                raise RuntimeError("empty response")
            result = _extract_json_object(raw)
            paper["summary_zh"] = result.get("summary_zh", "")
            paper["relevance"] = result.get("relevance", "")
            paper["key_findings"] = result.get("key_findings", [])
            paper["summary_status"] = "done" if paper["summary_zh"] else "pending"
        except Exception as e:
            print(f"[api] 论文 {i+1} LLM 处理失败，尝试简化重试: {e}")
            try:
                retry_prompt = f"""请只输出 JSON，为这篇论文生成简洁中文解读。

论文标题：{paper['title']}
论文摘要：{paper.get('abstract', '')[:900]}

JSON 格式：
{{
  "summary_zh": "3-4句话，概括研究对象、方法、主要发现和意义",
  "relevance": "1句话，说明这篇论文对研究者的启发；如果直接关联有限，就明确写直接关联有限"
}}
"""
                retry_raw, _, _ = _llm_chat_complete(
                    [{"role": "user", "content": retry_prompt}],
                    max_tokens=500,
                    temperature=0.2,
                )
                if not retry_raw:
                    raise RuntimeError("empty response")
                retry_result = _extract_json_object(retry_raw)
                paper["summary_zh"] = retry_result.get("summary_zh", "")
                paper["relevance"] = retry_result.get("relevance", "")
                paper["key_findings"] = []
                paper["summary_status"] = "done" if paper["summary_zh"] else "pending"
            except Exception as retry_error:
                print(f"[api] 论文 {i+1} 简化重试仍失败: {retry_error}")
                paper["summary_zh"] = ""
                paper["relevance"] = ""
                paper["key_findings"] = []
                paper["summary_status"] = "failed" if paper.get("_enrich_attempts", 0) >= MAX_ENRICH_ATTEMPTS else "pending"


# ========== 翻译 ==========

class TranslateRequest(BaseModel):
    text: str

@app.post("/api/translate")
def api_translate(data: TranslateRequest, request: Request):
    """将英文文本翻译为中文"""
    uid = _get_user_id(request)
    is_owner = OWNER_UID and uid == OWNER_UID

    if not is_owner and not check_rate_limit(uid, "translate", DAILY_TRANSLATE_LIMIT):
        return {"ok": False, "error": f"今日翻译次数已用完（每天 {DAILY_TRANSLATE_LIMIT} 次），明天再来吧。"}

    client, model = _get_llm_client()
    if not client:
        return {"ok": False, "error": "未配置 API"}
    try:
        translated, _, _ = _llm_chat_complete(
            [{"role": "user", "content": f"请将以下英文学术文本准确翻译为中文，保持专业术语的准确性，只输出翻译结果：\n\n{data.text[:3000]}"}],
            max_tokens=2000,
            temperature=0.2,
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
                _categorize([enriched], profile, client, model)
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
def api_chat(data: ChatRequest, request: Request):
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
    profile_text = ""
    if profile.get("discipline"):
        profile_text += f"学科领域：{profile['discipline']}\n"
    if profile.get("focus_areas"):
        profile_text += f"追踪主题：{profile['focus_areas']}\n"
    if profile.get("method_interests"):
        profile_text += f"方法兴趣：{profile['method_interests']}\n"
    if profile.get("background"):
        profile_text += f"补充说明：{profile['background']}\n"

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

    client, model = _get_llm_client()
    if not client:
        return {"reply": "AI 服务暂不可用，请稍后重试", "ok": False}

    messages = [{"role": "system", "content": system_prompt}]
    for msg in data.history[-8:]:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    messages.append({"role": "user", "content": data.message})

    try:
        reply, _, _ = _llm_chat_complete(
            messages,
            max_tokens=600,
            temperature=0.4,
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

        return {"reply": reply, "ok": True}
    except Exception as e:
        print(f"[api] chat 失败: {e}")
        return {"reply": "AI 回复失败，请稍后重试。", "ok": False}


# ========== Chat Summary → Notes ==========

@app.post("/api/chat/summarize")
def api_summarize_chat(data: SummarizeChatRequest, request: Request):
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

    result = _llm_complete(prompt, max_tokens=1200)
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
