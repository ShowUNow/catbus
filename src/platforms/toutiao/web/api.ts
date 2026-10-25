import { CatbusError } from '../../../core/errors.js'
import type { Tt } from './client.js'
import { MP } from './client.js'

/** 读取侧接口（上游 tou_tiao_creator_web_api.py + 热榜契约）。 */

/** 登录态：user_login_status_api，code=0 且 is_login 即已登录。 */
export async function loginStatus(p: Tt): Promise<any> {
  return p.json({
    url: `${MP}/mp/agw/media/user_login_status_api`,
    headers: { accept: 'application/json, text/plain, */*', referer: `${MP}/profile_v4/` },
  })
}

export class ToutiaoRiskBlocked extends CatbusError {
  constructor() {
    super('UPSTREAM', 'so.toutiao.com 搜索被环境级风控拦截（登录 Cookie 也不豁免）；可用的发现源是热榜（keyword hot）')
  }
}

export interface HotEntry {
  ClusterId: string
  Title: string
  Url: string
  HotValue: string
}

/** 公开热榜（匿名可用；条目 Url 为 /article/ 的是可读作品）。 */
export async function hotBoard(p: Tt): Promise<HotEntry[]> {
  const data = await p.json({
    url: 'https://www.toutiao.com/hot-event/hot-board/',
    query: { origin: 'toutiao_pc' },
    headers: { referer: 'https://www.toutiao.com/' },
  })
  const list: any[] = data?.data ?? []
  return list.map((it) => ({
    ClusterId: String(it.ClusterId ?? it.ClusterIdStr ?? ''),
    Title: String(it.Title ?? ''),
    Url: String(it.Url ?? ''),
    HotValue: String(it.HotValue ?? ''),
  }))
}

/** 草稿列表（创作者中心）。 */
export async function listDrafts(p: Tt): Promise<any[]> {
  const data = await p.json({
    url: `${MP}/mp/agw/creator_center/draft_list`,
    query: { app_id: '1231' },
    headers: { referer: `${MP}/profile_v4/graphic/publish` },
  })
  if (data?.code !== 0) throw new CatbusError('UPSTREAM', `草稿列表 code=${data?.code}`, { detail: data?.message })
  const d = data?.data ?? {}
  return (d.draft_list ?? d.list ?? []) as any[]
}

/** 删除草稿（body 只带 draft_type 与 gid）。 */
export async function deleteDraft(p: Tt, gid: string, draftType: string): Promise<any> {
  return p.json({
    method: 'POST',
    url: `${MP}/mp/agw/creator_center/delete_draft`,
    query: { app_id: '1231' },
    json: { draft_type: draftType, gid },
    headers: { referer: `${MP}/profile_v4/graphic/publish`, origin: MP },
  })
}
