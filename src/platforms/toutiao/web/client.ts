import { CatbusError } from '../../../core/errors.js'
import { CookieJar } from '../../../core/cookies.js'
import { HttpClient, parseJson } from '../../../core/http.js'
import type { HandlerContext } from '../../../core/registry.js'
import { jarOf } from '../../../core/toolkit.js'

/** 头条号 web 端会话（移植自上游 builder/auth.py + tou_tiao_creator_web_api.py）。 */

export const MP = 'https://mp.toutiao.com'
export const SSO = 'https://sso.toutiao.com'
export const WWW = 'https://www.toutiao.com'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

export class Tt {
  readonly ctx: HandlerContext
  readonly jar: CookieJar
  private client: HttpClient

  constructor(ctx: HandlerContext) {
    this.ctx = ctx
    this.jar = jarOf(ctx.credential)
    this.client = new HttpClient({ jar: this.jar, browser: 'chrome_146', os: 'windows', proxy: ctx.config.proxy, timeout: ctx.config.timeout, log: ctx.log })
  }

  request(req: {
    method?: string
    url: string
    query?: Record<string, string>
    headers?: Record<string, string>
    form?: Record<string, string>
    json?: unknown
    redirect?: 'follow' | 'manual'
    timeout?: number
  }) {
    const headers: Record<string, string> = { 'user-agent': UA, ...req.headers }
    return this.client.request({
      method: req.method,
      url: req.url,
      query: req.query,
      headers: Object.entries(headers),
      form: req.form,
      json: req.json,
      redirect: req.redirect,
      timeout: req.timeout,
    })
  }

  async json(req: Parameters<Tt['request']>[0]): Promise<any> {
    const res = await this.request(req)
    if (!(res.status >= 200 && res.status < 300)) {
      throw new CatbusError('UPSTREAM', `HTTP ${res.status}：${req.url}`)
    }
    return parseJson(res)
  }
}
