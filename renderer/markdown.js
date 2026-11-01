const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let out = text;
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

export function renderMarkdown(source) {
  const blocks = [];
  let text = escapeHtml(String(source || ''));

  text = text.replace(/```([\w+#.-]*)\r?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const index = blocks.length;
    blocks.push(
      `<pre><div class="code-head"><span>${lang || 'text'}</span><button class="copy-code" type="button">Копировать</button></div><code>${code.replace(/\n$/, '')}</code></pre>`,
    );
    return `\u0000B${index}\u0000`;
  });

  const lines = text.split(/\r?\n/);
  const html = [];
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const blockMatch = /^\u0000B(\d+)\u0000$/.exec(line.trim());
    if (blockMatch) {
      flushParagraph();
      closeList();
      html.push(blocks[Number(blockMatch[1])]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<hr />');
      continue;
    }
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list !== 'ul') {
        closeList();
        list = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (list !== 'ol') {
        closeList();
        list = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return html.join('\n');
}
