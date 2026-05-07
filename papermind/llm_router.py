from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from openai import AsyncOpenAI, OpenAI


load_dotenv(Path(__file__).parent / ".env")


# Built-in LLM routing: Qwen first, then GLM, then DeepSeek.
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


def _parse_model_list(raw: str) -> list[str]:
    return [m.strip() for m in (raw or "").split(",") if m.strip()]


_TASK_MODEL_ENV = {
    "translate": "LLM_TASK_TRANSLATE_MODELS",
    "search": "LLM_TASK_SEARCH_MODELS",
    "categorize": "LLM_TASK_CATEGORIZE_MODELS",
    "enrich": "LLM_TASK_ENRICH_MODELS",
    "summary": "LLM_TASK_SUMMARY_MODELS",
    "chat": "LLM_TASK_CHAT_MODELS",
}

_COMMON_TEXT_MODELS = [
    "qwen3.5-flash",
    "qwen3.6-flash",
    "qwen-flash-2025-07-28",
    "qwen3.5-27b",
    "qwen3.5-35b-a3b",
    "qwen3-max-preview",
    "qwen3-max-2025-09-23",
]

_TASK_MODEL_DEFAULTS = {
    "translate": [
        "qwen-mt-flash",
        "qwen-mt-plus",
        "qwen-mt-turbo",
        "qwen-mt-lite",
    ],
    "summary": [
        "qwen-flash-2025-07-28",
    ],
    "search": list(_COMMON_TEXT_MODELS),
    "categorize": list(_COMMON_TEXT_MODELS),
    "enrich": list(_COMMON_TEXT_MODELS),
    "chat": list(_COMMON_TEXT_MODELS),
}


def _get_task_preferred_models(task: str) -> list[str]:
    env_key = _TASK_MODEL_ENV.get(task or "")
    preferred = _parse_model_list(os.environ.get(env_key, "")) if env_key else []
    if not preferred:
        preferred = list(_TASK_MODEL_DEFAULTS.get(task or "", []))

    seen: set[str] = set()
    result = []
    for model in preferred:
        if model and model not in seen:
            seen.add(model)
            result.append(model)
    return result


def _get_qwen_models() -> list[str]:
    primary = os.environ.get("QWEN_MODEL", "qwen-plus").strip()
    fallback_raw = os.environ.get("QWEN_FALLBACK_MODELS", "")
    fallback_models = [m.strip() for m in fallback_raw.split(",") if m.strip()]
    models: list[str] = []
    task_models: list[str] = []
    for task in _TASK_MODEL_ENV:
        task_models.extend(_get_task_preferred_models(task))
    for model in [primary, *fallback_models, *task_models]:
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


# Cool providers for 10 minutes after auth/quota failures.
_provider_cooldown: dict[str, datetime] = {}
_COOLDOWN_SECONDS = 600


def _provider_key(provider: dict) -> str:
    return f"{provider['name']}:{provider['model']}"


def _is_provider_cooled(provider: dict) -> bool:
    until = _provider_cooldown.get(_provider_key(provider))
    if until and datetime.now() < until:
        return True
    return False


def _cooldown_provider(provider: dict, seconds: int = _COOLDOWN_SECONDS):
    key = _provider_key(provider)
    _provider_cooldown[key] = datetime.now() + timedelta(seconds=seconds)
    print(f"[llm] ⏸ {key} 冷却 {seconds}s（配额耗尽或认证失败）")


def _is_quota_error(e: Exception) -> bool:
    msg = str(e).lower()
    for keyword in ("401", "403", "quota", "rate_limit", "rate limit", "insufficient", "billing"):
        if keyword in msg:
            return True
    return False


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


def _build_async_llm_client(provider: dict) -> AsyncOpenAI:
    http_client = httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0"),
        timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0),
    )
    return AsyncOpenAI(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        http_client=http_client,
        timeout=60.0,
    )


