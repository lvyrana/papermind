# PaperMind

一个有记忆的学术文献助手。自动追踪领域前沿论文，AI 生成个性化解读，支持对话式深度阅读和笔记沉淀。

## 项目信息

- **项目名称**: PaperMind
- **启动时间**: 2026 年 3 月 25 日
- **当前版本**: v0.3
- **独立开发**: 雀雀（主导设计、需求定义、产品决策、测试与迭代）
- **开发方式**: 使用 AI 编程工具（Claude）辅助代码实现

> 本项目由雀雀主导设计、需求定义、测试与迭代，开发过程中使用 AI 编程工具辅助实现。所有产品决策、功能规划、视觉风格和交互设计均由作者独立完成。

## 核心功能

- **智能文献追踪**: 从 PubMed、Semantic Scholar 自动获取领域最新论文
- **个性化推荐**: 基于研究者画像，AI 解读每篇论文与你的研究关联
- **对话式阅读**: 和 AI 深度讨论论文，提问方法学、核心发现、研究启发
- **对话记忆**: 聊天记录自动保存，收藏后永久留存
- **研究笔记**: 边读边记，AI 可将对话总结为结构化笔记
- **文献导出**: 一键导出 RIS/BibTeX，直接导入 Zotero/EndNote/Mendeley
- **PDF 获取**: 自动查找开放获取全文
- **研究周报**: 生成 Markdown 格式中文科研周报

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite 8 + Tailwind CSS 4 + Lucide Icons |
| 后端 | Python + FastAPI + SQLite |
| 数据源 | PubMed E-utilities + Semantic Scholar API |
| AI | OpenRouter / DeepSeek / 智谱 / Moonshot / OpenAI（可配置） |

## 快速开始

### 后端

```bash
cd copd-research-weekly
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn api:app --reload --port 8000
```

### 前端

```bash
cd web
npm install
npm run dev
```

打开 http://localhost:5173 即可使用。

## 项目结构

```
papermind/
├── copd-research-weekly/     # Python 后端
│   ├── api.py                # FastAPI 主入口
│   ├── main.py               # CLI 周报生成
│   ├── src/                  # 核心模块
│   │   ├── fetch_papers.py   # PubMed 检索
│   │   ├── fetch_semantic_scholar.py
│   │   ├── categorize_papers.py
│   │   ├── summarize_papers.py
│   │   ├── generate_report.py
│   │   ├── llm_client.py
│   │   ├── config_store.py
│   │   └── database.py       # SQLite 数据层
│   └── data/                 # 数据库 + 配置
├── web/                      # React 前端
│   └── src/
│       ├── pages/            # 页面组件
│       └── components/       # 通用组件
└── docs/                     # 文档 + 截图 + 录屏
```

## 许可

待定
