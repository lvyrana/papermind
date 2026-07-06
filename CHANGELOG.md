# Changelog

## v0.11.4 - 2026-07-06

### 结构化 quote anchor + PDF 持久高亮

- 新增 `paper_quotes` 表：保存划词文本、页码、章节占位、anchor 矩形、追问、回答、来源和时间；删除收藏时同步清理 quote
- 新增 quote API：
  - `GET /api/quotes/{paper_rowid}`：拉取某篇论文的结构化引用
  - `POST /api/quotes`：保存一条引用/标记
  - `DELETE /api/quotes/{quote_id}`：删除引用
- `/api/chat` 支持单独接收 `quote` 对象；用户带引用追问时，后端会把 quote、问题和 AI 回答一起结构化落库
- `PdfViewer` 新增 quote highlight layer：划词时生成页面相对矩形 anchor，刷新后可按 anchor 重画淡 coral 高亮；点击右栏 quote 卡会跳回对应页并闪一下
- 阅读页右栏改为从后端 quote 表恢复「引用与追问」，同时保留旧本地 `_quote` 聊天的兼容去重
- 「精读这段」和「存为卡片」也会保存 quote anchor，让这些阅读动作在 PDF 上留下可恢复痕迹

#### 验证

- `POST /api/quotes` 烟测写入 paper 51 成功，并用 `DELETE /api/quotes/{id}` 清理；随后 `GET /api/quotes/51` 返回空列表
- `env PYTHONPYCACHEPREFIX=/Users/loujiahui/Desktop/papermind/.pycache-check /Users/loujiahui/Desktop/papermind/papermind/.venv_new/bin/python -m py_compile papermind/api.py papermind/src/database.py` 通过
- `npm run build` 通过；仍有既有的 `pdfjs-dist` `renderTextLayer` 构建 warning，未阻断构建
- `npm run lint` 仍失败于既有问题：`Terrain.jsx` fast-refresh 规则错误，以及 `Home.jsx` 两条 unused eslint-disable warning；本次修改过的 `PdfViewer.jsx` / `PaperRead.jsx` 不再报错

---

## v0.11.3 - 2026-07-06

### 图表追问上下文 + 精读右栏减负

- 对话请求现在会携带当前 PDF 页码和当前页 text layer 文本；用户问 “Fig 3 / Figure / 图 / 表” 时，后端会优先用当前页文字、图注和周围段落解释，而不是直接说“看不见图”
- 右栏移除空状态的「你在这篇里追问过」虚线占位：只有真正发出带 quote 的追问后，才展示 quote 卡片归档
- 移除「这篇会让画像往这里走」预览；这块没有真实后端画像更新闭环，放在精读页会显得没头没尾
- 移除右栏「标题翻译 · 摘要」折叠区；标题已在左侧元信息中展示，摘要改为左侧元信息栏里的低干扰 `Abstract` 折叠区
- 保持划词浮窗作为选区后的主入口：问 paperMind / 精读这段 / 存为卡片，后续若要做更像专业阅读器的高亮，需要单独实现 quote anchor 和自定义 highlight overlay

### PDF 阅读器布局微调

- PDF canvas 渲染按设备像素比提高清晰度，同时限制单页最大绘制像素，避免 Retina 屏上文字发糊但不让大 PDF 过度吃内存
- 左侧论文信息栏支持桌面端收起/展开，状态写入本地偏好；控制按钮从顶栏移入 PDF 工具栏，放在上一页箭头和页码前，更接近 Zotero/专业阅读器的布局习惯
- 右侧精读工作台支持手动拖拽调整宽度，并记住上次宽度；保留键盘方向键微调，移动端仍沿用原来的 PDF / 元信息 / 精读 tab

#### 验证

- `env PYTHONPYCACHEPREFIX=/Users/loujiahui/Desktop/papermind/.pycache-check /Users/loujiahui/Desktop/papermind/papermind/.venv_new/bin/python -m py_compile papermind/api.py` 通过
- `npm run build` 通过；仍有既有的 `pdfjs-dist` `renderTextLayer` 构建 warning，未阻断构建
- `npm run lint` 仍被既有规则债阻断：`PdfViewer.jsx` effect 同步 setState、`Terrain.jsx` fast-refresh export、`PaperRead.jsx` 旧 quote/project picker 未使用变量；本次布局微调未新增 lint 类别

---

## v0.11.2 - 2026-07-05

### 阅读页笔记浮出——已保存的笔记终于看得见了

- 右栏「我的笔记」原来只是自由笔记输入框，带读/对话总结保存的笔记（`paper_notes` 多行）在阅读页**没有任何展示入口**，用户保存后找不到
- 现在列出全部已保存笔记：来源标签（精读带读/对话总结/手写）+ 日期 + 长内容展开/收起 + 删除；有带读或总结笔记时默认展开，标题带数量角标；保存带读/总结后即时刷新列表
- 修复自由笔记两个数据 bug：
  - 自动保存不带 `note_id`，后端每次 INSERT 新行——编辑几次就积一堆重复笔记
  - 恢复时误取「任意来源的最新一条」，保存带读笔记后再进页面，带读内容会灌进自由笔记框；现在只认 `source=manual` 的最新一条
- 坑位记录：`note_id` 为空时必须整个省略字段——pydantic 的 `int = None` 字段收到显式 `null` 会 422

#### 验证

- Playwright E2E（临时 uid，测后清理）：种 deep_read + chat_summary 两条笔记 → 打开阅读页，「我的笔记 2」默认展开、两条均可见、长文展开正常；自由笔记连续编辑两轮后数据库仅 1 条 manual 记录且为最新内容（截图）
- `npm run build` 通过

---

## v0.11.1 - 2026-07-05

### PDF 划词修复 + 内置模型升级 qwen3.7-plus

#### 划词选区错位修复

- pdfjs 5.x 的文字层定位依赖容器上的 `--scale-factor` CSS 变量，`PdfViewer.jsx` 自建 textLayer 时从未设置，导致画布按实际缩放渲染、文字层按 1 倍铺——选区错位且越往页面下方偏得越多；渲染每页时补设该变量
- 文字层渲染改用 pdfjs 5.x 的 `TextLayer` 类（旧 `renderTextLayer` 已废弃，只留 4.x 兼容分支）

#### 划词浮窗翻页后消失修复

- 浮窗坐标原本加了 `scrollTop`（滚动内容坐标系），但浮窗渲染在外层不滚动的容器里，PDF 翻页后浮窗被定位到屏幕外，表现为"只有第一次划词有浮窗"
- 改为视口坐标 + `position: fixed`；PDF 滚动时主动收起浮窗，避免悬停在错误位置

#### 内置模型升级

- `.env`：`QWEN_MODEL` / `LLM_TASK_CHAT_MODELS` 首选从 qwen3.5-flash 升为 qwen3.7-plus（阅读页对话、精读带读、卡片起草全部受益），flash 系降为回退链；已用最小请求验证 dashscope 接受该模型名

#### 验证

- Playwright E2E（临时 uid 种数据，测完删除）：14 页 PDF，第 1 页与第 2 页划词浮窗均出现且在视口内（第 2 页为修复前的必现故障场景）；`--scale-factor` 已设置；选区高亮与文字紧贴（截图）
- `npm run build` 通过；uvicorn 已用 `.venv_new` 重启（此前进程用的系统 Python + Rosetta，arm64 下无法复现启动，`.venv_new` 才是可复现的启动方式）

#### 已知问题（待修）

- `DELETE /api/library/{id}` 不删除对应的 `data/pdfs/{id}.pdf`，会留孤儿文件

---

## v0.11.0 - 2026-07-05

### 直接精读入口 + 精读工作台

这一版把 PaperMind 的默认入口从“先画像 → 再推荐 → 再点进论文”调整为“先打开手头这一篇，推荐放到后面”。同时把右侧的精读能力从简单 AI 起草，推进到更接近陪读老师的工作台。

#### 首页入口

- Home 页移除无画像时自动跳转 `/onboarding` 的门槛，用户可以直接进入首页
- 首页新增「精读工作台」：支持输入 PMID / DOI / 标题检索论文后进入精读
- 首页新增本地 PDF 直传入口：没有元数据也能用文件名创建本地论文、上传 PDF、进入 `/paper/{id}?library=1`
- 推荐区降级为次要入口；画像改为影响推荐质量，而不是进入产品的前置条件

