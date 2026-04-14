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

function getUserId() {
  try {
    let uid = localStorage.getItem('papermind-uid')
    if (!uid) {
      uid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : fallbackUuid()
      localStorage.setItem('papermind-uid', uid)
    }
    return uid
  } catch {
    // 某些移动浏览器 / 隐私模式下 localStorage 可能不可用，退回到内存 UID
    if (!memoryUid) {
      memoryUid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : fallbackUuid()
    }
    return memoryUid
  }
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

export { API_BASE, getUserId }
