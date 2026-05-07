from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional

from llm_router import _get_llm_client, _llm_chat_complete
from src.categorize_papers import score_and_categorize_papers
from src.database import get_saved_titles, save_search_run
from src.fetch_papers import build_query as build_pubmed_query
from src.fetch_papers import get_papers as pubmed_get_papers
from src.fetch_semantic_scholar import get_papers as scholar_get_papers


def _parse_pub_date(pub_date: str) -> Optional[datetime]:
    """尽量把论文日期解析成 datetime，用于严格的时间窗过滤。"""
    if not pub_date:
        return None

    text = pub_date.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    normalized = re.sub(r"\s+", "-", text.replace("/", "-"))
    month_map = {
        "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
        "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
    }
    for month_name, month_num in month_map.items():
        normalized = normalized.replace(month_name, month_num)

    for fmt in ("%Y-%m-%d", "%Y-%m"):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue

    match = re.search(r"(20\d{2})", text)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y")
        except ValueError:
            return None
    return None


def _filter_papers_by_days(papers: list[dict], days: int) -> list[dict]:
    """按真实日期过滤论文，避免超出用户设定的追踪周期。"""
    cutoff = datetime.now() - timedelta(days=days)
    filtered = []
    dropped = 0
    for paper in papers:
        parsed_date = _parse_pub_date(paper.get("pub_date", ""))
        if parsed_date and parsed_date < cutoff:
            dropped += 1
            continue
        filtered.append(paper)
    if dropped:
        print(f"[search] 按 {days} 天时间窗过滤掉 {dropped} 篇旧论文")
    return filtered


