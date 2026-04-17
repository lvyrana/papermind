/**
 * API 工具：自动附加用户 ID 到所有请求
 */

const API_BASE = '/api'
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
  // 365 天，路径根目录，SameSite=Lax
  const expires = new Date(Date.now() + 365 * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`
}

function getUserId() {
  // 优先读 localStorage，其次 cookie，两者都写入保证跨设备恢复
  let uid = null
  try { uid = localStorage.getItem('papermind-uid') } catch {}
  if (!uid) uid = getCookie('papermind-uid')

  if (!uid) {
    uid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackUuid()
  }

  try { localStorage.setItem('papermind-uid', uid) } catch {}
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

export async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: headers() })
  return handleResponse(r)
}

export async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return handleResponse(r)
}

export async function apiDelete(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: headers(),
  })
  return handleResponse(r)
}

export async function apiGetRaw(path) {
  return fetch(`${API_BASE}${path}`, { headers: headers() })
}

function setUserId(uid) {
  try { localStorage.setItem('papermind-uid', uid) } catch {}
  setCookie('papermind-uid', uid)
}

export { API_BASE, getUserId, setUserId }
