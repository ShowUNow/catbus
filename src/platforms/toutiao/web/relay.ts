import { CatbusError } from '../../../core/errors.js'

/**
 * toutiao 浏览器中继（2026-10-25 实测结论）：so.toutiao.com 搜索与 www.toutiao.com
 * 作品页对纯 HTTP 请求有环境级风控（shark 挑战壳 / JSVM 壳，登录 Cookie 不豁免），
 * 但真实浏览器导航能拿到 SSR + JSON-LD。这里通过 CDP 驱动一个开着头条页的调试
 * Chrome（--remote-debugging-port=9223）代为导航与读取。
 *
 * 连接：GET /json/list 取第一个 page target 的 webSocketDebuggerUrl。
 * 用 Node 22 自带的 WebSocket；CDP 只用到 Page.navigate 和 Runtime.evaluate。
 */

export const DEFAULT_RELAY = 'http://127.0.0.1:9223'

export class Relay {
  private ws: WebSocket | null = null
  private nextId = 0
  private readonly base: string

  constructor(base: string) {
    this.base = base.replace(/\/$/, '')
  }

  private async pageWsUrl(): Promise<string> {
    const res = await fetch(`${this.base}/json/list`)
    if (!res.ok) throw new CatbusError('USAGE', `中继不可达（HTTP ${res.status}）：${this.base}`, { hint: '先用 --remote-debugging-port=9223 启动 Chrome 并打开任意头条页面' })
    const targets = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[]
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new CatbusError('USAGE', `中继 ${this.base} 上没有页面 target`)
    return page.webSocketDebuggerUrl
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    const url = await this.pageWsUrl()
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CatbusError('USAGE', `连接中继 WebSocket 超时：${url}`)), 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new CatbusError('USAGE', `连接中继失败：${url}`)) }, { once: true })
    })
    this.ws = ws
    return ws
  }

  private async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = await this.connect()
    const id = ++this.nextId
    ws.send(JSON.stringify({ id, method, params }))
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CatbusError('UPSTREAM', `中继命令超时：${method}`)), 30000)
      const onMessage = (ev: MessageEvent) => {
        try {
          const d = JSON.parse(String(ev.data))
          if (d.id === id) {
            clearTimeout(timer)
            ws.removeEventListener('message', onMessage)
            if (d.error) reject(new CatbusError('UPSTREAM', `中继 ${method} 出错：${d.error.message}`))
            else resolve(d.result)
          }
        } catch {
          /* 忽略非 JSON 帧 */
        }
      }
      ws.addEventListener('message', onMessage)
    })
  }

  /** 导航并等待加载；返回最终 URL。 */
  async navigate(url: string): Promise<string> {
    await this.send('Page.enable')
    const r = await this.send('Page.navigate', { url })
    if (r?.errorText) throw new CatbusError('UPSTREAM', `导航失败：${r.errorText}`)
    await this.sleep(6000)
    return String(r?.frameId ?? '')
  }

  /** 在页面里执行表达式（returnByValue），拿到 JSON 值。 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      throw new CatbusError('UPSTREAM', `页面脚本执行失败：${String(desc).slice(0, 160)}`)
    }
    return r?.result?.value as T
  }

  /** 可信点击（Input.dispatchMouseEvent press+release）。 */
  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /** 可信文本插入（Input.insertText；ProseMirror 只认这种）。 */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}

// ---------------------------------------------------------------- item get（JSON-LD 抽取，headline_relay.py 的移植）

const EXTRACT_ITEM = `(function(){
  var out = { url: location.href, ldCount: 0, ld: [] };
  var nodes = document.querySelectorAll('script[type="application/ld+json"]');
  out.ldCount = nodes.length;
  for (var i = 0; i < nodes.length; i++) out.ld.push(nodes[i].textContent);
  var art = document.querySelector('article');
  out.articleText = art ? art.innerText : '';
  return JSON.stringify(out);
})()`

export interface RelayItem {
  url: string
  type: 'article' | 'video'
  title: string
  text: string
  images: string[]
  contentUrl: string | null
}

export async function relayItemGet(relay: Relay, workUrl: string): Promise<RelayItem> {
  await relay.navigate(workUrl)
  const raw = await relay.evaluate<string>(EXTRACT_ITEM)
  const d = JSON.parse(raw)
  if (!d.ldCount) {
    throw new CatbusError('UPSTREAM', '作品页没有 JSON-LD（中继浏览器也吃挑战或页面已下线）', { detail: String(d.url).slice(0, 120) })
  }
  let info: any = {}
  for (const blob of d.ld) {
    try {
      const payload = JSON.parse(blob)
      const cands = Array.isArray(payload) ? payload : [payload]
      for (const c of cands) {
        if (c && Array.isArray(c['@graph'])) cands.push(...c['@graph'])
        else if (c && (c.headline || c.name)) info = c
      }
    } catch {
      /* 跳过坏块 */
    }
  }
  const title = info.headline ?? info.name ?? ''
  const isVideo = info['@type'] === 'VideoObject' || d.url.includes('/video/')
  const thumb = info.thumbnailUrl ?? info.image ?? []
  return {
    url: d.url,
    type: isVideo ? 'video' : 'article',
    title: String(title),
    text: String(d.articleText ?? info.description ?? ''),
    images: (Array.isArray(thumb) ? thumb : [thumb]).filter(Boolean).map(String),
    contentUrl: typeof info.contentUrl === 'string' ? info.contentUrl : null,
  }
}

// ---------------------------------------------------------------- item search（挑战检测 + 链接抽取）

const EXTRACT_SEARCH = `(function(){
  var links = [];
  var seen = {};
  var as = document.querySelectorAll('a[href]');
  for (var i = 0; i < as.length; i++) {
    try {
      var u = new URL(as[i].href, 'https://so.toutiao.com');
      if (u.hostname.indexOf('toutiao.com') < 0) continue;
      var m = u.pathname.match(/^\\/(article|video|item|group)\\/(\\d+)\\/?$/);
      if (!m || seen[m[2]]) continue;
      seen[m[2]] = 1;
      links.push({ id: m[2], kind: m[1], url: 'https://www.toutiao.com/' + m[1] + '/' + m[2] + '/', title: as[i].innerText.trim().slice(0, 120) });
    } catch (e) {}
  }
  var challenged = !!document.querySelector('iframe[src*="verifycenter"], iframe[src*="captcha"]');
  return JSON.stringify({ links: links.slice(0, 30), challenged: challenged });
})()`

export interface RelaySearchResult {
  links: { id: string; kind: string; url: string; title: string }[]
  challenged: boolean
}

export async function relayItemSearch(relay: Relay, keyword: string): Promise<RelaySearchResult> {
  await relay.navigate(`https://so.toutiao.com/search?keyword=${encodeURIComponent(keyword)}&pd=synthesis`)
  const raw = await relay.evaluate<string>(EXTRACT_SEARCH)
  const r: RelaySearchResult = JSON.parse(raw)
  if (r.challenged) {
    throw new CatbusError('UPSTREAM', '搜索页嵌入了验证中心挑战：在中继浏览器里人工完成一次滑块后重试', { hint: '挑战是会话级的，过一次后 cookie 会带上放行标记' })
  }
  if (!r.links.length) {
    throw new CatbusError('UPSTREAM', '搜索页没有解析到作品链接（环境风控静默拦截）：先在中继浏览器里搜索一次确认能出结果')
  }
  return r
}
