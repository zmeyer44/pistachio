/**
 * The page-side halves of the browser tools, as scripts evaluated as
 * strings in the page — Electron `webContents.executeJavaScript` and
 * Playwright `page.evaluate` alike. Every script is an IIFE that returns a
 * JSON-serializable value; the host does the rest (real keystrokes, the
 * settle delays, the error for a control that was not found).
 *
 * Kept as one copy so both backends read, find, and read back exactly the
 * same way: a control the desktop finds by label is the control the cloud
 * finds too.
 */

/** Read a compact, semantic view of a page. Returns a `PageInspection`. */
export const INSPECT_PAGE_SCRIPT = `(() => {
      const selectorFor = (element) => {
        if (element.id) return '#' + CSS.escape(element.id);
        const testId = element.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const name = element.getAttribute('name');
        if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const aria = element.getAttribute('aria-label');
        if (aria) return element.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
        const parts = [];
        let current = element;
        while (current instanceof Element && current !== document.body && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
            : [];
          if (siblings.length > 1) part += ':nth-of-type(' + String(siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      return {
      title: document.title,
      url: location.href,
      text: String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 24000),
      controls: [...document.querySelectorAll("a, button, input, textarea, select, [contenteditable=true], [role=button], [role=link], [role=option], [role=combobox], [role=listbox], [role=textbox], [role=searchbox], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=checkbox], [role=radio], [role=switch]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 180)
        .map((element) => ({
          role: element.getAttribute("role") || element.tagName.toLowerCase(),
          name: String(
            element.getAttribute("aria-label") ||
            element.getAttribute("placeholder") ||
            element.textContent ||
            element.getAttribute("name") ||
            ""
          ).replace(/\\s+/g, " ").trim().slice(0, 240),
          selector: selectorFor(element),
          href: element instanceof HTMLAnchorElement ? element.href : null,
          type: element instanceof HTMLInputElement ? element.type : null,
          value:
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? String(element.value).slice(0, 240)
              : element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox"
                ? String(element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 240)
                : null,
          disabled: 'disabled' in element && Boolean(element.disabled),
        })),
      };
    })()`;

/**
 * How both finders resolve a target that may be a CSS selector or a visible
 * label. The two overlap: an HTML document matches type selectors
 * case-insensitively, so `querySelector("Search")` finds a `<search>`
 * landmark and `querySelector("Main")` the page's `<main>`. A target that is
 * a bare word is therefore matched as a label first and tried as a selector
 * only when no label matches; anything with selector syntax in it keeps the
 * selector-first order. Labels rank exact, then whole-word, then substring,
 * so a button labelled exactly "Add to cart" wins over a card that merely
 * contains those words.
 *
 * A function expression taking the target, the candidate elements, and the
 * labels to read off one candidate. Returns an element or null.
 */
const RESOLVE_TARGET = `((target, candidates, labelsOf) => {
      const normalized = target.trim().replace(/\\s+/g, " ").toLowerCase();
      const asSelector = () => {
        try { return document.querySelector(target); } catch { return null; }
      };
      const labelsFor = (candidate) => labelsOf(candidate)
        .map((value) => String(value ?? "").replace(/\\s+/g, " ").trim().toLowerCase())
        .filter((value) => value !== "");
      const wholeWord = (label) => {
        for (let at = label.indexOf(normalized); at >= 0; at = label.indexOf(normalized, at + 1)) {
          const before = at === 0 ? "" : label[at - 1];
          const after = label[at + normalized.length] ?? "";
          if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after)) return true;
        }
        return false;
      };
      const byLabel = () => {
        if (normalized === "") return null;
        const scored = [...candidates()].map((candidate) => ({ candidate, labels: labelsFor(candidate) }));
        return scored.find((item) => item.labels.some((label) => label === normalized))?.candidate
          ?? scored.find((item) => item.labels.some((label) => wholeWord(label)))?.candidate
          ?? scored.find((item) => item.labels.some((label) => label.includes(normalized)))?.candidate
          ?? null;
      };
      return /^[a-z][a-z0-9-]*$/iu.test(target.trim()) ? byLabel() ?? asSelector() : asSelector() ?? byLabel();
    })`;

/**
 * Click a control found by CSS selector or by visible label. Returns
 * `true` when a control was clicked and `false` when none matched — the
 * host throws `page control not found: <target>` on false. The click is
 * `element.click()`, synthetic on both backends.
 */
export function clickPageScript(target: string): string {
  const encoded = JSON.stringify(target);
  return `(() => {
      const element = ${RESOLVE_TARGET}(
        ${encoded},
        () => document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button], [role=link], [role=option], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab]"),
        (candidate) => [candidate.getAttribute("aria-label"), candidate.textContent, candidate.value],
      );
      if (!(element instanceof HTMLElement)) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()`;
}

/** The editable-control finder shared by the two halves of `type`: a function expression, not called. */
function editableFinder(encodedTarget: string): string {
  return `(() => {
      const element = ${RESOLVE_TARGET}(
        ${encodedTarget},
        () => document.querySelectorAll("input, textarea, [contenteditable=true], [role=textbox], [role=searchbox], [role=combobox]"),
        (candidate) => [
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("placeholder"),
          candidate.getAttribute("name"),
          candidate.id,
        ],
      );
      return element instanceof HTMLElement ? element : null;
    })`;
}

const READ_BACK = `((element) =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? String(element.value)
        : String(element?.textContent ?? ""))`;

/**
 * The first half of `type`: find the editable control, bring it into view,
 * focus it, and select what is there so the first keystroke replaces it.
 * Returns `false` when no editable control matched — the host throws
 * `editable page control not found: <target>` — and `true` otherwise, after
 * which the host strikes the real keys.
 */
export function typePrepareScript(target: string): string {
  const finder = editableFinder(JSON.stringify(target));
  return `(() => {
      const element = ${finder}();
      if (element === null) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      // Select what is there so the first keystroke replaces it.
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
      else window.getSelection()?.selectAllChildren(element);
      return true;
    })()`;
}

/**
 * The second half of `type`: read the control back after the keystrokes.
 * When they did not land — some widgets re-render mid-type — the synthetic
 * path runs as a fallback (the prototype's value setter plus `input` and
 * `change` events) before the read-back. Returns the control's contents.
 */
export function typeReadBackScript(target: string, value: string): string {
  const finder = editableFinder(JSON.stringify(target));
  const encodedValue = JSON.stringify(value);
  return `(() => {
      const element = ${finder}();
      const value = ${encodedValue};
      const textual = (candidate) => candidate.isContentEditable
        || ["textbox", "searchbox", "combobox"].includes(String(candidate.getAttribute("role") ?? ""));
      let current = ${READ_BACK}(element);
      if (element !== null && current.trim() !== value.trim()) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
          setter?.call(element, value);
        } else if (!textual(element)) {
          // Not a text-entry control: writing to it would replace whatever
          // the element holds, so report what is there and let the host say
          // the text did not land.
          return current;
        } else {
          element.textContent = value;
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        current = ${READ_BACK}(element);
      }
      return current;
    })()`;
}

/** Scroll the page vertically by `deltaY` CSS pixels. Returns `true`. */
export function scrollScript(deltaY: number): string {
  return `(() => {
      window.scrollBy({ top: ${String(Math.round(deltaY))}, behavior: "smooth" });
      return true;
    })()`;
}
