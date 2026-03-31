/**
 * API 工具：自动附加用户 ID 到所有请求
 */

const API_BASE = '/api'

function getUserId() {
  let uid = localStorage.getItem('papermind-uid')
  if (!uid) {
    uid = crypto.randomUUID()
    localStorage.setItem('papermind-uid', uid)
  }
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

export { API_BASE, getUserId }
