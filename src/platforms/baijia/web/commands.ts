import { spawn } from 'node:child_process'
import { CatbusError, toCatbusError } from '../../../core/errors.js'
import { cookieCredential, finishLogin, freshCredential, loginContext, poll } from '../../../core/login.js'
import * as n from '../../../core/normalize.js'
import type { AuthStatus, Credential, Item, UserRef } from '../../../core/schemas.js'
import { authError, isGuest, paged } from '../../../core/toolkit.js'
import type { HandlerContext } from '../../../core/registry.js'
import * as api from './api.js'
import { Bc } from './client.js'
import * as creator from './creator.js'
import * as login from './login.js'

type Ctx = HandlerContext

const COOKIE_HINT = '从已登录浏览器的请求头复制 Cookie：catbus baijia auth login --method cookie --cookie "<Cookie>"'

function client(ctx: Ctx): Bc {
  return new Bc(ctx)
}

/** appinfo：errno=0 即已登录；顺带刷新 Creator token 到 credential.extra。 */
async function appinfoOf(p: Bc): Promise<any> {
  const data = await api.appinfo(p)
  return data?.errno === 0 ? data : null
}

function userRefOf(info: any): UserRef {
  const u = info?.data?.user ?? {}
  return n.userRef({ id: String(u.id ?? u.uk ?? ''), name: u.name ?? u.display_name })!
}

// ================================================================ auth

export async function authLogin(ctx: Ctx) {
  const method = ctx.options.method as string
  if (method === 'cookie') return loginCookie(ctx)
  if (method === 'qrcode') return loginQrcode(ctx)
  throw new CatbusError('USAGE', `不支持的登录方式：${method}`)
}

async function loginCookie(ctx: Ctx) {
  const credential = cookieCredential(ctx, '.baidu.com')
  const p = new Bc(loginContext(ctx, credential))
  const info = await appinfoOf(p)
  if (!info) throw new CatbusError('AUTH_REQUIRED', 'Cookie 未通过登录校验（appinfo errno != 0）', { hint: COOKIE_HINT })
  return finishLogin(loginContext(ctx, credential), credential, userRefOf(info))
}

async function loginQrcode(ctx: Ctx) {
  const credential = freshCredential(ctx, 'qrcode')
  const loginCtx = loginContext(ctx, credential)
  const p = new Bc(loginCtx)
  await login.bootstrap(p)
  const guid = gidOf(credential)
  const qr = await login.createQrcode(p)
  const pngPath = await login.saveQrPng(ctx.platform.id, qr.png)
  ctx.log.info(`二维码已保存：${pngPath}，用百度 App 扫码并在手机上确认`)
  openFile(pngPath)

  let ticket = ''
  let toldScanned = false
  await poll(
    async () => {
      const r = await login.pollQrcode(p, qr.sign, guid)
      if (r.state === 'approved') {
        ticket = r.ticket ?? ''
        return true
      }
      if (r.state === 'scanned' && !toldScanned) {
        toldScanned = true
        ctx.log.info('已扫码，请在手机上确认')
      }
      return undefined
    },
    { interval: 2, timeout: 300, what: '扫码确认' },
  )
  if (!ticket) throw new CatbusError('AUTH_REQUIRED', '扫码确认结果缺少票据')
  await login.complete(p, qr.sign, ticket, '')
  const info = await appinfoOf(p)
  if (!info) throw new CatbusError('AUTH_REQUIRED', '扫码后 appinfo 未通过')
  return finishLogin(loginCtx, credential, userRefOf(info))
}

