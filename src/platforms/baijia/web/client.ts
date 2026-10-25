import { CatbusError } from '../../../core/errors.js'
import { CookieJar } from '../../../core/cookies.js'
import { HttpClient, parseJson } from '../../../core/http.js'
import type { HandlerContext } from '../../../core/registry.js'
import { jarOf } from '../../../core/toolkit.js'

/**
 * 百家号 web 端的 HTTP 会话（移植自上游 baijia_apis/auth.py 的 BaijiaAuth）。
 *
 * Cookie 由 core 的凭证罐管理；Creator token（appinfo 响应的 token）是网页链路的一部分，
 * 存在 credential.extra.creator_token，刷新时机与上游一致：appinfo 响应携带 token 时更新。
 */

const WEB = 'https://baijiahao.baidu.com'
const PASSPORT = 'https://passport.baidu.com'

/** 上游 USER_AGENT：Chrome 133（登录链路实抓环境）。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

const COMMON: Record<string, string> = {
  'user-agent': UA,
  'accept-language': 'zh-CN,zh;q=0.9',
}

export interface BcRequest {
  method?: string
  url: string
  query?: Record<string, string>
  headers?: Record<string, string>
  form?: Record<string, string>
  body?: string
  redirect?: 'follow' | 'manual'
  timeout?: number
}

export class Bc {
  readonly ctx: HandlerContext
  readonly jar: CookieJar
  private client: HttpClient

  constructor(ctx: HandlerContext) {
    this.ctx = ctx
    this.jar = jarOf(ctx.credential)
    this.client = new HttpClient({ jar: this.jar, browser: 'chrome_146', os: 'windows', proxy: ctx.config.proxy, timeout: ctx.config.timeout, log: ctx.log })
  }

  /** 发请求；cookie 从凭证罐取，Set-Cookie 自动写回。 */
  request(req: BcRequest) {
    const headers: Record<string, string> = { ...COMMON, ...req.headers }
    return this.client.request({
      method: req.method,
      url: req.url,
      query: req.query,
      headers: Object.entries(headers),
      form: req.form,
      body: req.body,
      redirect: req.redirect,
      timeout: req.timeout,
    })
  }

  /** JSON 响应；HTTP 非 2xx 抛 UPSTREAM。 */
  async json(req: BcRequest): Promise<any> {
    const res = await this.request(req)
    if (!(res.status >= 200 && res.status < 300)) {
      throw new CatbusError('UPSTREAM', `HTTP ${res.status}：${req.url}`, {
        detail: (await res.text().catch(() => '')).slice(0, 200),
      })
    }
    return parseJson(res)
  }

  /** passport JSONP：`callback({...})` → 对象（上游 _parse_jsonp 的首尾括号法）。 */
  async jsonp(req: BcRequest): Promise<any> {
    const res = await this.request(req)
    if (!(res.status >= 200 && res.status < 300)) {
      throw new CatbusError('UPSTREAM', `HTTP ${res.status}：${req.url}`)
    }
    const text = await res.text()
    const start = text.indexOf('(')
    const end = text.lastIndexOf(')')
    if (start < 0 || end <= start) {
      throw new CatbusError('UPSTREAM', 'Passport JSONP 响应格式变化', { detail: text.slice(0, 120) })
    }
    return JSON.parse(text.slice(start + 1, end))
  }
}

export { WEB, PASSPORT }
