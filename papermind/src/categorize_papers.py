"""
论文相关性打分与方法分类。

分类标签优先使用固定的方法/研究设计池，避免并发 batch 各自造标签导致收藏页筛选漂移。
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional


MAX_CATEGORIZE_WORKERS = max(1, int(os.environ.get("CATEGORIZE_MAX_WORKERS", "4")))


METHOD_CATEGORIES = [
    "预测模型",
    "机器学习",
    "生存分析",
    "倾向评分",
    "因果推断",
    "诊断研究",
    "网络Meta",
    "成本效益",
    "量表验证",
    "中介调节",
    "聚类轨迹",
    "纵向分析",
]

DESIGN_CATEGORIES = [
    "随机对照",
    "非随机干预",
    "系统综述",
    "队列研究",
    "横断面",
    "病例对照",
    "质性研究",
    "混合研究",
    "真实世界",
    "指南共识",
    "病例报告",
    "研究方案",
]

FIXED_CATEGORIES = METHOD_CATEGORIES + DESIGN_CATEGORIES

CATEGORY_ALIASES = {
    "预后模型": "预测模型",
    "风险预测": "预测模型",
    "风险评分": "预测模型",
    "预测建模": "预测模型",
    "列线图": "预测模型",
    "人工智能": "机器学习",
    "深度学习": "机器学习",
    "随机森林": "机器学习",
    "生存模型": "生存分析",
    "Cox回归": "生存分析",
    "Cox": "生存分析",
    "PSM": "倾向评分",
    "倾向匹配": "倾向评分",
    "倾向得分": "倾向评分",
    "因果分析": "因果推断",
    "孟德尔随机化": "因果推断",
    "诊断准确性": "诊断研究",
    "ROC分析": "诊断研究",
    "网络分析": "网络Meta",
    "网状Meta": "网络Meta",
    "经济评价": "成本效益",
    "量表研究": "量表验证",
    "信效度": "量表验证",
    "调节效应": "中介调节",
    "中介效应": "中介调节",
    "轨迹分析": "聚类轨迹",
    "潜类别": "聚类轨迹",
    "纵向研究": "纵向分析",
    "重复测量": "纵向分析",
    "RCT": "随机对照",
    "随机试验": "随机对照",
    "随机研究": "随机对照",
    "干预研究": "非随机干预",
    "准实验": "非随机干预",
    "Meta分析": "系统综述",
    "荟萃分析": "系统综述",
    "综述": "系统综述",
    "队列": "队列研究",
    "横断面研究": "横断面",
    "调查研究": "横断面",
    "病例对照研究": "病例对照",
    "访谈研究": "质性研究",
    "混合方法": "混合研究",
    "真实世界研究": "真实世界",
    "指南": "指南共识",
    "共识": "指南共识",
    "病例系列": "病例报告",
    "方案": "研究方案",
}

GENERIC_CATEGORY_WORDS = {
    "其他",
    "研究",
    "护理",
    "患者",
    "临床",
    "疾病",
    "治疗",
    "管理",
}


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


def _text_for_category(paper: dict) -> str:
    title = paper.get("title") or ""
    abstract = paper.get("abstract") or ""
    return f"{title} {abstract}".lower()


def _category_from_keywords(text: str) -> str:
    """High-confidence deterministic mapping for common method/design clues."""
    checks = [
        ("网络Meta", r"\bnetwork meta|网状meta|网络meta"),
        ("倾向评分", r"propensity score|\bpsm\b|inverse probability weighting|\biptw\b|treatment weighting"),
        ("机器学习", r"machine learning|deep learning|neural network|xgboost|random forest|artificial intelligence|\bai\b"),
        ("预测模型", r"prediction model|predictive model|prognostic model|risk score|nomogram|risk stratification"),
        ("生存分析", r"survival analysis|kaplan[- ]meier|cox regression|time-to-event"),
        ("因果推断", r"causal inference|difference[- ]in[- ]differences|\bdid\b|instrumental variable|mendelian randomization"),
        ("诊断研究", r"diagnostic accuracy|sensitivity|specificity|receiver operating|roc curve|\bauc\b"),
        ("成本效益", r"cost-effectiveness|cost effectiveness|economic evaluation|cost-utility"),
        ("量表验证", r"psychometric|reliability|validity|validation of .*scale|questionnaire validation"),
        ("中介调节", r"mediation|mediating effect|moderation|moderating effect|interaction effect"),
        ("聚类轨迹", r"trajectory|latent class|cluster analysis|group-based"),
        ("纵向分析", r"longitudinal|mixed-effects|mixed effects|repeated measures"),
        ("系统综述", r"systematic review|meta-analysis|meta analysis"),
        ("随机对照", r"\brct\b|randomi[sz]ed controlled|randomi[sz]ed trial|controlled trial"),
        ("非随机干预", r"quasi-experimental|non-randomi[sz]ed|before-and-after|intervention study"),
        ("真实世界", r"real-world|real world|registry|electronic health record|\behr\b|claims database"),
        ("队列研究", r"cohort|prospective|retrospective"),
        ("横断面", r"cross-sectional|cross sectional|survey|prevalence"),
        ("病例对照", r"case-control|case control"),
        ("质性研究", r"qualitative|interview|thematic analysis|grounded theory|focus group"),
        ("混合研究", r"mixed methods"),
        ("指南共识", r"guideline|consensus|recommendation"),
        ("病例报告", r"case report|case series"),
        ("研究方案", r"study protocol|trial protocol|protocol for"),
    ]
    for category, pattern in checks:
        if re.search(pattern, text):
            return category
    return ""


def _fallback_title_keyword(paper: dict, focus: str) -> str:
    title = paper.get("title") or ""
    title_lower = title.lower()
    topic_checks = [
        ("症状管理", r"symptom management|symptom burden"),
        ("急性加重", r"exacerbation|acute exacerbation"),
        ("康复干预", r"rehabilitation|pulmonary rehabilitation"),
        ("运动干预", r"exercise|physical activity"),
        ("自我管理", r"self-management|self management"),
        ("患者教育", r"patient education|health education"),
        ("依从性", r"adherence|compliance"),
        ("生活质量", r"quality of life"),
        ("再入院", r"readmission"),
        ("死亡率", r"mortality"),
        ("共病", r"comorbidity|comorbidities"),
        ("药物治疗", r"drug|pharmacological|medication"),
        ("疫苗接种", r"vaccination|vaccine"),
        ("远程医疗", r"telehealth|telemedicine|remote monitoring"),
    ]
    for label, pattern in topic_checks:
        if re.search(pattern, title_lower):
            return label

    focus_tags = set(_extract_focus_tags(focus))
    stop_words = {
        "study",
        "research",
        "analysis",
        "effect",
        "effects",
        "patient",
        "patients",
        "disease",
        "clinical",
        "outcomes",
        "copd",
        "cancer",
    }
    candidates = re.findall(r"[A-Za-z][A-Za-z-]{3,}|[\u4e00-\u9fff]{2,6}", title)
    for word in candidates:
        normalized = word.strip("-:： ，,.;；").lower()
        if not normalized or normalized in stop_words:
            continue
        if word in focus_tags or normalized in {t.lower() for t in focus_tags}:
            continue
        if len(word) > 12:
            continue
        return word[:10]
    return "其他"


def _normalize_category(category: Optional[str], paper: dict, focus: str) -> str:
    raw = (category or "").strip()
    raw = re.sub(r"^[\"'“”‘’\s]+|[\"'“”‘’\s]+$", "", raw)
    raw = raw.replace(" ", "")

    text = _text_for_category(paper)
    keyword_category = _category_from_keywords(text)
    alias_category = CATEGORY_ALIASES.get(raw)

    # Keep especially important method terms stable even if the LLM picks a nearby label.
    comparable_raw = alias_category or raw
    if comparable_raw in {"预测模型", "系统综述"} and keyword_category in {"机器学习", "网络Meta", "倾向评分"}:
        return keyword_category

    if raw in FIXED_CATEGORIES:
        return raw
    if alias_category:
        return alias_category

    if keyword_category:
        return keyword_category

    focus_tags = set(_extract_focus_tags(focus))
    if raw and raw not in GENERIC_CATEGORY_WORDS and raw not in focus_tags:
        return raw[:10]
    return _fallback_title_keyword(paper, focus)


def score_and_categorize_papers(papers: list[dict], profile: dict, client, model: str, llm_call=None) -> list[dict]:
    """批量为论文打相关性分数（0-10）并生成稳定的方法/设计分类标签。

    返回按分数降序排列的论文列表，每篇增加:
      - relevance_score: 0-10
      - category: 固定方法/设计标签，必要时回退为标题关键词

    llm_call: 可选的 LLM 调用函数，签名为 (messages, max_tokens, temperature) -> (str, str, str)
              若为 None，则直接使用 client 参数。
    """
    if not papers or not client:
        return papers

    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")
    exclude = profile.get("exclude_areas", "")
    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if method_interests:
        profile_text += f"方法兴趣（只作辅助加权）：{method_interests}\n"
    if background:
        profile_text += f"补充说明：{background}\n"
    if exclude:
        profile_text += f"不想看的内容：{exclude}\n"

    batch_size = 20
    batches = [papers[start:start + batch_size] for start in range(0, len(papers), batch_size)]
    with ThreadPoolExecutor(max_workers=MAX_CATEGORIZE_WORKERS) as pool:
        futures = [pool.submit(_score_batch, b, profile_text, focus, client, model, llm_call) for b in batches]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception:
                pass

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

    category_pool = "、".join(FIXED_CATEGORIES)
    prompt = f"""你是一位学术文献筛选助手。请根据研究者画像，对以下论文进行相关性评分和方法分类。