#### PDF 与阅读页稳定性

- 阅读页无免费全文时补上本地 PDF 上传按钮；上传成功后立即加载本地 PDF
- 已上传 PDF 重新进入时优先通过 `HEAD /api/library/{id}/pdf` 探测并加载，避免继续走开放获取查找
- 修复本地 PDF 已存在但中间阅读区仍持续转圈的问题
- 收藏库论文从首页工作台进入时使用 `?library=1` 标记，刷新后优先按收藏库论文加载，避免误判为推荐列表序号

#### 精读工作台

- 右侧从「精读带读」升级为「精读工作台」
- 新增三种带读模式：
  - 路线图：先判断整篇文章怎么读
  - 摘要：先抓研究问题、方法、结果和正文前问题
  - 当前页：按页面内容做位置判断、逐段带读、英文句子拆解、术语数字和自测
- PDF 划词浮窗新增「精读这段」：选中英文片段后直接做句子拆解
- 后端 `/api/deep-read/guide` 的 prompt 改为面向英文阅读吃力用户的陪读结构，而不是普通摘要
- 精读结果可保存为笔记

#### 验证

- `env PYTHONPYCACHEPREFIX=/Users/loujiahui/Desktop/papermind/.pycache-check /Users/loujiahui/Desktop/papermind/papermind/.venv_new/bin/python -m py_compile papermind/api.py` 通过
- `npm run build` 通过
- 本地 uvicorn 已重新启动并确认 `http://127.0.0.1:8000/` 返回最新版前端 bundle
- 仍存在既有的 `pdfjs-dist` `renderTextLayer` 构建警告，未阻断构建

---

## v0.10.1 - 2026-07-05

### Zotero 插件安装失败真正修复（update_url 必须是 https）

- v0.9.2 的结论只对了一半：Zotero 9 确实硬性要求 `applications.zotero` 提供 `id` / `update_url` / `strict_max_version` 三项（缺一即 manifest 无效，见其 `Extension.sys.mjs` 的 Zotero 补丁）；但 Gecko 内核同时要求 updateURL 必须以 `https:` 开头（`XPIDatabase.providesUpdatesSecurely`），否则插件被强制禁用（appDisabled），安装时统一弹"可能无法与该版本的 Zotero 兼容"——这句提示对所有安装失败都一样，极具误导性
- 修复：manifest 的 update_url 从 `http://127.0.0.1:8000/...` 改为 `https://127.0.0.1:8000/...`，重新打包 xpi。本地开发阶段更新检查会静默失败（本地后端无 TLS），无副作用；后端 `/api/zotero-plugin/update.json` 接口保留，未来上 https 后自动生效

#### 验证

- 一次性 Zotero profile（独立数据目录，不碰真实库）侧载 A/B/C 对照实验：
  - A `http://` update_url（v0.9.2 现状）→ 安装但 `appDisabled: true`
  - B 删除 update_url → manifest 判无效，xpi 启动时被 Zotero 直接删除
  - C `https://` update_url（本次修复）→ `active: true`，Zotero 日志出现 `Calling bootstrap method 'startup' for plugin papermind-connector`，插件真实运行

---

## v0.10.0 - 2026-07-04

### 自定义 AI 模型（自带 API Key）

内置免费通道（注册赠送三个月）到期前的退路：设置页可配置自己的 API，优先于内置链使用，失败自动回退。

#### 后端

- `src/config_store.py` 新增自定义 provider 存取（`data/config.json`，不进 git），key 打码展示
- `llm_router.py`：`_get_custom_slots()` 注入自定义通道，永远排在 fallback 链首（不参与按任务的模型重排）；自定义通道的 httpx client 不再固定 transport——内置链固定 transport 会绕过系统代理，OpenRouter 等国外服务必须走代理；`.venv_new` 补装 `socksio` 支持 socks 代理
- 新接口：
  - `GET /api/settings` 扩展返回自定义配置（打码）+ 当前生效通道
  - `POST /api/settings/custom-llm` 保存（api_key 传空 = 沿用已存）
  - `DELETE /api/settings/custom-llm` 清除回到纯内置
  - `POST /api/settings/custom-llm/models` 调 provider 的 `/models` 列出该账号真实可用的模型
  - `POST /api/settings/custom-llm/test` 最小对话请求验证连通性（返回延迟 + 回复）

#### 前端（Settings 页新卡片「自定义 AI 模型」）

- 服务商预设：OpenRouter / DeepSeek / 智谱 GLM / 阿里云通义 / Kimi / 硅基流动 / 自定义（任何 OpenAI 兼容接口）
- 「获取可选模型」从你的账号实时拉取模型列表，支持关键词筛选、点击即选——不用记模型名
- 「测试连接」显示延迟和模型回复；保存后 key 打码回显（留空沿用）；启用/停用开关；清除配置
- AI 服务卡片的「自定义 API 功能将在正式版开放」占位文案移除

#### 验证

- 单元验证：自定义 slot 排链首、清除后恢复、key 打码
- Playwright + 本地 mock OpenAI 兼容服务全链路：拉模型列表 → 测试连接 → 保存启用 → `/api/chat` 实际命中自定义通道 → 刷新打码回显 → 清除恢复内置，8 项全过
- `tests/test_backend_guards.py` 8 个测试无回归；lint 无新增错误、build 通过

---

## v0.9.2 - 2026-07-05

### Zotero 插件安装失败修复

- Zotero 9 的 manifest 校验（其源码 `parseManifest` 中的 Zotero 补丁）硬性要求 `applications.zotero.update_url` 存在，缺失时安装直接失败且只提示"可能不兼容"；插件 manifest 补上该字段
- 新增 `GET /api/zotero-plugin/update.json` 应答更新检查（返回无更新）
- `strict_max_version` 从 `10.0.*` 放宽到 `10.99.99`，与主流插件一致

## v0.9.1 - 2026-07-04

### Zotero 一键精读（v1.0 精读闭环 · 阶段 1.5）

在 Zotero 里选中文献 → 右键「用 PaperMind 精读」→ 浏览器自动打开 PaperMind 阅读页，元数据 + 本地 PDF 全部就位。

#### 新增：Zotero 插件（zotero-plugin/）

- `manifest.json` + `bootstrap.js`，兼容 Zotero 7–10（bootstrap 插件架构），打包产物 `papermind-connector.xpi`
- 文献右键菜单「用 PaperMind 精读」：读取选中条目元数据（标题/作者/期刊/DOI/extra 中的 PMID/摘要）+ 最佳 PDF 附件，调用 `/api/library/save` 和 `/api/library/{id}/pdf`，然后 `Zotero.launchURL` 打开 `/paper/{rowid}?uid=`
- Tools 菜单「PaperMind 连接设置…」：配置 PaperMind 地址与设备 uid（存 Zotero prefs，首次使用自动弹出）
- 选中附件时自动上溯父条目；无 PDF 附件时跳过上传（阅读页仍可走 OA 查找）

#### PaperRead 深链支持

- 冷打开 `/paper/{id}` 新增收藏库回退：推荐缓存 → last-reading → `GET /api/library/{id}`，命中后自动恢复「已收藏」状态与 savedRowId

#### `?uid=` 语义修正（切换账号 vs 深链）

- `?uid=` 改为在 api.js 模块加载时同步认领——原来在 App.jsx effect 里处理，子组件的数据请求先于它发出，深链会带着随机新身份查不到论文
- UidHandler 不再无条件跳回首页：同 uid 深链保留当前路径、不清缓存；不同 uid（切换账号）才清本地缓存
- 回归验证：切换账号（清缓存 + 参数消失）与同人深链（缓存保留 + 路径保留）两条路径均通过

#### 决策：放弃 Onboarding 的 Zotero Web API 批量导入

- Web API 批量导入只有元数据、无本地 PDF，与精读工作流错位；Onboarding 里的 Web API tab 目前是无后端的占位 UI，后续清理

#### 验证

- Playwright 全新浏览器上下文模拟插件行为链：save → PDF 上传 → 冷开 `/paper/{id}?uid=`，论文/PDF/已收藏/卡片区全部就位
- 卡片流程与 PDF 上传流程回归通过；`npm run lint` 无新增错误、build 通过

---

