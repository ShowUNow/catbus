import { CatbusError } from '../../../core/errors.js'
import type { Tt } from './client.js'
import { MP, SSO } from './client.js'

/**
 * 头条号 SSO 二维码登录（移植自上游 builder/passport.py，契约经 2026-10-25 真机抓包复核）：
 *
 * ttwid bootstrap（mp 站会话）→ sso/get_qrcode 拿 token → check_qrconnect 1s 短轮询
 * （status 字符串：3=已确认，带 redirect_url?ticket；其余等待）→ 跟随 redirect
 * （mp.toutiao.com/passport/sso/login/callback/?ticket=... → 302 落 profile_v4，
 * Set-Cookie 写入 sessionid 族 28 个 Cookie）。
 */

export const SERVICE = `${MP}/profile_v4/`

/** 上游 _ensure_ttwid：HEAD mp 站 → ttwid/union/register → callback。 */
export async function ensureTtwid(p: Tt): Promise<void> {
  await p.request({ url: `${MP}/`, redirect: 'follow' })
  const reg = await p.json({
    method: 'POST',
    url: 'https://ttwid.bytedance.com/ttwid/union/register/',
    json: { aid: 24, service: 'www.toutiao.com', region: 'cn', union: true, needFid: false },
    headers: { 'content-type': 'application/json', origin: 'https://www.toutiao.com', referer: 'https://www.toutiao.com/' },
  })
  const redirectUrl: string | undefined = reg?.redirect_url
  if (!redirectUrl) throw new CatbusError('UPSTREAM', 'ttwid 注册没有返回回调地址')
  const host = new URL(redirectUrl).hostname
  if (host !== 'www.toutiao.com') throw new CatbusError('UPSTREAM', `ttwid 回调离开了头条域：${host}`)
  await p.request({ url: redirectUrl, redirect: 'follow' })
}

export interface QrChallenge {
  token: string
  /** 扫码链接（QR 内容）。 */
  link: string
}

export async function createQrcode(p: Tt): Promise<QrChallenge> {
  const data = await p.json({
    url: `${SSO}/get_qrcode/`,
    query: {
      service: encodeURIComponent(SERVICE),
      need_logo: 'true',
      ui_version: '3.3.2',
      aid: '1231',
      account_sdk_source: 'sso',
      sdk_version: '2.2.6',
      language: 'zh',
    },
    headers: { referer: `${MP}/`, origin: MP },
  })
  const token = data?.data?.token ?? data?.token
  const link = data?.data?.link ?? data?.qr_image_url ?? data?.link
  if (!token || !link) throw new CatbusError('UPSTREAM', 'get_qrcode 响应缺少 token/link', { detail: data })
  return { token: String(token), link: String(link) }
}

export type QrState =
  | { kind: 'waiting' }
  | { kind: 'scanned' }
  | { kind: 'expired' }
  | { kind: 'confirmed'; redirectUrl: string }

/** 一次 1s 短轮询（浏览器节律）。status=3 且带 redirect_url 为确认。 */
export async function checkQrcode(p: Tt, token: string): Promise<QrState> {
  const data = await p.json({
    url: `${SSO}/check_qrconnect/`,
    query: {
      service: encodeURIComponent(SERVICE),
      token,
      need_logo: 'true',
      ui_version: '3.3.2',
      aid: '1231',
      account_sdk_source: 'sso',
      sdk_version: '2.2.6',
    },
    headers: { referer: `${MP}/`, origin: MP },
  })
  if (data?.error_code !== 0 && data?.error_code !== undefined && data?.error_code !== 0) {
    throw new CatbusError('UPSTREAM', `check_qrconnect 错误：${data?.error_code}`, { detail: data })
  }
  const d = data?.data ?? {}
  const status = String(d.status ?? '')
  if (d.redirect_url) return { kind: 'confirmed', redirectUrl: String(d.redirect_url) }
  if (status === '3') {
    throw new CatbusError('UPSTREAM', 'check_qrconnect status=3 但没有 redirect_url', { detail: data })
  }
  if (status === '1' || status === '2') return { kind: 'scanned' }
  if (status === '4' || status === '5') return { kind: 'expired' }
  return { kind: 'waiting' }
}

/** 确认后的换票：跟随 redirect_url（callback 302 落地，Cookie 全程入罐）。 */
export async function complete(p: Tt, redirectUrl: string): Promise<string> {
  const host = new URL(redirectUrl).hostname
  if (host !== 'mp.toutiao.com' && host !== 'sso.toutiao.com') {
    throw new CatbusError('UPSTREAM', `SSO 跳转离开了头条登录域：${host}`)
  }
  const res = await p.request({ url: redirectUrl, redirect: 'follow' })
  const finalUrl = res.url ?? ''
  if (!res.ok) throw new CatbusError('UPSTREAM', `登录回调 HTTP ${res.status}`)
  return finalUrl
}
