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

def _build_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    return session

_SESSION = _build_session()

def search_papers(query: str, limit: int = 20, year_from: str = "") -> list[dict]:
    """搜索论文，返回标准化的论文字典列表"""
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
        print(f"[semantic_scholar] 搜索失败: {e}")
        return []

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

    print(f"[semantic_scholar] 搜索到 {len(papers)} 篇有摘要的文献")
    return papers


def get_papers(keywords: list[str], max_results: int = 20, year_from: str = "") -> list[dict]:
    """主入口：合并关键词搜索"""
    query = " ".join(keywords)
    return search_papers(query, limit=max_results, year_from=year_from)
