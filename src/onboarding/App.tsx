import { ArrowTopRightIcon, CheckIcon, RocketIcon } from "@radix-ui/react-icons";

const steps = [
  {
    title: "创建分类",
    description: "在设置页新增如 科学技术、视频、资讯 等分类。"
  },
  {
    title: "添加规则",
    description: "常见域名可提前绑定分类，例如 linux.do -> LDO 收藏夹。"
  },
  {
    title: "配置 AI",
    description: "填写 API 类型、Base URL、Key 与模型名称。"
  },
  {
    title: "开始使用",
    description: "在任意页面按快捷键即可自动分类收藏。"
  }
];

export default function App() {
  const openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const openShortcuts = () => {
    const isEdge = navigator.userAgent.includes("Edg");
    const url = isEdge ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
    chrome.tabs.create({ url });
  };

  return (
    <div className="page-scroll px-6 py-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="glass-card animate-float rounded-[36px] px-8 py-10">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="space-y-3">
              <span className="chip">Welcome</span>
              <h1 className="text-3xl font-semibold text-slate-900">欢迎使用 Favortex</h1>
              <p className="max-w-xl text-base text-slate-600">
                Favortex 帮你把网页内容自动归类，告别手动整理收藏夹的烦恼。
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={openOptions}
                className="gradient-button inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold"
              >
                立即配置
                <ArrowTopRightIcon />
              </button>
              <button
                type="button"
                onClick={openShortcuts}
                className="outline-button inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold"
              >
                设置快捷键
                <ArrowTopRightIcon />
              </button>
            </div>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          {steps.map((step, index) => (
            <div
              key={step.title}
              className="glass-card animate-float rounded-[28px] px-6 py-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Step {index + 1}
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
          <h2 className="text-lg font-semibold text-slate-900">使用小贴士</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              推荐先设置 3-5 个常用分类，AI 判断更稳定。
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              规则优先级高于 AI，适合固定站点归档。
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 text-sm text-slate-600">
              收藏后可在弹窗快速搜索与打开链接。
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
