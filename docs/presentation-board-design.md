# 组会汇报板（Presentation Board）设计

> 2026-07-06 · 已与作者对齐（含 Codex 评审意见的取舍）· 对应实现 v0.12.0

## 一句话

把组会 PPT 从"读完之后的导出产物"倒转为"读之前就存在的容器"：打开论文即有汇报骨架，边读边把划词、带读、卡片投递进对应板块，PPT 完成度即精读完成度。

## 产品叙事（采纳 Codex 的三层框架）

- **Read**：路线图 / 摘要 / 当前页陪读 / 划词拆句（已有）
- **Think**：卡片四分类（已有）+ 苏格拉底「考我一下」（二期）
- **Present**：汇报板（本期）——每次读懂都落到明确的位置上

## 与 Codex 方案的三处取舍

1. 板块数：默认 8（首页+7 内容板块）而非 14——组会常规粒度；板块可增删改名，方法学深挖自己加
2. MVP 含最简 Marp 导出——没有导出的汇报板在组会前一天等于零；pptx 精排后置
3. "目标导向"轻量吸收——首页板块带"为什么读这篇"一行（默认取推荐理由，可改），不做读前选择流程

## 默认板块（stable key 存储，中文名仅展示层）

| key | 默认名 |
|---|---|
| （首页由元数据自动生成，非板块行） | 标题/作者/期刊/年份/DOI/为什么读这篇 |
| background | 研究背景 |
| question | 研究问题 |
| methods | 方法 |
| results | 关键结果 |
| critique | 批判与局限 |
| implications | 对我的启发 |
| discussion | 讨论问题 |

## 数据层（SQLite，沿用 paper_quotes 模式）

```sql
presentation_boards(id, paper_rowid UNIQUE, sections_json, why_reading, created_at, updated_at)
board_items(id, paper_rowid, section, content, quote DEFAULT '', page, source DEFAULT 'selection',
            sort_order DEFAULT 0, created_at, updated_at)
```

- GET board 时惰性建板（get_or_create），收藏过的论文天然有板
- `source ∈ selection / deep_read / card / chat / manual`
- 删除论文级联删板与条目（挂进 delete_saved_paper）

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/board/{paper_rowid} | 板块结构 + why_reading + 全部条目（owner 校验） |
| PATCH | /api/board/{paper_rowid} | 改板块结构 / why_reading |
| POST | /api/board/{paper_rowid}/items | 投递条目 {section, content, quote, page, source} |
| PATCH | /api/board/items/{item_id} | 编辑内容 / 改投板块 / 排序 |
| DELETE | /api/board/items/{item_id} | 删除条目 |
| GET | /api/board/{paper_rowid}/export/marp | Marp Markdown 下载（白底黑字极简主题） |

Marp 导出：首页从论文元数据生成；空板块也出页并标"（待填入）"——骨架可见即进度可见；条目带页码与原文引用（blockquote）。

## 交互（全部在阅读页内）

1. **划词浮窗**加第 4 个按钮「送到汇报」→ 板块选单 → 落板块（自动带 quote + 页码）
2. **带读结果**（精读工作台）操作区加「送到汇报」
3. **卡片**加「入汇报」，默认映射：方法卡→methods、发现卡→results、批判卡→critique、迁移卡→implications（可改投）
4. **AI 回复**的操作行（归卡旁）加「送到汇报」
5. **右栏新增「汇报板」区块**：8 板块名 + 条目数，空板块灰显（阅读进度条的本质）；「打开汇报板」弹出抽屉（新组件 `BoardDrawer.jsx`）做整理/编辑/删除/导出

## 影响文件

- `papermind/src/database.py`：两张新表 + CRUD + 级联删除
- `papermind/api.py`：6 个接口
- `web/src/components/BoardDrawer.jsx`：新组件（板块全览抽屉 + 板块选单）
- `web/src/pages/PaperRead.jsx`：浮窗按钮、带读/对话操作、右栏区块、board 状态
- `web/src/components/CardDrawer.jsx`：卡片「入汇报」

## 风险与对策

- PaperRead 膨胀 → 新逻辑全部隔离进 BoardDrawer.jsx（含板块选单组件）
- sections_json 后期迁移 → 首版即用稳定英文 key，中文名只在展示层
- 与 Codex 并行开发冲突 → 动工前已合并其 quote anchors / workspace 重构

## 二期（已对齐，不在本期）

- 苏格拉底「考我一下」：AI 提问 → 用户作答 → 差距反馈 → 好答案一键入板/入卡
- 组会排练模式：对着填好的板子模拟老师提问
- 章节识别、pptx 精排导出、多篇横向对比
