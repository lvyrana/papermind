"""
统一的 LLM 调用入口：
- 优先使用 OpenRouter（OPENROUTER_API_KEY）
- 其次使用 OpenAI（OPENAI_API_KEY）
- 都没有时返回 None（上层走 mock）
"""

from __future__ import annotations

import os
from typing import Optional

from openai import OpenAI
from pydantic import BaseModel


class LLMConfig(BaseModel):
    provider: str
    model: str
    api_key: str
    base_url: Optional[str] = None


def get_llm_config() -> LLMConfig | None:
    """读取环境变量并返回可用的 LLM 配置。"""
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if openrouter_key:
        return LLMConfig(
            provider="openrouter",
            model=os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
            api_key=openrouter_key,
            base_url="https://openrouter.ai/api/v1",
        )

    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        return LLMConfig(
            provider="openai",
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            api_key=openai_key,
            base_url=None,
        )

    return None


def llm_mode_label() -> str:
    """用于命令行显示当前运行模式。"""
    config = get_llm_config()
    if not config:
        return "mock（无 API Key）"
    if config.provider == "openrouter":
        return f"LLM（OpenRouter: {config.model}）"
    return f"LLM（OpenAI: {config.model}）"


def llm_available() -> bool:
    return get_llm_config() is not None


def complete_text(prompt: str, max_tokens: int = 300, temperature: float = 0.2) -> str:
    """调用统一的 Chat Completions 接口并返回纯文本。"""
    config = get_llm_config()
    if not config:
        raise RuntimeError("未找到可用 LLM 配置，请设置 OPENROUTER_API_KEY 或 OPENAI_API_KEY。")

    if config.provider == "openrouter":
        client = OpenAI(api_key=config.api_key, base_url=config.base_url)
        extra_headers = {}
        site_url = os.environ.get("OPENROUTER_SITE_URL", "").strip()
        app_name = os.environ.get("OPENROUTER_APP_NAME", "").strip()
        if site_url:
            extra_headers["HTTP-Referer"] = site_url
        if app_name:
            extra_headers["X-Title"] = app_name
        resp = client.chat.completions.create(
            model=config.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
            extra_headers=extra_headers or None,
        )
    else:
        client = OpenAI(api_key=config.api_key)
        resp = client.chat.completions.create(
            model=config.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
        )

    content = resp.choices[0].message.content if resp.choices else ""
    return (content or "").strip()
