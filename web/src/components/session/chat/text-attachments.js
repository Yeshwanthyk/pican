export function textAttachmentLabel(att, fallback = 'Text attachment') {
  const snippet = String(att?.original || '')
    .replace(/\s+/g, ' ')
    .trim();
  return snippet.length > 48 ? snippet.slice(0, 48) + '…' : snippet || fallback;
}

export function composeMessageWithTextAttachments(typed, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return typed;
  const blocks = attachments.map((att) => {
    const quoted = String(att.original || '')
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n');
    return att.note ? quoted + '\n\n' + att.note : quoted;
  });
  if (typed) blocks.push(typed);
  return blocks.join('\n\n');
}
