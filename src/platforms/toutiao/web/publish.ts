import { CatbusError } from '../../../core/errors.js'
import type { Relay } from './relay.js'
import { MP } from './client.js'

/**
 * 头条图文发布的编辑器自动化（2026-10-25 全链实测的移植）。
 *
 * 纯 HTTP 发布缺 `_signature / msToken / a_bogus` 三个页面生成签名；中继走编辑器 UI：
 * 打开 /profile_v4/graphic/publish → 标题（React textarea setter）→ ProseMirror
 * （可信点击聚焦 + Input.insertText）→ 选「无封面」→ 点「预览并发布」→ 确认面板
 * 「确认发布」（面板渲染慢，轮询等）→ 跳转 /profile_v4/graphic/articles 即成功。
 */

const EDITOR = `${MP}/profile_v4/graphic/publish`

const SET_TITLE = `(function(){
  var ta = null;
  document.querySelectorAll('textarea').forEach(function(e){
    if ((e.placeholder || '').indexOf('文章标题') >= 0) ta = e;
  });
  if (!ta) return 'no-title-box';
  var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  s.call(ta, ${JSON.stringify('$$TITLE$$')});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`

const CLICK_EDITOR = `(function(){
  var ed = document.querySelector('.ProseMirror');
  if (!ed) return null;
  var b = ed.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
})()`

const CLEAR_EDITOR = `document.querySelector('.ProseMirror').focus(), document.execCommand('selectAll'), document.execCommand('delete'), 'cleared'`

const BTN_POS = `(function(){
  var btn = null;
  document.querySelectorAll('button').forEach(function(e){
    if ((e.innerText || '').trim() === '$$TEXT$$' && e.offsetParent) btn = e;
  });
  if (!btn) return null;
  btn.scrollIntoView({ block: 'center' });
  var b = btn.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
})()`

const PAGE_STATE = `(function(){
  var btns = [];
  document.querySelectorAll('button').forEach(function(e){
    var t = (e.innerText || '').trim();
    if (t && t.length < 10 && e.offsetParent) btns.push(t);
  });
  return JSON.stringify({ url: location.href.slice(0, 80), btns: btns.slice(-8) });
})()`

async function clickButton(relay: Relay, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pos = await relay.evaluate<string | null>(BTN_POS.replace('$$TEXT$$', text))
    if (pos) {
      const { x, y } = JSON.parse(pos)
      await relay.click(x, y)
      return
    }
    await relay.sleep(1500)
  }
  throw new CatbusError('UPSTREAM', `中继编辑器里没有等到「${text}」按钮`)
}

/** 按钮在但状态机没推进时（首击静默失败，实测偶发）：轮询目标按钮出现才算数，最多点 3 次。 */
async function clickUntil(relay: Relay, text: string, waitNext: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    await clickButton(relay, text, Math.max(4000, deadline - Date.now()))
    const until = Date.now() + 12000
    while (Date.now() < until) {
      const next = await relay.evaluate<string | null>(BTN_POS.replace('$$TEXT$$', waitNext))
      if (next) return
      await relay.sleep(2000)
    }
  }
  throw new CatbusError('UPSTREAM', `点击「${text}」后没有出现「${waitNext}」（编辑器状态机未推进）`)
}

export async function relayItemPublish(
  relay: Relay,
  title: string,
  text: string,
): Promise<{ item_id: string; url: string }> {
  await relay.navigate(EDITOR)
  await relay.sleep(4000)

  // 1) 标题
  const titleRes = await relay.evaluate<string>(SET_TITLE.replace('$$TITLE$$', title))
  if (titleRes !== 'ok') throw new CatbusError('UPSTREAM', `编辑器没有标题框：${titleRes}`)

  // 2) 正文：聚焦 ProseMirror → 清空 → 可信插入
  const ed = await relay.evaluate<string | null>(CLICK_EDITOR)
  if (!ed) throw new CatbusError('UPSTREAM', '编辑器没有 ProseMirror 正文区')
  const { x, y } = JSON.parse(ed)
  await relay.click(x, y)
  await relay.sleep(600)
  await relay.evaluate<string>(CLEAR_EDITOR)
  await relay.sleep(300)
  await relay.insertText(text)
  await relay.sleep(2000)

  // 3) 等 auto-save 至少飞一次（编辑器活体指标）
  await relay.sleep(6000)

  // 4) 无封面：默认是「单图」，没有可截取的图时发布会静默校验失败。
  //    注意「无封面」是 div/span 标签不是 button（实测），单独按文本点。
  const coverPos = await relay.evaluate<string | null>(`(function(){
    var el = null;
    document.querySelectorAll('button,div,span').forEach(function(e){
      if (!el && (e.innerText || '').trim() === '无封面' && e.offsetParent) el = e;
    });
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    var b = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  })()`)
  if (!coverPos) throw new CatbusError('UPSTREAM', '编辑器里没有找到「无封面」选项（封面区结构变化）')
  const cp = JSON.parse(coverPos)
  await relay.click(cp.x, cp.y)
  await relay.sleep(1000)

  // 5) 预览并发布（面板渲染慢；首击偶发静默失败，重试直到确认按钮出现）
  await clickUntil(relay, '预览并发布', '确认发布', 45000)
  await relay.sleep(2000)

  // 6) 确认发布
  await clickButton(relay, '确认发布', 20000)

  // 7) 等跳转到作品管理页
  for (let i = 0; i < 12; i++) {
    await relay.sleep(2500)
    const state = await relay.evaluate<string>(PAGE_STATE)
    const s = JSON.parse(state)
    if (String(s.url).includes('/profile_v4/graphic/articles')) {
      const m = String(s.url).match(/articles\/?$/)
      void m
      // 从页面正文抽 item_id：管理页条目链接
      const id = await relay.evaluate<string | null>(`(function(){
        var a = document.querySelector('a[href*="toutiao.com/item/"], a[href*="toutiao.com/article/"]');
        if (!a) return null;
        var m = (a.href || '').match(/(?:item|article)\\/(\\d{6,})/);
        return m ? m[1] : null;
      })()`)
      return { item_id: id ?? '', url: id ? `https://www.toutiao.com/item/${id}/` : '' }
    }
  }
  throw new CatbusError('UPSTREAM', '发布后没有跳转到作品管理页（可能还在确认面板或被风控拦下）')
}
