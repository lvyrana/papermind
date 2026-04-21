"""
动态论文分类与相关性打分。
根据用户画像生成分类标签，不再硬编码类别。
"""

import json
import re


def _extract_focus_tags(focus: str) -> list[str]:
    """清洗并拆分用户填写的研究方向，支持多种分隔符和括号补充说明。"""
    if not focus:
        return []
    # 去掉括号里的补充说明，如"老年护理（失能老人、居家照护）"→"老年护理"
    cleaned = re.sub(r'[（(][^）)]*[）)]', '', focus)
    # 支持 ,，、/；;| 和换行作为分隔符
    raw = [t.strip() for t in re.split(r'[,，、/；;|\n]+', cleaned) if t.strip()]
    seen: set[str] = set()
    result = []
    for tag in raw:
        if tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result[:5]


def _build_category_list(focus: str) -> dict:
    """根据研究方向构建主题类和方法类候选列表。

    返回 {"topic": [...], "method": [...]} 供提示词分层展示。
    """
    topic_tags = _extract_focus_tags(focus)
    method_tags = ["系统综述", "预测模型", "干预研究", "观察性研究", "质性研究"]
    return {"topic": topic_tags, "method": method_tags}


def score_and_categorize_papers(papers: list[dict], profile: dict, client, model: str, llm_call=None) -> list[dict]:
    """批量为论文打相关性分数（0-10）并生成动态分类标签。

    返回按分数降序排列的论文列表，每篇增加:
      - relevance_score: 0-10
      - category: 动态生成的短标签

    llm_call: 可选的 LLM 调用函数，签名为 (messages, max_tokens, temperature) -> str
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
    # current_goal 是"使用目的"而非研究主题，不参与分类标签生成，避免模型把用户目标词（如"日常追踪"）误用为论文分类

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
        profile_text += f"---\n用户修正后的偏好（辅助参考，低于以上明确输入，不影响分类标签命名）：\n{interests_summary}\n"

    categories = _build_category_list(focus)
    print(f"[categorize] 主题类: {categories['topic']}  方法类: {categories['method']}")

    # 分批处理，每批最多 20 篇
    batch_size = 20
    for start in range(0, len(papers), batch_size):
        batch = papers[start:start + batch_size]
        _score_batch(batch, profile_text, categories, client, model, llm_call)

    # 按分数降序排列
    papers.sort(key=lambda p: p.get("relevance_score", 0), reverse=True)
    return papers


def _score_batch(papers: list[dict], profile_text: str, categories: dict, client, model: str, llm_call=None):
    """batch score and categorize papers"""
    titles_block = "\n".join(
        f"{i+1}. {p['title']}" + (f" | {p['abstract'][:150]}" if p.get('abstract') else "")
        for i, p in enumerate(papers)
    )

    topic_line = "、".join(categories["topic"]) if categories["topic"] else "（无）"
    method_line = "、".join(categories["method"])

    prompt = f"""你是一位学术文献筛选助手。请根据研究者画像，对以下论文进行相关性评分和分类。

{profile_text}

论文列表：
{titles_block}

请为每篇论文：
1. 打一个相关性分数（0-10）：10=高度相关核心方向，7-9=相关，4-6=一般相关，1-3=不太相关。特别注意：如果论文内容属于研究者"不想看的内容"中列出的领域，必须打 0 分，即使标题看起来和研究方向有关；如果论文主要只是方法学（如机器学习、预测模型、孟德尔随机化、中介分析），但研究主题/对象与研究者主方向不一致，最高只能打 4 分；如果论文主题与研究者方向相关，同时方法又明显命中研究者的方法兴趣，可以额外加 1-2 分
2. 从以下两层候选中选一个分类标签，必须严格从列表中选，不得自造新标签：
   主题类（优先选）：{topic_line}
   方法类（主题对不上时才选）：{method_line}
   兜底：其他
   规则：先看论文研究的对象/疾病/人群能否落入主题类；只有主题类完全对不上，才选方法类；方法类只描述研究设计本身（如：这篇就是在做系统综述/质性访谈），不因为论文用了某方法就归方法类
3. 请综合以上信息评分，但优先依据研究者的明确输入；如果存在"用户修正后的偏好"，可作为低于明确输入的辅助参考

只输出 JSON 数组，格式：
[{{"score": 8, "category": "分类标签"}}, ...]
顺序与输入一致，不要其他文字。"""

    try:
        if llm_call:
            raw, _, _ = llm_call([{"role": "user", "content": prompt}], max_tokens=1000, temperature=0.2)
        else:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=1000,
            )
            raw = (resp.choices[0].message.content or "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        results = json.loads(raw)

        for p, r in zip(papers, results):
            p["relevance_score"] = int(r.get("score", 5))
            p["category"] = r.get("category", "其他")

        print(f"[categorize] 完成 {len(papers)} 篇论文打分")
    except Exception as e:
        print(f"[categorize] 打分失败: {e}")
        for p in papers:
            p.setdefault("relevance_score", 5)
            p.setdefault("category", "未分类")
