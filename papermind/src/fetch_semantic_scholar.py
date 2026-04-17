"""
从 Semantic Scholar API 获取文献
免费 API，无需 key，限速 100 次/5 分钟
"""

from __future__ import annotations
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://api.semanticscholar.org/graph/v1"
_COOLDOWN_UNTIL = 0.0

def _build_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    retry = Retry(
        total=2,
        backoff_factor=2,
        status_forcelist=[500, 502, 503],
        allowed_methods=frozenset(["GET"]),
        respect_retry_after_header=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    return session

_SESSION = _build_session()

def search_papers(query: str, limit: int = 20, year_from: str = "") -> list[dict]:
    """搜索论文，返回标准化的论文字典列表"""
    global _COOLDOWN_UNTIL
    now = time.time()
    if now < _COOLDOWN_UNTIL:
        wait_for = int(_COOLDOWN_UNTIL - now)
        print(f"[semantic_scholar] 命中冷却窗口，跳过本次查询（剩余约 {wait_for}s）")
        return []

    params = {
        "query": query,
        "limit": limit,
        "fields": "title,abstract,authors,year,externalIds,publicationDate,journal,url,citationCount",
    }
    if year_from:
        params["year"] = f"{year_from}-"

    try:
        resp = _SESSION.get(f"{BASE_URL}/paper/search", params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        status_code = getattr(getattr(e, "response", None), "status_code", None)
        if status_code == 429 or "429" in str(e):
            _COOLDOWN_UNTIL = time.time() + 90
            print("[semantic_scholar] 触发 429，进入 90 秒冷却")
        print(f"[semantic_scholar] 搜索失败: {e}")
        return []

    raw_count = len(data.get("data", []))
    papers = []
    for item in data.get("data", []):
        if not item.get("abstract"):
            continue

        # 提取 PubMed ID（如果有）
        ext_ids = item.get("externalIds") or {}
        pmid = ext_ids.get("PubMed", "")
        doi = ext_ids.get("DOI", "")

        # 构建链接
        if pmid:
            link = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
        elif doi:
            link = f"https://doi.org/{doi}"
        else:
            link = item.get("url", "")

        # 作者
        authors = item.get("authors") or []
        author_names = [a.get("name", "") for a in authors[:5]]
        authors_str = ", ".join(author_names)
        if len(authors) > 5:
            authors_str += " et al."

        # 期刊
        journal_info = item.get("journal") or {}
        journal = journal_info.get("name", "Unknown Journal")

        papers.append({
            "source": "semantic_scholar",
            "paper_id": item.get("paperId", ""),
            "pmid": pmid,
            "doi": doi,
            "title": (item.get("title") or "Untitled").strip(),
            "abstract": (item.get("abstract") or "").strip(),
            "authors": authors_str,
            "journal": journal,
            "pub_date": item.get("publicationDate") or str(item.get("year", "")),
            "link": link,
            "citation_count": item.get("citationCount", 0),
        })

    print(f"[semantic_scholar] 原始 {raw_count} 篇，过滤无摘要后剩 {len(papers)} 篇")
    return papers


def get_papers(keywords: list[str], max_results: int = 20, year_from: str = "") -> list[dict]:
    """主入口：合并关键词搜索"""
    query = " ".join(keywords)
    return search_papers(query, limit=max_results, year_from=year_from)