## v0.9.0 - 2026-07-04

### 阅读卡片系统（v1.0 精读闭环 · 阶段 1）

v1.0 方向确定为「从发现转向精读与沉淀」，本版本落地精读闭环的地基：结构化阅读卡片。

#### 新增：阅读卡片

- 新表 `reading_cards`：卡片类型（method 方法 / finding 发现 / critique 批判 / transfer 迁移）、标题、正文、原文引用锚点（quote + page）、来源（manual / quote / chat）
- 新接口：`POST/GET/PATCH/DELETE /api/cards`，全部带用户归属校验；删除论文时级联删除卡片
- 新接口：`POST /api/cards/draft` —— AI 起草卡片（不落库），按卡片类型注入方法学/发现/批判/迁移的定向提示词，结合用户研究画像
- 新组件 `web/src/components/CardDrawer.jsx`：右栏卡片区，含类型选择、AI 起草、编辑、删除、原文锚点跳页
- 三条入卡路径：
  1. 划词浮窗新增「存为卡片」按钮（与「问 papermind」并列），选中文字自动成为卡片的原文锚点
  2. AI 回复下方新增「归卡」，把一问一答沉淀为卡片（自动携带引用上下文）
  3. 右栏「+ 新卡片」手动创建
- 保存卡片时若论文未收藏，自动收藏（复用对话总结的 ensureSaved 模式）
- 创建卡片计入 memory_recent 行为信号（`increment_recent_events`）

#### 新增：本地 PDF 上传精读

- 阅读页无免费全文时，空状态新增「上传 PDF 精读」按钮，上传后立即进入 PDF 阅读
- 后端 `POST /api/library/{id}/pdf` 接口此前无前端入口，本次接通
- 新增 `HEAD /api/library/{id}/pdf` 路由（FastAPI 的 GET 不自动支持 HEAD），前端用它探测已上传的 PDF
- 重新进入阅读页时优先加载已上传的本地 PDF，其次才查开放获取全文

#### 验证

- `tests/test_backend_guards.py` 8 个测试全过，无回归
- `npm run lint` 无新增错误（PaperRead 3 个历史遗留错误未动），`npm run build` 通过
- Playwright 端到端验证：划词 → 存为卡片 → AI 起草 → 保存（带 P.1 锚点）；上传 PDF → 渲染 → 重进自动加载；跨用户访问卡片被拒绝

---

## v0.8.0 - 2026-05-21

### 全站视觉重构：研究地形 + 记忆优先

#### 新增组件
- `src/components/Terrain.jsx` — 共享研究地形图组件，支持 default / mini / hero 三种 variant，Profile / Home / Onboarding 三个页面共用
- `src/components/PdfViewer.jsx` — 基于 pdfjs-dist 的 PDF 阅读器，支持翻页、缩放、文本选中、划词浮窗

#### 新增依赖
- `pdfjs-dist@5.7.284` — PDF 渲染，不依赖 react-pdf，自行控制 worker 配置

#### Home 页重构（研究地形版）
- Hero 区：左侧 memory_recent + stats + 上次停在这里；右侧研究地形缩略图（点击跳 /profile）
- 论文卡片：reason banner 从底部抬到顶部 coral 眉条
- 论文网格从 2 列改为 3 列
- 新增「papermind 还在替你 hold 这些」线索区（lastReading 派生，后续接 /home/threads）

#### Profile 页重构（身份镜像版）
- 删掉右侧 4 个 tag 表单（已搬到 Settings）
- 顶部地形 hero + 时间游标（视觉 affordance，后续接 /profile/landscape?days_back=N）
- 左主栏：memory_core + memory_recent 抬升为「AI 在为你记着这些」
- 记忆来源溯源条（后续接 /profile/provenance）
- 长期画像手动编辑直接 POST /profile，不再依赖「保存」按钮
- 修复「4/12 添加」硬编码日期和「查看证据」空按钮

#### Settings 页增强
- 顶部新增「研究偏好」section：focus_areas / method_interests / exclude_areas / discipline / background / tracking_days
- 保存后写入 pm-auto-fetch flag，首页自动重新拉取推荐
- URL hash `#research-prefs` 锚点，供 Profile mobile 跳转

#### Onboarding 页重构（Zotero 导入版）
- 5 步流程：选择来源 → 导入 → 解析 → 地形浮现 → 确认方向 → 进入
- 支持 .bib / .ris / .json 客户端解析计数（无后端依赖）
- Fresh path（从零开始）跳过 import/parsing/reveal，直接进确认方向
- 「先逛逛」任意步骤可跳出（pm-skip-onboarding flag 不变）

#### PaperRead 页重构（三栏 + PDF Viewer）
- 三栏布局：左 TOC/元数据 / 中 PDF 阅读器 / 右记忆通道
- 划词浮窗：选中文字 → 浮出「问 papermind」→ 灌入右栏 chat
- 右栏：为什么推这篇（relevance hero）+ 你追问过的句子（quote 卡）+ 画像更新预告 + sticky chat foot
- 无 PDF 时自动降级为 AI 解读卡 + 上传 PDF 占位
- < 1024px 退化为单栏 + tab 切换

#### PDF 代理
- `/api/pdf-url` 现在返回代理地址（url）+ 原始直链（original_url）
- PdfViewer 错误状态下「在新标签打开」使用原始直链

#### 后端 bug 修复
- `cache["fetching"]` 卡死问题：新增 `fetching_since` 时间戳，超时 5 分钟自动解锁；`force_fetch=true` 可强制解锁

#### 样式 token
- `src/index.css @theme` 新增 `--color-coral-deep: #B56A5A` 和 `--color-mint-deep: #7BB89C`，修复全站 text-coral-deep / text-mint-deep 静默失效

#### 截图规范化
- docs/screenshots/ 历史截图从 v0.6.3 起按页面名重命名（desktop/tablet/mobile 设备类型 → home-page/library-page/profile-page 等）

---

## v0.7.0 - 2026-05-12

### 论文阅读页重构为默认双栏

- 桌面端进入任何论文详情页，直接以双栏布局呈现：左栏论文参照，右栏对话
- 左栏包含：导航 + 操作按钮（原文/PDF/引用）、分类标签、标题、"为什么和你相关"、中文解读、核心发现、摘要
- 右栏包含：论文标题 + 收藏按钮（桌面端）、收藏提示/项目选择、「和 AI 讨论」Tab（默认）/ 「我的想法」Tab
- 桌面端 `h-screen` 双栏固定高度，左右各自独立滚动；移动端上下堆叠，兼容不变
- 移除了「全文分栏」按钮（分栏已是默认状态，按钮失去意义）
- 对话 Tab 改为默认选中（原来默认是笔记），体现对话是主操作区的产品定位

### 收藏时直接选项目

- PaperRead 点击收藏按钮：若用户已建项目，弹出内联选择器，可直接收藏到指定项目或「直接收藏」
- 无需事后在收藏库手动归类，降低整理摩擦

### Bug 修复：自定义时间范围跳回「1 个月」

- Profile 页自定义月数输入框，清空内容时不再触发 `onChange`（原来会写入空字符串匹配到 30 天预设，导致跳回 1 个月选项）
- `onBlur` 时若无效则恢复上一次有效值

### fetch_papers.py 修复：正确提取 DOI 和 PMCID

- 原来只解析 `MedlineCitation`，未提取 `PubmedData/ArticleIdList` 中的 DOI 和 PMCID
- 修复后论文对象包含正确的 `doi` 和 `pmcid`，「PDF 获取」成功率大幅提升


---

## v0.6.10 - 2026-05-07

### 后端渐进式拆分

- 从 `api.py` 中拆出 `llm_router.py`，集中管理模型 provider、任务模型选择、fallback、冷却和同步/异步 LLM 调用
- 从 `api.py` 中拆出 `search_service.py`，集中管理检索词生成、query 清洗、PubMed / Semantic Scholar 抓取、低价值论文过滤、排除词硬过滤、打分排序和 search trace
- 从 `api.py` 中拆出 `memory_service.py`，集中管理 `memory_core` / `memory_recent` 的生成、更新、自动刷新和手动合并
- `api.py` 从 2600 多行降到约 1350 行，保留 HTTP 路由、用户缓存、后台线程入口和收藏/导出等接口逻辑

### 后端护栏测试

