<p align="center"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a></p>

# Favortex

Favortex is an AI-powered smart bookmark manager that auto-classifies, summarizes, and searches your saved web pages across Chrome, Edge, and Firefox.

## Highlights
- Auto classification with rules + AI (domain rules override)
- Dual summaries (short + long)
- AI search with embeddings, optional rerank, and follow-up chat
- Exa /contents support with fallback
- Favicon caching for quick recognition

## Install

### From artifacts (local load)
- Chrome / Edge: load `artifacts/dist/` as an unpacked extension
- Firefox: load `artifacts/dist-firefox/` as a temporary add-on

### Store packages
- Chrome / Edge: upload `artifacts/favortex.zip`
- Firefox: upload `artifacts/favortex.xpi`

## Build
```bash
npm install
npm run build:ext
```
Outputs:
- MV3 build: `artifacts/dist/`
- MV2 Firefox build: `artifacts/dist-firefox/`
- Packages: `artifacts/favortex.crx`, `artifacts/favortex.xpi`, `artifacts/favortex.zip`

Debug (unminified):
```bash
npm run build:debug
npm run build:debug:firefox
```

## Configure
- AI provider, Base URL, model, API key
- Exa Base URL + API key (optional)
- Embedding and reranker provider + model + base URL + key
- Theme color, compact mode, and other UI preferences

## Search
- Classic search: title / URL / summary
- AI search: embeddings + optional rerank
- Follow-up chat uses current results (title + long summary)

## Permissions
- `storage` / `unlimitedStorage`: save bookmarks, embeddings, settings
- `tabs`: read current tab URL/title for quick saving
- `scripting` (MV3 only): inject content script when ensuring capture
- `<all_urls>`: required to read page content and favicon

## Privacy
Data is stored locally in the extension storage. AI/Exa requests are sent only to the endpoints you configure.

## Release
The GitHub Actions workflow builds packages on tag push or manual dispatch. Use tags like `v1.0.0` to trigger a release build.
