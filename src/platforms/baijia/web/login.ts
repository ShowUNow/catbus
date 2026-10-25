import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CatbusError } from '../../../core/errors.js'
import { poll } from '../../../core/login.js'
import { cacheDir } from '../../../core/paths.js'
import { now } from '../../../core/rand.js'
import type { Credential } from '../../../core/schemas.js'
import type { Bc } from './client.js'
import { PASSPORT, WEB } from './client.js'

/**
 * 百家号二维码登录（移植自上游 baijia_apis/auth.py 的 BaijiaQRCodeLogin，契约经
 * 2026-10-24 真机抓包复核：allocTk 建站会话 → getqrcode 出码 → channel/unicast 轮询
 * （服务端 hold 约 30s 后回 errno=1 空结果）→ 手机确认后 channel_v 带 v 票据 →
 * v3/login/main/qrbdusslogin 换 BDUSS/STOKEN 全族 Cookie）。
 *
 * 状态语义（真机抓包）：errno=1 等待；errno=0 且 channel_v.status=1 已扫未确认；
 * errno=0 且 channel_v 带 v 票据为已确认。
 */

const POLL_SECONDS = 35

/** 会话引导：登录页种下 BAIDUID / PHPSESSID / theme 等（上游 bootstrap）。 */
export async function bootstrap(p: Bc): Promise<void> {
  await p.request({ url: `${WEB}/builder/theme/bjh/login`, redirect: 'follow' })
  await p.json({ method: 'POST', url: `${WEB}/user-ui/cms/allocTk`, form: {} })
}

export interface QrChallenge {
  sign: string
  /** QR PNG 字节（passport 服务端渲染，内容不可再生成为字符串）。 */
  png: Uint8Array
}

/** 出码：getqrcode 返回 sign + 图片地址，再取图片字节。 */
export async function createQrcode(p: Bc): Promise<QrChallenge> {
  const guid = makeGuid()
  const callback = `tangram_guid_${Date.now()}`
  const data = await p.jsonp({
    url: `${PASSPORT}/v2/api/getqrcode`,
    query: { lp: 'pc', qrloginfrom: 'pc', gid: guid, oauthLog: '', callback },
    headers: { referer: `${WEB}/`, accept: '*/*' },
  })
  if (data.errno !== 0 || !data.sign) {
    throw new CatbusError('AUTH_REQUIRED', `获取二维码失败：errno=${data.errno}`, { detail: data })
  }
  const img = await p.request({ url: `https://${String(data.imgurl).replace(/^https?:\/\//, '')}` })
  if (img.status !== 200) throw new CatbusError('UPSTREAM', `二维码图片 HTTP ${img.status}`)
  const ab = await (await img.arrayBuffer())
  return { sign: String(data.sign), png: new Uint8Array(ab) }
}

/** 一次轮询；返回 state 与确认票据（已确认时非空）。 */
export async function pollQrcode(p: Bc, sign: string, guid: string): Promise<{ state: 'waiting' | 'scanned' | 'approved'; ticket?: string }> {
  const ts = now()
  const callback = `tangram_guid_${ts}`
  const data = await p.jsonp({
    url: `${PASSPORT}/channel/unicast`,
    query: {
      channel_id: sign,
      gid: guid,
      tpl: 'bjh',
      _sdkFrom: '1',
      callback,
      apiver: 'v3',
      tt: String(ts),
      _: String(ts),
    },
    headers: { referer: `${WEB}/`, accept: '*/*' },
    timeout: POLL_SECONDS + 5,
  })
  const errno = Number(data.errno)
  let channel: any = data.channel_v
  if (typeof channel === 'string') {
    try {
      channel = JSON.parse(channel)
    } catch {
      channel = {}
    }
  }
  if (errno === 1) return { state: 'waiting' }
  if (errno === 2 || errno === 3) throw new CatbusError('AUTH_REQUIRED', '二维码已过期', { hint: '重新执行 catbus baijia auth login' })
  if (errno === 0) {
    const ticket = typeof channel?.v === 'string' && channel.v ? channel.v : ''
    return ticket ? { state: 'approved', ticket } : { state: 'scanned' }
  }
  return { state: 'waiting' }
}

/** 确认票据 → 登录 Cookie（qrbdusslogin；Set-Cookie 由客户端自动入罐）。 */
export async function complete(p: Bc, sign: string, ticket: string, user: string): Promise<string> {
  const ts = now()
  const data = await p.jsonp({
    url: `${PASSPORT}/v3/login/main/qrbdusslogin`,
    query: {
      v: String(ts),
      bduss: ticket,
      u: user || `https://${WEB.replace(/^https?:\/\//, '')}`,
      loginVersion: 'v4',
      qrcode: '1',
      tpl: 'bjh',
      callback: `tangram_guid_${ts}`,
      _: String(ts),
    },
    headers: { referer: `${WEB}/`, accept: '*/*' },
  })
  const no = Number(data?.errInfo?.no ?? data?.errno ?? -1)
  if (no !== 0 && no !== 200) {
    throw new CatbusError('AUTH_REQUIRED', `扫码登录失败：errno=${no}`, { detail: data })
  }
  return String(data?.url ?? '')
}

/** gid：上游格式的 36 位 UUID 变体（8-4-4-4-12 大写）。 */
function makeGuid(): string {
  const hex = '0123456789ABCDEF'
  const block = (n: number) =>
    Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]).join('')
  return `${block(8)}-${block(4)}-${block(4)}-${block(4)}-${block(12)}`
}

/** 把服务端渲染的 QR PNG 存到 cache 并返回路径（浏览器打开后扫码）。 */
export async function saveQrPng(platformId: string, png: Uint8Array): Promise<string> {
  const path = join(cacheDir(platformId), 'qrcode.png')
  await writeFile(path, png)
  return path
}