- 新增 `tests/test_backend_guards.py`，覆盖 LLM 无配置兜底、检索词锚点、排除词过滤、低价值论文过滤、推荐流程过滤链路和画像保存不覆盖后端记忆字段
- 推荐流程测试会模拟 PubMed 返回结果，确认去重、无摘要过滤和“不想看的内容”硬过滤在 service 层生效
- 代码层将 `ProfileData.dict()` 更新为 Pydantic v2 推荐的 `model_dump()`

## v0.6.9 - 2026-05-06

### 项目夹（任务型收藏夹）MVP

- 新增 `projects` 表，`saved_papers` 加 `project_id` 列（自动迁移，向后兼容）
- 后端新增 5 个接口：`GET/POST /api/projects`、`PATCH/DELETE /api/projects/{id}`、`PATCH /api/library/{id}/project`
- 前端 `api.js` 新增 `apiPatch` 工具函数
- 收藏页桌面侧边栏新增「项目」区块：支持新建项目（回车确认）、点击筛选、hover 删除
- 论文详情页（LibraryDetail）在作者信息下方新增项目归属选择器，实时保存

### 论文卡片充填优化

- 首页推荐卡片：网格固定行高 320px，摘要改为 `flex-1 overflow-hidden`——标题短时摘要自动显示更多行，标题长时摘要缩减，相关性始终固定间距贴底
- 收藏页桌面卡片：同样修复，固定行高 240px，摘要填充逻辑统一

### 论文标题颜色调深

- `pm-paper-title-en` / `pm-paper-title-zh` 颜色从 `#274A73` 调为 `#153D72`，饱和度提升、灰度降低，阅读感更厚重

---

## v0.6.8 - 2026-05-01

### 新手引导 Onboarding Wizard

- 新增独立路由 `/onboarding`，替换旧的内嵌式 OnboardingScreen
- Step 0：欢迎介绍屏（仅从 Home 跳转时显示，刷新直接进 Step 1）
- Steps 1–3：研究方向 → 方法偏好（芯片多选）→ 背景 + 检索范围
- 完成后自动触发首次论文检索（`pm-auto-fetch` sessionStorage 标记）
- “先逛逛，稍后再填” 跳过选项，防止首页无限重定向（`pm-skip-onboarding`）
- 首页主要空状态 CTA 已改为跳 `/onboarding`，侧边栏”完善研究画像”等补充入口仍保留 `/profile`

### 功能引导气泡 Feature Tour

- 新增 `TourBubble` 组件：固定定位气泡，支持 top/bottom/left/right 四方向箭头
- 首页 tour（移动端 + 桌面端）：第一张论文卡 → 下一页按钮
- 论文详情页 tour：收藏按钮 → 查看原文 → AI 讨论 Tab
- Tour `done` 标记在气泡实际出现时写入（setTimeout 回调内），而非 effect 启动时；用户在 800ms/1000ms 内离开则不标记，下次仍会再触发

### IP 限流

- 新增 `_get_client_ip()` 读取 `X-Forwarded-For`（nginx 反代场景）
- `/papers` 端点同时按用户 ID 和客户端 IP 计算推荐批次配额
- 无痕浏览器更换 userId 无法绕过每日限额

### Bug 修复 & 小改动

- 修复 `fetchPapers` 在 profile useEffect 中先用后声明的 lint 问题
- 设置页”全文翻译”标签改为”翻译次数”，说明文字改为动态读取 API 返回的 limit
- 服务器 `DAILY_RECOMMEND_LIMIT` 由 8 调整为 5
- Onboarding 移动端顶部 padding 从 96px 收到 48px，内容不再偏下
- 论文详情标题拆成两套字体规则（英文 serif / 中文宋体），收藏详情页与阅读详情页同步

## v0.6.7 - 2026-04-30

### 画像页桌面端继续微调

- 右侧结构继续收紧：`保存画像`、`系统观察摘要`、`画像快照` 的层级更清楚，首屏更平齐
- `长期画像` 和 `近期变化` 的预览高度继续放宽，默认能更完整地看到三行内容
- `检索时间范围` 的字号和排版进一步收轻，和整体页面更一致
- `吸收到长期画像` 按钮改回更轻量的胶囊样式，减少占位

### 全局手感微调

- 首页和收藏页的透明卡片点击反馈放慢、放柔，减少突兀感
- 画像页左右栏滚动行为统一，去掉右侧独立滚动和多余的空白高度

### 代码卫生

- 修复 `App.jsx`、`api.js`、`Navbar.jsx`、`Home.jsx`、`Settings.jsx` 的 lint 问题
- `npm run lint`、`npm run build`、`git diff --check` 通过

## v0.6.6 - 2026-04-27

### 液态透明玻璃卡片

- 新增 `.liquid-glass` CSS 类，替代首页和收藏页侧边栏的 `pm-glass-card`
  - 背景：`rgba(255, 255, 255, 0.05)` — 极轻透明感，底色透上来
  - 边框：`none`，改用 `box-shadow: 0 1px 0 rgba(255,255,255,0.5), 0 0 0 1px rgba(0,0,0,0.04)` 模拟微妙轮廓
  - 圆角：`24px`
  - 点击时 `liquid-wobble` 动画：极克制 0.4deg 微晃 + 轻微缩放（0.98），0.4s 回弹
- 首页侧边栏三张卡片（系统观察 / 关注方向+检索范围 / 上次停在这里）切换为 `liquid-glass`
- 收藏页侧边栏两张卡片（收藏概况 / 筛选）切换为 `liquid-glass`

### 全局卡片底色统一

- 首页论文卡片（PaperCard + 上次在读）底色统一为 `bg-warm-white/[0.82] backdrop-blur-sm border-cream-dark/[0.7]`
- 收藏页论文卡片（桌面版 + 移动版）底色统一为同一规格
- 画像页侧边栏（画像快照 / 系统观察摘要）和主区卡片底色统一为同一规格
- 设置页所有卡片底色统一为同一规格

### 导航栏搜索框移除

- 移除桌面端导航栏右侧的搜索占位框（Search 图标 + "搜索" + ⌘K 提示），因无实际搜索功能

### 设置页改版

- 全新分区布局：AI 服务 / 数据管理 / 偏好设置 / 用户反馈，各区域带 SectionLabel 小标题
- AI 服务卡片新增三列用量进度条（推荐批次 / AI 对话 / 全文翻译），实时显示已用/限额
- 数据导出卡片新增统计格（论文数 / 笔记数 / 对话次数），调用 `/api/stats`
- 新增隐私与安全卡片：匿名使用数据 Toggle 开关 + 清除所有数据按钮
- 新增用户反馈卡片：三种类型（发现问题 / 功能建议 / 其他）+ 文本输入 + 匿名发送
- 标题改为 `pm-page-title` 34px serif，与全局风格一致

### 后端新增接口

- `GET /api/usage`：返回当日推荐/对话/翻译使用量
- `GET /api/stats`：返回用户收藏论文数、笔记数、对话次数
- `POST /api/feedback`：存储用户反馈（type + content），写入 `user_feedback` 表
- 每日推荐配额默认值从 8 降为 5（`DAILY_RECOMMEND_LIMIT`）

### 页面适配新导航栏

- 首页、收藏页、画像页、设置页的桌面/移动端顶部 padding 调整，适配 v0.6.5 固定顶栏
- 首页问候语上方日期行移除（日期已显示在导航栏右侧）
- 首页翻页按钮文案："换一批"→"下一页"、"上一批"→"上一页"

---

## v0.6.5 - 2026-04-27

### 全局统一导航栏

- 所有屏幕尺寸统一使用固定顶部导航栏，移除旧的移动端浮动底栏
- 顶栏结构：左侧 Logo（芽图标 + "papermind" 衬线字）、居中导航项（首页 / 收藏 / 画像 / 设置 + 图标）、右侧日期 + 搜索占位按钮（⌘K 样式）
- 当前页导航项高亮：`bg-warm-white/70` 背景 + 微阴影，未激活项 hover 效果
- Profile / Settings 页返回箭头加 `lg:hidden`，桌面端依赖顶栏导航

### Profile 桌面端 v2

重新设计画像页桌面布局，与 Home / Library 工作台风格统一：

