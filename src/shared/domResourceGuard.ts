function isExternalUrl(raw: string) {
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw, window.location.href);
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isExternalStylesheetLink(node: Element) {
  if (!(node instanceof HTMLLinkElement)) {
    return false;
  }
  const rel = (node.getAttribute("rel") || node.rel || "").toLowerCase();
  if (!rel.includes("stylesheet")) {
    return false;
  }
  const href = node.getAttribute("href") || node.href || "";
  return isExternalUrl(href);
}

function isExternalScript(node: Element) {
  if (!(node instanceof HTMLScriptElement)) {
    return false;
  }
  const src = node.getAttribute("src") || node.src || "";
  return isExternalUrl(src);
}

function shouldBlockElement(node: Element) {
  return isExternalStylesheetLink(node) || isExternalScript(node);
}

function sanitizeFragment(fragment: DocumentFragment) {
  const blocked = Array.from(
    fragment.querySelectorAll("script[src], link[rel*='stylesheet' i][href]")
  ).filter((node) => shouldBlockElement(node));
  blocked.forEach((node) => node.remove());
  return blocked.length > 0;
}

function installDomResourceGuard() {
  const appendChildRaw = Node.prototype.appendChild;
  const insertBeforeRaw = Node.prototype.insertBefore;
  const replaceChildRaw = Node.prototype.replaceChild;
  const setAttributeRaw = Element.prototype.setAttribute;

  const blockedNotice = (tag: string, url: string) => {
    // Keep minimal logging to help trace unexpected injectors.
    console.warn(`[Favortex] blocked external ${tag}: ${url}`);
  };

  const scriptSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
  const linkHrefDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");
  const linkRelDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "rel");

  Node.prototype.appendChild = function appendChildPatched<T extends Node>(node: T): T {
    if (node instanceof Element && shouldBlockElement(node)) {
      blockedNotice(node.tagName.toLowerCase(), node.getAttribute("src") || node.getAttribute("href") || "");
      return node;
    }
    if (node instanceof DocumentFragment) {
      sanitizeFragment(node);
    }
    return appendChildRaw.call(this, node) as T;
  };

  Node.prototype.insertBefore = function insertBeforePatched<T extends Node>(
    node: T,
    child: Node | null
  ): T {
    if (node instanceof Element && shouldBlockElement(node)) {
      blockedNotice(node.tagName.toLowerCase(), node.getAttribute("src") || node.getAttribute("href") || "");
      return node;
    }
    if (node instanceof DocumentFragment) {
      sanitizeFragment(node);
    }
    return insertBeforeRaw.call(this, node, child) as T;
  };

  Node.prototype.replaceChild = function replaceChildPatched<T extends Node>(node: Node, child: T): T {
    if (node instanceof Element && shouldBlockElement(node)) {
      blockedNotice(
        node.tagName.toLowerCase(),
        node.getAttribute("src") || node.getAttribute("href") || ""
      );
      return child;
    }
    if (node instanceof DocumentFragment) {
      sanitizeFragment(node);
    }
    return replaceChildRaw.call(this, node, child) as T;
  };

  Element.prototype.setAttribute = function setAttributePatched(name: string, value: string): void {
    const lowered = name.toLowerCase();
    if (this instanceof HTMLScriptElement && lowered === "src" && isExternalUrl(value)) {
      blockedNotice("script", value);
      return;
    }
    if (this instanceof HTMLLinkElement) {
      if (lowered === "href") {
        const rel = (this.getAttribute("rel") || this.rel || "").toLowerCase();
        if (rel.includes("stylesheet") && isExternalUrl(value)) {
          blockedNotice("link", value);
          return;
        }
      }
      if (lowered === "rel") {
        const href = this.getAttribute("href") || this.href || "";
        if (value.toLowerCase().includes("stylesheet") && isExternalUrl(href)) {
          blockedNotice("link", href);
          return;
        }
      }
    }
    setAttributeRaw.call(this, name, value);
  };

  if (scriptSrcDescriptor?.get && scriptSrcDescriptor?.set) {
    Object.defineProperty(HTMLScriptElement.prototype, "src", {
      configurable: true,
      enumerable: scriptSrcDescriptor.enumerable ?? true,
      get() {
        return scriptSrcDescriptor.get?.call(this);
      },
      set(value: string) {
        const normalized = String(value || "");
        if (isExternalUrl(normalized)) {
          blockedNotice("script", normalized);
          return;
        }
        scriptSrcDescriptor.set?.call(this, normalized);
      }
    });
  }

  if (linkHrefDescriptor?.get && linkHrefDescriptor?.set) {
    Object.defineProperty(HTMLLinkElement.prototype, "href", {
      configurable: true,
      enumerable: linkHrefDescriptor.enumerable ?? true,
      get() {
        return linkHrefDescriptor.get?.call(this);
      },
      set(value: string) {
        const normalized = String(value || "");
        const rel = (this.getAttribute("rel") || this.rel || "").toLowerCase();
        if (rel.includes("stylesheet") && isExternalUrl(normalized)) {
          blockedNotice("link", normalized);
          return;
        }
        linkHrefDescriptor.set?.call(this, normalized);
      }
    });
  }

  if (linkRelDescriptor?.get && linkRelDescriptor?.set) {
    Object.defineProperty(HTMLLinkElement.prototype, "rel", {
      configurable: true,
      enumerable: linkRelDescriptor.enumerable ?? true,
      get() {
        return linkRelDescriptor.get?.call(this);
      },
      set(value: string) {
        const normalized = String(value || "");
        const href = this.getAttribute("href") || this.href || "";
        if (normalized.toLowerCase().includes("stylesheet") && isExternalUrl(href)) {
          blockedNotice("link", href);
          return;
        }
        linkRelDescriptor.set?.call(this, normalized);
      }
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element && shouldBlockElement(node)) {
          blockedNotice(
            node.tagName.toLowerCase(),
            node.getAttribute("src") || node.getAttribute("href") || ""
          );
          node.remove();
          return;
        }
        if (node instanceof HTMLElement) {
          node
            .querySelectorAll("script[src], link[rel*='stylesheet' i][href]")
            .forEach((el) => {
              if (shouldBlockElement(el)) {
                blockedNotice(
                  el.tagName.toLowerCase(),
                  el.getAttribute("src") || el.getAttribute("href") || ""
                );
                el.remove();
              }
            });
        }
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

installDomResourceGuard();
