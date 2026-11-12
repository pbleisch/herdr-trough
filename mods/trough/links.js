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