- **左侧边栏（300px 固定）**
  - 画像快照卡片：关注方向（coral 标签）、方法兴趣（灰色标签）、检索范围快捷按钮（近1月 / 近3月 / 近6月）
  - 系统观察摘要卡片：长期画像（来源角标 + 时间戳 + 铅笔图标内联编辑）、近期变化（mint 底色区块）、吸收按钮、吸收成功 ✓ 反馈
  - 保存画像按钮迁移至边栏底部（原在主区底部）
- **右侧主区**
  - 标题"我的研究画像"34px serif
  - 长期关注卡片：2 列 TagInput 网格（研究方向 / 方法兴趣 / 不想看的内容 / 学科领域）
  - 随手补充卡片：语音输入 + 文本域
  - 检索时间范围独立成卡片：近1个月 / 近3个月 / 近6个月 / 自定义
- `RANGE_OPTIONS` 增加 `shortLabel`，边栏用短标签（近1月），主区用完整标签（近1个月）
- `TagInput` 新增 `variant` 属性，`"coral"` 用于研究方向标签，默认灰底

### 全局 CSS 工具类

- `.pm-page-title`：统一页面标题字体（Songti SC / Noto Serif SC，正常字重，紧排），Library / Profile / Mobile-Profile 均已切换
- `.pm-glass-card`：毛玻璃效果卡片（多层渐变背景 + 内侧高光 + backdrop-blur 18px），用于首页桌面侧边栏三张卡片

### 平滑页面过渡

- Profile 页进入时先从 `localStorage` 还原 `cached-profile`，消除导航到画像页时的内容闪白
- Library / LibraryDetail / PaperRead 过渡平滑优化

### 异步调用第一阶段（Codex）

将用户等待 AI 返回的核心接口改为 `async def`，解除 FastAPI 同步阻塞：

- `/api/chat`、`/api/translate`：对话与翻译
- `/api/profile/memory-recent`、`/api/profile/merge-to-core`：记忆生成与合并
- `/api/settings/test`：LLM 连接测试
- 新增 `_llm_chat_complete_async`（基于 `AsyncOpenAI`），所有请求处理路径共享同一套 provider 路由与冷却逻辑
- 后台线程保留同步桥接：`_llm_chat_complete` 内部改为 `asyncio.run(_llm_chat_complete_async(...))`，不再维护两套 provider 代码

> 未完成：后台抓取 / 批量解读完全 async 化——当前仍为后台线程 + 同步桥接，不阻塞请求，留待第二阶段

---

## v0.6.4 - 2026-04-25

### 桌面端工作台布局（Library + Home）

- **Library L2 桌面工作台**：lg+ 屏幕显示两栏布局（260px 边栏 + 主区）
  - 边栏：标题、篇数统计、分类分布（进度条 + 点击筛选）、筛选面板、添加按钮
  - 主区：搜索框、分类标签栏、2 列 `PaperCard` 网格（显示摘要 + 相关性）
  - 移动端保持原有 `PaperRow` 列表，`lg:hidden` / `hidden lg:grid` 分支
- **Home D1 桌面工作台**：lg+ 屏幕显示两栏布局（300px 边栏 + 主区）
  - 边栏：日期/问候、近期变化（`memory_recent`）、研究画像（`memory_core`）、画像编辑入口
  - 主区：上次在读卡片、2 列论文推荐网格、换批/回退/重抓按钮
  - Memory 数据复用已有 `/api/profile` 请求，无新接口
  - 移动端布局完全不变

---

## v0.6.3 - 2026-04-24

### 记忆系统调优（Codex patch）

- **recent 长度控制**：prompt 改为 100-180 字，新增 `_enforce_recent_length` 硬截断兜底（180 字），防止模型输出失控过长
- **core 长度收紧**：所有生成/merge 场景统一改为 140-220 字（原 180-260 字）
- **修复 merge 后立刻重新生成 recent 的 bug**：merge 后 events 重置为 0，此时 `has_recent=False` + `events=0` + `core 已存在` → 跳过生成，避免和刚合并的 core 高度重复
- **recent 增量提示加强**："只写最近新增或最近明显变强的关注点，不要把长期画像换句话再写一遍"
- **relevance 字段长度限制**：添加 "80字以内" 约束，减少论文解读"为什么和你相关"过长

### PaperRead 阅读行为追踪改进（Codex patch）

- 停留 20 秒后才计为有效阅读（原来进页面即记录），减少误计
- 额外追踪 export、下载 PDF、点击原文链接等行为，丰富 recent 行为信号

### 后端性能：workers 2 + SQLite WAL

- uvicorn `--workers 1` 改为 `--workers 2`：双进程分担 LLM 阻塞调用，翻译不再被后台 memory 任务卡住
- SQLite 开启 WAL 模式（`journal_mode=WAL`）+ `busy_timeout=5000`：多进程并发写不互相锁死

### 前端字体修复

- 加载 `Noto Sans SC` 作为中文无衬线兜底字体，解决部分 Android 设备 CJK 字形不一致问题
- 字体优先级：`DM Sans → system-ui（苹方/系统字体）→ Noto Sans SC`，桌面端维持原有苹方显示

### LibraryDetail 布局修复

- 收藏页论文详情的"译"按钮从标题右侧移到标题下方，与 PaperRead 一致，手机端不再错位

---

## v0.6.2 - 2026-04-23

### 双层记忆系统（Memory Core + Recent）

- **新增 `memory_core`**：长期研究骨架，首次保存画像后后台异步生成，给对话和论文解读提供稳定背景
- **新增 `memory_recent`**：近期 7 天行为观察（收藏、提问、阅读），累计 8 次行为或 7 天触发更新
- **auto_initial 快速升级**：初版 core 仅基于填写内容，第一次 recent 生成后立刻刷新 core（有真实行为数据），无需等 14 天
- **core 自动吸收周期**：14 天自动把最新 recent 整合进 core（旧版 30 天）
- **用户手动 merge**：画像页"吸收到长期画像"按钮，merge 成功后清空 recent，重新开始下一轮 7 天观察
- **记忆不参与检索**：memory_core 和 memory_recent 只用于 AI 对话和论文解读，不影响检索关键词生成和分类打分
- **数据库迁移**：user_profiles 新增 memory_core、memory_recent、behavior_events_since_recent、last_recent_updated_at、last_core_merged_at、core_source；旧 interests_summary 数据自动迁移到 memory_core

### Profile 页改版

- "系统观察摘要" section 改为展示长期画像 + 近期变化两块，各自有独立更新时间
- 保存画像时 memory-recent 在后台异步触发，不阻塞保存反馈
- "吸收到长期画像"按钮仅在有 recent 内容时显示

---

## v0.6.1 - 2026-04-23

### LLM 路由稳定性加固

- **Provider 冷却机制**：当某个 LLM provider 返回 401/403/quota 相关错误时，自动冷却 10 分钟，期间直接跳过该 provider，不再每次请求都先报错再尝试下一个，减少 30%+ 的无意义调用
- **配额耗尽时的体验改善**：日志更清爽，用户感知延迟显著降低

### 系统观察摘要策略调整

- **触发条件改为事件 + 时间混合**：不再"每次进首页都尝试"或"画像一变就立刻重生成"，改为累计 8 次关键行为（收藏 / 对话 / 阅读）或距上次生成 ≥7 天时触发，降低无谓重生成和 token 焦虑
- **数据库迁移**：`user_profiles` 新增 `behavior_events_since_summary` 字段追踪行为计数
- **摘要生成指定模型**：系统观察摘要调用新增 `prefer_model="qwen-flash-2025-07-28"` 参数，确保质量一致性，配额耗尽时自动 fallback 其他 provider

### Enrichment 缓存系统

- **新增 SQLite 缓存表**：`enrichment_cache` 存储论文的 `summary_zh / relevance / key_findings`，以 `pmid:{id}` 或 `doi:{id}` 为键
- **同一篇论文重复出现时命中缓存**：解读耗时从 3-10s 降至 0s，库累积越多、重复率越高、收益越明显

### 分类打分性能优化

- **批次处理改为线程池并行**：从 `ThreadPoolExecutor(max_workers=4)` 并行 8 个批次，耗时从 21s 降至 ~6s
- **整体推荐耗时优化**：关键词生成 3s + 并发抓取 12s + 并发打分 6s + 并发解读 9s ≈ 30s（v0.6 的 48s 进一步优化）

