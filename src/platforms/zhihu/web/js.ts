import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { CatbusError } from '../../../core/errors.js'
import { staticFile } from '../../../core/paths.js'

/**
 * 上游签名 JS（static/zhihu/zhihu.js，原样复制）：`tv(url, body, {zse93, dc0, xZst81}, ec)`
 * → `{source, signature}`。上游 utils/zhihu_utils.py 通过 execjs 调用；jsdom 的窗口壳在文件头部，
 * 这里在 node:vm 里按 CommonJS 加载（jsdom 由宿主 require 提供）。
 */

const hostRequire = createRequire(import.meta.url)

interface SignerExports {
  tv: (
    url: string,
    body: string | undefined,
    info: { zse93: string; dc0: string; xZst81: string | null },
    ec: string | undefined,
  ) => { source: string; signature: string }
}

let cached: SignerExports | null = null

function load(): SignerExports {
  if (cached) return cached
  const source = readFileSync(staticFile('zhihu', 'zhihu.js'), 'utf8')
  const module = { exports: {} as Record<string, unknown> }
  // other.js 在 require 时就读 window/self/document：先造 jsdom 窗口，两个模块都在同一 vm 上下文里跑
  const { JSDOM } = hostRequire('jsdom') as typeof import('jsdom')
  const dom = new JSDOM('<!DOCTYPE html><p>ok</p>', { url: 'https://www.zhihu.com/' })
  const vmModules = new Map<string, Record<string, unknown>>()
  const runModule = (file: string, filename: string): Record<string, unknown> => {
    const hit = vmModules.get(filename)
    if (hit) return hit
    const mod = { exports: {} as Record<string, unknown> }
    vmModules.set(filename, mod.exports)
    vm.runInContext(readFileSync(file, 'utf8'), context, { filename })
    vmModules.set(filename, mod.exports)
    return mod.exports
  }
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === './static/other') return runModule(staticFile('zhihu', 'other.js'), 'other.js')
      return hostRequire(name)
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
  })
  try {
    vm.runInContext('this.global = this;', context)
  // 上游 zhihu.js 里 ti() 用到的 tr（字符串长度）从未定义；只有签名带请求体时才会触发（上游一直只签 GET）。
  vm.runInContext('this.tr = function(s){ return String(s).length }', context)
    vm.runInContext(source, context, { filename: 'zhihu.js' })
  } catch (err) {
    throw new CatbusError('UPSTREAM', '加载知乎签名 JS 失败', { detail: String(err) })
  }
  // 上游 execjs 的调用方式：tv 是顶层函数，从上下文全局取句柄
  const tv = vm.runInContext('typeof tv === "function" ? tv : undefined', context)
  if (typeof tv !== 'function') throw new CatbusError('UPSTREAM', 'zhihu.js 里没有 tv 函数')
  cached = { tv }
  return cached
}

export const ZSE_93 = '101_3_3.0'

/**
 * 请求签名头：x-zse-93 / x-zse-96（上游 get_x_zse_96 + 2026-10-25 发布抓包补充）。
 * 签名源是 `zse93 + path?search + d_c0 + (请求体原文，长度 ≤4096 时)`；GET 不传 body。
 */
export function signHeaders(
  url: string,
  params: Record<string, string> | undefined,
  dC0: string,
  body?: string,
): Record<string, string> {
  const er = params && Object.keys(params).length ? `${url}?${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')}` : url
  const res = load().tv(er, body, { zse93: ZSE_93, dc0: dC0, xZst81: null }, undefined)
  return { 'x-zse-93': ZSE_93, 'x-zse-96': `2.0_${res.signature}` }
}
