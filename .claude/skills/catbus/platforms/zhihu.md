# 知乎（zhihu）

| | |
|---|---|
| id / 别名 | `zhihu` · `zh` |
| `item` 是 | 内容 |
| 登录 | **扫码**（知乎 App）· cookie |

## 能做

- **读**：`item search`（综合搜索，需要登录 Cookie）；`item get`（回答 / 专栏文章详情，参数是完整内容 URL）。
- **写**：`item publish`（纯 HTTP：建草稿 → 存正文 → `POST /api/v4/content/publish`，带 x-zse-96 签名；`--draft` 只存草稿）；`item delete`（删除已发布文章，需确认）。

## 做不到

自己的内容列表（知乎没有稳定的草稿/作品列表 HTTP 端点，只有计数）。回答的发布与删除。短信/密码登录（依赖 `zsEncrypt` 加密体）。匿名搜索撞登录/权限墙。

## 参数

- 内容：完整 URL（`zhihu.com/question/.../answer/<id>` 或 `zhuanlan.zhihu.com/p/<id>`；`api.zhihu.com` 形态也可以）。
- 发布：`--title` + `--text`。

## 坑

- 二维码约 2 分钟过期，客户端会自动换新码重画。
- 扫码确认那一拍直接返回 `access_token` 并种下 `z_c0` Cookie，全程不需要加密。
- `item publish` 会真的发布文章；`item delete` 要 `--yes` 确认。

## 示例

```bash
catbus zhihu auth login
catbus zhihu item search 咖啡
```
