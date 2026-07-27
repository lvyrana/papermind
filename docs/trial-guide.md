# PaperMind 小范围试用指南

> 适用场景：向同事/同学开放 PaperMind 试用（局域网或临时部署）。
> 分两部分：给试用者看的「使用须知」，给主持人（部署者）看的「准备清单」。

---

## 一、给试用者：使用须知

### 怎么开始

1. 主持人会给你一个访问链接（例如 `http://<主持人电脑IP>:8000`），用电脑浏览器打开即可，无需注册登录。
2. 第一次打开时系统会自动为浏览器分配一个匿名设备 ID。系统按这个 ID 筛选收藏、笔记和对话，但它不是真正的账号密码，也不提供加密保护。
3. 建议先到「研究画像」页填写你的研究方向，推荐质量会明显更好。

### 换设备 / 换浏览器怎么办

设备 ID 存在浏览器里。换电脑或退出设备身份后会变成“新用户”。如需在新设备继续使用原数据，可在旧设备的「设置」页复制专属链接并在新设备打开。**专属链接包含设备 ID，等同当前试用环境的访问凭证，请勿转发或发布。**

### 隐私须知（请务必阅读）

- **数据存在主持人的电脑上**：你的收藏、笔记、对话记录、上传的 PDF 都保存在运行 PaperMind 的主持人电脑上。它们不会因为你清理浏览器而自动删除；试用结束后如需彻底删除，请联系主持人并提供设置页专属链接中的设备 ID。
- **内容会发送给第三方 AI 服务**：AI 解读、对话、翻译功能会把论文摘要、你的提问、划选的原文片段发送到第三方大模型 API（阿里云通义/智谱/DeepSeek 等）。**请勿在对话和笔记中输入患者隐私、未发表数据、涉密内容**。
- **上传 PDF 请注意版权**：本地上传的 PDF 仅用于你个人精读，请上传你有权使用的文献。
- **无密码保护**：试用环境没有登录密码。匿名设备 ID 只能用于日常数据区分，不能替代账号鉴权；请不要存放敏感信息，也不要转发专属链接。

### 用量限制

为控制 AI 成本，试用期每人每天有用量上限（默认：推荐 8 批次 / AI 对话 20 次 / 翻译 30 次），到达上限后第二天恢复。如果遇到"今日次数已用完"提示属于正常现象。

### 遇到问题 / 提反馈

请按下面模板把反馈发给主持人（微信/邮件均可）：

```
【PaperMind 试用反馈】
1. 你在做什么操作：
2. 期望发生什么：
3. 实际发生了什么（有报错请截图）：
4. 设备/浏览器（如 Mac Chrome / iPhone Safari）：
5. 大致时间：
6. 整体最想吐槽的一点 + 最喜欢的一点：
```

---

## 二、给主持人：试用准备清单

### 开放前检查

- [ ] `.env` 已配置可用的 LLM API Key（参考 `papermind/.env.example`）
- [ ] `OWNER_UID` 已填自己的设备 ID（自己不受限速）
- [ ] 确认每日限速值符合预算：`DAILY_CHAT_LIMIT` / `DAILY_TRANSLATE_LIMIT` / `DAILY_RECOMMEND_LIMIT` / `GLOBAL_DAILY_CHAT_LIMIT`（全局熔断是成本兜底，务必保留）
- [ ] 已执行一次备份并确认产物存在：`bash scripts/backup_local.sh --with-files`
- [ ] 前端为最新构建：`cd web && npm run build`
- [ ] 后端测试通过：`papermind/.venv_new/bin/python -m unittest discover -s tests`

### 启动方式（局域网试用）

```bash
cd papermind        # 仓库根目录下的后端目录
.venv_new/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

- `--host 0.0.0.0` 表示局域网内可访问。把 `http://<你的IP>:8000` 发给试用者（macOS 查 IP：系统设置 → Wi-Fi → 详细信息）。
- 只想自己用时改回 `--host 127.0.0.1`。
- 如果部署到公网（有域名），务必在 `.env` 设置 `ALLOWED_ORIGINS=https://yourdomain.com` 收紧跨域。

### 试用期间的日常动作

- **每天备份一次**：`bash scripts/backup_local.sh`（有新 PDF 或图表截图时加 `--with-files`）。产物默认在 `backups/`，保留 30 天。
- **定期保留异地副本**：可把备份直接写到移动硬盘或受控云盘，例如 `BACKUP_DIR="/Volumes/你的备份盘/PaperMind" bash scripts/backup_local.sh --with-files`。不要把包含试用数据的备份放进公开网盘或 Git 仓库。
- **观察后端日志**：uvicorn 控制台会打印 LLM 命中的模型和限速触发情况。
- **健康检查**：浏览器打开 `http://127.0.0.1:8000` 能加载首页即为正常。

### 收尾动作

- [ ] 汇总反馈（建议按「bug / 体验 / 新需求」三类整理进 issue 或笔记）
- [ ] 做一次收尾备份：`bash scripts/backup_local.sh --with-files`
- [ ] 如有试用者要求删除数据，先停止后端，预览后再执行：

```bash
# 只查看将删除哪些记录和文件，不会真正删除
python3 scripts/delete_user_data.py --user-id <完整设备UUID>

# 核对无误后执行；脚本会先自动备份数据库
python3 scripts/delete_user_data.py --user-id <完整设备UUID> --confirm
```

### 数据位置速查

| 内容 | 位置 |
|---|---|
| 主数据库（收藏/笔记/对话/卡片） | `papermind/data/paperdiary.db` |
| 上传的 PDF | `papermind/data/pdfs/` |
| 汇报板中的图表截图 | `papermind/data/figures/` |
| 用户级 LLM 配置 | `papermind/data/config.json` |
| 备份产物 | `backups/`（不入 git） |

`config.json` 可能包含 API Key，备份脚本不会把它放入未加密压缩包。迁移机器时应单独、安全地重新配置密钥。
