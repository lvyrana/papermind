# PaperMind Connector

PaperMind Connector 把 Zotero 中的论文元数据和本地 PDF 一键送入 PaperMind，继续完成结构化精读、证据卡片、苏格拉底自测与汇报整理。

## 当前能力

- 在 Zotero 文献右键菜单中提供「用 PaperMind 精读」
- 自动读取题名、作者、期刊、日期、DOI、PMID 与摘要
- 自动上传当前条目的最佳 PDF 附件
- 在默认浏览器打开对应的 PaperMind 精读页
- 保持 Zotero 与 PaperMind 使用同一匿名设备身份

## 安装与连接

1. 下载 `papermind-connector.xpi`。
2. Zotero →「工具」→「插件」→ 齿轮按钮 →「从文件安装插件」。
3. 打开 PaperMind 设置页，复制「我的专属链接」。
4. Zotero →「工具」→「PaperMind 连接设置…」，粘贴该链接。
5. 选中一篇文献，右键选择「用 PaperMind 精读」。

PaperMind 当前小范围试用不需要共享访问密码。`0.2.x` 升级到 `0.3.0` 时会自动保留专属链接，并清除 Zotero 首选项中已经失效的旧预览凭据。

## 数据边界

发送论文时，插件会把文献元数据和最佳 PDF 附件上传到用户配置的 PaperMind 服务。AI 解读过程中，论文内容和用户提问可能发送给 PaperMind 配置的第三方模型服务。请勿处理患者隐私、未发表敏感数据或无权上传的 PDF。

匿名设备 ID 用于区分书架、笔记、卡片和对话，但不是正式账号。专属链接包含该设备 ID，不应公开转发。

## 开发

```bash
node --test zotero-plugin/test-bootstrap.mjs
bash zotero-plugin/build.sh
unzip -l zotero-plugin/papermind-connector.xpi
```

当前版本以 Zotero 9 为实际验证上限。公开插件市场发布前，仍需完成正式身份、隐私政策、许可证、双语界面和独立 GitHub Release。
