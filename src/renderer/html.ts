export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/\n/g, '&#10;');
}

export function ansiToHtml(input: string): string {
  const tokenRegex = /\x1b\[([0-9;]*)m/g;
  let currentClasses: string[] = [];
  let lastIndex = 0;
  let html = '';

  const appendChunk = (chunk: string): void => {
    if (!chunk) return;
    const escaped = escapeHtml(chunk);
    if (currentClasses.length === 0) {
      html += escaped;
      return;
    }
    html += `<span class="${currentClasses.join(' ')}">${escaped}</span>`;
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(input)) !== null) {
    appendChunk(input.slice(lastIndex, match.index));
    lastIndex = tokenRegex.lastIndex;

    const codes = (match[1] || '0').split(';').map((v) => Number(v || '0'));
    for (const code of codes) {
      if (code === 0) {
        currentClasses = [];
        continue;
      }
      if (code === 1) {
        if (!currentClasses.includes('ansi-bold')) currentClasses.push('ansi-bold');
        continue;
      }
      if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        currentClasses = currentClasses.filter((c) => !c.startsWith('ansi-fg-'));
        currentClasses.push(`ansi-fg-${code}`);
      }
    }
  }

  appendChunk(input.slice(lastIndex));
  return html.replace(/\n/g, '<br/>');
}
