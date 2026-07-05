/**
 * PaperMind Connector — Zotero 插件
 *
 * 在文献右键菜单加一项「用 PaperMind 精读」：
 *   1. 读取选中条目的元数据 + 最佳 PDF 附件
 *   2. POST 到本地 PaperMind（/api/library/save + /api/library/{id}/pdf）
 *   3. 用默认浏览器打开 PaperMind 阅读页（带 ?uid= 自动认领设备身份）
 *
 * 首次使用会弹窗询问 PaperMind 地址和设备 uid（从 PaperMind 设置页的专属链接里复制）。
 * Tools 菜单里有「PaperMind 连接设置…」可随时修改。
 *
 * 兼容 Zotero 7 – 10（bootstrap 插件架构，参考官方 make-it-red 示例）。
 */

/* global Zotero, Services, Components */

var PaperMind = {
  MENU_ID: 'papermind-open-menuitem',
  TOOLS_ID: 'papermind-settings-menuitem',
  PREF_BASE: 'extensions.papermind.baseURL',
  PREF_UID: 'extensions.papermind.uid',

  log(msg) {
    Zotero.debug('[papermind] ' + msg)
  },

  getBaseURL() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_BASE, true) } catch (e) { /* unset */ }
    return (v || 'http://127.0.0.1:8000').replace(/\/+$/, '')
  },

  getUid() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_UID, true) } catch (e) { /* unset */ }
    return v || ''
  },

  promptSettings(win) {
    const ps = Services.prompt

    const base = { value: this.getBaseURL() }
    if (!ps.prompt(win, 'PaperMind 连接设置', 'PaperMind 地址（本地运行时保持默认即可）：', base, null, {})) {
      return false
    }
    Zotero.Prefs.set(this.PREF_BASE, base.value.trim().replace(/\/+$/, ''), true)

    const uid = { value: this.getUid() }
    if (!ps.prompt(win, 'PaperMind 连接设置',
      '设备 uid（打开 PaperMind → 设置 → 专属链接，复制链接里 uid= 后面那串）：', uid, null, {})) {
      return false
    }
    const cleaned = uid.value.trim()
    if (!/^[0-9a-f-]{36}$/i.test(cleaned)) {
      ps.alert(win, 'PaperMind', 'uid 格式不对：应该是 36 位的 UUID（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）。')
      return false
    }
    Zotero.Prefs.set(this.PREF_UID, cleaned, true)
    return true
  },

  /** 从 extra 字段提取 PMID */
  extractPmid(extra) {
    const m = /PMID:\s*(\d+)/i.exec(extra || '')
    return m ? m[1] : ''
  },

  buildPaper(item) {
    const authors = item.getCreators()
      .map(c => [c.firstName, c.lastName].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(', ')
    const doi = item.getField('DOI') || ''
    return {
      title: item.getField('title') || '(untitled)',
      abstract: item.getField('abstractNote') || '',
      authors,
      journal: item.getField('publicationTitle') || item.getField('conferenceName') || '',
      pub_date: item.getField('date') || '',
      doi,
      pmid: this.extractPmid(item.getField('extra')),
      link: item.getField('url') || (doi ? 'https://doi.org/' + doi : ''),
      source: 'zotero',
    }
  },

  async openSelected(win) {
    const pane = Zotero.getActiveZoteroPane()
    let item = pane.getSelectedItems()[0]
    if (!item) {
      Services.prompt.alert(win, 'PaperMind', '请先选中一条文献。')
      return
    }
    if (item.isAttachment() && item.parentItemID) {
      item = Zotero.Items.get(item.parentItemID)
    }
    if (!item.isRegularItem()) {
      Services.prompt.alert(win, 'PaperMind', '请选中一条文献条目（而不是笔记或独立附件）。')
      return
    }

    if (!this.getUid() && !this.promptSettings(win)) return
    const base = this.getBaseURL()
    const uid = this.getUid()

    try {
      // 1. 保存元数据到 PaperMind 收藏库
      const saveResp = await win.fetch(base + '/api/library/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': uid },
        body: JSON.stringify({ paper: this.buildPaper(item), chats: [] }),
      })
      if (!saveResp.ok) throw new Error('save HTTP ' + saveResp.status)
      const saved = await saveResp.json()
      if (!saved.id) throw new Error('save 未返回 id')
      this.log('saved rowid=' + saved.id)

      // 2. 上传最佳 PDF 附件（没有就跳过，PaperMind 侧还能自动找 OA 全文）
      try {
        const att = await item.getBestAttachment()
        if (att && att.attachmentContentType === 'application/pdf') {
          const path = await att.getFilePathAsync()
          if (path) {
            const bytes = await win.IOUtils.read(path)
            const fd = new win.FormData()
            fd.append('file', new win.Blob([bytes], { type: 'application/pdf' }), 'paper.pdf')
            const upResp = await win.fetch(`${base}/api/library/${saved.id}/pdf`, {
              method: 'POST',
              headers: { 'X-User-ID': uid },
              body: fd,
            })
            this.log('pdf upload HTTP ' + upResp.status)
          }
        }
      } catch (e) {
        this.log('pdf upload skipped: ' + e)
      }

      // 3. 打开浏览器进入阅读页（?uid= 让新浏览器自动继承设备身份）
      Zotero.launchURL(`${base}/paper/${saved.id}?uid=${uid}`)
    } catch (e) {
      this.log('openSelected failed: ' + e)
      Services.prompt.alert(win, 'PaperMind',
        '发送失败：' + e.message + '\n\n请确认 PaperMind 正在运行（' + base + '）。')
    }
  },

  addToWindow(win) {
    const doc = win.document
    if (doc.getElementById(this.MENU_ID)) return

    // 文献右键菜单
    const itemMenu = doc.getElementById('zotero-itemmenu')
    if (itemMenu) {
      const mi = doc.createXULElement('menuitem')
      mi.id = this.MENU_ID
      mi.setAttribute('label', '用 PaperMind 精读')
      mi.addEventListener('command', () => this.openSelected(win))
      itemMenu.appendChild(mi)
    }

    // Tools 菜单：连接设置
    const toolsMenu = doc.getElementById('menu_ToolsPopup')
    if (toolsMenu && !doc.getElementById(this.TOOLS_ID)) {
      const mi = doc.createXULElement('menuitem')
      mi.id = this.TOOLS_ID
      mi.setAttribute('label', 'PaperMind 连接设置…')
      mi.addEventListener('command', () => this.promptSettings(win))
      toolsMenu.appendChild(mi)
    }
  },

  removeFromWindow(win) {
    const doc = win.document
    for (const id of [this.MENU_ID, this.TOOLS_ID]) {
      const el = doc.getElementById(id)
      if (el) el.remove()
    }
  },
}

// ── bootstrap entry points ──────────────────────────────────

function install() {}

async function startup({ rootURI }) {
  await Zotero.initializationPromise
  for (const win of Zotero.getMainWindows()) {
    PaperMind.addToWindow(win)
  }
}

function onMainWindowLoad({ window }) {
  PaperMind.addToWindow(window)
}

function onMainWindowUnload({ window }) {
  PaperMind.removeFromWindow(window)
}

function shutdown() {
  if (typeof Zotero !== 'undefined') {
    for (const win of Zotero.getMainWindows()) {
      PaperMind.removeFromWindow(win)
    }
  }
}

function uninstall() {}
