"""
将论文分类到预定义类别。
LLM 模式：一次批量请求，返回 JSON 数组。
mock 模式：关键词匹配。
"""

import json

from .llm_client import complete_text, llm_available

CATEGORIES = ["急性加重", "肺康复", "护理与患者管理", "药物治疗", "机制研究", "其他"]

# mock 模式关键词表（英文，匹配标题+摘要）
_MOCK_RULES: list[tuple[str, list[str]]] = [
    ("急性加重", ["exacerbation", "acute", "hospitalization", "readmission", "flare"]),
    ("肺康复", ["rehabilitation", "exercise training", "pulmonary rehab", "physical activity"]),
    ("护理与患者管理", ["nurs", "care", "self-management", "patient education", "caregiver", "palliative"]),
    ("药物治疗", ["drug", "inhaler", "bronchodilator", "corticosteroid", "pharmacol", "therapy", "treatment", "medication"]),
    ("机制研究", ["mechanism", "pathogenesis", "biomarker", "inflammation", "oxidative", "genetic", "molecular", "pathway"]),
]


def categorize_papers(papers: list[dict]) -> list[dict]:
    """为每篇论文添加 paper['category'] 字段"""
    if not llm_available():
        print("[categorize] 未检测到 LLM API Key，使用 mock 模式（关键词匹配）")
        return _mock_categorize(papers)
    try:
        return _llm_categorize(papers)
    except Exception as e:
        print(f"[categorize] LLM 分类失败，回退 mock 模式: {e}")
        return _mock_categorize(papers)


# ---------- mock ----------

def _mock_categorize(papers: list[dict]) -> list[dict]:
    for p in papers:
        text = (p["title"] + " " + p["abstract"]).lower()
        p["category"] = "其他"
        for cat, keywords in _MOCK_RULES:
            if any(kw in text for kw in keywords):
                p["category"] = cat
                break
    return papers


# ---------- LLM ----------

def _llm_categorize(papers: list[dict]) -> list[dict]:
    cats_str = "、".join(CATEGORIES)
    titles_block = "\n".join(f"{i+1}. {p['title']}" for i, p in enumerate(papers))

    prompt = (
        f"请将以下论文标题各自分类到最合适的一个类别中：{cats_str}。\n\n"
        f"{titles_block}\n\n"
        "只输出 JSON 数组，格式为 [\"类别1\", \"类别2\", ...]，顺序与输入一致，不要任何其他文字。"
    )

    print(f"[categorize] 批量分类 {len(papers)} 篇文献...")
    raw = complete_text(prompt, max_tokens=600)

    try:
        categories = json.loads(raw)
        for p, cat in zip(papers, categories):
            p["category"] = cat if cat in CATEGORIES else "其他"
    except Exception as e:
        print(f"[categorize] 解析分类结果失败: {e}，回退到 mock 模式")
        return _mock_categorize(papers)

    return papers
