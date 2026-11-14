// Prepares a story body for TextView.markdown. A body is the producer's text, so it may neither
// draw HTML nor make the pane load a picture:
// - raw HTML is shown as text (`<` becomes `&lt;`), except an autolink such as <https://example.com>;
// - image syntax `![alt](src)` becomes the link `[alt](src)` ("image" when alt is empty): it can be clicked, nothing loads.
// Code spans and fenced code blocks are left exactly as written, since markdown shows them literally.
// An indented code block is not recognised, so a `<` in one shows as `&lt;`.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function safeMarkdown(text) {
  const out = [];
  let fence = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const opening = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (opening) { fence = opening[1]; out.push(line); continue; }
    out.push(inline(line));
  }
  return out.join('\n');
}

// Outside code spans only. A code span is a run of backticks closed by a run of the same length.
function inline(line) {
  let result = '', i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      const run = /^`+/.exec(line.slice(i))[0];
      let close = i + run.length;
      for (;;) {
        close = line.indexOf(run, close);
        if (close === -1 || line[close + run.length] !== '`') break;
        close = line.slice(close).match(/^`+/)[0].length + close;
      }
      if (close !== -1) { result += line.slice(i, close + run.length); i = close + run.length; continue; }
      result += run; i += run.length; continue;
    }
    const next = line.indexOf('`', i), end = next === -1 ? line.length : next;
    result += plain(line.slice(i, end));
    i = end;
  }
  return result;
}

function plain(text) {
  return text
    .split(/(<https?:\/\/[^\s<>]+>)/)
    .map((part, index) => index % 2 ? part : part.replace(/</g, '&lt;'))
    .join('')
    .replace(/(\\*)!\[([^\]]*)\]/g, (match, slashes, alt) => slashes.length % 2 ? match : `${slashes}[${alt.trim() || 'image'}]`);
}