### Rate Limit 重新定义

- **只对用户主动「重新抓取」计费**：`force_fetch=true` 才消耗推荐配额；缓存重建（服务重启 / 过期 / 首次加载）不消耗
- **原因**：之前无差别计费导致服务重启 8 次 = 8 次无意义消耗，用户体感"明明没操作就配额没了"

## v0.6 - 2026-04-22

### 检索性能大幅优化（P0 并发改造）

- **LLM enrichment 并发化**：论文 AI 解读从逐篇串行调用改为 `ThreadPoolExecutor(max_workers=5)` 并发，10 篇解读从 30-100s 降至 3-10s
- **外部 API 抓取并发化**：6 组 PubMed / Semantic Scholar 查询从顺序执行改为 `ThreadPoolExecutor(max_workers=3)` 并发抓取，从 10-25s 降至 3-8s
- **S2 配额线程安全**：Semantic Scholar 每轮 ≤4 次查询限制改为 `threading.Lock` 保护，并发下不会超限

### Qwen3.5-Flash 适配

- **关闭 thinking 模式**：Qwen 链路自动加 `extra_body={"enable_thinking": False}`，避免 thinking 阶段白白消耗 10-20s
- **显式 prompt 缓存**：enrichment prompt 拆为 `system`（含 profile + 输出格式，标记 `cache_control: {"type":"ephemeral"}`）+ `user`（只含论文内容），同一批并发调用共享 system 前缀，命中 Qwen 服务端缓存时跳过前缀计算；日志打印 `(cache hit)` 标记

### Bug 修复

- **`saved_titles` 未定义崩溃**：`_fetch_and_cache_papers` 中遗漏了 `saved_titles = get_saved_titles(user_id)`，导致每次抓取完论文后直接抛 `NameError`，enrichment 从未执行，用户始终看不到结果

### 预期效果

| 阶段 | v0.5 | v0.6 |
|------|------|------|
| 首屏可见（loading → 看到论文卡片） | 17-45s | 5-12s |
| 全部 AI 解读完成 | 47-145s | 8-22s |

## v0.5.24 - 2026-04-20

### 画像页 UI 优化

- 头部预览卡片"关注方向"拆为两行，分别展示研究方向（navy 深色 tag）和方法兴趣（navy 浅色 tag）
- "随手补充"更名为"自由描述"
- 研究方向占位示例改为：肺癌、中医护理、慢病管理、术后康复

## v0.5.23 - 2026-04-20

### Bug 修复 & 体验优化

- **P0 rate limit 漏洞**：缓存超过 1 小时触发的自动重抓绕过了配额检查，现统一在 `need_fetch=True` 时检查；超额时返回已有缓存而非空列表
- **P2 默认时间范围**：新用户默认检索窗口从 30 天改为 90 天（前后端 fallback 均已修正）
- **保存画像后引导**：保存成功后出现"去首页看推荐 →"按钮，解决用户不知道下一步的问题
- **排除词防呆 toast**：填入「研究」「论文」「综述」等过宽词保存时，底部弹出 5 秒提示，不拦截保存
- **随手补充占位提示**：改为"用日常的话说就行，AI 会理解你的意思并生成检索词"，示例换为带状疱疹中医干预场景
- **自然语言检索增强**：`focus_areas` 填写少于 10 字时，prompt 增加指令让 LLM 从「随手补充」中主动提取疾病/人群/干预/研究设计，转化为 PubMed 检索词

## v0.5.22 - 2026-04-19

### 引导页文案终版

- 第一条标题"越聊越懂你"→"它记得你的方向"，描述改为"研究画像不是关键词标签，是它理解你的起点——对话和解读都会围绕你的真实关注"
- 第三条描述恢复"越用越懂你"结尾（与第一条不再重复）

## v0.5.21 - 2026-04-19

### 引导页文案精简与核心价值重写

- 副标题精简："它记得你的方向、偏好和每次思考——从检索到讨论，全程为你定制"
- 第一条：标题"越聊越懂你"，描述精简为"AI 结合你的研究背景讨论论文，不是泛泛而谈"
- 第二条："一键检索，精准推荐"描述精简，突出 AI 逐篇打分与个性化
- 第三条："思考越积越厚"，加入系统观察偏好的说明，以"越用越懂你"收尾
- CTA 按钮去掉"开始"，改为"告诉它你在研究什么 →"
- 底部小字"设置一次，长期受益"→"随时可以调整"

## v0.5.20 - 2026-04-19

### 引导页文案修正 & 字体闪烁修复

- 引导页第二条标题"每天帮你过滤一遍"→"一键检索，AI 替你筛"，描述移除"自动抓取""那几篇"等不准确表述，改为"根据你的研究画像从 PubMed 检索最新文献，AI 打分筛选出相关论文并生成中文解读"
- 副标题"每天自动筛选最新文献"→"随时检索最新文献"
- 修复首次打开字体"从胖变瘦"闪烁：Google Fonts 加载策略从 `display=swap` 改为 `display=optional`，100ms 内字体未到位则全程使用系统兜底字体，不再发生替换跳变

## v0.5.19 - 2026-04-19

### 设置页简化：移除设备 ID 模块

- 删除"设备 ID"卡片（原始 UUID 对普通用户无实际用途）
- 将"数据存储在此设备"的说明文字合并入"多端同步"卡片，信息不丢失，页面更简洁
- 移除关联的 `copied` state、`handleCopy` 函数及 `Copy` 图标 import

## v0.5.18 - 2026-04-19

### 新功能：AI 对话支持语音输入

- 新增 `useSpeechInput` hook，封装 Web Speech API（`SpeechRecognition` / `webkitSpeechRecognition`）
- 论文阅读页（`PaperRead`）和收藏详情页（`LibraryDetail`）的 AI 对话输入框旁新增麦克风按钮
- 点击后开始识别，识别结果追加到输入框；再次点击或识别结束自动停止；录音中按钮变为珊瑚色脉冲动效
- 不支持 Web Speech API 的浏览器（如部分 Firefox）自动隐藏麦克风按钮，不影响正常使用

## v0.5.17 - 2026-04-19

### Bug 修复：per-paper 缓存串账 / 解读轮询无终止条件

- **per-paper 缓存串账（P1）**：UID 切换时改为遍历 localStorage 全量清除所有 `paper-notes-*`、`paper-chat-*`、`paper-bookmark-*` 前缀的动态 key，不再只清除顶层固定 key；旧账号的本地笔记、对话、收藏状态不会暴露给新账号
- **解读轮询无终止条件（P2）**：`LibraryDetail` 的 AI 解读轮询增加最大次数上限（15 次 × 4s = 60s）；超时后自动停止轮询和转圈占位，不再无限等待；AI 失败或不可用时页面会安静地停下来而不是永远转圈

## v0.5.16 - 2026-04-19

### Bug 修复：翻页历史串批次 / 切换 UID 泄露缓存 / 手动论文解读不可见

- **翻页历史串批次（P1）**：`_bg_fetch_and_enrich` 新一轮抓取完成后，同步清空 `pages_history` 和 `current_page`。旧批次结果不再保留在历史栈中，防止用户点"上一批"翻到上一轮检索的论文
- **UID 切换泄露旧缓存（P1）**：`App.jsx` 的 `UidHandler` 在应用新 UID 前，先清除 `cached-papers` / `cached-papers-time` / `cached-search-debug` / `last-reading` 四个 localStorage 键；避免新账号短暂看到上一个账号的阅读记录和缓存论文
- **手动添加论文看不到 AI 解读（P2）**：`LibraryDetail` 首次加载若检测到 `abstract` 存在但 `summary_zh` 为空（即后台正在补充解读），启动 4s 间隔轮询；解读到位后自动更新并停止轮询；同时显示"AI 解读生成中…"占位提示，用户知道在等待而不是以为功能失效

## v0.5.15 - 2026-04-19

### 后端守护：画像为空时不消耗推荐配额

- 后端 `/api/papers` 在即将触发抓取时检查画像是否完全为空（focus_areas / method_interests / background / current_goal 均为空）
- 若画像为空，直接返回 `needs_profile: true`，**不扣除当日配额**——防止用户在无画像状态下烧光 8 批配额却 0 结果
- 前端收到 `needs_profile` 时，在首页展示「去填写研究画像 →」引导链接，而不是普通报错文字
- 此前测试用户截图证实该场景确实发生：画像空 → 抓取 8 次 → 每次 0 组查询 0 篇结果 → 配额耗尽

