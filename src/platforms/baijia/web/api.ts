import { CatbusError } from '../../../core/errors.js'
import type { Bc } from './client.js'
import { WEB } from './client.js'

/** 读取侧接口（移植自上游 baijia_apis 的 BaijiaAuth.login_state / BaijiaContentAPI / BaijiaSearchAPI）。 */

/** 登录态：GET /builder/app/appinfo，errno=0 即已登录；响应 token 回写 creator_token。 */
export async function appinfo(p: Bc): Promise<any> {
  const res = await p.request({
    url: `${WEB}/builder/app/appinfo`,
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: `${WEB}/builder/rc/home`,
    },
  })
  // token 在响应头（上游 _absorb_response_auth 的实抓结论），不在 JSON body
  const token = res.headers.get('token') ?? res.headers.get('Token') ?? ''
  if (token) (p.ctx.credential.extra as Record<string, unknown>).creator_token = token
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new CatbusError('UPSTREAM', `appinfo 响应不是 JSON（HTTP ${res.status}）`, { detail: text.slice(0, 120) })
  }
}

export class BaijiaSearchBlocked extends CatbusError {
  constructor() {
    super('UPSTREAM', '百度搜索跳转到安全验证页，需要人工完成验证后重试')
  }
}

/** 站内搜索：百度网页搜索限定 site:baijiahao.baidu.com（上游 search_articles）。 */
export async function searchArticles(p: Bc, keyword: string, page: number): Promise<any[]> {
  const res = await p.request({
    url: 'https://www.baidu.com/s',
    query: { wd: `site:baijiahao.baidu.com ${keyword}`, pn: String((page - 1) * 10) },
    headers: { referer: 'https://www.baidu.com/' },
    redirect: 'manual',
  })
  if (res.status >= 300 && res.status < 400) throw new BaijiaSearchBlocked()
  const html = await res.text()
  if (html.includes('百度安全验证') || /wappass/.test(html)) throw new BaijiaSearchBlocked()
  return parseSearchLinks(html)
}

/** 搜索结果卡片：链接指向 baijiahao.baidu.com/s?id=<数字> 的条目。 */
function parseSearchLinks(html: string): any[] {
  const items: { title: string; url: string; id: string }[] = []
  const seen = new Set<string>()
  const re = /<a[^>]+href="(https?:\/\/baijiahao\.baidu\.com\/s\?id=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const id = m[2]!
    if (seen.has(id)) continue
    const title = m[3]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    seen.add(id)
    items.push({ id, title, url: `https://baijiahao.baidu.com/s?id=${id}` })
  }
  return items
}

export interface PublicArticle {
  id: string
  title: string
  author: string | null
  updated_at: string | null
  content: string
}

/** 公开文章：SSR 页面解析（上游 get_article 的标签缓冲区方式）。 */
export async function getArticle(p: Bc, id: string): Promise<PublicArticle> {
  const res = await p.request({ url: `${WEB}/s`, query: { id } })
  const html = await res.text()
  if (res.status !== 200) throw new CatbusError('UPSTREAM', `文章页 HTTP ${res.status}`)
  if (html.includes('百度安全验证') || html.length < 2000) {
    throw new CatbusError('UPSTREAM', '文章页触发安全验证或内容为空', { detail: html.slice(0, 120) })
  }
  return parseArticle(id, html)
}

/** 上游 _ArticleHTML 的移植：按 data-testid（title/article/author-name/updatetime）子树深度收集文本。 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

export function parseArticle(id: string, html: string): PublicArticle {
  const buffers: Record<string, string[]> = { title: [], article: [], 'author-name': [], updatetime: [] }
  const depths = new Map<string, number>()
  let dateUpdate = ''
  const tagRe = /<(\/)?([a-zA-Z][^\s>/]*)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const closing = Boolean(m[1])
    const tag = m[2]!.toLowerCase()
    const attrs = m[3] ?? ''
    if (!closing) {
      if (!VOID.has(tag)) for (const k of depths.keys()) depths.set(k, depths.get(k)! + 1)
      if (tag === 'title') depths.set('title', 1)
      const testid = /data-testid="([^"]*)"/.exec(attrs)?.[1]
      if (testid && testid in buffers) depths.set(testid, 1)
      if (tag === 'meta' && /itemprop="dateUpdate"/.test(attrs)) {
        dateUpdate = /content="([^"]*)"/.exec(attrs)?.[1] ?? ''
      }
    } else if (!VOID.has(tag)) {
      for (const k of [...depths.keys()]) {
        const d = depths.get(k)! - 1
        if (d <= 0) depths.delete(k)
        else depths.set(k, d)
      }
    }
    if (!closing && depths.size) {
      // 收集该开标签到下一个标签之间的文本
      const rest = html.slice(m.index + m[0].length)
      const next = rest.search(/<[a-zA-Z!/]/)
      const text = (next < 0 ? rest : rest.slice(0, next)).replace(/&#?\w+;/g, ' ')
      if (text.trim()) for (const k of depths.keys()) buffers[k]!.push(text)
    }
  }
  const squeeze = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim()
  return {
    id,
    title: squeeze(buffers.title!),
    author: squeeze(buffers['author-name']!) || null,
    updated_at: dateUpdate || squeeze(buffers.updatetime!) || null,
    content: squeeze(buffers.article!),
  }
}
