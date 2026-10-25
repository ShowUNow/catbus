import { CatbusError } from '../../../core/errors.js'
import type { Zh } from './client.js'
import { WWW } from './client.js'
import { signHeaders } from './js.js'

/** 读取与写入侧接口（上游 apis/zhihu_web_apis.py + 2026-10-25 发布/删除实抓）。 */

const ZHUANLAN = 'https://zhuanlan.zhihu.com'

/** /api/v4/me：登录态与当前用户（带 x-zse 签名）。 */
export async function me(p: Zh): Promise<any | null> {
  const query = { include: 'is_realname' }
  const data = await p.json({
    url: `${WWW}/api/v4/me`,
    query,
    headers: { referer: `${WWW}/`, ...p.xsrfHeader(), ...signHeaders(`${WWW}/api/v4/me`, query, dC0(p)) },
  })
  if (!data?.id || data?.error) return null
  return data
}

/** 签名用的 d_c0 cookie。 */
export function dC0(p: Zh): string {
  return p.jar.forUrl(`${WWW}/`).find((c) => c.name === 'd_c0')?.value ?? ''
}

/** 综合搜索（search_v3）。匿名会撞权限墙，需要登录 Cookie。 */
export async function search(p: Zh, keyword: string, offset: number, limit: number): Promise<any[]> {
  const query = { t: 'general', q: keyword, offset: String(offset), limit: String(limit), search_source: 'Normal' }
  const data = await p.json({
    url: `${WWW}/api/v4/search_v3`,
    query,
    headers: { referer: `${WWW}/search?q=${encodeURIComponent(keyword)}`, ...p.xsrfHeader(), ...signHeaders(`${WWW}/api/v4/search_v3`, query, dC0(p)) },
  })
  if (data?.error) {
    throw new CatbusError('AUTH_REQUIRED', `知乎搜索返回错误：${data.error.message ?? data.error.code}`, {
      hint: '匿名搜索受登录/权限墙限制，先 catbus zhihu auth login',
    })
  }
  return (data?.data ?? []) as any[]
}

// ---------------------------------------------------------------- item get（回答 / 专栏文章）

export interface ContentItem {
  kind: 'answer' | 'article'
  id: string
  title: string | null
  text: string
  author: { id: string; name: string | null } | null
  url: string
  created_at: number | null
  excerpt: string | null
}

/** 回答详情（上游 get_answer）。 */
export async function getAnswer(p: Zh, id: string): Promise<ContentItem> {
  const query = 'include=content,excerpt,question,author'
  const data = await p.json({
    url: `${WWW}/api/v4/answers/${id}`,
    query: { include: 'content,excerpt,question,author' },
    headers: { referer: `${WWW}/`, ...p.xsrfHeader(), ...signHeaders(`${WWW}/api/v4/answers/${id}`, { include: 'content,excerpt,question,author' }, dC0(p)) },
  })
  void query
  if (typeof data?.content !== 'string') throw new CatbusError('UPSTREAM', '回答响应缺少 content')
  return {
    kind: 'answer',
    id: String(data.id ?? id),
    title: data?.question?.title ?? null,
    text: data.content,
    author: data?.author ? { id: String(data.author.id ?? ''), name: data.author.name ?? null } : null,
    url: `${WWW}/question/${data?.question?.id}/answer/${data.id ?? id}`,
    created_at: data.created_time ?? null,
    excerpt: data.excerpt ?? null,
  }
}

/** 专栏文章详情（上游 get_article）。 */
export async function getArticle(p: Zh, id: string): Promise<ContentItem> {
  const data = await p.json({
    url: `${ZHUANLAN}/api/articles/${id}`,
    headers: { referer: `${ZHUANLAN}/p/${id}`, ...p.xsrfHeader() },
  })
  if (typeof data?.content !== 'string') throw new CatbusError('UPSTREAM', '文章响应缺少 content')
  return {
    kind: 'article',
    id: String(data.id ?? id),
    title: data.title ?? null,
    text: data.content,
    author: data?.author ? { id: String(data.author.id ?? ''), name: data.author.name ?? null } : null,
    url: `${ZHUANLAN}/p/${data.id ?? id}`,
    created_at: data.created ?? null,
    excerpt: data.excerpt ?? null,
  }
}

/** 回答 / 文章 URL 或纯 ID 判断（上游 get_item 的路由规则）。 */
export function resolveItem(input: string): { kind: 'answer' | 'article'; id: string } {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) throw new CatbusError('USAGE', '纯数字 ID 无法区分回答或文章；给完整 URL（zhihu.com/.../answer/<id> 或 zhuanlan.zhihu.com/p/<id>）')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    throw new CatbusError('USAGE', '需要知乎内容 URL')
  }
  if (u.protocol !== 'https:') throw new CatbusError('USAGE', '需要知乎 HTTPS 内容 URL')
  if (u.hostname === 'www.zhihu.com') {
    const m = u.pathname.match(/^\/question\/\d+\/answer\/(\d+)\/?$/)
    if (m) return { kind: 'answer', id: m[1]! }
  }
  if (u.hostname === 'zhuanlan.zhihu.com') {
    const m = u.pathname.match(/^\/p\/(\d+)\/?$/)
    if (m) return { kind: 'article', id: m[1]! }
  }
  if (u.hostname === 'api.zhihu.com') {
    const m = u.pathname.match(/^\/(answers|articles)\/(\d+)\/?$/)
    if (m) return { kind: m[1] === 'answers' ? 'answer' : 'article', id: m[2]! }
  }
  throw new CatbusError('USAGE', '当前只支持回答或专栏文章 URL')
}