## v0.5.14 - 2026-04-19

### 新用户引导 & 跨设备访问 & 翻页修复 & 手动添加论文

#### 新用户引导页
- 首次进入（画像空、无缓存论文）直接显示引导页，用"有记忆的学术文献助手"为核心卖点，清楚说明三个价值：记住你是谁 / 每天帮你过滤 / 沉淀你的思考
- 画像未填时，首页"重新抓取"按钮整个隐藏；空状态按钮变为"先填写研究方向"，点击跳转画像页——防止新用户在无画像状态下烧光推荐配额

#### 跨设备专属链接
- 设置页新增"复制我的专属链接"按钮，生成 `papermindapp.com/?uid=xxx` 格式链接
- App 启动时读取 URL 中的 `?uid=` 参数，自动绑定身份后跳转首页——打开链接即可在新设备无缝继续

#### 首页翻页修复
- 修复"换一批"后无法回到上一批的问题：后端引入 `pages_history`，记录每次翻页前的当前批
- 新增"上一批"按钮（有历史时显示），点击回退到上一批，`served_indices` 同步还原

#### 手动添加论文
- 收藏页右上角新增"添加论文"按钮，支持输入 PMID、DOI 或标题关键词搜索 PubMed
- 搜索结果显示最多 3 篇供选择；收藏后自动跳转论文详情页；若论文无 AI 解读，后台自动补充生成

## v0.5.13 - 2026-04-18

### 移动端体验优化
- **收藏卡片布局重构**：分类标签和元数据移至顶行，标题独占全宽，手机上长标题不再被挤压截断
- **论文分类统一为大类**：AI 分类标签改为从固定 10 个大类中选择（预测模型、系统综述、干预研究、症状管理、患者教育、慢性病管理、肿瘤护理、老年护理、心理健康、其他），不再自由生成细碎标签，收藏页筛选更实用
- **底部导航滚动自动隐藏**：向下滚动时导航栏滑出隐藏，向上滚动时立即恢复，减少对内容区域的遮挡

## v0.5.12 - 2026-04-18

### 收藏页移动端标题显示优化
- 收藏列表卡片标题由最多 2 行改为最多 3 行，手机上长标题不再过早截断

## v0.5.11 - 2026-04-18

### 搜索质量改进

- **PubMed 查询宽化**：`build_query` 的精确短语匹配阈值从 5 个关键词降为 3 个，4词以上的查询自动降级为 `"exact phrase"[tiab] OR (word1[tiab] AND word2[tiab] AND word3[tiab])`，大幅减少 0 结果概率
- **S2 年份范围加宽**：Semantic Scholar 年份过滤往前扩展 1 年，避免 2026 年最新论文因尚无摘要被全部过滤
- **LLM 关键词长度约束**：提示词要求每组查询控制在 2-4 个词，覆盖不同维度（疾病/干预/方法），不再把所有关键词堆在同一条查询里
- **护理学科影像学过滤**：当学科为护理时，提示词明确禁止生成纯影像学查询（CT、MRI、radiomics）；预测模型查询必须带临床结局词（mortality、readmission、symptom 等）
- **S2 限流处理优化**：移除 Retry 对 429 的重试，避免单次限流放大为多次无效请求消耗配额

## v0.5.10 - 2026-04-17

### 设备同步与 UID 持久化
- UID 持久化策略升级：同时写入 localStorage 和 cookie，手机刷新不再丢失设备身份
- 设置页新增"切换账号"入口，粘贴另一台设备的 ID 即可在本机访问同一账号的数据
- 支持跨设备（电脑 ↔ 手机）数据同步，无需登录体系

## v0.5.9 - 2026-04-17

### 搜索稳定性修复
- Semantic Scholar 结果现在会在后端最终再按真实日期过滤，避免“近一个月”混入去年的旧论文
- PubMed 长查询放宽，不再简单拆成超长 `AND [tiab]` 链，降低 0 结果概率
- Semantic Scholar 增加更温和的 429 冷却与查询上限，减少一轮检索中被频繁限流的抖动

### 页面文案与标题层级
- 首页空状态按钮文案由“获取本周文献”改为“获取推荐论文”
- 收藏页空状态链接文案由“去看看本周论文”改为“去看看推荐论文”
- 收藏页与研究画像页标题栏统一了字号、字重和上下边距
- 研究画像页去掉重复的英文小标签与“系统观察”小字，分区标题调整为更清晰的层级

## v0.5.8 - 2026-04-17

### 收藏详情笔记编辑修复
- 修复 `✨ 总结` 等长笔记进入编辑态后编辑框过矮的问题，长内容现在会默认给更高的编辑区
- 笔记编辑框支持纵向拉伸，手机上也能更自然地编辑长段内容
- 收藏详情里的编辑 / 删除按钮改为移动端默认可见，不再只依赖桌面端 hover

## v0.5.7 - 2026-04-17

### Qwen 模型回退
- 新增 `QWEN_FALLBACK_MODELS` 配置，支持在同一个阿里云 API Key 下按顺序尝试多个千问模型
- 当主模型不可用或失败时，会自动切到后续 Qwen 模型；Qwen 全部失败后才继续退到 GLM / DeepSeek
- 后端日志现在会打印每次实际命中的 provider / model，便于在线确认当前使用的是哪一个模型

## v0.5.6 - 2026-04-17

### 阅读页与收藏同步修复
- 修复“首页详情页先聊天再收藏”时，旧对话不会进入收藏详情的问题；收藏动作现在会把本地临时对话一并迁移到后端
- 修复首页详情页“将对话保存为笔记”后生成两条重复总结笔记的问题；总结结果只保留服务端保存的 `chat_summary`

### 首页与画像页细节
- 首页问候语改为只显示“早上好 / 下午好 / 晚上好”，去掉“研究者”称呼
- 首页“换一批 / 重新抓取”按钮统一改为胶囊形，`换一批` 增加更柔和的投影
- 画像页“保存画像”按钮改为 coral 主色

### 部署补丁
- `update.sh` 现在会为已有 ECS 机器补装 `sqlite3`
- `backup.sh` 在缺少 `sqlite3` 时会输出明确报错，便于线上排查

## v0.5.5 - 2026-04-16

### 数据备份
- 新增 `deploy/backup.sh`，使用 SQLite 原生 `.backup` 方式生成数据库备份并自动 gzip 压缩
- 新增 `papermind-backup.service` 与 `papermind-backup.timer`，默认每天 `04:30` 自动备份
- 默认保留最近 `14` 天备份，过期文件自动清理
- `setup.sh` / `update.sh` 会自动同步并启用备份定时器

## v0.5.4 - 2026-04-15

### 安全与稳定性
- `/api/settings/test` 改为仅 `OWNER_UID` 对应设备可调用；若服务端未配置 `OWNER_UID`，会返回明确提示
- CORS 改为 `allow_credentials = false`，并支持通过 `ALLOWED_ORIGINS` 环境变量在生产环境收紧来源
- 翻译、聊天、兴趣摘要生成等接口不再把底层异常 `str(e)` 直接回传前端，改为通用错误提示并保留服务端日志
- `ChatRequest` 增加长度限制，降低超长输入意外消耗 token 的风险

### 设置页与设备 ID
- 设置页改为更稳的设备 ID 读取方式：即使移动端浏览器无法访问 `localStorage` 或 `crypto.randomUUID`，页面也不会白屏
- 新增基于内存的降级设备 ID 兜底逻辑，保证移动端 Edge / Safari 等环境仍可正常打开设置页
- 设置页限额文案同步更新为“每天最多获取 8 批推荐结果、20 次 AI 对话、30 次翻译”

### 配置
- `.env.example` 默认限额更新为推荐 8 批 / 对话 20 次 / 翻译 30 次
- `.env.example` 增加 `ALLOWED_ORIGINS` 示例，方便后续接入域名后收紧跨域来源

## v0.5.3 - 2026-04-15

### 后端限速与熔断
- `/api/chat` 新增用户级每日限速（默认 30 次）和全局每日熔断（默认 500 次）
- `/api/chat/summarize` 接入全局 AI 熔断，并计入全局对话额度
- `/api/translate` 新增用户级每日限速（默认 50 次）
- 限速阈值支持通过 `.env` 覆盖，无需改代码

