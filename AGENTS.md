# Repository Guidelines

## 项目结构与模块组织
- `src/` 为扩展主代码目录。
- UI 入口位于 `src/popup/`、`src/options/`、`src/search/`、`src/onboarding/`，每个入口通常包含 `index.html`、`main.tsx`、`App.tsx`。
- 扩展运行脚本为 `src/background.ts`（service worker）与 `src/content.ts`（content script）。
- 通用能力集中在 `src/shared/`，包括状态、存储、API、i18n、类型与工具函数。
- 静态资源和扩展元数据位于 `public/`（如 `manifest.json`、`icons/`、`_locales/`）。
- 打包脚本在 `scripts/`，构建产物输出到 `artifacts/`，不要手动修改产物文件。

## 构建、测试与开发命令
- `npm install`：安装依赖。
- `npm run dev`：启动 Vite 开发服务，用于页面联调。
- `npm run typecheck`：执行 TypeScript 严格类型检查（`tsc --noEmit`）。
- `npm run build`：构建 Chromium MV3 默认包。
- `npm run build:firefox`：构建并转换 Firefox 可用包。
- `npm run build:ext`：生成发布产物（`.zip`、`.xpi`、`.crx`）到 `artifacts/`。
- `npm run build:debug` / `npm run build:debug:firefox`：生成未压缩调试构建。

## 代码风格与命名规范
- 技术栈：TypeScript + React + Vite（ESM）。
- 遵循现有风格：2 空格缩进、双引号、保留分号。
- 目录名使用小写（如 `src/popup`）；组件和类型使用 PascalCase（如 `App.tsx`、`SearchProviderConfig`）；变量与函数使用 camelCase（如 `makeExcerpt`）。
- 可复用逻辑优先放到 `src/shared/`，避免在各入口重复实现。

## 测试指南
- 当前未引入独立单元测试框架，PR 前至少完成以下检查：
- `npm run typecheck`
- `npm run build:ext`
- 在 Chromium 与 Firefox 中分别基于 `artifacts/dist/` 与 `artifacts/dist-firefox/` 做手工冒烟测试。
- 重点验证：页面收藏/分类、搜索、选项持久化、多语言文案显示。

## 提交与 Pull Request 规范
- 提交信息沿用仓库现有 Conventional Commit 风格：`feat:`、`fix:`、`chore:`（示例：`feat: render markdown in AI search`）。
- 单次提交应聚焦单一改动，避免混入无关修改。
- PR 需包含：变更说明、关联 issue（如有）、本地验证命令及结果；涉及 UI 变更请附截图。

## 安全与配置提示
- 禁止提交 API Key 或签名密钥。
- 发布签名配置通过 GitHub Actions Secrets 注入（`CRX_PRIVATE_KEY_B64`、`AMO_JWT_ISSUER`、`AMO_JWT_SECRET`）。
- `.keys/` 仅用于本地/CI 密钥材料管理。
