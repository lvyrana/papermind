/**
 * PaperMind Connector — Zotero 插件
 *
 * 在文献右键菜单加一项「用 PaperMind 精读」：
 *   1. 读取选中条目的元数据 + 最佳 PDF 附件
 *   2. POST 到 PaperMind（/api/library/save + /api/library/{id}/pdf）
 *   3. 用默认浏览器打开 PaperMind 阅读页（带 ?uid= 自动认领设备身份）
 *
 * 首次使用会弹窗要求粘贴 PaperMind 设置页复制的专属链接。
 * 线上私密预览还需填写一次预览账号和密码；本地开发可留空。
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
  PREF_USERNAME: 'extensions.papermind.username',
  PREF_PASSWORD: 'extensions.papermind.password',
  PREF_CONFIG_VERSION: 'extensions.papermind.configVersion',
  CONFIG_VERSION: 2,
  DEFAULT_BASE: 'https://papermindapp.com',

  log(msg) {
    Zotero.debug('[papermind] ' + msg)
  },

  getBaseURL() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_BASE, true) } catch (e) { /* unset */ }
    return (v || this.DEFAULT_BASE).replace(/\/+$/, '')
  },

  getUid() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_UID, true) } catch (e) { /* unset */ }
    return v || ''
  },

  getUsername() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_USERNAME, true) } catch (e) { /* unset */ }
    return v || ''
  },

  getPassword() {
    let v = ''
    try { v = Zotero.Prefs.get(this.PREF_PASSWORD, true) } catch (e) { /* unset */ }
    return v || ''
  },

  getConfigVersion() {
    let v = 0
    try { v = Number(Zotero.Prefs.get(this.PREF_CONFIG_VERSION, true)) } catch (e) { /* unset */ }
    return v || 0
  },

  isValidUid(uid) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid || '')
  },

  isLocalBase(base) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base || '')
  },

  isConfigured() {
    const base = this.getBaseURL()
    const hasAuth = Boolean(this.getUsername() && this.getPassword())
    return this.getConfigVersion() >= this.CONFIG_VERSION
      && this.isValidUid(this.getUid())
      && (this.isLocalBase(base) || hasAuth)
  },

  authHeaders(win) {
    const username = this.getUsername()
    const password = this.getPassword()
    if (!username || !password) return {}

    const bytes = new win.TextEncoder().encode(username + ':' + password)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { Authorization: 'Basic ' + win.btoa(binary) }
  },

  requestHeaders(win, extra = {}) {
    return {
      ...this.authHeaders(win),
      'X-User-ID': this.getUid(),
      ...extra,
    }
  },

  async readError(resp) {
    try {
      const text = (await resp.text()).slice(0, 500)
      if (!text) return ''
      try {
        const data = JSON.parse(text)
        return data.detail || data.error || ''
      } catch (e) {
        return text.slice(0, 160)
      }
    } catch (e) { return '' }
  },

  async requireOk(resp, action) {
    if (resp.ok) return resp

    const detail = await this.readError(resp)
    const err = new Error(`${action}失败（HTTP ${resp.status}${detail ? '：' + detail : ''}）`)
    err.status = resp.status
    throw err
  },

  connectionMessage(error, base) {
    if (error && error.status === 401) {
      return '连接未通过认证。请打开 Zotero「工具 → PaperMind 连接设置…」，检查专属链接、预览账号和密码。'
    }
    if (error && error.status === 403) {
      return '当前设备没有这项操作权限。请重新粘贴 PaperMind 设置页里的“我的专属链接”。'
    }
    if (this.isLocalBase(base)) {
      return '插件仍在连接本机开发地址。请打开 Zotero「工具 → PaperMind 连接设置…」，改为线上专属链接。'
    }
    return `无法连接 ${base}。请检查网络后再试，或在 Zotero「工具 → PaperMind 连接设置…」重新连接。`
  },

  parsePersonalLink(win, rawLink) {
    let url
    try {
      url = new win.URL(rawLink.trim())
    } catch (e) {
      throw new Error('链接格式不正确。请直接粘贴 PaperMind 设置页复制的完整专属链接。')
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('链接必须以 http:// 或 https:// 开头。')
    }
    const uid = (url.searchParams.get('uid') || '').trim().toLowerCase()
    if (!this.isValidUid(uid)) {
      throw new Error('链接里没有有效的设备 ID。请在 PaperMind「设置」页点击“复制我的专属链接”后再粘贴。')
    }
    return { base: url.origin, uid }
  },

  async promptSettings(win) {
    const ps = Services.prompt

    const currentUid = this.getUid()
    const currentBase = this.getBaseURL()
    const link = {
      value: this.isValidUid(currentUid)
        ? `${currentBase}/?uid=${currentUid}`
        : this.DEFAULT_BASE,
    }
    if (!ps.prompt(win, 'PaperMind 连接设置',
      '打开 PaperMind → 设置 → 点击“复制我的专属链接”，然后粘贴到这里：', link, null, {})) {
      return false
    }

    let parsed
    try {
      parsed = this.parsePersonalLink(win, link.value)
    } catch (e) {
      ps.alert(win, 'PaperMind', e.message)
      return false
    }

    let username = ''
    let password = ''
    if (!this.isLocalBase(parsed.base)) {
      const usernameBox = { value: this.getUsername() || 'papermind' }
      if (!ps.prompt(win, 'PaperMind 连接设置',
        '线上私密预览账号：', usernameBox, null, {})) {
        return false
      }
      username = usernameBox.value.trim()

      const passwordBox = { value: this.getPassword() }
      if (!ps.promptPassword(win, 'PaperMind 连接设置',
        '线上私密预览密码（只需在这台电脑设置一次）：', passwordBox, null, {})) {
        return false
      }
      password = passwordBox.value
      if (!username || !password) {
        ps.alert(win, 'PaperMind', '线上连接需要填写预览账号和密码。')
        return false
      }
    }

    Zotero.Prefs.set(this.PREF_BASE, parsed.base, true)
    Zotero.Prefs.set(this.PREF_UID, parsed.uid, true)
    Zotero.Prefs.set(this.PREF_USERNAME, username, true)
    Zotero.Prefs.set(this.PREF_PASSWORD, password, true)
    Zotero.Prefs.set(this.PREF_CONFIG_VERSION, this.CONFIG_VERSION, true)

    try {
      const resp = await win.fetch(parsed.base + '/api/settings', {
        headers: this.requestHeaders(win),
      })
      await this.requireOk(resp, '连接测试')
      ps.alert(win, 'PaperMind', '连接成功。现在可以右键文献 →「用 PaperMind 精读」。')
    } catch (e) {
      this.log('connection test failed: ' + e)
      ps.alert(win, 'PaperMind',
        this.connectionMessage(e, parsed.base) + '\n\n技术信息：' + e.message)
      return false
    }
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

    if (!this.isConfigured() && !await this.promptSettings(win)) return
    const base = this.getBaseURL()
    const uid = this.getUid()

    try {
      // 1. 保存元数据到 PaperMind 收藏库
      const saveResp = await win.fetch(base + '/api/library/save', {
        method: 'POST',
        headers: this.requestHeaders(win, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ paper: this.buildPaper(item), chats: [] }),
      })
      await this.requireOk(saveResp, '保存文献')
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
              headers: this.requestHeaders(win),
              body: fd,
            })
            await this.requireOk(upResp, '上传 PDF')
            this.log('pdf upload HTTP ' + upResp.status)
          }
        }
      } catch (e) {
        this.log('pdf upload skipped: ' + e)
      }

      // 3. 打开浏览器进入阅读页（?uid= 让新浏览器自动继承设备身份）
      Zotero.launchURL(`${base}/paper/${saved.id}?uid=${encodeURIComponent(uid)}`)
    } catch (e) {
      this.log('openSelected failed: ' + e)
      Services.prompt.alert(win, 'PaperMind',
        '发送失败：' + e.message + '\n\n' + this.connectionMessage(e, base))
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
      mi.addEventListener('command', () => { void this.promptSettings(win) })
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
