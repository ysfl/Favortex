import { ArrowTopRightIcon, CheckIcon, RocketIcon } from "@radix-ui/react-icons";
import clsx from "clsx";
import { useCallback, useEffect, useMemo } from "react";
import { useAppState } from "../shared/hooks";
import { getLanguageTag, useI18n } from "../shared/i18n";

export default function App() {
  const { t, locale } = useI18n();
  const { state } = useAppState();

  useEffect(() => {
    document.documentElement.lang = getLanguageTag(locale);
    document.title = t("欢迎使用 Favortex", "Welcome to Favortex");
  }, [locale, t]);
  const hasCategories = (state?.categories ?? []).length > 1;
  const hasRules = (state?.rules ?? []).length > 0;
  const aiReady = Boolean(state?.ai.apiKey && state.ai.baseUrl && state.ai.model);
  const exaReady = Boolean(state?.exa.enabled && state.exa.apiKey && state.exa.baseUrl);
  const embeddingReady = Boolean(
    state?.search.embedding.apiKey &&
      state.search.embedding.baseUrl &&
      state.search.embedding.model
  );
  const steps = useMemo(
    () => [
      {
        title: t("打开设置中心", "Open settings"),
        description: t(
          "先打开设置页面，准备好常用分类与规则。",
          "Open settings first and prepare your core categories and rules."
        )
      },
      {
        title: t("完善分类规则", "Add rules"),
        description: t(
          "为常见站点添加域名/URL 前缀或自然语言提示。",
          "Bind domain/URL prefixes or add natural hints for sites you visit."
        )
      },
      {
        title: t("配置 AI 与 Exa", "Configure AI + Exa"),
        description: t(
          "填写 AI 供应商与 Exa 参数，摘要与分类会更稳定。",
          "Fill AI provider + Exa for more reliable summaries and classification."
        )
      },
      {
        title: t("配置 AI 搜索", "Set up AI search"),
        description: t(
          "填写 Embedding（可选 Reranker），搜索会更精准。",
          "Provide embedding (optional rerank) to improve AI search."
        )
      },
      {
        title: t("开始收藏", "Start saving"),
        description: t(
          "在任意页面按快捷键即可自动分类收藏。",
          "Press the shortcut on any page to save and classify."
        )
      }
    ],
    [t]
  );
  const openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const openOptionsTab = useCallback((tab: "categories" | "bookmarks" | "ai") => {
    const url = chrome.runtime.getURL(`options/index.html?tab=${tab}`);
    chrome.tabs.create({ url });
  }, []);

  const openShortcuts = () => {
    const isEdge = navigator.userAgent.includes("Edg");
    const url = isEdge ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
    chrome.tabs.create({ url });
  };

  const checklist = useMemo(
    () => [
      {
        title: t("已创建分类", "Categories created"),
        description: t("建议先建立 3-5 个常用分类。", "Start with 3-5 core categories."),
        done: hasCategories,
        optional: false,
        action: () => openOptionsTab("categories")
      },
      {
        title: t("已添加规则", "Rules added"),
        description: t("为固定站点配置域名或 URL 前缀。", "Add domain or URL prefix rules."),
        done: hasRules,
        optional: false,
        action: () => openOptionsTab("categories")
      },
      {
        title: t("AI 已配置", "AI configured"),
        description: t("填写 API Key 与模型名称。", "Provide API key and model."),
        done: aiReady,
        optional: false,
        action: () => openOptionsTab("ai")
      },
      {
        title: t("Exa 已启用", "Exa enabled"),
        description: t("可选，用于提取页面内容。", "Optional: fetch cleaner page content."),
        done: exaReady,
        optional: true,
        action: () => openOptionsTab("ai")
      },
      {
        title: t("AI 搜索已配置", "AI search ready"),
        description: t("可选，配置 Embedding 后更好用。", "Optional: add embeddings for AI search."),
        done: embeddingReady,
        optional: true,
        action: () => openOptionsTab("ai")
      }
    ],
    [t, hasCategories, hasRules, aiReady, exaReady, embeddingReady, openOptionsTab]
  );

  return (
    <div className="page-scroll px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <header className="glass-card animate-float rounded-[36px] px-8 py-10">
            <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
              <div className="space-y-3">
                <span className="chip">{t("欢迎", "Welcome")}</span>
                <h1 className="text-3xl font-semibold text-slate-900">
                  {t("欢迎使用 Favortex", "Welcome to Favortex")}
                </h1>
                <p className="max-w-xl text-base text-slate-600">
                  {t(
                    "Favortex 帮你把网页内容自动归类，告别手动整理收藏夹的烦恼。",
                    "Favortex auto-classifies your web saves so you can stop organizing manually."
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={openOptions}
                  className="gradient-button inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold"
                >
                  {t("立即配置", "Configure now")}
                  <ArrowTopRightIcon />
                </button>
                <button
                  type="button"
                  onClick={() => openOptionsTab("ai")}
                  className="outline-button inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold"
                >
                  {t("打开 AI 配置", "Open AI settings")}
                  <ArrowTopRightIcon />
                </button>
                <button
                  type="button"
                  onClick={openShortcuts}
                  className="outline-button inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold"
                >
                  {t("设置快捷键", "Set shortcuts")}
                  <ArrowTopRightIcon />
                </button>
              </div>
            </div>
          </header>

          <section className="glass-card rounded-[30px] px-6 py-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {t("配置清单", "Setup checklist")}
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {t(
                    "按顺序完成配置，AI 才能稳定工作。",
                    "Complete these steps to stabilize AI behavior."
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => openOptionsTab("categories")}
                className="outline-button rounded-full px-3 py-1 text-xs font-semibold"
              >
                {t("去设置", "Go to settings")}
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {checklist.map((item) => {
                const status = !state
                  ? t("检测中", "Checking")
                  : item.done
                    ? t("已完成", "Done")
                    : item.optional
                      ? t("可选", "Optional")
                      : t("待配置", "Pending");
                const statusClass = !state
                  ? "border-slate-200 bg-white/80 text-slate-500"
                  : item.done
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : item.optional
                      ? "border-slate-200 bg-white/80 text-slate-500"
                      : "border-amber-200 bg-amber-50 text-amber-700";
                return (
                  <div
                    key={item.title}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/70 bg-white/80 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-slate-800">{item.title}</div>
                        <span
                          className={clsx(
                            "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                            statusClass
                          )}
                        >
                          {status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{item.description}</div>
                    </div>
                    <button
                      type="button"
                      onClick={item.action}
                      className="outline-button rounded-full px-3 py-1 text-xs font-semibold"
                    >
                      {t("前往", "Go")}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <section className="grid gap-4 md:grid-cols-2">
          {steps.map((step, index) => (
            <div
              key={step.title}
              className="glass-card animate-float rounded-[28px] px-6 py-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    {t("步骤 {index}", "Step {index}", { index: index + 1 })}
                  </div>
                  <h3 className="mt-2 text-xl font-semibold text-slate-900">
                    {step.title}
                  </h3>
                </div>
                <div className="rounded-full border border-white/70 bg-white/70 p-2 text-slate-600">
                  {index === steps.length - 1 ? <RocketIcon /> : <CheckIcon />}
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-600">{step.description}</p>
            </div>
          ))}
        </section>

        <section className="glass-card rounded-[30px] px-6 py-6">
          <h2 className="text-lg font-semibold text-slate-900">
            {t("使用小贴士", "Tips")}
          </h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              {t(
                "推荐先设置 3-5 个常用分类，AI 判断更稳定。",
                "Start with 3-5 common categories for more stable AI results."
              )}
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              {t(
                "规则优先级高于 AI，适合固定站点归档。",
                "Rules override AI, perfect for recurring domains."
              )}
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              {t(
                "配置 Exa 与 Embedding 后，摘要与搜索更准确。",
                "Exa + embeddings improve summary quality and AI search."
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
