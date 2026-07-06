# PaperMind 精读功能总结

> 版本基线：v0.11.2（2026-07-06）
> 用途：功能现状的单页总览，供产品重构讨论和 UI 设计参考。随版本迭代更新。

---

## 一、产品定位

PaperMind v1.0 的重心已从「每天帮你发现论文」翻转为「**帮你读懂手上这一篇，并把读懂的东西沉淀成可复用的产物**」。精读闭环是唯一主线：

```
拿到一篇论文 → 带着读懂 → 边读边沉淀（卡片/笔记）→ 导出成产物（报告/PPT/Obsidian）
```

发现流（每日推荐、画像检索、配额）已冻结，不再迭代。

---

## 二、三个精读入口

| 入口 | 路径 | 说明 |
|---|---|---|
| **Zotero 一键精读** | Zotero 里右键文献 →「用 PaperMind 精读」 | 插件自动发送元数据 + 本地 PDF 附件，浏览器直接打开阅读页（`?uid=` 自动认领身份）。首次使用需在插件设置里填 PaperMind 地址和设备 uid（只填 `uid=` 后面那 36 位） |
| **本地 PDF 直传** | 首页「精读工作台」/ 阅读页空状态按钮 | 没有元数据也能用文件名创建条目、上传 PDF 开读；用户上传的 PDF 永远优先于自动找到的开放获取版本 |
| **检索进入** | 首页工作台输入 PMID / DOI / 标题 | 走 PubMed 查询（Semantic Scholar 通道基本不可用，重构中计划移除） |

进入后统一路由 `/paper/{id}`（收藏库论文带 `?library=1` 标记）。

---

## 三、阅读页（三栏布局）

```
┌──────────┬──────────────────────┬────────────────────┐
│ 左栏      │ 中栏                  │ 右栏                │
│ 元数据     │ PDF 阅读器            │ 精读工作台 + 沉淀区   │
│ 收藏/引用  │ 翻页/缩放/划词         │ 卡片/追问/笔记/对话   │
└──────────┴──────────────────────┴────────────────────┘
```
移动端（<1024px）退化为单栏 + PDF/元信息/精读三个 tab。

### 中栏：PDF 阅读器（pdfjs 自研封装）

- 整篇顺序渲染、翻页、缩放（默认 140%），当前页自动同步
- 透明文字层支持划选（v0.11.1 修复了缩放下选区错位）
- **划词浮窗**：在 PDF 正文划选 ≥8 个字符的文字，松开鼠标弹出三个按钮：
  - `问 papermind` —— 把选中句子带进对话作为追问引用
  - `精读这段` —— 对选中英文做句子拆解（见工作台）
  - `存为卡片` —— 选中文字自动成为卡片的原文锚点（含页码）
- 限制：扫描件没有文字层，划词和按页带读均不可用（OCR 在远期清单）

### 右栏：精读工作台（v0.11.0，核心能力）

三种带读模式，由 `/api/deep-read/guide` 生成，prompt 面向"英文阅读吃力也要读懂方法学"的用户，并注入研究者画像（会做"这和你的 MR 研究的关系是……"式迁移）：

| 模式 | 回答的问题 | 典型输出 |
|---|---|---|
| **路线图** | 整篇怎么读 | 各章节读法优先级、重点预警 |
| **摘要带读** | 先抓什么 | 研究问题/方法/结果 + 进正文前该带着的问题 |
| **当前页陪读** | 这页在讲什么 | 页面在全文的位置 → 逐段带读 → 英文长句拆解 → 术语/变量/数字 → 暂停自测 → 下一步读法 |

- 划词「精读这段」= 针对选中句子的定向拆解
- 带读结果可一键**保存为笔记**（来源标记 `deep_read`）

### 右栏：沉淀区

**阅读卡片**（四类型，类型即精读方法论）：
- 方法卡（这研究怎么做的）/ 发现卡（结果是什么）/ 批判卡（哪里站不住）/ 迁移卡（我能怎么用）
- 三条入卡路径：划词「存为卡片」、对话「归卡」、手动「+ 新卡片」
- AI 按类型起草、用户编辑定稿；卡片带原文锚点可跳回原页
- 保存卡片时未收藏的论文自动收藏

**我的笔记**（v0.11.2 重做）：
- 列出该论文全部已保存笔记：来源标签（精读带读 / 对话总结 / 手写）+ 日期 + 展开/收起 + 删除
- 有带读或总结笔记时默认展开，标题带数量角标
- 下方是自由笔记框（自动保存，单条更新）

