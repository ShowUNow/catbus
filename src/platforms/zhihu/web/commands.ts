import { CatbusError, toCatbusError } from '../../../core/errors.js'
import { cookieCredential, finishLogin, freshCredential, loginContext, poll, showQrcode } from '../../../core/login.js'
import * as n from '../../../core/normalize.js'
import type { AuthStatus, Credential, UserRef } from '../../../core/schemas.js'
import { authError, isGuest, paged } from '../../../core/toolkit.js'
import type { HandlerContext } from '../../../core/registry.js'
import * as api from './api.js'
import { Zh } from './client.js'
import * as login from './login.js'

type Ctx = HandlerContext

const COOKIE_HINT = '从已登录浏览器的请求头复制 Cookie：catbus zhihu auth login --method cookie --cookie "<Cookie>"'

function client(ctx: Ctx): Zh {
  return new Zh(ctx)
}

// ================================================================ auth

export async function authLogin(ctx: Ctx) {
  const method = ctx.options.method as string
  if (method === 'cookie') return loginCookie(ctx)
  if (method === 'qrcode') return loginQrcode(ctx)
  throw new CatbusError('USAGE', `不支持的登录方式：${method}`)
}

async function loginCookie(ctx: Ctx) {
  const credential = cookieCredential(ctx, '.zhihu.com')
  const p = new Zh(loginContext(ctx, credential))
  const me = await api.me(p)
  if (!me) throw new CatbusError('AUTH_REQUIRED', 'Cookie 未通过登录校验（/api/v4/me）', { hint: COOKIE_HINT })
  return finishLogin(loginContext(ctx, credential), credential, userRefOf(me))
}

async function loginQrcode(ctx: Ctx) {
  const credential = freshCredential(ctx, 'qrcode')
  const loginCtx = loginContext(ctx, credential)
  const p = new Zh(loginCtx)
  await login.udid(p)
  let qr = await login.createQrcode(p)
  const confirmed = await poll(
    async () => {
      await showQrcode(ctx, qr.link, '请用知乎 App 扫码并在手机上确认（二维码约 2 分钟自动换新）')
      const s = await login.checkQrcode(p, qr.token)
      if (s.kind === 'confirmed') return s
      if (s.kind === 'rotated') {
        qr = { token: s.token, link: s.link, expiresAt: null }
        ctx.log.info('二维码已过期，换新码')
      }
      return undefined
    },
    { interval: 2, timeout: 600, what: '扫码确认' },
  )
  const me = await api.me(p)
  if (!me) throw new CatbusError('AUTH_REQUIRED', '扫码后 /api/v4/me 未通过（z_c0 可能未落）')
  return finishLogin(loginCtx, credential, userRefOf(me))
}

function userRefOf(me: any): UserRef {
  return n.userRef({ id: String(me.id ?? me.url_token ?? ''), name: me.name ?? null })!
}

export async function authStatus(ctx: Ctx): Promise<AuthStatus> {
  if (isGuest(ctx)) return { logged_in: false, user: null, method: null, expires_at: null }
  try {
    const me = await api.me(client(ctx))
    return { logged_in: Boolean(me), user: me ? userRefOf(me) : null, method: me ? ctx.credential.method : null, expires_at: null }
  } catch (err) {
    const e = toCatbusError(err) as CatbusError
    if (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_EXPIRED') return { logged_in: false, user: null, method: null, expires_at: null }
    throw err
  }
}

// ================================================================ item

/** 综合搜索；卡片形态按 type 归一（answer/article/topic/user 等）。 */
export async function itemSearch(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const page = Number(ctx.cursor ?? 0) || 0
  const data = await api.search(client(ctx), ctx.args.keyword!, page, 20)
  const items = data.map(cardOf).filter(Boolean)
  return paged(items, page + 20, data.length >= 20)
}

function cardOf(card: any): ReturnType<typeof n.item> | null {
  const obj = card?.object ?? card
  const type = String(obj?.type ?? '')
  const id = String(obj?.id ?? '')
  if (!id) return null
  const kind = type === 'article' ? 'article' : 'text'
  const title = obj?.title ?? obj?.question?.name ?? null
  const author = obj?.author?.name ? n.userRef({ id: String(obj.author.id ?? obj.author.url_token ?? ''), name: obj.author.name }) : null
  return n.item({
    id,
    kind,
    title,
    text: obj?.excerpt ?? obj?.content ?? null,
    url: obj?.url ?? null,
    author,
    created_at: obj?.created_time ? n.time(obj.created_time * 1000) : obj?.updated_time ? n.time(obj.updated_time * 1000) : null,
  })
}

// ================================================================ item 详情 / 发布 / 删除

export async function itemGet(ctx: Ctx) {
  const { kind, id } = api.resolveItem(ctx.args.item!)
  const p = client(ctx)
  const c = kind === 'answer' ? await api.getAnswer(p, id) : await api.getArticle(p, id)
  return n.item({
    id: c.id,
    kind: 'article',
    title: c.title,
    text: c.text || c.excerpt || null,
    url: c.url,
    author: c.author ? n.userRef({ id: c.author.id, name: c.author.name }) : null,
    created_at: c.created_at ? n.time(c.created_at * 1000) : null,
  })
}

export async function itemPublish(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const p = client(ctx)
  const title = String(ctx.options.title ?? '')
  const text = String(ctx.options.text ?? '')
  if (!title || !text) throw new CatbusError('USAGE', '需要 --title 与 --text')
  const html = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
  const draftId = await api.createDraft(p, title)
  await api.saveDraftContent(p, draftId, title, html)
  if (ctx.options.draft === true) {
    return { published: false, draft_id: draftId, edit_url: `https://zhuanlan.zhihu.com/p/${draftId}/edit` }
  }
  const articleId = await api.publishDraft(p, draftId, title, html)
  return { published: true, article_id: articleId, url: `https://zhuanlan.zhihu.com/p/${articleId}` }
}

export async function itemDelete(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const { kind, id } = api.resolveItem(ctx.args.item!)
  if (kind !== 'article') throw new CatbusError('USAGE', '删除当前只支持专栏文章（URL 或 zhuanlan 链接）')
  await api.deleteArticle(client(ctx), id)
  return { deleted: id }
}
