# PaperMind

一个有记忆的学术文献助手。自动追踪领域前沿论文，AI 生成个性化解读，支持对话式深度阅读和笔记沉淀。

## 项目信息

- **项目名称**: PaperMind
- **启动时间**: 2026 年 3 月 25 日
- **当前版本**: v0.14.0
- **独立开发**: 雀雀（主导设计、需求定义、产品决策、测试与迭代）
- **开发方式**: 使用 AI 编程工具（Claude）辅助代码实现

> 本项目由雀雀主导设计、需求定义、测试与迭代，开发过程中使用 AI 编程工具辅助实现。所有产品决策、功能规划、视觉风格和交互设计均由作者独立完成。

## 核心功能

- **首页精读工作台**（桌面 W2 单栏）: 一进来就是「放入一篇论文开始精读」＋「继续上次精读」＋「最近的精读工程」，把入口对准精读闭环而非发现流；每个工程带在读/读过状态、卡片/笔记/对话计数与「已导出」标记（推荐流以旗标保留，移动端仍为推荐首页）
- **智能文献追踪**: 从 PubMed、Semantic Scholar 自动获取领域最新论文
- **个性化推荐**: 基于研究画像生成检索词，结合方法兴趣动态打分；系统观察摘要只在手动修正后参与理解层，不主导搜索召回
- **排除不感兴趣的方向**: 画像中设置排除领域，搜索和评分双重屏蔽
- **三栏精读阅读页**: 左栏论文元数据 / 中栏 PDF 阅读器（翻页、缩放、划词）/ 右栏精读工作台与沉淀区
- **精读工作台**: 路线图（整篇怎么读）/ 摘要带读 / 当前页陪读三种模式；PDF 划词可对英文长句做「精读这段」拆解，结果可保存为笔记（功能与实现总览见 `docs/deep-reading-overview.md`）
- **阅读卡片**: 精读时把读懂的内容沉淀为方法/发现/批判/迁移四类结构化卡片，支持划词入卡、对话归卡、AI 起草，卡片带原文页码锚点可跳转
- **本地 PDF 精读**: 无免费全文时可直接上传手头的 PDF，重进页面自动加载
- **Zotero 一键精读**: 安装 `zotero-plugin/papermind-connector.xpi` 后，在 Zotero 里右键文献 →「用 PaperMind 精读」，元数据和 PDF 自动进入阅读页
- **对话式阅读**: 和 AI 深度讨论论文，提问方法学、核心发现、研究启发
- **对话记忆**: 聊天记录自动保存，收藏后永久留存
- **研究笔记**: 边读边记，AI 对话可一键保存为笔记
- **笔记导出**: 支持将全部笔记导出为 Markdown，便于沉淀到 Obsidian / Notion / 本地文件
- **标题 & 摘要翻译**: 点击即译，原文/中文随时切换（首页、阅读页、收藏页均支持）
- **书架**（原收藏页）: 精读工程列表 + 标题搜索 + `全部/在读/读过/有导出` 筛选；每个工程点进真精读台
- **精读画像**（只读副产品）: 书架顶部深色卡，展示主题分布与方法/发现/批判/迁移四类卡片构成，**完全由精读行为聚合，无需填写**（旧的主动填写偏好入口已隐藏，代码保留）
- **精读台右栏**: 沉淀（卡片流）+ 出口（组会汇报板 / 导出 PPT）常驻；对话、带读、收藏、自由笔记按需唤出，不占据主轨
- **苏格拉底自测**: 读完让 papermind 考考你——围绕五个核心问题（研究问题 / 方法—问题匹配 / 结果有多强 / 哪里站不住 / 外推边界）一次一问、三问收口。出题混合「已有卡片 + 划了没做卡的段落 + 完全没碰的板块」，刻意往盲区问；判定分「站住了 / 部分对 / 还不对」三档且**每条反馈都带可点回原文的锚点**（后端逐字校验，编造的锚点会被剥掉）。答不上来可「不确定·转到对话」带上下文过去、再返回作答；暴露的概念累积成「方法学盲区」
- **文献导出**: 一键导出 RIS/BibTeX，直接导入 Zotero/EndNote/Mendeley
- **PDF 获取**: 自动查找开放获取全文
- **跨设备访问**: 新设备默认独立；主动打开设置页生成的专属链接后才同步同一份数据
- **手动添加论文**: 输入 PMID / DOI / 标题关键词搜索并收藏任意论文，自动触发 AI 解读
- **设备隔离**: 无需个人账号，书架、PDF、笔记、对话、卡片、汇报板和自测按匿名设备 ID 隔离
- **测试期安全兜底**: Owner 专属连通性测试、按端点限额、可配置 CORS 来源

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite + Tailwind CSS 4 + Lucide Icons |
| 后端 | Python + FastAPI + SQLite + systemd/nginx 部署 |
| 数据源 | PubMed E-utilities + Semantic Scholar API |
| AI | 主持人可配置自定义 API（OpenRouter / DeepSeek / 智谱 / 通义 / Kimi / 硅基流动 / OpenAI 兼容接口）→ 内置：阿里云通义（同 key 多模型顺序回退）→ 智谱 GLM → DeepSeek |