def _ordered_llm_slots(task: str = "", prefer_model: str = "") -> list[dict]:
    slots = _get_llm_slots()
    preferred_models = []
    if prefer_model:
        preferred_models.append(prefer_model)
    preferred_models.extend(_get_task_preferred_models(task))
    if not preferred_models:
        return slots

    preferred_slots = []
    seen_keys: set[str] = set()
    for model in preferred_models:
        for provider in slots:
            if provider["model"] == model:
                key = _provider_key(provider)
                if key not in seen_keys:
                    seen_keys.add(key)
                    preferred_slots.append(provider)
    return preferred_slots + [provider for provider in slots if _provider_key(provider) not in seen_keys]


def _get_llm_client(task: str = "") -> tuple[Optional[OpenAI], str]:
    """Return the current preferred built-in LLM client for lightweight status checks."""
    slots = _ordered_llm_slots(task=task)
    for provider in slots:
        api_key = provider["api_key"].strip()
        if not api_key or _is_provider_cooled(provider):
            continue
        try:
            client = _build_llm_client(provider)
            return client, provider["model"]
        except Exception as e:
            print(f"[llm] {provider['name']} 初始化失败: {e}")
            continue
    return None, ""


def _has_llm_config(task: str = "") -> bool:
    for provider in _ordered_llm_slots(task=task):
        if provider["api_key"].strip() and not _is_provider_cooled(provider):
            return True
    return False


async def _llm_chat_complete_async(
    messages: list[dict],
    max_tokens: int = 800,
    temperature: float = 0.3,
    prefer_model: str = "",
    task: str = "",
) -> tuple[str, str, str]:
    last_error = ""
    slots = _ordered_llm_slots(task=task, prefer_model=prefer_model)
    for provider in slots:
        api_key = provider["api_key"].strip()
        if not api_key:
            continue
        name = f"{provider['name']} / {provider['model']}"
        if _is_provider_cooled(provider):
            print(f"[llm] ⏭ {name}（冷却中，跳过）")
            continue
        client = None
        try:
            client = _build_async_llm_client(provider)
            kwargs = dict(
                model=provider["model"],
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            if "qwen" in provider["name"]:
                kwargs["extra_body"] = {"enable_thinking": False}
            resp = await client.chat.completions.create(**kwargs)
            content = (resp.choices[0].message.content or "").strip()
            cached = False
            try:
                details = getattr(getattr(resp, "usage", None), "prompt_tokens_details", None)
                ct = getattr(details, "cached_tokens", 0) if details else 0
                cached = (ct or 0) > 0
            except Exception:
                pass
            if content:
                print(f"[llm] ✓ {name}" + (" (cache hit)" if cached else ""))
                return content, provider["name"], provider["model"]
            print(f"[llm] {name} 返回空内容，尝试下一个")
            last_error = "empty content"
        except Exception as e:
            last_error = str(e)
            print(f"[llm] ✗ {name}: {e}")
            if _is_quota_error(e):
                _cooldown_provider(provider)
        finally:
            if client is not None:
                try:
                    await client.close()
                except Exception:
                    pass
    print(f"[llm] 所有 provider 失败，最后错误: {last_error}")
    return "", "", ""


async def _llm_complete_async(prompt: str, max_tokens: int = 800, task: str = "") -> str:
    content, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.3,
        task=task,
    )
    return content


def _llm_chat_complete(
    messages: list[dict],
    max_tokens: int = 800,
    temperature: float = 0.3,
    prefer_model: str = "",
    task: str = "",
) -> tuple[str, str, str]:
    """Sync bridge for legacy/background code paths."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_llm_chat_complete_async(
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            prefer_model=prefer_model,
            task=task,
        ))

    raise RuntimeError("_llm_chat_complete called from an async context; use _llm_chat_complete_async instead")


def _llm_complete(prompt: str, max_tokens: int = 800, task: str = "") -> str:
    content, _, _ = _llm_chat_complete(
        [{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.3,
        task=task,
    )
    return content
