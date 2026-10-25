import { z } from 'zod'
import { definePlatform, handlers } from '../../core/registry.js'

/** 懒加载 web 端的 handler。 */
const { impl } = handlers(() => import('./web/commands.js'))

export default definePlatform({
  id: 'baijia',
  name: '百家号',
  aliases: ['baijiahao', 'bjh'],
  item: '文章',
  endpoints: {
    app: 'planned',
    pc: 'planned',
    web: {
      guest: true,
      login: { methods: ['qrcode', 'cookie'], default: 'qrcode' },
      commands: {
        'auth login': impl('full', 'authLogin'),
        'auth status': impl('full', 'authStatus'),

        'user get': 'none',
        'user search': 'none',
        'user items': 'none',

        'item get': impl('full', 'itemGet', { note: '匿名可读公开文章', auth: 'optional' }),
        'item search': impl('partial', 'itemSearch', {
          note: '百度网页搜索限定 site:，偶发安全验证（显式报错，不当成空结果）',
          auth: 'optional',
        }),
        'item list': impl('full', 'itemList', { note: '创作者作品管理' }),
        'item publish': impl('partial', 'itemPublish', {
          supports: ['title', 'text', 'image'],
          note: '平台可能要求滑块（errno=10000015）：浏览器过验证后 --ticket as,ds,tk 注入票据重试',
          options: {
            ticket: z.string().describe('kunlun 滑块票据，格式 as,ds,tk（浏览器过验证后从重发请求里取）'),
          },
        }),
        'item delete': impl('full', 'itemDelete', { note: '草稿与已发布同路由' }),
      },
    },
  },
})
