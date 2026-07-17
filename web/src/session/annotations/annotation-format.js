export function annotationOffsetToLine(content, offset) {
  let line = 1;
  const limit = Math.min(Math.max(0, offset), content.length);
  for (let i = 0; i < limit; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

export function annotationLineLabel(content, start, end) {
  if (typeof content !== 'string' || content.length === 0) return '';
  const a = annotationOffsetToLine(content, start);
  const b = annotationOffsetToLine(content, Math.max(start, end - 1));
  return a === b ? `Line ${a}` : `Lines ${a}-${b}`;
}

export function quoteAnnotationText(text) {
  return `"${String(text || '')
    .replace(/\s+/g, ' ')
    .trim()}"`;
}

export function formatAnnotationsForPi(annotations = [], { resolveArtifact = null } = {}) {
  const fileGroups = new Map();
  const conversation = [];
  for (const annotation of annotations || []) {
    const anchorId = annotation.anchorId || '';
    if (anchorId.indexOf('artifact-') === 0) {
      const artifact = resolveArtifact ? resolveArtifact(anchorId.slice('artifact-'.length)) : null;
      const path = (artifact && (artifact.filePath || artifact.title)) || '(artifact)';
      const label = artifact
        ? annotationLineLabel(artifact.content, annotation.startOffset, annotation.endOffset)
        : '';
      if (!fileGroups.has(path)) fileGroups.set(path, []);
      fileGroups.get(path).push({ label, original: annotation.original, text: annotation.text });
    } else {
      conversation.push(annotation);
    }
  }

  const out = [
    "Here are my review notes on this session — changes I want you to make to the work we've already done together in this conversation. Please go through each note below and apply it. This is a continuation of our current task, not a new or separate request.",
    '',
  ];
  for (const [path, items] of fileGroups) {
    out.push(`In ${path}:`);
    for (const item of items) {
      out.push('');
      out.push(
        item.label
          ? `${item.label} — ${quoteAnnotationText(item.original)}`
          : quoteAnnotationText(item.original),
      );
      if (item.text) out.push(`  ${item.text}`);
    }
    out.push('');
  }
  if (conversation.length > 0) {
    out.push('In this conversation:');
    for (const annotation of conversation) {
      out.push('');
      out.push(quoteAnnotationText(annotation.original));
      if (annotation.text) out.push(`  ${annotation.text}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}
