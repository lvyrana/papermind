# PaperMind

一个有记忆的学术文献助手。自动追踪领域前沿论文，AI 生成个性化解读，支持对话式深度阅读和笔记沉淀。

## 项目信息

- **项目名称**: PaperMind
- **启动时间**: 2026 年 3 月 25 日
- **当前版本**: v0.4
- **独立开发**: 雀雀（主导设计、需求定义、产品决策、测试与迭代）
- **开发方式**: 使用 AI 编程工具（Claude）辅助代码实现

> 本项目由雀雀主导设计、需求定义、测试与迭代，开发过程中使用 AI 编程工具辅助实现。所有产品决策、功能规划、视觉风格和交互设计均由作者独立完成。

## 核心功能

- **智能文献追踪**: 从 PubMed、Semantic Scholar 自动获取领域最新论文
- **个性化推荐**: 基于研究者画像，LLM 生成 PubMed 检索词，动态打分过滤
- **排除不感兴趣的方向**: 画像中设置排除领域，搜索和评分双重屏蔽
- **对话式阅读**: 和 AI 深度讨论论文，提问方法学、核心发现、研究启发
- **对话记忆**: 聊天记录自动保存，收藏后永久留存
- **研究笔记**: 边读边记，AI 对话可一键保存为笔记
- **摘要翻译**: 点击即译，原文/中文随时切换
- **文献导出**: 一键导出 RIS/BibTeX，直接导入 Zotero/EndNote/Mendeley
- **PDF 获取**: 自动查找开放获取全文
- **设备隔离**: 无需登录，每台设备数据独立

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite + Tailwind CSS 4 + Lucide Icons |
| 后端 | Python + FastAPI + SQLite |
| 数据源 | PubMed E-utilities + Semantic Scholar API |
| AI | 阿里云通义（qwen-flash/plus）→ 智谱 GLM → DeepSeek（内置，无需配置）|

## 快速开始

### 环境准备

```bash
cd papermind/papermind
python3 -m venv .venv_new
source .venv_new/bin/activate
pip install -r requirements.txt
```

### 配置 API Key

复制 `.env.example` 为 `.env`，填入 API Key：

```bash
cp .env.example .env
```

### 启动后端

```bash
cd papermind/papermind
.venv_new/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

### 构建前端

```bash
cd web
npm install
npm run build
```

打开 http://localhost:8000 即可使用。

> 前端已构建到后端 `dist/` 目录，由 FastAPI 统一提供服务，无需单独启动前端开发服务器。

## 项目结构

```
papermind/
├── papermind/              # Python 后端
│   ├── api.py              # FastAPI 主入口
│   ├── .env                # API Keys（不提交 git）
│   ├── src/
│   │   ├── fetch_papers.py         # PubMed 检索
│   │   ├── fetch_semantic_scholar.py
│   │   ├── categorize_papers.py    # LLM 动态打分分类
│   │   └── database.py             # SQLite 数据层（用户隔离）
│   └── data/               # 数据库文件
└── web/                    # React 前端
    └── src/
        ├── api.js           # 统一 API 请求（自动注入用户 ID）
        ├── pages/           # 页面组件
        └── components/      # 通用组件
```

## 许可

待定
