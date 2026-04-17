"""
从 PubMed 获取学术文献
使用 NCBI E-utilities API（免费，无需注册）
"""

from __future__ import annotations
import os
import time
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def _build_http_session() -> requests.Session:
    """构建更稳健的 HTTP 会话：禁用环境代理 + 自动重试。"""
    session = requests.Session()
    session.trust_env = False  # 避免被系统/终端代理变量影响
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET"]),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


_SESSION = _build_http_session()


def _ncbi_common_params() -> dict[str, str]:
    """可选附加 NCBI 建议参数（如 email）。"""
    params: dict[str, str] = {}
    email = os.environ.get("EMAIL", "").strip()
    if email:
        params["email"] = email
        params["tool"] = "papermind"
    return params


def build_query(keywords: list[str], days: int = 7) -> str:
    """构造 PubMed 搜索查询字符串。

    支持两种输入:
    - 短关键词（1-3个词）: 用精确短语匹配 "keyword"[tiab]
    - 长查询（多个词）: 拆成单词用 AND 连接，每个词搜 [tiab]
    """
    date_to = datetime.now()
    date_from = date_to - timedelta(days=days)
    date_range = (
        f"{date_from.strftime('%Y/%m/%d')}:{date_to.strftime('%Y/%m/%d')}[dp]"
    )

    parts = []
    for kw in keywords:
        text = kw.strip()
        if not text:
            continue

        connector_split = [seg.strip() for seg in re.split(r"\bAND\b", text, flags=re.IGNORECASE) if seg.strip()]
        if len(connector_split) >= 2:
            primary = f'"{connector_split[0]}"[tiab]'
            secondary = [f'"{seg}"[tiab]' for seg in connector_split[1:4]]
            if len(secondary) == 1:
                parts.append(f"({primary} AND {secondary[0]})")
            else:
                parts.append(f"({primary} AND ({' OR '.join(secondary)}))")
            continue

        words = re.findall(r"[A-Za-z0-9-]+", text)
        if len(words) <= 3:
            parts.append(f'"{text}"[tiab]')
            continue

        _stop = {"and", "or", "the", "of", "in", "for", "with", "on", "to", "a", "an", "by", "from", "using", "based"}
        significant = [w for w in words if len(w) > 2 and w.lower() not in _stop]
        if len(significant) <= 3:
            parts.append(f'"{text}"[tiab]')
        else:
            anchor_words = significant[:3]
            anchor_query = " AND ".join(f"{w}[tiab]" for w in anchor_words)
            parts.append(f'("{text}"[tiab] OR ({anchor_query}))')

    keyword_query = " OR ".join(parts)
    return f"({keyword_query}) AND {date_range}"


def search_pmids(query: str, max_results: int = 50) -> list[str]:
    """用 esearch 获取符合条件的 PMID 列表"""
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": max_results,
        "retmode": "json",
        "sort": "pub_date",
        **_ncbi_common_params(),
    }
    resp = _SESSION.get(f"{BASE_URL}/esearch.fcgi", params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    pmids = data.get("esearchresult", {}).get("idlist", [])
    print(f"[fetch] 共检索到 {len(pmids)} 篇文献")
    return pmids


def fetch_paper_details(pmids: list[str]) -> list[dict]:
    """用 efetch 批量获取文献详情，返回解析后的字典列表"""
    if not pmids:
        return []

    papers = []
    batch_size = 10  # 减小单次请求体积，降低网络失败概率

    for start in range(0, len(pmids), batch_size):
        batch = pmids[start : start + batch_size]
        params = {
            "db": "pubmed",
            "id": ",".join(batch),
            "retmode": "xml",
            "rettype": "abstract",
            **_ncbi_common_params(),
        }
        resp = _SESSION.get(f"{BASE_URL}/efetch.fcgi", params=params, timeout=30)
        resp.raise_for_status()

        root = ET.fromstring(resp.text)
        for article in root.findall(".//PubmedArticle"):
            paper = _parse_article(article)
            if paper:
                papers.append(paper)

        # NCBI 限速建议最多 3 次/秒，这里留一点余量
        if start + batch_size < len(pmids):
            time.sleep(0.4)

    return papers


def _parse_article(article: ET.Element) -> dict | None:
    """解析单篇文章的 XML 节点"""
    try:
        medline = article.find("MedlineCitation")
        pmid_el = medline.find("PMID")
        pmid = pmid_el.text if pmid_el is not None else ""

        art = medline.find("Article")

        # 标题
        title_el = art.find("ArticleTitle")
        title = "".join(title_el.itertext()) if title_el is not None else "无标题"

        # 摘要
        abstract_parts = art.findall(".//AbstractText")
        if abstract_parts:
            abstract = " ".join("".join(p.itertext()) for p in abstract_parts)
        else:
            abstract = "（无摘要）"

        # 作者
        author_list = art.find("AuthorList")
        authors = []
        if author_list is not None:
            for author in author_list.findall("Author"):
                last = author.findtext("LastName", "")
                fore = author.findtext("ForeName", "")
                name = f"{last} {fore}".strip()
                if name:
                    authors.append(name)
        authors_str = ", ".join(authors[:5])
        if len(authors) > 5:
            authors_str += " 等"

        # 期刊
        journal_el = art.find("Journal")
        journal = journal_el.findtext("Title", "未知期刊") if journal_el else "未知期刊"

        # 发表日期
        pub_date = _extract_pub_date(art)

        # 链接
        link = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"

        return {
            "pmid": pmid,
            "title": title.strip(),
            "abstract": abstract.strip(),
            "authors": authors_str,
            "journal": journal,
            "pub_date": pub_date,
            "link": link,
        }
    except Exception as e:
        print(f"[warn] 解析文章失败: {e}")
        return None


def _extract_pub_date(art: ET.Element) -> str:
    """尝试从多个字段提取发表日期"""
    journal = art.find("Journal")
    if journal is not None:
        ji = journal.find("JournalIssue")
        if ji is not None:
            pd = ji.find("PubDate")
            if pd is not None:
                year = pd.findtext("Year", "")
                month = pd.findtext("Month", "")
                day = pd.findtext("Day", "")
                med_date = pd.findtext("MedlineDate", "")
                if year:
                    return f"{year}-{month}-{day}".strip("-").replace("--", "-")
                if med_date:
                    return med_date
    return "日期未知"


def get_papers(keywords: list[str], days: int = 7, max_results: int = 50) -> list[dict]:
    """主入口：搜索并返回文献列表"""
    query = build_query(keywords, days)
    print(f"[fetch] 查询语句: {query}")
    pmids = search_pmids(query, max_results)
    if not pmids:
        return []
    time.sleep(0.4)  # 遵守 NCBI 限速规则（3次/秒）
    papers = fetch_paper_details(pmids)
    print(f"[fetch] 成功解析 {len(papers)} 篇文献")
    return papers
