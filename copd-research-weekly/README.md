# copd-research-weekly

自动从 PubMed 检索近7天 COPD 相关文献，生成 Markdown 格式中文科研周报。

## 项目结构

```
copd-research-weekly/
├── main.py                    # 主入口（串联所有步骤）
├── requirements.txt           # 依赖
├── .env.example               # 环境变量示例
├── README.md
└── src/
    ├── __init__.py
    ├── fetch_papers.py        # PubMed 文献检索与解析
    ├── llm_client.py          # OpenRouter/OpenAI 统一调用
    ├── summarize_papers.py    # LLM 生成中文摘要 & 护理启发
    ├── categorize_papers.py   # 文献主题分类
    └── generate_report.py     # Markdown 报告生成
```

## 环境要求

- Python 3.9+
- 网络可访问 PubMed（`eutils.ncbi.nlm.nih.gov`）

## 安装

```bash
# 克隆 / 进入项目目录
cd copd-research-weekly

# 创建虚拟环境（推荐）
python3 -m venv .venv
source .venv/bin/activate      # macOS/Linux
# .venv\Scripts\activate       # Windows

# 安装依赖
pip install -r requirements.txt

# 可选：复制环境变量模板
cp .env.example .env
```

## 运行

### mock 模式（无需 API Key，可直接测试）

```bash
python main.py
```

- 中文摘要：截取英文摘要前150字
- 文献分类：关键词规则匹配
- 护理启发：预置模板文本

### LLM 模式（推荐 OpenRouter）

```bash
OPENROUTER_API_KEY=sk-or-... python main.py
```

`.env` 里常用配置：

```bash
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_MODEL=openai/gpt-4o-mini
EMAIL=your_email_for_pubmed_api
```

如果你用 OpenAI 官方 key，也可配置 `OPENAI_API_KEY`（不配 `OPENROUTER_API_KEY` 时自动走 OpenAI）。

### 自定义关键词

```bash
python main.py "COPD exacerbation" "pulmonary rehabilitation"
```

## 输出

运行后在当前目录生成 `report_YYYYMMDD.md`，包含以下章节：

| 章节 | 内容 |
|------|------|
| 一页速览 | 文献数量、主题分布、优先关注方向 |
| 本周重点 | 前5篇重点文献的一句话解读 |
| 按主题快读 | 各主题快速跳转阅读 |
| 护理行动点 | LLM 综合护理启发（mock 模式下为示例文本）|
| 附录 | 纳入文献清单表格 |

## 注意事项

- NCBI E-utilities 免费使用，无需注册，限速 3 次/秒
- 推荐在 `.env` 里设置 `EMAIL`，更符合 PubMed API 使用规范
- 未配置 LLM Key 时会自动回退到 mock 模式，不会发起模型请求
- 默认从 PubMed 拉取 24 篇候选文献，按分类排除“药物治疗/机制研究”后最多保留 12 篇用于周报
