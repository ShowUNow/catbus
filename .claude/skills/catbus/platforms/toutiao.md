# 今日头条（toutiao）

| | |
|---|---|
| id / 别名 | `toutiao` · `jinritoutiao` |
| `item` 是 | 作品 |
| 登录 | **扫码**（今日头条 App）· cookie |

## 能做

- **读**：`keyword hot`（公开热榜，匿名可用；条目里 `/article/` 链接是可读作品）。
- **读（中继）**：`item get` / `item search`（`--relay`）：驱动调试 Chrome（`--remote-debugging-port=9223`）导航读 JSON-LD，绕开环境级风控。
- **写**：`item list`（创作者草稿）；`item delete`（删除草稿）。
- **写（中继）**：`item publish`（`--relay`）：编辑器自动化发布（标题 + ProseMirror 可信输入 + 无封面 + 预览并发布 + 确认），已端到端验证。

## 做不到

纯 HTTP 直连的作品读取与公开发布：so.toutiao.com / www.toutiao.com 对本环境有环境级风控（shark 挑战壳 / JSVM 壳，登录 Cookie 不豁免）；公开发布缺编辑器三签名（`_signature` / `msToken` / `a_bogus`）。中继模式下都能做。已发布作品列表的接口参数未对齐（发布后的 ID 由发布命令返回，删除在创作者后台）。

## 参数

- 作品：`toutiao.com/(article|video|item|group)/<id>` 或纯数字 ID。
- 草稿：`item list` 输出的 `gid`。
- 中继：`--relay http://127.0.0.1:9223`（默认值；Chrome 要用 `--remote-debugging-port=9223` 启动并登录头条）。

## 坑

- 热榜的 ClusterId 不是作品 ID：`trending/<id>` 是聚合页，只有 `Url` 为 `/article/<id>` 的条目是单篇作品。
- `item search` 中继也可能撞验证中心挑战：在中继浏览器里人工过一次滑块后再跑。
- `item publish` 会真的发布文章（走编辑器，等同人工点击）；封面固定选「无封面」（编辑器默认单图在无图时会静默拦截发布）。

## 示例

```bash
catbus toutiao keyword hot
catbus toutiao item list
catbus toutiao item delete <gid>
```
