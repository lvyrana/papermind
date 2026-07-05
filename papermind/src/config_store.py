"""
运行时配置存储：API 设置和研究者画像
保存在本地 JSON 文件中
"""

import json
from pathlib import Path
from typing import Optional

CONFIG_PATH = Path(__file__).parent.parent / "data" / "config.json"
PROFILE_PATH = Path(__file__).parent.parent / "data" / "profile.json"

def _ensure_data_dir():
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

def _read_json(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}

def _write_json(path: Path, data: dict):
    _ensure_data_dir()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# === API Settings ===

def get_api_settings() -> dict:
    """获取 API 配置"""
    defaults = {
        "provider": "openrouter",
        "model": "openai/gpt-4o-mini",
        "api_key": "",
        "base_url": "",
    }
    saved = _read_json(CONFIG_PATH)
    defaults.update(saved)
    return defaults

def save_api_settings(settings: dict):
    """保存 API 配置"""
    _write_json(CONFIG_PATH, settings)

def get_api_settings_safe() -> dict:
    """返回不含完整 key 的设置（前端展示用）"""
    settings = get_api_settings()
    key = settings.get("api_key", "")
    if key and len(key) > 8:
        settings["api_key_masked"] = key[:4] + "****" + key[-4:]
    else:
        settings["api_key_masked"] = ""
    del settings["api_key"]
    return settings


# === 自定义 LLM Provider（v0.10：优先于内置链） ===

CUSTOM_PROVIDER_DEFAULTS = {
    "enabled": False,
    "preset": "openrouter",
    "base_url": "",
    "api_key": "",
    "model": "",
}


def get_custom_provider() -> dict:
    """获取自定义 LLM 配置（含明文 key，仅供后端路由使用）"""
    saved = _read_json(CONFIG_PATH).get("custom_provider", {})
    cfg = dict(CUSTOM_PROVIDER_DEFAULTS)
    for k in CUSTOM_PROVIDER_DEFAULTS:
        if k in saved:
            cfg[k] = saved[k]
    return cfg


def save_custom_provider(cfg: dict):
    """保存自定义 LLM 配置（只收录已知字段）"""
    data = _read_json(CONFIG_PATH)
    data["custom_provider"] = {k: cfg.get(k, v) for k, v in CUSTOM_PROVIDER_DEFAULTS.items()}
    _write_json(CONFIG_PATH, data)


def get_custom_provider_safe() -> dict:
    """返回不含完整 key 的自定义配置（前端展示用）"""
    cfg = get_custom_provider()
    key = cfg.pop("api_key", "")
    if key and len(key) > 8:
        cfg["api_key_masked"] = key[:4] + "****" + key[-4:]
    else:
        cfg["api_key_masked"] = "****" if key else ""
    cfg["has_key"] = bool(key)
    return cfg


# === Researcher Profile ===

def get_profile() -> dict:
    """获取研究者画像"""
    defaults = {
        "focus_areas": "",
        "exclude_areas": "",
        "method_interests": "",
        "current_goal": "",
        "background": "",
    }
    saved = _read_json(PROFILE_PATH)
    defaults.update(saved)
    return defaults

def save_profile(profile: dict):
    """保存研究者画像"""
    _write_json(PROFILE_PATH, profile)
