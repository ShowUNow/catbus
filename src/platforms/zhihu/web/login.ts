import { CatbusError } from '../../../core/errors.js'
import type { Zh } from './client.js'
import { WWW } from './client.js'

/**
 * 知乎二维码登录（移植自上游 apis/zhihu_http_auth.py，契约经 2026-10-25 真机抓包复核）：
 *
 * POST /udid 种设备 → POST /api/v3/account/api/login/qrcode 拿 token+link（QR 内容，
 * 约 2 分钟过期）→ GET .../qrcode/{token}/scan_info 2s 轮询（status=0 等待；
 * status=5 + new_token 过期自动换码；确认拍响应直接带 access_token/refresh_token
 * 并 Set-Cookie z_c0——无需任何加密）。
 */

export interface QrChallenge {
  token: string
  link: string
  expiresAt: number | null
}

export async function udid(p: Zh): Promise<void> {
  await p.request({ method: 'POST', url: `${WWW}/udid`, headers: { referer: `${WWW}/signin` }, form: {} })
}

export async function createQrcode(p: Zh): Promise<QrChallenge> {
  const data = await p.json({
    method: 'POST',
    url: `${WWW}/api/v3/account/api/login/qrcode`,
    headers: { referer: `${WWW}/signin`, origin: WWW },
    form: {},
  })
  const token = data?.token
  const link = data?.link
  if (!token || !link) throw new CatbusError('UPSTREAM', '建码响应缺少 token/link', { detail: data })
  return { token: String(token), link: String(link), expiresAt: data?.expires_at ?? null }
}

export type QrState =
  | { kind: 'waiting' }
  | { kind: 'rotated'; token: string; link: string }
  | { kind: 'confirmed'; access_token: string; user_id: string }

/** 一次轮询。确认拍返回的 access_token/user_id 表示登录完成（z_c0 已入 Cookie 罐）。 */
export async function checkQrcode(p: Zh, token: string): Promise<QrState> {
  const data = await p.json({
    url: `${WWW}/api/v3/account/api/login/qrcode/${token}/scan_info`,
    headers: { referer: `${WWW}/signin` },
  })
  const status = Number(data?.status ?? -1)
  if (data?.access_token) {
    return { kind: 'confirmed', access_token: String(data.access_token), user_id: String(data.user_id ?? '') }
  }
  if (status === 5 && data?.new_token?.Token) {
    return { kind: 'rotated', token: String(data.new_token.Token), link: String(data.new_token.Link ?? '') }
  }
  return { kind: 'waiting' }
}
