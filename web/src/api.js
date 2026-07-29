/**
 * API 工具：自动附加用户 ID 到所有请求
 */

const API_BASE = '/api'
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let memoryUid = ''

function fallbackUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function setCookie(name, value) {
  // 365 天，路径根目录，生产 HTTPS 下同时启用 Secure。
  const expires = new Date(Date.now() + 365 * 864e5).toUTCString()
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${secure}`
}

// 专属链接和 Zotero 深链会显式认领同一匿名身份；普通新设备仍会生成独立 UUID。
let uidSwitchedViaUrl = false
try {
  const urlUid = new URLSearchParams(window.location.search).get('uid')
  if (urlUid && DEVICE_ID_PATTERN.test(urlUid)) {
    let prev = null
    try { prev = localStorage.getItem('papermind-uid') } catch { /* ignore */ }
    prev = prev || getCookie('papermind-uid')
    if (prev && prev !== urlUid) uidSwitchedViaUrl = true
    memoryUid = urlUid
    try { localStorage.setItem('papermind-uid', urlUid) } catch { /* ignore */ }
    setCookie('papermind-uid', urlUid)
  }
} catch { /* ignore */ }

function consumeUidSwitchFlag() {
  const value = uidSwitchedViaUrl
  uidSwitchedViaUrl = false
  return value
}

function getUserId() {
  // 优先读 localStorage，其次 cookie，两者都写入保证跨设备恢复
  let uid = memoryUid || null
  try {
    uid = uid || localStorage.getItem('papermind-uid')
  } catch {
    // localStorage may be unavailable in privacy-restricted browsers.
  }
  if (!uid) uid = getCookie('papermind-uid')
  if (uid && !DEVICE_ID_PATTERN.test(uid)) uid = null

  if (!uid) {
    uid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackUuid()
  }

  memoryUid = uid
  try {
    localStorage.setItem('papermind-uid', uid)
  } catch {
    // Cookie and memory fallbacks keep the app usable.
  }
  setCookie('papermind-uid', uid)

  return uid
}

function headers(extra = {}) {
  return {
    'X-User-ID': getUserId(),
    ...extra,
  }
}

async function handleResponse(r) {
  if (!r.ok) {
    throw new Error(`API error: ${r.status} ${r.statusText}`)
  }
  return r.json()
}

async function fetchWithTimeout(url, init, timeoutMs = 0) {
  if (!timeoutMs) return fetch(url, init)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

export async function apiGet(path, { timeoutMs = 0 } = {}) {
  const r = await fetchWithTimeout(`${API_BASE}${path}`, { headers: headers() }, timeoutMs)
  return handleResponse(r)
}

export async function apiPost(path, body, { timeoutMs = 0 } = {}) {
  const r = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }, timeoutMs)
  return handleResponse(r)
}

export async function apiDelete(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: headers(),
  })
  return handleResponse(r)
}

export async function apiPatch(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return handleResponse(r)
}

export async function apiGetRaw(path) {
  return fetch(`${API_BASE}${path}`, { headers: headers() })
}

function setUserId(uid) {
  memoryUid = uid
  try {
    localStorage.setItem('papermind-uid', uid)
  } catch {
    // Cookie and memory fallbacks keep the app usable.
  }
  setCookie('papermind-uid', uid)
}

function clearUserId() {
  memoryUid = ''
  try {
    localStorage.removeItem('papermind-uid')
  } catch {
    // The expired cookie is enough when localStorage is unavailable.
  }
  document.cookie = 'papermind-uid=; Max-Age=0; path=/; SameSite=Lax'
}

export { API_BASE, getUserId, setUserId, clearUserId, consumeUidSwitchFlag }
