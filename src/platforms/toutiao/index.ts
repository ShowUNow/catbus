import { z } from 'zod'
import { definePlatform, handlers } from '../../core/registry.js'

/** 懒加载 web 端的 handler。 */
const { impl } = handlers(() => import('./web/commands.js'))

export default definePlatform({
  id: 'toutiao',
  name: '今日头条',
  aliases: ['jinritoutiao'],
  item: '作品',
  endpoints: {
    app: 'planned',
    pc: 'planned',
    web: {
      guest: true,
      login: { methods: ['qrcode', 'cookie'], default: 'qrcode' },
      commands: {
        'auth login': impl('full', 'authLogin'),
        'auth status': impl('full', 'authStatus'),

        'keyword hot': impl('full', 'keywordHot', { note: '公开热榜，匿名可用；条目里 /article/ 链接是可读作品' }),

        'item get': impl('partial', 'itemGet', {
          note: '需要 --relay <CDP 地址>：环境级风控下走浏览器中继读 JSON-LD',
          options: { relay: z.string().optional().describe('调试 Chrome 的 CDP 地址（--remote-debugging-port），默认 http://127.0.0.1:9223') },
        }),
        'item search': impl('partial', 'itemSearch', {
          note: '需要 --relay；中继浏览器里先人工过一次验证中心滑块',
          options: { relay: z.string().optional().describe('调试 Chrome 的 CDP 地址，默认 http://127.0.0.1:9223') },
        }),
        'item list': impl('partial', 'itemList', { note: '创作者草稿；已发布列表接口参数未对齐' }),
        'item delete': impl('full', 'itemDelete', { note: '删除草稿；发布出去的作品在创作者后台删' }),
        'item publish': impl('partial', 'itemPublish', {
          supports: ['title', 'text'],
          note: '需要 --relay：编辑器自动化（纯 HTTP 缺 _signature/msToken/a_bogus 三签名）',
          options: { relay: z.string().optional().describe('调试 Chrome 的 CDP 地址，默认 http://127.0.0.1:9223') },
        }),
      },
    },
  },
})
