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


# === Researcher Profile ===

def get_profile() -> dict:
    """获取研究者画像"""
    defaults = {
        "focus_areas": "",
        "exclude_areas": "",
        "current_goal": "",
        "background": "",
    }
    saved = _read_json(PROFILE_PATH)
    defaults.update(saved)
    return defaults

def save_profile(profile: dict):
    """保存研究者画像"""
    _write_json(PROFILE_PATH, profile)