### 数据导出
- 新增 `GET /api/export/notes-markdown`，支持导出当前设备下所有有笔记的论文为 Markdown
- 导出内容包含论文标题、中文摘要、笔记正文与来源标签
- 设置页新增“导出全部笔记”按钮，并补上失败状态处理

### 部署
- 新增 `deploy/` 目录，提供 ECS 首次部署脚本、更新脚本、systemd 服务配置与 nginx 配置
- 首次部署脚本会自动安装 Node.js、构建前端并配置 nginx/systemd
- 更新脚本会执行 `pull → pip install → npm build → reload nginx → restart service`

## v0.5.2 - 2026-04-13

### 系统观察摘要策略调整
- `interests_summary` 不再参与关键词生成，避免系统观察把搜索召回方向带偏
- 论文打分仅在 `interests_summary_is_manual = '1'` 时参考用户手动修正后的偏好
- 论文 AI 解读继续仅在 `interests_summary_is_manual = '1'` 时注入，且明确要求以论文实际内容为依据，不硬贴无关方向
- 手动编辑或手动清空系统观察摘要后，保存画像时不再立刻触发自动重新生成，用户修正会被尊重

### 收藏页调整
- 收藏页改为更紧凑的行列表结构，弱化大卡片与时间分组，提升快速回看效率
- 新增“有笔记”筛选开关，便于优先回看自己写过内容的论文
- 删除按钮在移动端默认可见，避免手机上因为没有 hover 而找不到入口

### 稳定性修复
- 修复 `api.py` 中弯引号导致的后端语法错误，恢复后端可启动状态
- 前后端基础检查重新通过：`py_compile`、`lint`、`build` 全部通过

## v0.5.1 - 2026-04-13

### 研究画像重构
- Profile 页从传统表单重构为新的“研究画像”页：研究方向、方法兴趣、随手补充、排除内容、学科领域、系统观察摘要
- `tracking_days` 从按天按钮调整为按月预设（近 1 / 3 / 6 个月）并支持自定义月份
- 新增 `method_interests` 字段，方法兴趣会参与搜索词生成与论文相关性打分
- 新增“系统观察摘要”展示与编辑入口，画像保存后会触发兴趣摘要刷新

### 推荐与解读稳定性
- 保存研究画像后会自动清空当前用户推荐缓存，避免旧画像结果残留
- 首页当前批次论文支持继续后台补解读，减少尾页长期没有中文解读的情况
- 论文解读失败时增加简化重试路径，降低空白卡片概率
- 首页本地缓存恢复逻辑优化，刷新后更容易接上上次阅读状态

### 数据隔离与权限
- 收藏详情、删除收藏、保存笔记、AI 对话、对话总结等接口统一切换为严格的 `user_id` 归属校验
- 删除笔记继续按笔记所有者校验，跨设备误读写风险下降
- MCP Server 返回的研究画像补充 `method_interests` 字段

### 搜索逻辑
- 相比 v0.5，保留了原有“LLM 生成主题查询”的主路径
- 在此基础上把 `method_interests` 接入搜索词生成 prompt 和翻译兜底逻辑
- Semantic Scholar 仍保留宽年份窗口策略，因此画像时间范围目前仍是近似时间窗，而非严格过滤

### Bug 修复
- 修复 Profile 页保存失败仍显示“已保存”的假成功提示
- 修复 Profile 页遗留未使用函数导致的前端 lint 报错
- 前端构建与 lint 重新恢复为通过状态

## v0.5 - 2026-04-11

### 研究者画像升级
- Profile 页拆分为两层：追踪设置 + 关于我
- 新增 `discipline` 字段（护理/医学/生物等），优化画像精准度
- 新增 `tracking_days` 字段，用于控制默认抓取周期（近 7 / 14 / 30 天）

### 后端 Prompt 层重写
- 搜索词生成：把 `discipline` 纳入画像上下文，帮助 LLM 生成更贴合学科视角的检索词
- AI 对话：加强论文实质内容的引导，减少套话
- 对话总结为笔记：改为结构化编号要点，更适合后续复盘
- 兴趣演化：基于收藏标题、分类分布和最近提问生成兴趣摘要，并写回画像

### 收藏库增强
- Library 页新增论文标题搜索
- 新增分类标签筛选 + 最近收藏 / 最近阅读切换
- LibraryDetail 页笔记改为分条展示，支持 Markdown 渲染
- LibraryDetail 页单条笔记可独立删除
- LibraryDetail 页论文标题新增翻译按钮

### 论文阅读页
- 标题新增"中文/原文"翻译切换按钮（与摘要翻译一致）
- "将对话保存为笔记"失败时显示具体错误原因，不再静默失败

### Bug 修复
- 修复 legacy 论文（user_id 为空）在 `GET/DELETE /api/library/{id}` 和 `POST /api/notes` 时被错误拒绝的问题，ownership 检查改为兼容空 user_id

## v0.4 - 2026-03-31

### 架构
- 设备隔离：无需登录，UUID 存 localStorage，通过 X-User-ID 头传递，所有数据按用户隔离
- 内置 LLM：API Key 存后端 .env，用户无需配置。优先级：阿里云通义 → 智谱 GLM → DeepSeek
- 每日 rate limit（20次/人），owner 设备不限量
- 论文抓取改为后台线程异步执行，前端轮询，离开页面不打断

### 搜索与推荐
- 基于研究者画像，LLM 生成 PubMed 检索词（而非硬编码关键词）
- 动态论文打分（0-10）+ 自动分类标签，替代硬编码分类
- 排除领域双重生效：搜索词生成时不产生相关词 + 打分时强制 0 分过滤
- 已探索完提示：全部看完后显示"已全部探索完"，换批按钮置灰

### AI 解读优化
- relevance 改写：只说论文实际涉及的内容，不再复读用户画像关键词
- chat max_tokens 800 → 2000，不再截断长回复
- 切换到 qwen-flash 测试（可配置）

### 前端
- `api.js`：统一 fetch 封装，自动注入 user ID，统一错误处理
- 论文阅读页：页面刷新后可恢复论文数据（后端新增 `/api/papers/{index}`）
- 摘要翻译：点击切换原文/中文翻译（阅读页 + 收藏详情页均支持）
- 收藏详情页：AI 对话每条回复下方新增"保存为笔记"按钮
- 笔记自动保存状态修复：保存后短暂显示"已保存"，不再一直显示"自动保存中"
- 首页空状态文案："今天还没有开始阅读，不如从一个问题开始。"
- 换批按钮显示剩余篇数
- 设置页简化为内置服务说明卡片，显示设备 ID 方便 owner 配置

## v0.3 - 2026-03-29
- 新增一键导出 RIS/BibTeX（兼容 Zotero/EndNote/Mendeley）
- 新增通过 Unpaywall/PMC 查找免费 PDF 全文
- 对话记录自动保存到 localStorage，刷新不丢失
- 已收藏论文从后端加载完整对话历史
- 视觉升级：呼吸感入场动画、卡片物理悬浮、流光渐变背景
- 对话气泡毛玻璃效果 + 左右入场动画
- 收藏/保存按钮微光波纹反馈
- 换批论文时跳过已解读的，提升响应速度

## v0.2 - 2026-03-27
- 新增研究者画像（研究方向、排除领域、当前目标、研究经历）
- 首页改为"研究空间"风格，个性化问候
- 推荐论文卡片式展示，含中文解读 + "为什么和你相关"
- 新增"上次在读"快速入口
- 论文阅读页：AI 对话 + 笔记双 tab
- AI 对话可总结为笔记并保存
- 收藏库：按日期分组，显示笔记/对话数
- 收藏详情页：笔记自动保存 + 继续对话
- 新增 Semantic Scholar 数据源
- 支持多 LLM Provider（OpenRouter/DeepSeek/智谱/Moonshot/OpenAI）
- API 连接测试功能

## v0.1 - 2026-03-25
- 跑通基础科研周报功能
- 支持 PubMed 文献抓取（E-utilities API）
- LLM 生成中文摘要 + 护理启发
- 文献主题自动分类
- 生成 Markdown 格式周报
- Mock 模式支持（无需 API Key）
