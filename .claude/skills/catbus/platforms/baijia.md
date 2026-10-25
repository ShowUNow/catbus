# 百家号（baijia）

| | |
|---|---|
| id / 别名 | `baijia` · `baijiahao` `bjh` |
| `item` 是 | 文章 |
| 登录 | **扫码**（百度 App）· cookie |

## 能做

- **读**：`item get`（匿名可读公开文章）；`item search`（百度网页搜索限定 site:）；`item list`（创作者作品管理）。
- **写**：`item publish`（网页发布，可能要滑块票据）；`item delete`（草稿与已发布同路由）。

## 做不到

作者主页/动态、评论、消息、视频链路。

## 参数

- 文章：纯数字 ID 或 `baijiahao.baidu.com/s?id=<id>` 链接。

## 坑

- 搜索走百度网页搜索，偶发安全验证：显式报错，不当成空结果。
- **`item publish` 会真的发布文章**，发布前把标题和正文给用户确认。
  - 无 `--image` 时自动上传纯色占位封面（平台要求 1–3 张封面）；正式发布建议传真实封面 URL。
  - 平台可能要求滑块（errno=10000015）：在浏览器完成验证后，从重发请求里取 `as`、`ds`、`tk` 三个字段，用 `--ticket as,ds,tk` 注入重试。
- `item delete` 对已发布文章同样生效（实测）。

## 示例

```bash
catbus baijia item get 1839669810600928968
catbus baijia item search 咖啡
catbus baijia item list
catbus baijia item publish --title "标题" --text "正文"
catbus baijia item delete <article_id>
```