## v0.5.9 相比 v0.5 的主要变化

- 研究画像页从旧表单升级为新的分区式页面，新增 `method_interests` 和“系统观察摘要”
- 搜索链路在 `v0.5` 主题检索基础上，开始显式参考方法兴趣，但系统观察摘要已退出关键词生成，只保留在手动修正后的理解层
- 首页增加本地缓存恢复与当前批次补解读机制
- 收藏 / 笔记 / AI 对话相关接口的用户归属校验更严格
- 收藏页调整为更紧凑的行列表，增加“有笔记”筛选，移动端删除入口可见
- 新增按端点拆分的 AI 限速与全局熔断
- 设置页新增 Markdown 笔记导出
- 设置页新增"切换账号"同步码入口，支持跨设备数据迁移
- UID 持久化升级为 localStorage + cookie 双写，手机刷新不再丢失设备身份
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

## 数据与备份（本地运行）

所有用户数据都在本地文件里，请纳入备份习惯：

| 内容 | 位置 |
|---|---|
| 主数据库（收藏/笔记/对话/卡片） | `papermind/data/paperdiary.db` |
| 上传的 PDF | `papermind/data/pdfs/` |
| 汇报板中的图表截图 | `papermind/data/figures/` |
| 用户级 LLM 配置 | `papermind/data/config.json` |

备份与恢复：

```bash
# 备份数据库（后端运行中也可安全执行）
bash scripts/backup_local.sh

# 同时打包上传的 PDF 和图表截图
bash scripts/backup_local.sh --with-files

# 可选：直接备份到移动硬盘或受控云盘目录
BACKUP_DIR="/Volumes/你的备份盘/PaperMind" bash scripts/backup_local.sh --with-files

# 恢复：停止后端后，解压 backups/ 里的 .db.gz 覆盖 papermind/data/paperdiary.db
```

产物默认在 `backups/` 目录（已 gitignore），保留 30 天，可用 `RETENTION_DAYS` 调整。`config.json` 可能包含 API Key，不会进入未加密文件包；迁移时应单独、安全地重新配置密钥。

## 小范围试用

给同事/同学开放试用前，请阅读 [docs/trial-guide.md](docs/trial-guide.md)——包含试用者使用须知、隐私说明（数据存储位置、内容会发送至第三方 LLM API）、主持人准备清单和反馈收集模板。

当前产品验证采用“中文核心闭环优先”路线。先按 [中文文献精读验收方案](docs/chinese-reading-validation.md) 验证研究逻辑、证据忠实、原文回溯和沉淀价值；通过后再增加英文术语、长句拆解和翻译辅助。

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
