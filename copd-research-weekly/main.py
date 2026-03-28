"""
COPD 科研周报生成器
用法：
  python main.py                          # 默认关键词
  python main.py "COPD exacerbation"      # 自定义关键词
  OPENROUTER_API_KEY=sk-or-... python main.py # 启用 LLM 模式
"""

import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

from src.fetch_papers import get_papers
from src.summarize_papers import generate_insights, summarize_papers
from src.categorize_papers import categorize_papers
from src.generate_report import generate_report
from src.llm_client import llm_mode_label

DEFAULT_KEYWORDS = [
    "COPD",
    "chronic obstructive pulmonary disease",
    "emphysema",
    "chronic bronchitis",
]
DEFAULT_DAYS = 7
DEFAULT_MAX_RESULTS = 24
REPORT_MAX_PAPERS = 12
EXCLUDED_CATEGORIES = {"药物治疗", "机制研究"}
EXCLUDED_KEYWORDS = {
    "drug",
    "medication",
    "therapy",
    "therapeutic",
    "inhibitor",
    "phosphodiesterase",
    "corticosteroid",
    "bronchodilator",
    "molecular",
    "genetic",
    "pathway",
    "biomarker",
    "mechanism",
    "pathogenesis",
    "inflammation",
    "inflammatory",
    "oxidative",
    "microbiota",
    "pathophysiology",
}


def _is_excluded_paper(paper: dict) -> bool:
    if paper.get("category") in EXCLUDED_CATEGORIES:
        return True
    text = (paper.get("title", "") + " " + paper.get("abstract", "")).lower()
    return any(kw in text for kw in EXCLUDED_KEYWORDS)


def main():
    load_dotenv()

    print("=" * 55)
    print("  COPD 科研周报生成器")
    print(f"  模式：{llm_mode_label()}")
    print("=" * 55)

    keywords = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_KEYWORDS
    print(f"[main] 关键词：{keywords}\n")

    # 1. 获取文献
    print("[步骤 1/4] 从 PubMed 检索文献...")
    papers = get_papers(keywords, days=DEFAULT_DAYS, max_results=DEFAULT_MAX_RESULTS)
    if not papers:
        print("[main] 未检索到文献，请检查网络或关键词后重试。")
        sys.exit(1)

    # 2. 分类与筛选
    print(f"\n[步骤 2/4] 文献分类并筛选...")
    papers = categorize_papers(papers)
    before_filter = len(papers)
    papers = [p for p in papers if not _is_excluded_paper(p)]
    papers = papers[:REPORT_MAX_PAPERS]
    print(
        f"[main] 已排除分类：{', '.join(sorted(EXCLUDED_CATEGORIES))}，"
        f"并应用关键词过滤（药物/机制），"
        f"从 {before_filter} 篇筛到 {len(papers)} 篇"
    )
    if not papers:
        print("[main] 筛选后无文献，建议扩大天数或调整关键词。")
        sys.exit(1)

    # 3. 生成中文摘要
    print(f"\n[步骤 3/4] 生成中文摘要（共 {len(papers)} 篇）...")
    papers = summarize_papers(papers)

    # 4. 生成报告
    print(f"\n[步骤 4/4] 生成 Markdown 周报...")
    insights = generate_insights(papers)
    output_path = Path(f"report_{datetime.now().strftime('%Y%m%d')}.md")
    generate_report(
        papers,
        keywords,
        insights=insights,
        output_path=str(output_path),
        excluded_categories=sorted(EXCLUDED_CATEGORIES),
    )

    print(f"\n{'=' * 55}")
    print(f"  完成！报告路径: {output_path.resolve()}")
    print("=" * 55)


if __name__ == "__main__":
    main()