// ---------------------------------------------------------------- item publish（草稿 → 公开发布，2026-10-25 实抓契约）

/** 创建文章草稿（POST zhuanlan/api/articles/drafts）。 */
export async function createDraft(p: Zh, title: string): Promise<string> {
  const data = await p.json({
    method: 'POST',
    url: `${ZHUANLAN}/api/articles/drafts`,
    json: { title, delta_time: 0, can_reward: false },
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      origin: ZHUANLAN,
      referer: `${ZHUANLAN}/write`,
      ...p.xsrfHeader(),
    },
  })
  if (data?.state !== 'draft' || data?.type !== 'article_draft' || !data?.id) {
    throw new CatbusError('UPSTREAM', '知乎未确认创建文章草稿', { detail: data })
  }
  return String(data.id)
}

/** 保存草稿正文（PATCH .../draft）并回读确认。 */
export async function saveDraftContent(p: Zh, draftId: string, title: string, html: string): Promise<void> {
  const patchRes = await p.request({
    method: 'PATCH',
    url: `${ZHUANLAN}/api/articles/${draftId}/draft`,
    json: { content: html, table_of_contents: false, delta_time: 0, can_reward: false },
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      origin: ZHUANLAN,
      referer: `${ZHUANLAN}/p/${draftId}/edit`,
      ...p.xsrfHeader(),
    },
  })
  // PATCH 成功返回 200 + 空 body（实抓）
  if (patchRes.status !== 200) {
    throw new CatbusError('UPSTREAM', `草稿正文保存 HTTP ${patchRes.status}`, { detail: (await patchRes.text()).slice(0, 150) })
  }
  await patchRes.text()
  const saved = await p.json({
    url: `${ZHUANLAN}/api/articles/${draftId}/draft`,
    headers: { referer: `${ZHUANLAN}/p/${draftId}/edit`, ...p.xsrfHeader() },
  })
  if (saved?.title !== title) throw new CatbusError('UPSTREAM', '草稿回读标题与提交不一致')
}

/**
 * 公开发布草稿：POST /api/v4/content/publish（2026-10-25 编辑器实抓）。
 * 请求体结构与编辑器逐字段一致；traceId = `<ms>,<uuid>`。签名覆盖完整 body（≤4096）。
 */
export async function publishDraft(p: Zh, draftId: string, title: string, html: string): Promise<string> {
  const business = {
    commentPermission: 'anyone',
    disclaimer_type: 'none',
    disclaimer_status: 'close',
    table_of_contents_enabled: false,
    content: html,
    title,
    commercial_report_info: { commercial_types: [] },
    commercial_zhitask_bind_info: null,
    canReward: false,
  }
  const textLength = html.replace(/<[^>]+>/g, '').length
  const body = {
    action: 'article',
    data: {
      publish: { traceId: `${Date.now()},${crypto.randomUUID()}` },
      extra_info: { publisher: 'pc', pc_business_params: JSON.stringify(business) },
      draft: { disabled: 1, id: draftId, isPublished: false },
      commentsPermission: { comment_permission: 'anyone' },
      creationStatement: { disclaimer_type: 'none', disclaimer_status: 'close' },
      contentsTables: { table_of_contents_enabled: false },
      commercialReportInfo: { isReport: 0 },
      appreciate: { can_reward: false, tagline: '' },
      hybridInfo: {},
      hybrid: { html, textLength },
      title: { title },
    },
  }
  const bodyText = JSON.stringify(body)
  const url = `${WWW}/api/v4/content/publish`
  const res = await p.request({
    method: 'POST',
    url,
    body: bodyText,
    headers: {
      'content-type': 'application/json',
      origin: ZHUANLAN,
      referer: `${ZHUANLAN}/p/${draftId}/edit`,
      ...p.xsrfHeader(),
      ...signHeaders(url, undefined, dC0(p), bodyText),
    },
  })
  if (res.status !== 200) {
    throw new CatbusError('UPSTREAM', `发布 HTTP ${res.status}`, { detail: (await res.text()).slice(0, 200) })
  }
  const text = await res.text()
  // 编辑器实抓：成功时 200 + 空 body（页面随后直接跳转正文页）
  if (!text.trim()) return draftId
  const data = JSON.parse(text)
  if (data?.error) throw new CatbusError('UPSTREAM', `发布失败：${data.error.message ?? data.error.code}`, { detail: data })
  return String(data?.data?.[0]?.id ?? data?.id ?? draftId)
}

// ---------------------------------------------------------------- item delete（已发布文章 / 文章草稿同路由实测）

export async function deleteArticle(p: Zh, articleId: string): Promise<void> {
  const res = await p.request({
    method: 'DELETE',
    url: `${WWW}/api/v4/articles/${articleId}`,
    headers: { origin: WWW, referer: `${WWW}/people/`, ...p.xsrfHeader() },
  })
  if (res.status !== 200) {
    throw new CatbusError('UPSTREAM', `删除 HTTP ${res.status}`, { detail: (await res.text()).slice(0, 150) })
  }
}
