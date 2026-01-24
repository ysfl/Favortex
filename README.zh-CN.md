# Favortex

> [English](README.md) | [简体中文](README.zh-CN.md)

Favortex 是一款 AI 驱动的智能收藏夹，自动分类、摘要并支持搜索你的网页收藏，支持 Chrome、Edge 与 Firefox。

## 亮点
- 规则优先 + AI 自动分类
- 双摘要（短摘要 + 长摘要）
- AI 搜索（嵌入检索 + 可选重排 + 追问聊天）
- Exa /contents 解析（失败自动回退）
- 网站图标缓存，方便快速识别

## 安装

### 本地加载
- Chrome / Edge：加载 `artifacts/dist/` 作为解压扩展
- Firefox：加载 `artifacts/dist-firefox/` 作为临时附加组件

### 商店包
- Chrome / Edge：上传 `artifacts/favortex.zip`
- Firefox：上传 `artifacts/favortex.xpi`

## 构建
```bash
npm install
npm run build:ext
```
产物位置：
- MV3 构建：`artifacts/dist/`
- MV2 Firefox 构建：`artifacts/dist-firefox/`
- 包文件：`artifacts/favortex.crx`、`artifacts/favortex.xpi`、`artifacts/favortex.zip`

调试版（未压缩）：
```bash
npm run build:debug
npm run build:debug:firefox
```

## 配置
- AI 提供商、Base URL、模型、API Key
- Exa Base URL 与 API Key（可选）
- Embedding 与 Reranker 的提供商、模型、Base URL、Key
- 主题色、简洁模式与其他 UI 偏好

## 搜索
- 传统搜索：标题 / 链接 / 摘要
- AI 搜索：嵌入检索 + 可选重排
- 追问聊天使用当前结果（标题 + 长摘要）

## 权限说明
- `storage` / `unlimitedStorage`：保存收藏、嵌入与设置
- `tabs`：读取当前标签页 URL/标题以便快速收藏
- `scripting`（仅 MV3）：确保内容脚本注入
- `<all_urls>`：读取网页正文与 favicon

## 隐私
数据保存在扩展本地存储中；AI/Exa 请求仅发送到你配置的服务地址。

## 许可证
GPL-3.0-only，详见 [LICENSE](LICENSE)。

## 发布
GitHub Actions 在标签推送或手动触发时构建产物，使用 `v1.0.0` 之类的标签触发发布构建。
