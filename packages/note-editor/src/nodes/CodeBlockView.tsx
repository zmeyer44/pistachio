/**
 * A code block in the editor: the code plus a hover bar to pick the language
 * (kept as the `language-*` class, so markdown fences round-trip) and copy
 * the code.
 */

import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useIsEditable } from "./use-is-editable";

const LANGUAGES: Array<[value: string, label: string]> = [
  ["", "Plain text"],
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["graphql", "GraphQL"],
  ["html", "HTML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["jsx", "JSX"],
  ["kotlin", "Kotlin"],
  ["markdown", "Markdown"],
  ["php", "PHP"],
  ["python", "Python"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["shell", "Shell"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["toml", "TOML"],
  ["tsx", "TSX"],
  ["typescript", "TypeScript"],
  ["xml", "XML"],
  ["yaml", "YAML"],
];

const ALIASES: Record<string, string> = { js: "JavaScript", ts: "TypeScript", py: "Python", sh: "Shell", zsh: "Shell", rb: "Ruby", yml: "YAML", md: "Markdown" };

export function labelForLanguage(language: string): string {
  return LANGUAGES.find(([value]) => value === language)?.[1] ?? ALIASES[language] ?? language;
}

export function CodeBlockView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const language = (node.attrs["language"] as string | null | undefined) ?? "";
  const editable = useIsEditable(editor);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard.writeText(node.textContent).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  // Fence languages we don't list (```elixir…) stay selectable as themselves.
  const options: Array<readonly [string, string]> = LANGUAGES.some(([value]) => value === language)
    ? LANGUAGES
    : [[language, labelForLanguage(language)] as const, ...LANGUAGES];

  return (
    <NodeViewWrapper className="note-code" data-language={language === "" ? undefined : language}>
      <pre>
        <div className="note-code__bar" contentEditable={false}>
          {editable ? (
            <select
              className="note-code__language"
              value={language}
              aria-label="Code language"
              onChange={(event) => updateAttributes({ language: event.target.value === "" ? null : event.target.value })}
            >
              {options.map(([value, label]) => (
                <option key={value === "" ? "plain" : value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <span className="note-code__language">{labelForLanguage(language)}</span>
          )}
          <button type="button" className="note-code__copy" onMouseDown={(event) => event.preventDefault()} onClick={copy} aria-label="Copy code" title="Copy code">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <NodeViewContent<"code"> as="code" className={language === "" ? undefined : `language-${language}`} style={{ whiteSpace: "pre" }} />
      </pre>
    </NodeViewWrapper>
  );
}
