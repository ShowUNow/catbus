import { CatbusError, toCatbusError } from '../../../core/errors.js'
import { cookieCredential, finishLogin, freshCredential, loginContext, poll, showQrcode } from '../../../core/login.js'
import * as n from '../../../core/normalize.js'
import type { AuthStatus, Credential, Item, UserRef } from '../../../core/schemas.js'
import { authError, isGuest, paged } from '../../../core/toolkit.js'
import type { HandlerContext } from '../../../core/registry.js'
import * as api from './api.js'
import { Tt } from './client.js'
import * as login from './login.js'

type Ctx = HandlerContext

const COOKIE_HINT = '从已登录浏览器的请求头复制 Cookie：catbus toutiao auth login --method cookie --cookie "<Cookie>"'

function client(ctx: Ctx): Tt {
  return new Tt(ctx)
}

async function loginStatusOf(p: Tt): Promise<any | null> {
  const d = await api.loginStatus(p)
  if (d?.code === 0 && d?.data?.is_login) return { ...d.data, ...d.data.media }
  return null
}

// ================================================================ auth

export async function authLogin(ctx: Ctx) {
  const method = ctx.options.method as string
  if (method === 'cookie') return loginCookie(ctx)
  if (method === 'qrcode') return loginQrcode(ctx)
  throw new CatbusError('USAGE', `不支持的登录方式：${method}`)
}

async function loginCookie(ctx: Ctx) {
  const credential = cookieCredential(ctx, '.toutiao.com')
  const p = new Tt(loginContext(ctx, credential))
  const d = await loginStatusOf(p)
  if (!d) throw new CatbusError('AUTH_REQUIRED', 'Cookie 未通过登录校验（user_login_status_api）', { hint: COOKIE_HINT })
  return finishLogin(loginContext(ctx, credential), credential, userRefOf(d))
}

async function loginQrcode(ctx: Ctx) {
  const credential = freshCredential(ctx, 'qrcode')
  const loginCtx = loginContext(ctx, credential)
  const p = new Tt(loginCtx)
  await login.ensureTtwid(p)
  const qr = await login.createQrcode(p)
  await showQrcode(ctx, qr.link, '请用今日头条 App 扫码并在手机上确认')
  let told = false
  const confirmed = await poll(
    async () => {
      const s = await login.checkQrcode(p, qr.token)
      if (s.kind === 'confirmed') return s
      if (s.kind === 'expired') throw new CatbusError('AUTH_REQUIRED', '二维码已过期', { hint: '重新执行 catbus toutiao auth login' })
      if (s.kind === 'scanned' && !told) {
        told = true
        ctx.log.info('已扫码，请在手机上确认')
      }
      return undefined
    },
    { interval: 1, timeout: 600, what: '扫码确认' },
  )
  await login.complete(p, confirmed.redirectUrl)
  const d = await loginStatusOf(p)
  if (!d) throw new CatbusError('AUTH_REQUIRED', '扫码后登录态校验未通过')
  return finishLogin(loginCtx, credential, userRefOf(d))
}

function userRefOf(d: any): UserRef {
  const name = d?.screen_name ?? d?.media_name ?? d?.name ?? null
  const id = String(d?.user_id ?? d?.user_id_str ?? d?.id ?? '')
  return n.userRef({ id: id || 'me', name })!
}

export async function authStatus(ctx: Ctx): Promise<AuthStatus> {
  if (isGuest(ctx)) return { logged_in: false, user: null, method: null, expires_at: null }
  try {
    const d = await loginStatusOf(client(ctx))
    return {
      logged_in: Boolean(d),
      user: d ? userRefOf(d) : null,
      method: d ? ctx.credential.method : null,
      expires_at: null,
    }
  } catch (err) {
    const e = toCatbusError(err) as CatbusError
    if (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_EXPIRED') return { logged_in: false, user: null, method: null, expires_at: null }
    throw err
  }
}

// ================================================================ keyword / item

/** 热榜（匿名可用）。 */
export async function keywordHot(ctx: Ctx) {
  const entries = await api.hotBoard(client(ctx))
  return entries.map((e) => ({
    id: e.ClusterId,
    keyword: e.Title,
    url: e.Url || null,
    hot: n.count(e.HotValue),
    raw: e,
  }))
}

/** 草稿列表映射到 item list（创作者视角；头条暂只有草稿读取这一稳定只读面）。 */
export async function itemList(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const drafts = await api.listDrafts(client(ctx))
  return paged((drafts as any[]).map((d) => draftItem(d)), null, false)
}

export async function itemDelete(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const gid = ctx.args.item!
  const data = await api.deleteDraft(client(ctx), gid, 'article')
  if (data?.code !== 0) throw new CatbusError('UPSTREAM', `删除草稿失败：code=${data?.code}`, { detail: data?.message })
  return { deleted: gid }
}

function draftItem(d: any): Item {
  const id = String(d.gid ?? d.id ?? d.article_id ?? '')
  return n.item({
    id: id || String(d.draft_id ?? ''),
    kind: 'article',
    title: n.str(d.title) ?? '',
    status: 'draft',
    created_at: n.time(d.create_time) ?? n.time(d.modified_time),
  })
}

// ================================================================ 中继模式（--relay）

import { DEFAULT_RELAY, Relay, relayItemGet, relayItemSearch } from './relay.js'
import { relayItemPublish } from './publish.js'

function relayOf(ctx: Ctx): Relay {
  return new Relay(String(ctx.options.relay ?? DEFAULT_RELAY))
}

/** --relay：浏览器中继读作品（环境级风控下唯一可用路径）。 */
export async function itemGet(ctx: Ctx) {
  const relay = relayOf(ctx)
  try {
    const item = await relayItemGet(relay, ctx.args.item!)
    return n.item({
      id: (item.url.match(/\/(?:article|video|item|group)\/(\d+)/) ?? [])[1] ?? item.url,
      kind: item.type === 'video' ? 'video' : 'article',
      title: item.title,
      text: item.text || null,
      url: item.url,
      cover: item.images[0] ?? null,
      media: item.contentUrl ? [n.media({ type: 'video', url: item.contentUrl, id: null })] : [],
    })
  } finally {
    relay.close()
  }
}

/** --relay：浏览器中继搜索（挑战未过时显式报错）。 */
export async function itemSearch(ctx: Ctx) {
  const relay = relayOf(ctx)
  try {
    const r = await relayItemSearch(relay, ctx.args.keyword!)
    return paged(
      r.links.map((l) => n.item({ id: l.id, kind: l.kind === 'video' ? 'video' : 'article', title: l.title, url: l.url })),
      null,
      false,
    )
  } finally {
    relay.close()
  }
}

/** --relay：编辑器自动化发布（编辑器签名不可纯 HTTP 复刻的替代路径）。 */
export async function itemPublish(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const title = String(ctx.options.title ?? '')
  const text = String(ctx.options.text ?? '')
  if (!title || !text) throw new CatbusError('USAGE', '需要 --title 与 --text')
  const relay = relayOf(ctx)
  try {
    return await relayItemPublish(relay, title, text)
  } finally {
    relay.close()
  }
}
