"""
动态论文分类与相关性打分。
同一批次内 LLM 先自定标签表再分配，保证一致性和区分度。
"""

import json
import re


def _extract_focus_tags(focus: str) -> list[str]:
    """清洗并拆分用户填写的研究方向，支持多种分隔符和括号补充说明。"""
    if not focus:
        return []
    cleaned = re.sub(r'[（(][^）)]*[）)]', '', focus)
    raw = [t.strip() for t in re.split(r'[,，、/；;|\n]+', cleaned) if t.strip()]
    seen: set[str] = set()
    result = []
    for tag in raw:
        if tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result[:5]


def score_and_categorize_papers(papers: list[dict], profile: dict, client, model: str, llm_call=None) -> list[dict]:
    """批量为论文打相关性分数（0-10）并生成动态分类标签。

    返回按分数降序排列的论文列表，每篇增加:
      - relevance_score: 0-10
      - category: 动态生成的短标签

    llm_call: 可选的 LLM 调用函数，签名为 (messages, max_tokens, temperature) -> (str, str, str)
              若为 None，则直接使用 client 参数。
    """
    if not papers or not client:
        return papers

    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")
    exclude = profile.get("exclude_areas", "")
    interests_summary = profile.get("interests_summary", "")
    is_manual_summary = profile.get("interests_summary_is_manual", "0") == "1"

    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if method_interests:
        profile_text += f"方法兴趣（只作辅助加权）：{method_interests}\n"
    if background:
        profile_text += f"补充说明：{background}\n"
    if exclude:
        profile_text += f"不想看的内容：{exclude}\n"
    if is_manual_summary and interests_summary:
        profile_text += f"---\n用户修正后的偏好（辅助参考，低于以上明确输入）：\n{interests_summary}\n"

    batch_size = 20
    for start in range(0, len(papers), batch_size):
        batch = papers[start:start + batch_size]
        _score_batch(batch, profile_text, focus, client, model, llm_call)

    papers.sort(key=lambda p: p.get("relevance_score", 0), reverse=True)
    return papers


def _score_batch(papers: list[dict], profile_text: str, focus: str, client, model: str, llm_call=None):
    """batch score and categorize papers"""
    titles_block = "\n".join(
        f"{i+1}. {p['title']}" + (f" | {p['abstract'][:200]}" if p.get('abstract') else "")
        for i, p in enumerate(papers)
    )

    focus_hint = ""
    if focus:
        focus_hint = (
            f'重要：研究者方向是\u201c{focus}\u201d，大多数论文都会涉及该方向。'
            '分类标签不能只写方向名（如只写\u201c慢阻肺\u201d），必须体现论文的\u200b\u200b具体研究角度。\n'
        )

    prompt = f"""你是一位学术文献筛选助手。请根据研究者画像，对以下论文进行相关性评分和分类。

{profile_text}

{focus_hint}论文列表：
{titles_block}

请分两步完成：

第一步：先通读所有论文，确定本批论文的分类标签表（3-8个标签）。
标签要求：
- 每个2-4个字，体现具体研究角度或方法类型
- 好的标签示例：急性加重、预后预测、药物治疗、康复干预、危险因素、生存分析、症状管理、预测模型、系统综述、质性研究
- 差的标签示例：慢阻肺、肺癌、护理（太笼统，无区分度）；急性加重管理、预后预测分析、药物治疗效果评估（太长太碎）
- 同一概念只用一个标签，不要"预测模型""预测建模""预后模型"并存

第二步：为每篇论文打分并从标签表中选一个分类。

评分规则（0-10）：
- 属于"不想看的内容"→ 0 分
- 纯方法学但主题不对→ 最高 4 分
- 主题相关 + 方法命中 → 额外加 1-2 分

只输出 JSON，格式如下（categories 是你定的标签表，papers 是每篇的评分）：
{{
  "categories": ["标签1", "标签2", ...],
  "papers": [
    {{"score": 8, "category": "标签1"}},
    ...
  ]
}}
顺序与输入一致，不要其他文字。"""

    try:
        if llm_call:
            raw, _, _ = llm_call([{"role": "user", "content": prompt}], max_tokens=1200, temperature=0.2)
        else:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=1200,
            )
            raw = (resp.choices[0].message.content or "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        parsed = json.loads(raw)

        if isinstance(parsed, dict):
            categories = parsed.get("categories", [])
            results = parsed.get("papers", [])
        elif isinstance(parsed, list):
            categories = list({r.get("category", "其他") for r in parsed})
            results = parsed
        else:
            raise ValueError(f"unexpected json type: {type(parsed)}")

        print(f"[categorize] 标签表: {categories}")

        for p, r in zip(papers, results):
            p["relevance_score"] = int(r.get("score", 5))
            cat = (r.get("category") or "其他").strip()[:10]
            p["category"] = cat

        dist = {}
        for p in papers:
            c = p.get("category", "")
            dist[c] = dist.get(c, 0) + 1
        print(f"[categorize] 完成 {len(papers)} 篇论文打分, 分类分布: {dist}")
    except Exception as e:
        print(f"[categorize] 打分失败: {e}")
        for p in papers:
            p.setdefault("relevance_score", 5)
            p.setdefault("category", "其他")
