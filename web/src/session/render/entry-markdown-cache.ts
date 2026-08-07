export type EntryMarkdownSlot = string | number;
export type MarkdownParser = (content: string) => string;

interface CachedMarkdown {
  readonly contentRevision: string;
  readonly parserRevision: unknown;
  readonly html: string;
}

/**
 * Caches rendered Markdown only while its entry object remains reachable.
 * Callers provide a stable slot for each Markdown-bearing field within the entry.
 */
export function createEntryMarkdownCache(
  parse: MarkdownParser,
  getParserRevision: () => unknown = () => undefined,
): (entry: object, slot: EntryMarkdownSlot, content: string) => string {
  const entries = new WeakMap<object, Map<EntryMarkdownSlot, CachedMarkdown>>();

  return (entry, slot, content) => {
    let slots = entries.get(entry);
    if (!slots) {
      slots = new Map();
      entries.set(entry, slots);
    }

    const parserRevision = getParserRevision();
    const cached = slots.get(slot);
    if (cached?.contentRevision === content && cached.parserRevision === parserRevision) {
      return cached.html;
    }

    const html = parse(content);
    slots.set(slot, { contentRevision: content, parserRevision, html });
    return html;
  };
}
