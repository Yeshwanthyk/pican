export const strictStrikethroughRegex =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// marked.use() wraps existing tokenizer/renderer hooks rather than replacing
// them. Reconfiguring the shared live instance on every SPA session switch
// therefore retains each prior renderer closure and its unmounted session DOM.
// Each Marked instance has one immutable session-markdown configuration.
const configuredMarkedInstances = new WeakSet<object>();

export function configureSessionMarkdown({
  marked,
  hljs,
  escapeHtml,
}: {
  readonly marked: Marked;
  readonly hljs: HLJSApi | null;
  readonly escapeHtml: (text: unknown) => string;
}): void {
  if (configuredMarkedInstances.has(marked)) return;
  configuredMarkedInstances.add(marked);
  marked.use({
    breaks: true,
    gfm: true,
    tokenizer: {
      html() {
        return undefined;
      },
      tag() {
        return undefined;
      },
      del(src) {
        const match = strictStrikethroughRegex.exec(src);
        if (!match) return undefined;
        const text = match[2];
        if (text === undefined) return undefined;
        return {
          type: "del",
          raw: match[0],
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      },
    },
    renderer: {
      link(token) {
        const href = (token.href || "").trim();
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          return this.parser.parseInline(token.tokens);
        }
        let out = '<a href="' + escapeHtml(href) + '"';
        if (token.title) {
          out += ' title="' + escapeHtml(token.title) + '"';
        }
        out += ">" + this.parser.parseInline(token.tokens) + "</a>";
        return out;
      },
      image(token) {
        const href = (token.href || "").trim();
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          return escapeHtml(token.text || "");
        }
        let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || "") + '"';
        if (token.title) {
          out += ' title="' + escapeHtml(token.title) + '"';
        }
        out += ">";
        return out;
      },
      code(token) {
        const code = token.text;
        const lang = token.lang;
        if (hljs) {
          let highlighted: string;
          if (lang && hljs.getLanguage(lang)) {
            highlighted = runSync(
              Effect.try({
                try: () => hljs.highlight(code, { language: lang }).value,
                catch: () => escapeHtml(code),
              }).pipe(Effect.catch((fallback) => Effect.succeed(fallback))),
            );
          } else {
            highlighted = runSync(
              Effect.try({
                try: () => hljs.highlightAuto(code).value,
                catch: () => escapeHtml(code),
              }).pipe(Effect.catch((fallback) => Effect.succeed(fallback))),
            );
          }
          return `<pre><code class="hljs">${highlighted}</code></pre>`;
        }
        // hljs not yet loaded: plain text, marked for lazy highlighting
        const dataLang = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        return `<pre><code class="hljs" data-highlight-pending${dataLang}>${escapeHtml(code)}</code></pre>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      },
    },
  });
}

export function safeMarkedParse(text: string, { marked }: { readonly marked: Marked }): string {
  return marked.parse(text, { async: false });
}
import { Effect } from "effect";
import type { HLJSApi } from "highlight.js";
import type { Marked } from "marked";
import { runSync } from "../../lib/runtime.js";
