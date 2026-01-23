# Favortex

Favortex is an AI-powered smart bookmark manager that auto-classifies, summarizes, and searches your saved web pages across Chrome, Edge, and Firefox.

Favortex 是一款 AI 驱动的智能收藏夹，自动分类、摘要并支持搜索你的网页收藏，支持 Chrome、Edge 与 Firefox。

## Highlights / 亮点
- Auto classification with rules + AI (domain rules override) / 规则优先 + AI 自动分类
- Dual summaries (short + long) / 双摘要（短摘要 + 长摘要）
- AI search with embeddings, optional rerank, and follow-up chat / 嵌入检索 + 可选重排 + 追问聊天
- Exa /contents support with fallback / Exa /contents 解析 + 失败回退
- Favicon caching for quick recognition / 网站图标缓存

## Install / 安装

### From artifacts (local load) / 本地加载
- Chrome / Edge: load `artifacts/dist/` as unpacked extension
- Firefox: load `artifacts/dist-firefox/` as temporary add-on

### Store packages / 商店包
- Chrome / Edge: upload `artifacts/favortex.zip`
- Firefox: upload `artifacts/favortex.xpi`

## Build / 构建
```bash
npm install
npm run build:ext
```
Outputs / 产物:
- MV3 build: `artifacts/dist/`
- MV2 Firefox build: `artifacts/dist-firefox/`
- Packages: `artifacts/favortex.crx`, `artifacts/favortex.xpi`, `artifacts/favortex.zip`

Debug (unminified) / 调试版:
```bash
npm run build:debug
npm run build:debug:firefox
```

## Configure / 配置
- AI provider, Base URL, model, API key
- Exa Base URL + API key (optional)
- Embedding and reranker provider + model + base URL + key
- Theme color, compact mode, and other UI preferences

## Search / 搜索
- Classic search: title / URL / summary
- AI search: embeddings + optional rerank
- Follow-up chat uses current results (title + long summary)

## Permissions / 权限说明
- `storage` / `unlimitedStorage`: save bookmarks, embeddings, settings
- `tabs`: read current tab URL/title for quick saving
- `scripting` (MV3 only): inject content script when ensuring capture
- `<all_urls>`: required to read page content and favicon

## Privacy / 隐私
- Data is stored locally in the extension storage.
- AI/Exa requests are sent only to the endpoints you configure.

数据存储在本地扩展存储中；AI/Exa 请求仅发送到你配置的服务地址。

## Release / 发布
The GitHub Actions workflow builds packages on tag push or manual dispatch.
Use tags like `v1.0.0` to trigger a release build.

GitHub Actions 在标签推送或手动触发时构建产物；使用 `v1.0.0` 等标签触发发布。
