"""
调用 LLM 将英文摘要整理为简洁中文摘要，并生成护理启发段落。
未设置 OPENROUTER_API_KEY / OPENAI_API_KEY 时自动进入 mock 模式。
"""

from .llm_client import complete_text, llm_available

MOCK_INSIGHTS = """（mock 模式）本周文献涵盖 COPD 多个维度，以下几点对护理工作有参考价值：

- **症状监测**：多项研究强调早期识别急性加重前兆的重要性，护理人员应加强日常症状评估。
- **患者教育**：肺康复相关研究提示，系统化的患者自我管理教育可显著减少住院次数。
- **呼吸康复训练**：规律的呼吸训练和活动管理有助于提升耐力并改善生活质量。
- **多学科协作**：多篇文献涉及护理与医疗团队的协同管理模式，值得临床借鉴。

*注：以上为 mock 模式生成的示例文本，实际运行请配置 OPENROUTER_API_KEY 或 OPENAI_API_KEY。*"""


def summarize_papers(papers: list[dict]) -> list[dict]:
    """为每篇论文生成中文摘要，结果写入 paper['summary_zh']"""
    if not llm_available():
        print("[summarize] 未检测到 LLM API Key，使用 mock 模式")
        return _mock_summarize(papers)
    try:
        return _llm_summarize(papers)
    except Exception as e:
        print(f"[summarize] LLM 摘要失败，回退 mock 模式: {e}")
        return _mock_summarize(papers)


def generate_insights(papers: list[dict]) -> str:
    """根据本周文献生成'对护理研究的启发'段落"""
    if not llm_available():
        return MOCK_INSIGHTS
    try:
        return _llm_insights(papers)
    except Exception as e:
        print(f"[summarize] LLM 启发生成失败，使用 mock 文本: {e}")
        return MOCK_INSIGHTS


# ---------- mock ----------

def _mock_summarize(papers: list[dict]) -> list[dict]:
    for p in papers:
        snippet = p["abstract"].replace("\n", " ")[:150]
        p["summary_zh"] = f"【mock】{snippet}……"
    return papers


# ---------- LLM ----------

def _llm_summarize(papers: list[dict]) -> list[dict]:
    for i, p in enumerate(papers, 1):
        print(f"[summarize] {i}/{len(papers)}: {p['title'][:50]}")
        prompt = (
            "请将以下英文医学摘要整理为2-3句简洁的中文摘要，"
            "突出研究目的、主要发现和临床意义：\n\n"
            f"{p['abstract']}\n\n"
            "只输出中文摘要，不加任何前缀或解释。"
        )
        p["summary_zh"] = complete_text(prompt, max_tokens=300)

    return papers


def _llm_insights(papers: list[dict]) -> str:
    summaries = "\n".join(
        f"- {p['title']}：{p.get('summary_zh', p['abstract'][:100])}"
        for p in papers[:15]  # 最多取前15篇避免超出上下文
    )
    prompt = (
        "以下是本周 COPD 领域的最新文献摘要列表：\n\n"
        f"{summaries}\n\n"
        "请从护理研究和临床护理实践的角度，提炼3-5条本周文献对护理工作的启发或值得关注的方向。"
        "用中文，条目式输出，语言简洁专业。"
    )
    return complete_text(prompt, max_tokens=600)