def _split_profile_terms(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[，,、/；;]+", text or "") if part.strip()]


def _dedupe_terms(terms: list[str]) -> list[str]:
    seen = set()
    result = []
    for term in terms:
        key = (term or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(term.strip())
    return result


def _expand_exclude_terms(raw_terms: list[str]) -> list[str]:
    """把用户排除词扩展成更容易命中的中英文关键词。"""
    alias_map = {
        "药物研究": ["drug", "drugs", "medication", "pharmacologic", "pharmacological", "pharmacotherapy", "pharmaceutical"],
        "药物治疗": ["drug therapy", "medication", "pharmacologic", "pharmacological", "pharmacotherapy"],
        "药物合成": ["drug synthesis", "synthesis", "compound synthesis", "pharmaceutical synthesis"],
        "基础研究": ["basic science", "basic research", "mechanism", "molecular", "cellular", "animal model"],
        "动物实验": ["animal", "mice", "mouse", "rat", "rats", "murine"],
        "分子机制": ["molecular mechanism", "mechanism", "signaling pathway", "gene expression"],
    }
    expanded: list[str] = []
    for term in raw_terms:
        expanded.append(term)
        expanded.extend(alias_map.get(term, []))
        expanded.extend(alias_map.get(term.lower(), []))
    return _dedupe_terms(expanded)


def _paper_matches_exclude(paper: dict, exclude_terms: list[str]) -> bool:
    if not exclude_terms:
        return False
    haystack = " ".join([
        paper.get("title", ""),
        paper.get("abstract", ""),
        " ".join(paper.get("publication_types", []) or []),
    ]).lower()
    for term in exclude_terms:
        token = (term or "").strip().lower()
        if token and token in haystack:
            return True
    return False


def _is_low_value_publication(paper: dict) -> bool:
    """过滤 reply/comment/editorial/letter 等低价值条目，以及无摘要条目。"""
    publication_types = [t.lower() for t in (paper.get("publication_types", []) or [])]
    low_value_types = {
        "comment",
        "editorial",
        "letter",
        "news",
        "published erratum",
        "retraction of publication",
    }
    if any(pt in low_value_types for pt in publication_types):
        return True

    title = (paper.get("title", "") or "").strip().lower()
    low_value_prefixes = (
        "reply",
        "reply to",
        "comment on",
        "editorial",
        "letter to the editor",
    )
    if any(title.startswith(prefix) for prefix in low_value_prefixes):
        return True

    abstract = (paper.get("abstract", "") or "").strip()
    if paper.get("has_abstract") is False:
        return True
    if abstract in {"", "（无摘要）", "(no abstract)"}:
        return True

    return False


def _build_broader_queries(profile: dict) -> list[str]:
    """当首轮检索过窄时，构造更宽的主题查询作为兜底。"""
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    if not focus_terms:
        return []

    broad_queries = []
    for term in focus_terms[:4]:
        broad_queries.append(term)
    seen = set()
    result = []
    for query in broad_queries:
        key = query.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(query)
    return result[:6]


def _normalize_focus_terms(focus: str) -> list[str]:
    """把常见中文研究主题映射到更稳定的英文检索词。"""
    alias_map = {
        "慢阻肺": "COPD",
        "肺癌": "lung cancer",
        "肺康复": "pulmonary rehabilitation",
        "慢病护理": "chronic disease nursing",
        "护理": "nursing",
        "解释性现象学": "interpretative phenomenological analysis",
        "现象学": "phenomenological study",
        "质性研究": "qualitative research",
        "扎根理论": "grounded theory",
        "主题分析": "thematic analysis",
    }
    terms = _split_profile_terms(focus)
    normalized = []
    for term in terms:
        normalized.append(alias_map.get(term, term))
    return normalized


def _normalize_method_terms(methods: str, keep_unknown: bool = True) -> list[str]:
    """把方法兴趣转换成稳定的英文方法术语。"""
    alias_map = {
        "解释性现象学": "interpretative phenomenological analysis",
        "ipa": "interpretative phenomenological analysis",
        "现象学": "phenomenological study",
        "质性研究": "qualitative research",
        "定性研究": "qualitative research",
        "扎根理论": "grounded theory",
        "主题分析": "thematic analysis",
        "机器学习": "machine learning",
        "预测模型": "prediction model",
        "孟德尔随机化": "mendelian randomization",
        "中介效应": "mediation analysis",
    }
    normalized = []
    for term in _split_profile_terms(methods):
        mapped = alias_map.get(term.lower(), alias_map.get(term))
        if mapped:
            normalized.append(mapped)
        elif keep_unknown:
            normalized.append(term)
    return _dedupe_terms(normalized)


def _build_method_aware_queries(profile: dict) -> list[str]:
    """基于主题和方法兴趣，构造一批带主题锚点的确定性查询。"""
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    method_terms = _normalize_method_terms(profile.get("method_interests", ""))
    method_terms.extend(_normalize_method_terms(profile.get("focus_areas", ""), keep_unknown=False))
    method_terms = _dedupe_terms(method_terms)

    if not (focus_terms or method_terms):
        return []

    has_qualitative_family = any(term in method_terms for term in (
        "qualitative research",
        "interpretative phenomenological analysis",
        "phenomenological study",
        "grounded theory",
        "thematic analysis",
    ))

    method_templates = method_terms.copy()
    if has_qualitative_family:
        method_templates.extend([
            "qualitative research",
            "qualitative study",
            "patient experience",
            "lived experience",
        ])
    method_templates = _dedupe_terms(method_templates)

    query_groups: list[str] = []

    for focus in focus_terms[:4]:
        query_groups.append(focus)
        if method_templates:
            for method in method_templates[:3]:
                query_groups.append(f"{focus} {method}")

    return _dedupe_terms(query_groups)[:8]


def _generate_search_keywords(profile: dict, client, model: str) -> list[str]:
    """根据当前用户画像，用 LLM 生成多组搜索关键词。"""
    focus = profile.get("focus_areas", "")
    method_interests = profile.get("method_interests", "")
    background = profile.get("background", "")

    if not (focus or method_interests or background):
        return []

    exclude = profile.get("exclude_areas", "")
    profile_text = ""
    if focus:
        profile_text += f"研究方向：{focus}\n"
    if method_interests:
        profile_text += f"方法兴趣：{method_interests}\n"
    if background:
        profile_text += f"补充说明：{background}\n"
    if exclude:
        profile_text += f"明确排除（不要生成相关关键词）：{exclude}\n"

    sparse_focus = len((focus or "").strip()) < 10
    sparse_hint = ""
    if sparse_focus and background:
        sparse_hint = (
            "\n注意：该用户的「研究方向」填写较少，请重点从「补充说明」的自然语言中，"
            "提取以下要素并转化为检索词：\n"
            "- 疾病 / 症状 / 临床问题（如：带状疱疹、COPD、术后疼痛）\n"
            "- 目标人群（如：老年患者、住院患者、护理人员）\n"
            "- 干预方式 / 研究内容（如：中医干预、康复护理、自我管理）\n"
            "- 研究设计偏好（如：综述、RCT、质性研究）\n"
            "将上述要素组合成多组有效的 PubMed 英文检索词。\n"
        )

    prompt = f"""你是一位学术检索专家。根据以下研究者画像，生成用于 PubMed 检索的英文关键词组合。

    {profile_text}
    {sparse_hint}
要求：
1. 生成 4-6 组关键词，每组是一个用于 PubMed 搜索的英文查询字符串
2. 每组关键词控制在 2-4 个词以内，不要堆砌过多词汇
3. 覆盖研究者关注方向的不同角度：至少 2 组聚焦疾病/临床场景，1-2 组聚焦方法，不要每组都把所有关键词堆在一起
4. 必须使用英文专业学术术语（PubMed 只支持英文检索）
5. 可以使用 AND/OR 组合，但每组词之间不需要全部 AND，允许适度宽泛
6. 严格避免生成用户明确排除的领域的关键词
7. 如果研究者明确写了方法兴趣，请至少生成 1-2 组能体现这些方法兴趣的查询，但不要完全脱离研究主题
8. 明确输入的研究方向和方法兴趣优先级最高，始终以研究方向为核心组织检索
9. 每一组查询都必须保留至少一个"研究主题锚点"（疾病、人群、场景、护理问题等），不能只剩方法词，例如不能只写 qualitative research、thematic analysis、patient experience 这类宽泛查询
10. 学科领域仅用于后续解读和排序，不参与本轮检索词生成；请不要因为学科领域自动补入 nursing、patient、caregiver、self-management 等语境词，除非它们来自研究方向、方法兴趣或补充说明本身

示例输出：["COPD self-management", "lung cancer mortality prediction", "COPD exacerbation readmission risk", "symptom management quality of life", "machine learning hospital readmission"]

只输出 JSON 数组，不要 markdown 代码块，不要其他文字。"""

    try:
        raw, _, _ = _llm_chat_complete(
            [{"role": "user", "content": prompt}],
            max_tokens=400,
            temperature=0.3,
            task="search",
        )
        if not raw:
            raise RuntimeError("empty response")
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        keywords = json.loads(raw)
        print(f"[search] LLM 生成搜索关键词: {keywords}")
        return keywords
    except Exception as e:
        print(f"[search] 关键词生成失败: {e}")
        return []


def _clean_query_text(query: str) -> str:
    return re.sub(r"\s+", " ", (query or "").replace("\n", " ")).strip().strip(",;")


def _query_has_focus_anchor(query: str, focus_terms: list[str]) -> bool:
    english_focus_terms = [term for term in focus_terms if re.search(r"[A-Za-z]", term or "")]
    if not english_focus_terms:
        return True
    lower_query = query.lower()
    return any(term.lower() in lower_query for term in english_focus_terms)


def _is_overly_generic_query(query: str, method_terms: list[str]) -> bool:
    lower_query = query.lower()
    generic_queries = {
        "qualitative research",
        "qualitative study",
        "patient experience",
        "lived experience",
        "grounded theory",
        "thematic analysis",
        "phenomenological study",
        "interpretative phenomenological analysis",
        "nursing",
        "nursing patient experience",
    }
    if lower_query in generic_queries:
        return True

    generic_tokens = {
        "qualitative", "research", "study", "patient", "experience", "lived",
        "grounded", "theory", "thematic", "analysis", "phenomenological",
        "interpretative", "nursing", "care", "caregiver",
    }
    generic_tokens.update(
        token
        for term in method_terms
        for token in re.findall(r"[a-z0-9-]+", term.lower())
    )
    tokens = re.findall(r"[a-z0-9-]+", lower_query)
    return bool(tokens) and all(token in generic_tokens for token in tokens)


def _query_matches_exclude(query: str, profile: dict) -> bool:
    exclude_terms = _expand_exclude_terms(_split_profile_terms(profile.get("exclude_areas", "")))
    lower_query = (query or "").lower()
    return any(term.strip().lower() in lower_query for term in exclude_terms if term.strip())


def _sanitize_generated_queries(raw_queries: list[str], profile: dict) -> tuple[list[str], list[dict]]:
    focus_terms = _normalize_focus_terms(profile.get("focus_areas", ""))
    method_terms = _normalize_method_terms(profile.get("method_interests", ""))
    dropped: list[dict] = []
    sanitized: list[str] = []

    for raw_query in raw_queries or []:
        query = _clean_query_text(raw_query)
        if not query:
            continue
        if not _query_has_focus_anchor(query, focus_terms):
            dropped.append({"query": query, "reason": "missing_focus_anchor"})
            continue
        if _is_overly_generic_query(query, method_terms):
            dropped.append({"query": query, "reason": "too_generic"})
            continue
        if _query_matches_exclude(query, profile):
            dropped.append({"query": query, "reason": "matches_exclude"})
            continue
        sanitized.append(query)

    return _dedupe_terms(sanitized), dropped


def _build_query_specs(profile: dict, keyword_list: list[str], smart_queries: list[str]) -> tuple[list[dict], list[dict]]:
    query_specs: list[dict] = []
    dropped_queries: list[dict] = []

    sanitized_llm, dropped = _sanitize_generated_queries(smart_queries, profile)
    dropped_queries.extend([{**item, "origin": "llm"} for item in dropped])
    for query in sanitized_llm:
        query_specs.append({"query": query, "origin": "llm"})

    if keyword_list:
        manual_query = " OR ".join(_dedupe_terms(keyword_list))
        if manual_query:
            query_specs.append({"query": manual_query, "origin": "manual"})

    if len(query_specs) < 3:
        for query in _build_method_aware_queries(profile):
            query_specs.append({"query": query, "origin": "deterministic"})

    if len(query_specs) < 3:
        for query in _build_broader_queries(profile):
            query_specs.append({"query": query, "origin": "broad_fallback"})

    deduped_specs = []
    seen = set()
    for spec in query_specs:
        query = _clean_query_text(spec.get("query", ""))
        key = query.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_specs.append({**spec, "query": query})

    return deduped_specs[:6], dropped_queries


def _round_robin_sources(papers: list[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = {}
    for paper in papers:
        buckets.setdefault(paper.get("source", "unknown"), []).append(paper)

    if len(buckets) <= 1:
        return papers

    source_order = sorted(buckets.keys(), key=lambda key: (-len(buckets[key]), key))
    mixed: list[dict] = []
    while True:
        progressed = False
        for source in source_order:
            if buckets[source]:
                mixed.append(buckets[source].pop(0))
                progressed = True
        if not progressed:
            break
    return mixed


def fetch_and_rank_papers(keyword_list, days, source, profile, user_id: str = ""):
    """从 PubMed + Semantic Scholar 抓取论文并缓存，同时记录检索轨迹。"""
    client, model = _get_llm_client()
    saved_titles = get_saved_titles(user_id) if user_id else []
    trace = {
        "created_at": datetime.now().isoformat(),
        "source_requested": source,
        "input_keywords": keyword_list or [],
        "profile_snapshot": {
            "discipline": profile.get("discipline", ""),
            "focus_areas": profile.get("focus_areas", ""),
            "method_interests": profile.get("method_interests", ""),
            "exclude_areas": profile.get("exclude_areas", ""),
            "tracking_days": str(days),
        },
        "llm_queries_raw": [],
        "translated_queries_raw": [],
        "dropped_queries": [],
        "queries": [],
        "totals": {},
        "final_source_counts": {},
    }

    smart_queries = []
    if client and (profile.get("focus_areas") or profile.get("method_interests") or profile.get("background")):
        smart_queries = _generate_search_keywords(profile, client, model)
    trace["llm_queries_raw"] = smart_queries

    query_specs, dropped_queries = _build_query_specs(profile, keyword_list, smart_queries)
    trace["dropped_queries"] = dropped_queries

    if len(query_specs) < 2 and client:
        focus = profile.get("focus_areas", "")
        method_interests = profile.get("method_interests", "")
        fallback_seed = ", ".join(part for part in [focus, method_interests] if part)
        if fallback_seed:
            try:
                translated, _, _ = _llm_chat_complete(
                    [{"role": "user", "content": f'将以下研究方向和方法兴趣翻译为英文学术术语，用逗号分隔，只输出翻译结果：{fallback_seed}'}],
                    max_tokens=200,
                    temperature=0,
                    task="translate",
                )
                translated_queries = [t.strip() for t in translated.split(",") if t.strip()]
                trace["translated_queries_raw"] = translated_queries
                print(f"[search] 翻译画像关键词: {translated_queries}")
                translated_specs, translated_dropped = _build_query_specs(profile, [], translated_queries)
                trace["dropped_queries"].extend([{**item, "origin": "translated_fallback"} for item in translated_dropped])
                for spec in translated_specs:
                    query_specs.append({**spec, "origin": "translated_fallback"})
            except Exception:
                pass

    deduped_specs = []
    seen_queries = set()
    for spec in query_specs:
        query = _clean_query_text(spec.get("query", ""))
        key = query.lower()
        if not key or key in seen_queries:
            continue
        seen_queries.add(key)
        deduped_specs.append({**spec, "query": query})
    query_specs = deduped_specs[:6]

    if not query_specs:
        print("[search] 无搜索关键词，跳过")
        trace["totals"] = {"query_count": 0, "raw_papers": 0, "final_papers": 0}
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    all_papers = []
    s2_counter = threading.Lock()
    s2_used = [0]

    def _fetch_for_spec(spec):
        papers = []
        query = spec["query"]
        origin = spec.get("origin", "unknown")
        query_keywords = [k.strip() for k in query.split(" OR ") if k.strip()] if " OR " in query else [query]
        qt = {
            "query": query,
            "origin": origin,
            "query_keywords": query_keywords,
            "pubmed_query": build_pubmed_query(query_keywords, days) if source in ("pubmed", "all") else "",
            "semantic_query": " ".join(query_keywords) if source in ("semantic_scholar", "all") else "",
            "sources": [],
        }

        if source in ("pubmed", "all"):
            try:
                pp = pubmed_get_papers(query_keywords, days=days, max_results=30)
                for p in pp:
                    p["source"] = "pubmed"
                    p.setdefault("_matched_queries", []).append(query)
                papers.extend(pp)
                qt["sources"].append({"source": "pubmed", "status": "ok", "count": len(pp)})
            except Exception as e:
                print(f"[search] PubMed 获取失败 ({query}): {e}")
                qt["sources"].append({"source": "pubmed", "status": "error", "count": 0, "error": str(e)})

        if source in ("semantic_scholar", "all"):
            do_s2 = False
            with s2_counter:
                if s2_used[0] < 4:
                    s2_used[0] += 1
                    do_s2 = True
            if not do_s2:
                qt["sources"].append({"source": "semantic_scholar", "status": "skipped_limit", "count": 0})
            else:
                try:
                    year_from = (datetime.now() - timedelta(days=max(days, 30) + 365)).strftime("%Y")
                    sp = scholar_get_papers(query_keywords, max_results=15, year_from=year_from)
                    for p in sp:
                        p.setdefault("_matched_queries", []).append(query)
                    papers.extend(sp)
                    qt["sources"].append({"source": "semantic_scholar", "status": "ok", "count": len(sp)})
                except Exception as e:
                    print(f"[search] Semantic Scholar 获取失败 ({query}): {e}")
                    qt["sources"].append({"source": "semantic_scholar", "status": "error", "count": 0, "error": str(e)})

        return papers, qt

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(_fetch_for_spec, spec) for spec in query_specs]
        for f in as_completed(futures):
            try:
                spec_papers, qt = f.result()
                all_papers.extend(spec_papers)
                trace["queries"].append(qt)
            except Exception as e:
                print(f"[search] 并发抓取异常: {e}")

    if not all_papers:
        trace["totals"] = {
            "query_count": len(query_specs),
            "raw_papers": 0,
            "after_dedupe": 0,
            "after_saved_filter": 0,
            "after_day_filter": 0,
            "final_papers": 0,
        }
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    seen_titles = set()
    unique_papers = []
    for p in all_papers:
        title_key = p["title"].lower().strip()[:80]
        if title_key not in seen_titles:
            seen_titles.add(title_key)
            unique_papers.append(p)

    print(f"[search] 去重后 {len(unique_papers)} 篇论文")
    trace["totals"]["query_count"] = len(query_specs)
    trace["totals"]["raw_papers"] = len(all_papers)
    trace["totals"]["after_dedupe"] = len(unique_papers)

    if saved_titles and user_id:
        saved_set = {t.lower().strip()[:80] for t in saved_titles}
        before = len(unique_papers)
        unique_papers = [p for p in unique_papers if p["title"].lower().strip()[:80] not in saved_set]
        filtered_saved = before - len(unique_papers)
        if filtered_saved:
            print(f"[search] 过滤已收藏论文 {filtered_saved} 篇")
    trace["totals"]["after_saved_filter"] = len(unique_papers)

    month_map = {"Jan":"01","Feb":"02","Mar":"03","Apr":"04","May":"05","Jun":"06",
                 "Jul":"07","Aug":"08","Sep":"09","Oct":"10","Nov":"11","Dec":"12"}
    for p in unique_papers:
        d = p.get("pub_date", "")
        parts = d.split("-")
        if len(parts) == 3 and len(parts[1]) == 3 and parts[1] in month_map:
            p["pub_date"] = f"{parts[0]}-{month_map[parts[1]]}-{parts[2].zfill(2)}"
        elif len(parts) == 2 and len(parts[1]) == 3 and parts[1] in month_map:
            p["pub_date"] = f"{parts[0]}-{month_map[parts[1]]}"

    unique_papers = _filter_papers_by_days(unique_papers, days)
    trace["totals"]["after_day_filter"] = len(unique_papers)
    if not unique_papers:
        print("[search] 时间窗过滤后无论文")
        trace["totals"]["final_papers"] = 0
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    before_low_value = len(unique_papers)
    unique_papers = [p for p in unique_papers if not _is_low_value_publication(p)]
    filtered_low_value = before_low_value - len(unique_papers)
    trace["totals"]["after_low_value_filter"] = len(unique_papers)
    if filtered_low_value:
        print(f"[search] 过滤低价值/无摘要文献 {filtered_low_value} 篇")
    if not unique_papers:
        print("[search] 低价值文献过滤后无论文")
        trace["totals"]["final_papers"] = 0
        trace["run_id"] = save_search_run(user_id, source, trace)
        return [], trace

    raw_exclude_terms = _split_profile_terms(profile.get("exclude_areas", ""))
    exclude_terms = _expand_exclude_terms(raw_exclude_terms)
    if exclude_terms:
        before_exclude = len(unique_papers)
        unique_papers = [p for p in unique_papers if not _paper_matches_exclude(p, exclude_terms)]
        filtered_exclude = before_exclude - len(unique_papers)
        trace["totals"]["after_exclude_filter"] = len(unique_papers)
        if filtered_exclude:
            print(f"[search] 按排除词硬过滤 {filtered_exclude} 篇")
        if not unique_papers:
            print("[search] 排除词过滤后无论文")
            trace["totals"]["final_papers"] = 0
            trace["run_id"] = save_search_run(user_id, source, trace)
            return [], trace

    if client:
        unique_papers = score_and_categorize_papers(
            unique_papers,
            profile,
            client,
            model,
            llm_call=lambda messages, max_tokens, temperature: _llm_chat_complete(
                messages,
                max_tokens=max_tokens,
                temperature=temperature,
                task="categorize",
            ),
        )
        scored = [p for p in unique_papers if p.get("relevance_score", 5) >= 3]
        if len(scored) >= 8:
            filtered = len(unique_papers) - len(scored)
            unique_papers = scored
            if filtered:
                print(f"[search] 过滤低相关性论文 {filtered} 篇")
        else:
            target_count = min(10, len(unique_papers))
            borderline = [
                p for p in unique_papers
                if 2 <= p.get("relevance_score", 5) < 3
            ][: max(target_count - len(scored), 0)]
            unique_papers = scored + borderline
            unique_papers.sort(key=lambda p: p.get("relevance_score", 0), reverse=True)
            print(f"[search] 高分论文不足 8 篇，保留 {len(unique_papers)} 篇不重复的中高相关论文")

    if source == "all":
        unique_papers = _round_robin_sources(unique_papers)

    for paper in unique_papers:
        paper.pop("_matched_queries", None)

    final_source_counts: dict[str, int] = {}
    for paper in unique_papers:
        paper_source = paper.get("source", "unknown")
        final_source_counts[paper_source] = final_source_counts.get(paper_source, 0) + 1
    trace["final_source_counts"] = final_source_counts
    trace["totals"]["final_papers"] = len(unique_papers)
    trace["run_id"] = save_search_run(user_id, source, trace)

    print(f"[search] 最终缓存 {len(unique_papers)} 篇论文")
    return unique_papers, trace
