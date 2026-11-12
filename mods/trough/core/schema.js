export const ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{32})$/;
export const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const NS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const own = (o, k) => Object.hasOwn(o, k);
const fail = (path, reason) => { throw new Error(`${path}: ${reason}`); };
const object = (v, path, required, allowed) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected object');
  for (const k of required) if (!own(v, k)) fail(`${path}.${k}`, 'required');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'unknown field');
};
const string = (v, path, min, max) => {
  if (typeof v !== 'string' || v.length < min || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(path, `expected plain text of ${min}-${max} characters`);
};
const key = (v, path) => { if (typeof v !== 'string' || !KEY.test(v)) fail(path, 'invalid key'); };
const id = (v, path) => { if (typeof v !== 'string' || !ID.test(v)) fail(path, 'invalid story id'); };
export const timestamp = (v, path) => {
  const parts = typeof v === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(v);
  if (!parts || !Number.isFinite(Date.parse(v))) fail(path, 'expected RFC 3339 timestamp');
  const offset = v.match(/([+-])(\d\d):(\d\d)$/);
  if (offset && (+offset[2] > 23 || +offset[3] > 59)) fail(path, 'invalid time offset');
  const minutes=offset ? (offset[1]==='+' ? 1 : -1)*(+offset[2]*60 + +offset[3]) : 0;
  const d=new Date(Date.parse(v)+minutes*60000);
  const actual=[d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()];
  if (actual.some((n,i)=>n!==+parts[i+1])) fail(path,'invalid calendar date or time');
};
const url = (v, path) => {
  string(v, path, 1, 2048);
  let parsed;
  try { parsed = new URL(v); } catch { fail(path, 'invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) fail(path, 'expected absolute http(s) URL without credentials');
};
const localPath = (v, path) => {
  string(v, path, 1, 4096);
  if (!v.startsWith('/') || v.startsWith('//')) fail(path, 'expected absolute local path');
};
const unique = (entries, path) => {
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.id)) fail(path, `duplicate id ${e.id}`); seen.add(e.id); }
};
// Reject duplicate JSON keys before JSON.parse can silently choose the last value.
export function parseJson(bytes) {
  if (bytes.length > 65536) throw new Error('story exceeds 64 KiB');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const str = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('unterminated JSON string');
  };
  const value = () => {
    ws();
    if (text[i] === '"') { str(); return; }
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); if (text[i] !== '"') throw new Error('invalid JSON object');
        const k = str(); if (keys.has(k)) throw new Error(`duplicate JSON key: ${k}`); keys.add(k);
        ws(); if (text[i++] !== ':') throw new Error('invalid JSON object');
        value(); ws(); if (text[i] === '}') { i++; return; }
        if (text[i++] !== ',') throw new Error('invalid JSON object');
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (text[i] === ']') { i++; return; } if (text[i++] !== ',') throw new Error('invalid JSON array'); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) throw new Error('invalid JSON value'); i += match[0].length;
  };
  value(); ws(); if (i !== text.length) throw new Error('trailing JSON content');
  return JSON.parse(text);
}
export function validateStory(s, filename) {
  object(s, 'story', ['v','id','source','kind','title','summary','occurred_at','severity'], ['v','id','source','kind','title','summary','occurred_at','severity','outcome','subject','group_key','expires_at','supersedes','links','provenance','actions','decision','extensions']);
  if (s.v !== 1) fail('v', 'unsupported version'); id(s.id,'id');
  if (filename && filename !== `${s.id}.json`) fail('id', 'does not match filename');
  object(s.source,'source',['id','label'],['id','label','instance','machine','terminal','session']);
  key(s.source.id,'source.id'); string(s.source.label,'source.label',1,128);
  for (const k of ['instance','machine','terminal','session']) if (own(s.source,k)) string(s.source[k],`source.${k}`,0,128);
  key(s.kind,'kind'); string(s.title,'title',1,200); string(s.summary,'summary',1,4096); timestamp(s.occurred_at,'occurred_at');
  if (!['info','notice','warning','critical'].includes(s.severity)) fail('severity','invalid severity');
  if (own(s,'outcome') && !['succeeded','failed','pending'].includes(s.outcome)) fail('outcome','invalid outcome');
  if (own(s,'subject')) { object(s.subject,'subject',['type','key'],['type','key','label']); key(s.subject.type,'subject.type'); string(s.subject.key,'subject.key',1,256); if (own(s.subject,'label')) string(s.subject.label,'subject.label',0,200); }
  if (own(s,'group_key')) string(s.group_key,'group_key',1,256);
  if (own(s,'expires_at')) timestamp(s.expires_at,'expires_at');
  if (own(s,'supersedes')) id(s.supersedes,'supersedes');
  if (own(s,'provenance')) { object(s.provenance,'provenance',[],['event_id','task_id','repository_url','head','reference']); for (const [k,v] of Object.entries(s.provenance)) string(v,`provenance.${k}`,0,k === 'task_id'||k === 'head' ? 128 : k === 'event_id' ? 256 : 2048); }
  const links = s.links ?? []; if (!Array.isArray(links) || links.length > 16) fail('links','expected at most 16 links');
  for (const [i,l] of links.entries()) { object(l,`links[${i}]`,['id','label'],['id','label','url','path']); key(l.id,`links[${i}].id`); string(l.label,`links[${i}].label`,1,120); if (own(l,'url') === own(l,'path')) fail(`links[${i}]`,'expected exactly one destination'); if (own(l,'url')) url(l.url,`links[${i}].url`); else localPath(l.path,`links[${i}].path`); } unique(links,'links');
  const actions = s.actions ?? []; if (!Array.isArray(actions) || actions.length > 8) fail('actions','expected at most 8 actions');
  for (const [i,a] of actions.entries()) {
    object(a,`actions[${i}]`,['id','label','handler'],['id','label','handler','args','choice']); key(a.id,`actions[${i}].id`); string(a.label,`actions[${i}].label`,1,120); key(a.handler,`actions[${i}].handler`);
    if(own(a,'choice') && typeof a.choice!=='boolean') fail(`actions[${i}].choice`,'expected boolean');
    if (own(a,'args')) { if (!a.args || typeof a.args !== 'object' || Array.isArray(a.args) || Object.keys(a.args).length > 12) fail(`actions[${i}].args`,'expected bounded object'); for (const [k,v] of Object.entries(a.args)) { key(k,`actions[${i}].args key`); if (typeof v === 'string') string(v,`actions[${i}].args.${k}`,0,8192); else if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) fail(`actions[${i}].args.${k}`,'expected string, number or boolean'); } }
    if (['open_url','open_path','open_file','add_to_reading_list'].includes(a.handler)) {
      const link=links.find(l=>l.id===a.args?.link);
      if(!link) fail(`actions[${i}].args.link`,'must reference a declared link');
      if(a.handler==='open_url'&&!link.url || ['open_path','open_file'].includes(a.handler)&&!link.path) fail(`actions[${i}].args.link`,'wrong link destination type');
    }
    if((a.handler==='answer_decision'||a.choice)&&s.kind!=='decision') fail(`actions[${i}]`,'choice action requires decision kind');
  } unique(actions,'actions');
  if (s.kind === 'decision') {
    if (!own(s,'decision')) fail('decision','required for decision');
    if (actions.some(a => a.handler === 'answer_decision'||a.choice) && (!Array.isArray(s.decision?.options)||s.decision.options.length<2)) fail('decision.options','choice action needs at least two options');
  } else if (own(s,'decision')) fail('decision','only valid for decision kind');
  if (own(s,'decision')) { const d=s.decision; object(d,'decision',['question_id','prompt','options'],['question_id','prompt','options','allow_comment']); key(d.question_id,'decision.question_id'); string(d.prompt,'decision.prompt',1,4096); if (!Array.isArray(d.options) || d.options.length>10) fail('decision.options','expected 0-10 options'); for (const [i,o] of d.options.entries()) { object(o,`decision.options[${i}]`,['id','label','answer_text'],['id','label','answer_text']); key(o.id,`decision.options[${i}].id`); string(o.label,`decision.options[${i}].label`,1,120); string(o.answer_text,`decision.options[${i}].answer_text`,1,512); } unique(d.options,'decision.options'); if (own(d,'allow_comment') && typeof d.allow_comment !== 'boolean') fail('decision.allow_comment','expected boolean'); }
  if (own(s,'extensions')) { if (!s.extensions || typeof s.extensions !== 'object' || Array.isArray(s.extensions) || Object.keys(s.extensions).length>16) fail('extensions','expected bounded object'); for (const k of Object.keys(s.extensions)) if (!NS.test(k)) fail(`extensions.${k}`,'expected namespaced key'); }
  return s;
}