{profile_text}

{focus_hint}论文列表：
{titles_block}

分类规则：
1. 优先按统计/分析方法分类，其次按研究设计分类。
2. 必须优先从以下固定标签池选择：{category_pool}
3. 如果固定标签池都不合适，才从标题中提取一个2-6字的核心主题词作为兜底标签。
4. 不要使用研究方向本身作为分类标签，例如不要只写"慢阻肺"、"肺癌"、"护理"。
5. 同一概念必须归一：预后模型/风险评分/列线图归为"预测模型"；XGBoost/随机森林/深度学习归为"机器学习"；propensity score/IPTW/PSM归为"倾向评分"。

边界例子：
- XGBoost、random forest、neural network 建模 → 机器学习
- logistic regression、nomogram、risk score 建模 → 预测模型
- propensity score matching、IPTW、inverse probability weighting → 倾向评分
- Cox、Kaplan-Meier、time-to-event → 生存分析
- systematic review、meta-analysis → 系统综述
- network meta-analysis → 网络Meta

评分规则（0-10）：
- 属于"不想看的内容"→ 0 分
- 纯方法学但主题不对→ 最高 4 分
- 主题相关 + 方法命中 → 额外加 1-2 分

只输出 JSON 数组，格式如下：
[
  {{"score": 8, "category": "预测模型"}},
  ...
]
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
            results = parsed.get("papers", [])
        elif isinstance(parsed, list):
            results = parsed
        else:
            raise ValueError(f"unexpected json type: {type(parsed)}")

        for i, p in enumerate(papers):
            r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
            score = int(r.get("score", 5))
            p["relevance_score"] = max(0, min(10, score))
            p["category"] = _normalize_category(r.get("category"), p, focus)

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