**对话式阅读**：
- 底部常驻对话，支持划词引用追问、语音输入
- 对话可一键总结为结构化笔记（来源 `chat_summary`）
- 接记忆系统：AI 知道你的研究背景与历史讨论

---

## 四、支撑系统

- **模型路由**：对话/带读/卡片起草走 qwen3.7-plus（内置链首选），翻译走 qwen-mt 系，批量摘要走 flash；设置页可配自定义 API（OpenRouter 等，配置后排链首、失败回退内置）
- **记忆系统**：memory_core / memory_recent，卡片和对话行为都是画像信号；记忆只影响解读质量，不参与检索
- **收藏与项目**：论文可归入项目夹；卡片/笔记/对话都挂在收藏条目上
- **身份**：无账号体系，设备 uid（UUID）+ 专属链接跨设备

## 五、导出（现状 vs 待做）

| 能力 | 状态 |
|---|---|
| 单篇 RIS / BibTeX 引用 | ✅ 阅读页左栏 |
| 全部笔记 Markdown 打包 | ✅ 设置页 |
| **单篇精读报告 MD**（笔记+卡片+带读整合） | ⏳ 已规划待做 |
| **单篇白底黑字 Marp PPT** | ⏳ 已规划待做 |
| Obsidian 一卡一文件（wiki links） | ⏳ v1.0 阶段 3 |

## 六、实现映射（怎么实现的）

| 功能 | 前端 | 后端 |
|---|---|---|
| PDF 渲染/文字层/划词 | `web/src/components/PdfViewer.jsx`（pdfjs-dist 5.x 自研封装，onSelection 回调视口坐标） | `/api/pdf-url`（OA 查找+代理）、`/api/pdf-proxy`、`/api/library/{id}/pdf`（上传/读取） |
| 阅读页三栏 | `web/src/pages/PaperRead.jsx`（约 1600 行：左 RailContent / 右 MemoryChannel） | `/api/library/{id}`（论文+对话+笔记一次取回） |
| 精读工作台三模式 | PaperRead 内 `runDeepRead(mode, text, page)`，当前页文本来自 pdfjs `getTextContent` | `/api/deep-read/guide`（按模式拼陪读 prompt + 研究者画像，task=chat 走 qwen3.7-plus） |
| 划词浮窗三按钮 | PaperRead `selection` state + fixed 定位浮窗 | 问→`/api/chat`；精读这段→`/api/deep-read/guide`(selection)；存卡→`/api/cards` |
| 阅读卡片 | `web/src/components/CardDrawer.jsx` | `/api/cards` CRUD + `/api/cards/draft`（AI 起草，不落库） |
| 笔记 | PaperRead `savedNotes`/`SavedNoteItem`（v0.11.2） | `/api/notes`（带 note_id 为更新，否则插入；来源 manual/deep_read/chat_summary） |
| 对话与总结 | PaperRead 底部 chat + `handleSummarizeChat` | `/api/chat`（注入记忆）、`/api/chat/summarize`（落 chat_summary 笔记） |
| Zotero 插件 | `zotero-plugin/bootstrap.js`（右键菜单→save→传PDF→launchURL） | 复用 `/api/library/save` + `/api/library/{id}/pdf`，零新增接口 |
| 模型路由 | — | `papermind/llm_router.py`（自定义槽→qwen3.7-plus→flash 回退链；任务级模型表） |
| 记忆/画像 | — | `papermind/memory_service.py` + `/api/profile*`（memory_core/recent） |

数据表（SQLite `paperdiary.db`）：`saved_papers`（收藏主表，rowid 即论文 id）、`paper_notes`、`reading_cards`、`paper_chats`、`user_profiles`、`reading_history`、`projects`。

## 七、已知限制与近期清单

1. 扫描件 PDF 无文字层 → 划词/按页带读不可用（远期：OCR）
2. 划词浮窗触发条件隐蔽（正文划选 ≥8 字符），新用户不知道 → 需首次引导
3. 章节识别和全文阅读进度未做，「当前页陪读」依赖文字层质量
4. 删除收藏论文时对应 PDF 文件不会清理（孤儿文件）
5. Zotero 插件 uid 输入不认整条链接，需只贴 UUID → 待做自动识别
6. `/paper/{id}` 双重身份（推荐序号 vs 收藏 rowid）靠 `?library=1` 补丁区分 → 重构第二批统一
7. 全站重构三批节奏：①砍发现流残留（Onboarding/S2/配额 UI）②路由身份统一 + 收藏库变精读书架 ③导出补全 + 交互引导
