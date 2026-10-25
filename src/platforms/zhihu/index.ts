import { z } from 'zod'
import { definePlatform, handlers } from '../../core/registry.js'

/** 懒加载 web 端的 handler。 */
const { impl } = handlers(() => import('./web/commands.js'))

export default definePlatform({
  id: 'zhihu',
  name: '知乎',
  aliases: ['zh'],
  item: '内容',
  endpoints: {
    app: 'planned',
    pc: 'planned',
    web: {
      login: { methods: ['qrcode', 'cookie'], default: 'qrcode' },
      commands: {
        'auth login': impl('full', 'authLogin'),
        'auth status': impl('full', 'authStatus'),

        'item get': impl('full', 'itemGet', { note: '回答 / 专栏文章；参数是完整内容 URL' }),
        'item search': impl('partial', 'itemSearch', { note: '需要登录 Cookie（匿名撞权限墙）' }),
        'item list': 'none',
        'item publish': impl('full', 'itemPublish', {
          supports: ['title', 'text'],
          note: '草稿 → 公开发布（POST /api/v4/content/publish，2026-10-25 实抓契约）；--draft 只存草稿',
          options: { draft: z.boolean().optional().describe('只存草稿，不公开发布') },
        }),
        'item delete': impl('full', 'itemDelete', { note: '删除已发布的专栏文章（与草稿同路由实测）' }),
      },
    },
  },
})
