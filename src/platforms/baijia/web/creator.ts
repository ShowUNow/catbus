import { CatbusError } from '../../../core/errors.js'
import type { Bc } from './client.js'
import { WEB } from './client.js'

/**
 * 创作者中心（移植自上游 baijia_apis/creator.py 的网页链路）。
 *
 * 契约经 2026-10-25 全链抓包验证：
 * - 图片上传 POST /pcui/picture/uploadproxy（网页 Cookie + token 头，CurlMime/FormData）
 * - 草稿保存 POST /pcui/article/save?callback=bjhdraft
 * - 作品删除 POST /pcui/article/remove（已发布与草稿同路由，errno=0 即成功）
 * - 公开发布 POST /pcui/article/publish?callback=bjhpublish：服务端可要求
 *   kunlun 滑块（errno=10000015，通过后同表单重发附加 as/ds/tk 三字段）。
 *   滑块票据目前需要人工获取，本切片只提供票据注入参数。
 */

function creatorToken(p: Bc): string {
  const t = (p.ctx.credential.extra as Record<string, unknown>).creator_token
  if (typeof t === 'string' && t) return t
  throw new CatbusError('AUTH_REQUIRED', '缺少 Creator token，先执行 catbus baijia auth status 刷新')
}

/** Creator token 可能随会话轮换：内存里没有时先刷一次 appinfo。 */
export async function ensureCreatorToken(p: Bc): Promise<string> {
  try {
    return creatorToken(p)
  } catch {
    const { appinfo } = await import('./api.js')
    await appinfo(p)
    return creatorToken(p)
  }
}

async function post(p: Bc, url: string, form: Record<string, string>): Promise<any> {
  return p.json({
    method: 'POST',
    url,
    form,
    headers: { token: creatorToken(p), referer: `${WEB}/builder/rc/edit?type=news&is_from_cms=1`, origin: WEB },
  })
}

export interface WebWork {
  article_id: string
  title: string
  is_publish: number | null
  publish_status: number | null
  updated_at: string | null
}

/** 作品列表（view=all/news/draft）。 */
export async function listWorks(p: Bc, view: 'all' | 'news' | 'draft', page: number): Promise<WebWork[]> {
  const data = await p.json({
    url: `${WEB}/pcui/article/lists`,
    query: {
      currentPage: String(page),
      pageSize: '10',
      search: '',
      type: view === 'all' ? '' : 'news',
      collection: view === 'draft' ? 'draft' : '',
      startDate: '',
      endDate: '',
      clearBeforeFetch: 'false',
      ...(view === 'all' ? { dynamic: '1' } : {}),
    },
    headers: { token: creatorToken(p), referer: `${WEB}/builder/rc/content` },
  })
  if (data.errno !== 0) throw new CatbusError('UPSTREAM', `作品列表 errno=${data.errno}`, { detail: data.errmsg })
  const list: any[] = data?.data?.list ?? []
  return list.map((it) => ({
    article_id: String(it.article_id ?? it.id ?? ''),
    title: String(it.title ?? ''),
    is_publish: it.is_publish ?? null,
    publish_status: it.publish_status ?? null,
    updated_at: it.updated_at ?? it.update_time ?? null,
  }))
}

/** 保存网页草稿（一次性，不重试）。返回平台响应。 */
export async function saveDraft(p: Bc, title: string, contentHtml: string): Promise<any> {
  return post(p, `${WEB}/pcui/article/save?callback=bjhdraft`, {
    type: 'news',
    title,
    content: contentHtml,
    len: String(contentHtml.length),
    is_publish: '0',
  })
}

/** 删除作品（草稿与已发布同路由；已实测删除已发布测试文章）。 */
export async function removeWork(p: Bc, articleId: string): Promise<any> {
  return post(p, `${WEB}/pcui/article/remove`, { article_id: articleId })
}

export interface PublishTicket {
  as: string
  ds: string
  tk: string
}

/** 公开发布。errno=10000015 表示需要 kunlun 滑块票据（--ticket as,ds,tk）。 */
export async function publishArticle(
  p: Bc,
  o: { title: string; contentHtml: string; covers: string[]; abstract?: string; crop?: [number, number]; ticket?: PublishTicket },
): Promise<any> {
  const crop = o.crop ?? [2048, 1365]
  const coverImages = o.covers.map((src) => ({
    src,
    cropData: { x: 0, y: 0, width: crop[0], height: crop[1] },
    machine_chooseimg: 0,
    isLegal: 1,
  }))
  const form: Record<string, string> = {
    type: 'news',
    title: o.title,
    author: '',
    abstract: o.abstract ?? '',
    content: o.contentHtml,
    auto_mount_goods: '1',
    len: String(o.contentHtml.length),
    vertical_cover: o.covers[0] ?? '',
    cover_images: JSON.stringify(coverImages),
    _cover_images_map: JSON.stringify(o.covers.map((src) => ({ src }))),
    source: 'upload',
    cover_source: 'upload',
    subtitle: '',
    bjhtopic_id: '',
    bjhtopic_info: '',
    clue: '1',
    bjhmt: '',
    order_id: '',
    aigc_rebuild: '',
    is_publish: '1',
  }
  if (o.ticket) {
    form.as = o.ticket.as
    form.ds = o.ticket.ds
    form.tk = o.ticket.tk
  }
  const data = await post(p, `${WEB}/pcui/article/publish?callback=bjhpublish`, form)
  if (Number(data.errno) === 10000015) {
    throw new CatbusError('UPSTREAM', '平台要求滑块验证（errno=10000015）：在浏览器完成验证后，用 --ticket as,ds,tk 附上票据重试', {
      detail: data,
    })
  }
  return data
}

/** 上传封面图（JPEG/PNG 字节）→ https 图片地址。 */
export async function uploadImage(p: Bc, bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const url = `${WEB}/pcui/picture/uploadproxy`
  const { HttpClient } = await import('../../../core/http.js')
  const client = new HttpClient({ jar: p.jar, proxy: p.ctx.config.proxy, timeout: p.ctx.config.timeout, log: p.ctx.log })
  const response = await client.request({
    method: 'POST',
    url,
    multipart: [
      { name: 'type', data: 'image' },
      { name: 'app_id', data: '' },
      { name: 'is_waterlog', data: '1' },
      { name: 'save_material', data: '1' },
      { name: 'no_compress', data: '0' },
      { name: 'is_events', data: '' },
      { name: 'article_type', data: 'news' },
      { name: 'media', data: bytes, filename, contentType: mime },
    ],
    headers: [
      ['token', creatorToken(p)],
      ['referer', `${WEB}/builder/rc/edit?type=news&is_from_cms=1`],
      ['origin', WEB],
    ],
  })
  if (response.status !== 200) throw new CatbusError('UPSTREAM', `图片上传 HTTP ${response.status}`)
  const data = JSON.parse(await response.text())
  if (data.errno !== 0) throw new CatbusError('UPSTREAM', `图片上传 errno=${data.errno}`, { detail: data.errmsg })
  const httpsUrl = data?.ret?.https_url
  if (typeof httpsUrl !== 'string' || !httpsUrl.startsWith('https://')) {
    throw new CatbusError('UPSTREAM', '上传响应缺少 ret.https_url')
  }
  return httpsUrl
}
