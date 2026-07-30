# PaperMind · 给协作 agent 的约定

本仓库由多个 AI agent（Claude Code / Codex）和作者共同维护。以下是**反复被改错、必须守住**的不变量。改动前请先读，动完请跑 `cd web && npm test`。

---

## 不变量 1：划词工具条的操作不得被 OCR 阻断 ⛔

**位置**：`web/src/pages/PaperRead.jsx` — 划词浮窗（`aria-label="选中文字操作"`）与四个 handler
（`askAboutSelection` / `deepReadSelection` / `saveSelectionAsCard` / `sendSelectionToBoard`）

**规则**：
- 四个按钮**永远不加 `disabled`**
- 四个 handler **不得**因 `selection.needsOcr` 或 `selectionOcrPending` 提前 `return`
- OCR 的每条失败路径（无选区图 / `!data.ok` / `.catch`）**必须**把 `needsOcr` 置回 `false`
- OCR 结果回写**按 `ocrRequestId` 匹配**，不得用 `current === nextSelection` 这类对象身份比较

**为什么**（这个坑已经踩回去两次，第三次请忍住）：

OCR 只是「把可能乱码的文字层换成更准的版本」的**增强**步骤。它会失败、会超时、
会因为模型不支持图片而返回 400。PDF 文字层的原文**始终存在且可用**。

一旦让操作依赖 OCR，用户会遇到：转圈 →「识别中」→ 停 → 四个按钮点了**全无反应**，
而且没有任何出口——因为失败路径不清 `needsOcr`，selection 永远停在「待识别」。
用对象身份比较回写时更糟：识别其实成功了，但结果被静默丢弃，界面看着完全正常却点不动。

**如果确实想限制不可靠的文字**：请在**沉淀结果**上做标注（例如卡片里标「文字可能有误」），
让用户自己判断；**不要锁死入口**——用户完全不知道为什么点不动。

**护栏**：`web/src/pages/selectionActions.guard.test.js`。违反会直接测试失败并打印原因。

---

## 不变量 2：视觉模型白名单按实测结果维护

**位置**：`papermind/llm_router.py` — `_VISION_MODEL_MARKERS` / `_VISION_MODEL_DENYLIST` / `_supports_vision()`

`"qwen3.7"` 是**子串匹配**，会把 `qwen3.7-max` 一起放行。但实测该别名**不接受 image_url**
（`400 InternalError.Algo.InvalidParameter`），而带日期的 `qwen3.7-max-2026-*` 快照反而支持。

新增模型进 OCR 池前，**先真调一次 API 确认它接受 `image_url`**，不要凭名字推断。

---

## 通用约定

- **文案**：陈述式、去人称、无 emoji。「说人话 ≠ 说浅话」——类比只是台阶，落点要回到具体数字。
- **隐藏而非删除**：砍功能用条件渲染 + 旗标（如 `SHOW_LEGACY_FEED`、`SHOW_PREFERENCES`）保留代码。
- **改完必须更新文档**（作者定的硬规矩，容易漏）：
  - `CHANGELOG.md` —— 每个实质改动都要有条目，写清**症状 / 根因 / 修法**，不要只写「修复了 X」
  - `DECISIONS.md` —— 只在**做了取舍**时写：为什么选 A 不选 B、踩过什么坑。不是每次都写
  - `README.md` —— 改动影响到用户看得见的功能或版本号时更新
  - 一次改动分多个提交时，**最后一个提交要把文档补齐**，别整批漏掉
- **验证**：`cd web && npm test && npm run build`；后端改动跑一次真实接口，别只看语法。
