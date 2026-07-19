import type { HLJSApi } from "highlight.js";
import type { marked } from "marked";

export type ExportMarked = typeof marked;

const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

export function configureSessionMarkdown({
  marked,
  hljs,
  escapeHtml,
}: {
  readonly marked: ExportMarked;
  readonly hljs: HLJSApi | null;
  readonly escapeHtml: (text: unknown) => string;
}): void {
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
        const text = match?.[2];
        if (!match || text === undefined) return undefined;
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
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${escapeHtml(href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token) {
        const href = (token.href || "").trim();
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          return escapeHtml(token.text || "");
        }
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text || "")}"${title}>`;
      },
      code(token) {
        const language = token.lang;
        if (hljs) {
          const highlighted =
            language && hljs.getLanguage(language)
              ? hljs.highlight(token.text, { language }).value
              : hljs.highlightAuto(token.text).value;
          return `<pre><code class="hljs">${highlighted}</code></pre>`;
        }
        const dataLanguage = language ? ` data-lang="${escapeHtml(language)}"` : "";
        return `<pre><code class="hljs" data-highlight-pending${dataLanguage}>${escapeHtml(token.text)}</code></pre>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      },
    },
  });
}

export function safeMarkedParse(
  text: string,
  { marked }: { readonly marked: ExportMarked },
): string {
  return marked.parse(text, { async: false });
}
