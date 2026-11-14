const URL_CANDIDATE = /https?:\/\/[^\s<>"']+/gi;
const PATH_CANDIDATE = /(?:^|[\s([{])((?:\/(?!\/)|~\/)[^\s<>"']+)/g;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

export function isHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function trimUrl(candidate) {
  let url = candidate;
  for (;;) {
    const shorter = url.replace(TRAILING_PUNCTUATION, '');
    if (shorter !== url) { url = shorter; continue; }
    const close = url.at(-1);
    const open = {')': '(', ']': '[', '}': '{'}[close];
    if (open && [...url].filter(c => c === close).length > [...url].filter(c => c === open).length) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function splitHttpLinks(text) {
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const index = match.index;
    if (index > 0 && /[\w@/.:\-]/.test(text[index - 1])) continue;
    const url = trimUrl(match[0]);
    if (!isHttpUrl(url)) continue;
    if (index > start) parts.push({text: text.slice(start, index)});
    parts.push({text: url, url});
    start = index + url.length;
  }
  if (start < text.length || !parts.length) parts.push({text: text.slice(start)});
  return parts;
}

export function splitDetailLinks(text) {
  return splitHttpLinks(text).flatMap(part => {
    if (part.url) return [part];
    const pieces = [];
    let start = 0;
    for (const match of part.text.matchAll(PATH_CANDIDATE)) {
      const candidate = match[1];
      const index = match.index + match[0].length - candidate.length;
      const localPath = trimUrl(candidate);
      if (localPath === '/' || localPath === '~/' || !localPath) continue;
      if (index > start) pieces.push({text: part.text.slice(start, index)});
      pieces.push({text: localPath, path: localPath});
      start = index + localPath.length;
    }
    if (start < part.text.length || !pieces.length) pieces.push({text: part.text.slice(start)});
    return pieces;
  });
}


// The link a story-declared action targets: its `link` argument, when that names one of the story's links.
export function actionLink(action, story) {
  const id = action.args?.link;
  return typeof id === 'string' && (story.links ?? []).some(link => link.id === id) ? id : null;
}

// Absolute paths a story body links to: written as text, as markdown link destinations, or as
// file:// URLs. A click on one is allowed to open it, as a path in the summary is.
const MARKDOWN_DESTINATION = /\]\(\s*<?([^)\s>]+)>?/g;
function decoded(value) { try { return decodeURIComponent(value); } catch { return value; } }
export function bodyPaths(text) {
  const found = new Set(splitDetailLinks(text ?? '').filter(part => part.path).map(part => part.path));
  for (const match of (text ?? '').matchAll(MARKDOWN_DESTINATION)) {
    const target = linkTarget(match[1]);
    if (!target?.path) continue;
    found.add(target.path);
    // The destination as written too, in case the click reports it undecoded.
    if (match[1].startsWith('/')) found.add(match[1]);
  }
  return [...found];
}

// What a link clicked in a story body points at: {url} for http(s), {path} for an absolute path or
// a file:// URL on this machine, null for anything else.
export function linkTarget(value) {
  if (typeof value !== 'string') return null;
  if (isHttpUrl(value)) return {url: value};
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.host && url.host !== 'localhost' ? null : {path: decoded(url.pathname)};
    } catch { return null; }
  }
  if ((value.startsWith('/') && !value.startsWith('//')) || value.startsWith('~/')) return {path: decoded(value)};
  return null;
}
