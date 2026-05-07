from __future__ import annotations

import re
from datetime import datetime

from llm_router import _llm_chat_complete_async
from src.database import (
    get_all_recent_chats_since,
    get_profile,
    get_reading_history_since,
    get_saved_titles_since,
    reset_recent_events,
    save_profile,
)


RECENT_EVENT_THRESHOLD = 8
RECENT_TIME_THRESHOLD = 7 * 86400
RECENT_WINDOW_DAYS = 7
AUTO_CORE_REFRESH_DAYS = 14


def has_profile_seed(profile: dict) -> bool:
    return any(
        (profile.get(key) or "").strip()
        for key in ("focus_areas", "method_interests", "background", "current_goal", "exclude_areas", "discipline")
    )


def build_memory_context(profile: dict) -> str:
    parts = []
    core = (profile.get("memory_core") or "").strip()
    recent = (profile.get("memory_recent") or "").strip()
    if core:
        parts.append(f"---\n系统观察（辅助参考，低于以上明确输入）：\n长期研究画像：{core}")
    if recent:
        parts.append(f"近期关注变化：{recent}")
    return "\n".join(parts)


def _collect_recent_memory_signals(uid: str, days: int = RECENT_WINDOW_DAYS) -> dict:
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


async def ensure_memory_core(uid: str, profile: dict) -> tuple[str, bool]:
    existing = (profile.get("memory_core") or "").strip()
    if existing:
        return existing, False
    if not has_profile_seed(profile):
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


async def maybe_auto_refresh_memory_core(uid: str, profile: dict) -> bool:
    if not (profile.get("memory_core") or "").strip():
        return False
    if not (profile.get("memory_recent") or "").strip():
        return False

    core_source = profile.get("core_source", "")
    if core_source != "auto_initial":
        last_merged = profile.get("last_core_merged_at", "")
        if last_merged:
            try:
                if (datetime.now() - datetime.fromisoformat(last_merged)).total_seconds() < AUTO_CORE_REFRESH_DAYS * 86400:
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


async def update_memory_recent(uid: str, force: bool = False) -> dict:
    """更新近期关注变化：保留已有 recent，并在近 7 天行为基础上增量修正。"""
    profile = get_profile(uid)

    _, core_generated = await ensure_memory_core(uid, profile)
    if core_generated:
        profile = get_profile(uid)

    signals = _collect_recent_memory_signals(uid, days=RECENT_WINDOW_DAYS)
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

    should_generate = bool(force)
    if not should_generate:
        if not has_recent:
            if events > 0 or not (profile.get("memory_core") or "").strip():
                should_generate = True
        elif events >= RECENT_EVENT_THRESHOLD:
            should_generate = True
        elif time_elapsed >= RECENT_TIME_THRESHOLD and events > 0:
            should_generate = True

    if not should_generate:
        return {"ok": True, "skipped": True, "core_generated": core_generated}

    prompt = f"""请基于已有的近期关注变化和最近 { RECENT_WINDOW_DAYS } 天的新行为，更新一版 memory_recent。

长期研究画像（稳定骨架）：
{profile.get("memory_core", "") or '（暂无）'}

已有近期关注变化：
{profile.get("memory_recent", "") or '（暂无）'}

最近 { RECENT_WINDOW_DAYS } 天收藏的论文标题：
{chr(10).join(f'- {t}' for t in signals["recent_titles"][:20]) if signals["recent_titles"] else '（暂无）'}

最近 { RECENT_WINDOW_DAYS } 天跨论文提问：
{chr(10).join(f'- {q}' for q in signals["recent_questions"][:15]) if signals["recent_questions"] else '（暂无）'}

最近 { RECENT_WINDOW_DAYS } 天阅读轨迹：
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
    auto_merged = await maybe_auto_refresh_memory_core(uid, refreshed_profile)
    latest = get_profile(uid)
    return {
        "ok": True,
        "recent": latest.get("memory_recent", ""),
        "core": latest.get("memory_core", ""),
        "core_generated": core_generated,
        "core_auto_updated": auto_merged,
    }


async def merge_recent_to_core(uid: str) -> dict:
    """用户手动确认：把近期关注变化吸收到长期研究画像。"""
    profile = get_profile(uid)

    _, core_generated = await ensure_memory_core(uid, profile)
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
        "memory_recent": "",
        "core_source": "manual_confirmed",
        "last_core_merged_at": datetime.now().isoformat(),
        "last_recent_updated_at": "",
    }
    save_profile(uid, updated_profile)
    reset_recent_events(uid)
    latest = get_profile(uid)
    return {"ok": True, "core": latest.get("memory_core", ""), "recent": ""}
