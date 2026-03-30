"""
将文献列表生成 Markdown 格式的中文科研周报。
论文字典预期字段：title, authors, journal, pub_date, link, pmid,
                  abstract, summary_zh（可选）, category（可选）
"""

from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from .categorize_papers import CATEGORIES


def generate_report(
    papers: list[dict],
    keywords: list[str],
    insights: str = "",
    output_path: str = "report.md",
    excluded_categories: Optional[list[str]] = None,
) -> str:
    """生成 Markdown 周报并写入文件，返回文件路径"""
    today = datetime.now().strftime("%Y年%m月%d日")
    lines: list[str] = []
    excluded_text = "、".join(excluded_categories or [])

    lines += [
        "# COPD 护理周报（精简版）",
        "",
        f"> 生成日期：{today}  ",
        f"> 检索关键词：{', '.join(keywords)}  ",
        f"> 来源：PubMed（近7天）  ",
        f"> 最终纳入文献：{len(papers)} 篇  ",
        f"> 已排除主题：{excluded_text or '无'}",
        "",
        "---",
        "",
    ]

    if not papers:
        lines.append("本周未检索到相关文献。")
        _write(output_path, lines)
        return output_path

    by_category = _group_by_category(papers)

    lines += _section_one_page_overview(papers, by_category)
    lines += _section_top_papers(papers, top_n=5)
    lines += _section_topic_digest(by_category)
    lines += _section_insights(insights)
    lines += _section_appendix_table(papers)

    lines += [
        "---",
        "",
        "*本报告由 copd-research-weekly 自动生成，适用于护理团队每周快速阅读。*",
    ]

    _write(output_path, lines)
    print(f"[report] 周报已保存至: {output_path}")
    return output_path


def _section_one_page_overview(papers: list[dict], by_category: dict) -> list[str]:
    lines = ["## 一页速览", ""]
    lines.append(f"本周纳入 **{len(papers)}** 篇文献，建议优先看「本周重点」与「护理行动点」。")
    lines.append("")
    lines.append("| 主题 | 篇数 |")
    lines.append("|---|---:|")
    non_zero = []
    for cat in CATEGORIES:
        count = len(by_category.get(cat, []))
        if count > 0:
            non_zero.append((cat, count))
            lines.append(f"| {cat} | {count} |")
    if not non_zero:
        lines.append("| 其他 | 0 |")

    top_cat = max(non_zero, key=lambda x: x[1])[0] if non_zero else "其他"
    lines += [
        "",
        f"本周最多的主题是 **{top_cat}**，适合优先组织科室讨论。",
        "",
        "---",
        "",
    ]
    return lines


def _section_top_papers(papers: list[dict], top_n: int = 5) -> list[str]:
    lines = ["## 本周重点（前 5 篇）", ""]
    for i, p in enumerate(papers[:top_n], 1):
        lines += [
            f"### {i}. {p['title']}",
            "",
            f"- 分类：{p.get('category', '未分类')}",
            f"- 期刊/日期：*{p['journal']}* · {p['pub_date']}",
            f"- 一句话：{_one_line_summary(p)}",
            f"- 原文：[PubMed {p['pmid']}]({p['link']})",
            "",
        ]
    lines += ["---", ""]
    return lines


def _section_topic_digest(by_category: dict) -> list[str]:
    lines = ["## 按主题快读", ""]
    for cat in CATEGORIES:
        group = by_category.get(cat, [])
        if not group:
            continue
        lines.append(f"### {cat}（{len(group)} 篇）")
        lines.append("")
        for p in group:
            lines.append(
                f"- [{p['title']}]({p['link']})｜{p['pub_date']}｜{p['journal']}"
            )
        lines.append("")
    lines += ["---", ""]
    return lines


def _section_insights(insights: str) -> list[str]:
    lines = ["## 护理行动点", ""]
    lines.append(insights or "（本节内容未生成）")
    lines += ["", "---", ""]
    return lines


def _section_appendix_table(papers: list[dict]) -> list[str]:
    lines = ["## 附录：纳入文献清单", ""]
    lines.append("| # | 主题 | 标题 | 日期 |")
    lines.append("|---:|---|---|---|")
    for i, p in enumerate(papers, 1):
        title = p["title"].replace("|", "\\|")
        lines.append(
            f"| {i} | {p.get('category', '未分类')} | "
            f"[{title}]({p['link']}) | {p['pub_date']} |"
        )
    lines += ["", ""]
    return lines


def _group_by_category(papers: list[dict]) -> dict:
    groups: dict = defaultdict(list)
    for p in papers:
        cat = p.get("category", "其他")
        groups[cat].append(p)
    return groups


def _one_line_summary(paper: dict) -> str:
    text = (paper.get("summary_zh") or paper.get("abstract") or "（无摘要）").replace("\n", " ")
    if len(text) > 120:
        return text[:120].rstrip() + "……"
    return text


def _write(output_path: str, lines: list[str]) -> None:
    Path(output_path).write_text("\n".join(lines), encoding="utf-8")