export async function authStatus(ctx: Ctx): Promise<AuthStatus> {
  if (isGuest(ctx)) return { logged_in: false, user: null, method: null, expires_at: null }
  try {
    const info = await appinfoOf(client(ctx))
    return { logged_in: Boolean(info), user: info ? userRefOf(info) : null, method: info ? ctx.credential.method : null, expires_at: null }
  } catch (err) {
    const e = toCatbusError(err) as CatbusError
    if (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_EXPIRED') return { logged_in: false, user: null, method: null, expires_at: null }
    throw err
  }
}

// ================================================================ item

export async function itemGet(ctx: Ctx) {
  const id = ctx.args.item!
  const a = await api.getArticle(client(ctx), id)
  return itemOf(a.id, a.title, a.content, a.author, a.updated_at)
}

export async function itemSearch(ctx: Ctx) {
  const page = Number(ctx.cursor ?? 1) || 1
  const items = await api.searchArticles(client(ctx), ctx.args.keyword!, page)
  return paged(items.map((it) => itemOf(it.id, it.title, '', null, null)), page + 1, items.length >= 10)
}

export async function itemList(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const page = Number(ctx.cursor ?? 1) || 1
  const p = client(ctx)
  await creator.ensureCreatorToken(p)
  const works = await creator.listWorks(p, 'all', page)
  return paged(
    works.map((w) =>
      n.item({
        id: w.article_id,
        kind: 'article',
        title: w.title,
        url: `https://baijiahao.baidu.com/s?id=${w.article_id}`,
        status: w.is_publish === 1 ? 'published' : 'draft',
        created_at: w.updated_at ? n.time(w.updated_at) : null,
      }),
    ),
    page + 1,
    works.length >= 20,
  )
}

export async function itemDelete(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const p = client(ctx)
  await creator.ensureCreatorToken(p)
  const data = await creator.removeWork(p, ctx.args.item!)
  if (data.errno !== 0) throw new CatbusError('UPSTREAM', `删除失败：errno=${data.errno}`, { detail: data.errmsg })
  return { deleted: ctx.args.item! }
}

export async function itemPublish(ctx: Ctx) {
  if (isGuest(ctx)) throw authError(ctx)
  const p = client(ctx)
  await creator.ensureCreatorToken(p)
  const title = String(ctx.options.title ?? '')
  const text = String(ctx.options.text ?? '')
  if (!title || !text) throw new CatbusError('USAGE', '需要 --title 与 --text')
  const rawCovers = Array.isArray(ctx.options.image) ? (ctx.options.image as string[]) : ctx.options.image ? [String(ctx.options.image)] : []
  const ticket = parseTicket(ctx.options.ticket as string | undefined)

  let covers = rawCovers
  if (!covers.length) {
    covers = [await creator.uploadImage(p, placeholderPng(), 'cover.png', 'image/png')]
    ctx.log.info('未给 --image，已上传自动生成的纯色封面')
  }
  const contentHtml = `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
  const data = await creator.publishArticle(p, { title, contentHtml, covers, ticket })
  if (data.errno !== 0) throw new CatbusError('UPSTREAM', `发布失败：errno=${data.errno}`, { detail: data.errmsg })
  return { published: true, article_id: String(data?.data?.article_id ?? ''), raw: data }
}

function parseTicket(raw: string | undefined): creator.PublishTicket | undefined {
  if (!raw) return undefined
  const [as, ds, tk] = raw.split(',')
  if (!as || !ds || !tk) throw new CatbusError('USAGE', '--ticket 格式：as,ds,tk')
  return { as, ds, tk }
}

function itemOf(id: string, title: string, content: string, author: string | null, updated: string | null): Item {
  return n.item({
    id,
    kind: 'article',
    title,
    text: content || null,
    url: `https://baijiahao.baidu.com/s?id=${id}`,
    author: author ? n.userRef({ id: author, name: author }) : null,
    created_at: updated ? n.time(updated) : null,
  })
}

/** gid 存在 credential.extra，轮询与出码共用。 */
function gidOf(credential: Credential): string {
  const extra = credential.extra as Record<string, unknown>
  if (typeof extra.gid === 'string' && extra.gid) return extra.gid
  const hex = '0123456789ABCDEF'
  const block = (len: number) => Array.from({ length: len }, () => hex[Math.floor(Math.random() * 16)]).join('')
  const g = `${block(8)}-${block(4)}-${block(4)}-${block(4)}-${block(12)}`
  extra.gid = g
  return g
}

/** 1×1 纯色 PNG（封面占位；正式发布建议 --image 传真实封面 URL）。 */
function placeholderPng(): Uint8Array {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function openFile(path: string) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', path], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', [path], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 打不开就提示用户手动打开 */
  }
}
