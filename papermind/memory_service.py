from __future__ import annotations

import json
import re
from datetime import datetime

from llm_router import _llm_chat_complete_async
from src.database import (
    get_all_recent_chats_since,
    get_deep_reading_signals,
    get_profile,
    get_stated_memory,
    save_stated_memory,
    get_reading_history_since,
    get_saved_titles_since,
    reset_recent_events,
    save_profile,
)


RECENT_EVENT_THRESHOLD = 8
RECENT_TIME_THRESHOLD = 7 * 86400
RECENT_WINDOW_DAYS = 7
CORE_WINDOW_DAYS = 90
AUTO_CORE_REFRESH_DAYS = 14


def has_profile_seed(profile: dict) -> bool:
    return any(
        (profile.get(key) or "").strip()
        for key in ("focus_areas", "method_interests", "background", "current_goal", "exclude_areas", "discipline")
    )


def build_memory_context(profile: dict, stated: list[dict] | None = None) -> str:
    parts = []
    core = (profile.get("memory_core") or "").strip()
    recent = (profile.get("memory_recent") or "").strip()
    if core:
        parts.append(
            "---\n关于这位读者（由他的精读行为总结，用户可随时改写；仅作参考）：\n"
            f"阅读画像：{core}"
        )
    if recent:
        parts.append(f"近期关注变化：{recent}")
    # 「你说过的」单独标注来源：这是他亲口讲的，可信度高于上面的行为推断
    said = [(it.get("text") or "").strip() for it in (stated or []) if (it.get("text") or "").strip()]
    if said:
        parts.append("他自己讲过（可信度高于以上推断）：\n" + "\n".join(f"- {t}" for t in said))
    if parts:
        # 曾出现「结合你关注的护理资源效率」这类用户不认的断言：把旧画像硬套到不相干的论文上
        parts.append(
            "使用要求：只有当上述背景与当前论文**确实相关**时才引用；不相关就完全不要提，"
            "更不要为了显得贴心而生硬联系。聊到课题启发、他以前做过什么、对什么感兴趣时，"
            "才是该主动调用这些背景的时候。"
        )
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
    # 不再要求「先填画像」：记忆从精读行为长出来，没填过表单的用户同样应该有记忆

    # 记忆从「精读行为」学，而不是从早已停用的画像表单。
    # 表单隐藏后仍拿它生成画像，会让 AI 长期引用一份用户不再维护、也看不见的旧描述。
    signals = get_deep_reading_signals(uid, days=CORE_WINDOW_DAYS)
    cards = signals.get("cards") or []
    papers = signals.get("papers") or []
    questions = signals.get("questions") or []
    if not (cards or papers):
        return "", False

    card_lines = "\n".join(
        f"- [{c.get('card_type', '')}] {c.get('title') or ''}：{(c.get('content') or '')[:120]}"
        for c in cards[:20]
    ) or "（还没有卡片）"
    paper_lines = "\n".join(
        f"- {p.get('title', '')[:70]}（{p.get('category') or '未分类'}）" for p in papers[:20]
    ) or "（还没有精读记录）"
    question_lines = "\n".join(f"- {q[:80]}" for q in questions[:12]) or "（还没有提问）"

    prompt = f"""请根据这位研究者的**精读行为**，总结一段稳定的长期研究画像（memory_core）。

他精读过的论文：
{paper_lines}

他自己动手沉淀的阅读卡片（最能代表他真正在意什么）：
{card_lines}

他追问过的问题：
{question_lines}

要求：
- 只依据上面的行为证据，**不要编造**没有出现过的研究方向或身份
- 这是长期骨架，不要写“最近”“近期”等短期词
- 总结稳定的研究主线、方法偏好、读论文时习惯盯的角度
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


async def update_stated_memory(uid: str, days: int = RECENT_WINDOW_DAYS) -> dict:
    """「你说过的」：从对话里挑出用户**明确讲过**的自我陈述，跨对话保留。

    和阅读画像分开：画像是「我观察到的」（可对着论文和卡片查证），
    这里是「你亲口说的」（可对着某次对话查证）。两边都有出处，都能单独删。
    沿用原记忆系统最值钱的一点：增量更新——把已有条目喂回去，只做新增与合并，
    不推倒重写，否则记忆每次都像失忆后重新认识你。
    """
    existing = get_stated_memory(uid)
    chats = get_all_recent_chats_since(uid, days=days, limit=60)
    said = [m["content"] for m in chats if m.get("role") == "user" and (m.get("content") or "").strip()]
    if not said:
        return {"ok": True, "skipped": True, "reason": "no_messages"}

    existing_lines = "\n".join(f"- {it.get('text','')}" for it in existing) or "（暂无）"
    said_lines = "\n".join(f"- {t[:150]}" for t in said[:30])

    prompt = f"""从用户最近的对话发言里，挑出他**明确讲过的、关于自己的事实**。

已经记下的（不要重复，仍然成立的保留原样）：
{existing_lines}

用户最近说过的话：
{said_lines}

只挑这几类：
- 在做什么课题 / 做过什么研究
- 对什么方法、人群、问题感兴趣
- 所处的学科、岗位、工作场景

严格要求：
- **只记他明确说出口的**。提问不算陈述（问「PSM 怎么用」≠ 他在做 PSM 研究）
- **不要推断、不要延伸**。宁可少记，也不要替他下结论
- 每条一句话，不超过 25 字，用他自己的说法
- 没有任何符合的就返回空数组

只输出 JSON 数组，不要其他内容：
["在做基层 COPD 管理相关课题", "对倾向评分匹配的适用边界感兴趣"]"""

    raw, _, _ = await _llm_chat_complete_async(
        [{"role": "user", "content": prompt}],
        max_tokens=400, temperature=0.1, task="summary",
    )
    match = re.search(r"\[.*\]", raw or "", re.DOTALL)
    if not match:
        return {"ok": True, "skipped": True, "reason": "nothing_extracted"}
    try:
        items = json.loads(match.group(0))
    except (json.JSONDecodeError, TypeError):
        return {"ok": True, "skipped": True, "reason": "parse_failed"}

    now = datetime.now().isoformat()
    seen = {(it.get("text") or "").strip() for it in existing}
    merged = list(existing)
    for text in items:
        text = str(text or "").strip()[:60]
        if text and text not in seen:
            seen.add(text)
            merged.append({"text": text, "said_at": now})
    if len(merged) == len(existing):
        return {"ok": True, "skipped": True, "reason": "no_new"}

    save_stated_memory(uid, merged[-12:])
    return {"ok": True, "stated": get_stated_memory(uid)}


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
