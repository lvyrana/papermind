# PaperMind

一个有记忆的学术文献助手。自动追踪领域前沿论文，AI 生成个性化解读，支持对话式深度阅读和笔记沉淀。

## 项目信息

- **项目名称**: PaperMind
- **启动时间**: 2026 年 3 月 25 日
- **当前版本**: v0.5.9
- **独立开发**: 雀雀（主导设计、需求定义、产品决策、测试与迭代）
- **开发方式**: 使用 AI 编程工具（Claude）辅助代码实现

> 本项目由雀雀主导设计、需求定义、测试与迭代，开发过程中使用 AI 编程工具辅助实现。所有产品决策、功能规划、视觉风格和交互设计均由作者独立完成。

## 核心功能

- **智能文献追踪**: 从 PubMed、Semantic Scholar 自动获取领域最新论文
- **个性化推荐**: 基于研究画像生成检索词，结合方法兴趣动态打分；系统观察摘要只在手动修正后参与理解层，不主导搜索召回
- **排除不感兴趣的方向**: 画像中设置排除领域，搜索和评分双重屏蔽
- **对话式阅读**: 和 AI 深度讨论论文，提问方法学、核心发现、研究启发
- **对话记忆**: 聊天记录自动保存，收藏后永久留存
- **研究笔记**: 边读边记，AI 对话可一键保存为笔记
- **笔记导出**: 支持将全部笔记导出为 Markdown，便于沉淀到 Obsidian / Notion / 本地文件
- **标题 & 摘要翻译**: 点击即译，原文/中文随时切换（首页、阅读页、收藏页均支持）
- **收藏库浏览**: 支持论文标题搜索、分类筛选、“有笔记”快速筛选与紧凑行列表回看
- **研究画像工作台**: 支持研究方向、方法兴趣、排除内容、学科领域、系统观察摘要
- **文献导出**: 一键导出 RIS/BibTeX，直接导入 Zotero/EndNote/Mendeley
- **PDF 获取**: 自动查找开放获取全文
- **设备隔离**: 无需登录，每台设备数据独立
- **测试期安全兜底**: Owner 专属连通性测试、按端点限额、可配置 CORS 来源

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite + Tailwind CSS 4 + Lucide Icons |
| 后端 | Python + FastAPI + SQLite + systemd/nginx 部署 |
| 数据源 | PubMed E-utilities + Semantic Scholar API |
| AI | 阿里云通义（支持同 key 多模型顺序回退）→ 智谱 GLM → DeepSeek（内置，无需配置）|

## v0.5.9 相比 v0.5 的主要变化

- 研究画像页从旧表单升级为新的分区式页面，新增 `method_interests` 和“系统观察摘要”
- 搜索链路在 `v0.5` 主题检索基础上，开始显式参考方法兴趣，但系统观察摘要已退出关键词生成，只保留在手动修正后的理解层
- 首页增加本地缓存恢复与当前批次补解读机制
- 收藏 / 笔记 / AI 对话相关接口的用户归属校验更严格
- 收藏页调整为更紧凑的行列表，增加“有笔记”筛选，移动端删除入口可见
- 新增按端点拆分的 AI 限速与全局熔断
- 设置页新增 Markdown 笔记导出
- 设置页移动端兼容性增强，设备 ID 读取失败不再导致整页空白
- `/api/settings/test` 改为仅 owner 设备可调用，生产环境可通过 `ALLOWED_ORIGINS` 收紧跨域
- 新增面向阿里云 ECS 的部署脚本与服务配置
- 新增 SQLite 日备份脚本与 `systemd timer`，默认每天自动备份并保留 14 天
- 修复首页详情页与收藏详情之间的对话/总结同步问题，首页先聊再收藏也能完整继承历史记录
- 支持通过 `QWEN_FALLBACK_MODELS` 为同一个阿里云 API Key 配置多模型顺序回退，并在后端日志里显示实际命中的模型
- 修复收藏详情里长笔记编辑区过矮的问题，移动端也能直接看到编辑 / 删除按钮
- 修复 Semantic Scholar 时间窗失真问题，并放宽 PubMed 长查询，提升近一个月检索的稳定性
- 首页、收藏页、研究画像页的空状态与标题层级进一步统一，去掉“本周论文”等旧周报遗留文案

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

如果本机访问 `127.0.0.1:8000` 出现 `502 Bad Gateway`，通常是 shell 里配置了全局代理。请确认 `NO_PROXY` / `no_proxy` 包含：

```bash
localhost,127.0.0.1,::1
```

### 构建前端

```bash
cd web
npm install
npm run build
```

打开 http://localhost:8000 即可使用。

> 前端已构建到后端 `dist/` 目录，由 FastAPI 统一提供服务，无需单独启动前端开发服务器。

开发调试时也可以分别启动：

```bash
cd papermind/papermind
.venv_new/bin/python -m uvicorn api:app --host 127.0.0.1 --port 8000

cd web
npm install
npm run dev
```

此时 Vite 会把 `/api` 代理到本机 `8000` 端口。

## 部署（ECS）

仓库内已提供一套面向 Ubuntu 22.04 + ECS 的最小部署文件：

- `deploy/setup.sh`：首次部署
- `deploy/update.sh`：后续更新
- `deploy/papermind.service`：systemd 服务
- `deploy/papermind-backup.service`：数据库备份任务
- `deploy/papermind-backup.timer`：数据库日备份定时器
- `deploy/backup.sh`：SQLite 备份脚本
- `deploy/nginx-papermind.conf`：nginx 站点配置

首次部署示例：

```bash
sudo bash /opt/papermind/deploy/setup.sh
sudo nano /opt/papermind/papermind/.env
sudo systemctl restart papermind
journalctl -u papermind -f
```

常用线上命令：

```bash
sudo systemctl start papermind-backup
ls -lh /opt/papermind/backups
systemctl status papermind-backup.timer
```

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
