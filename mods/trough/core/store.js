import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID, parseJson, validateStory, timestamp } from './schema.js';

export const rootDir = (override) => path.resolve(override || process.env.TROUGH_DIR || path.join(os.homedir(), '.local/state/trough'));
const folder = (root, name) => path.join(root, name);
const now = () => new Date().toISOString();
const random = () => crypto.randomBytes(8).toString('hex');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function layout(root) {
  for (const dir of [root, ...['inbox','store','state','rejected','receipts','answers','tombstones'].map(n => folder(root,n))]) {
    await fs.mkdir(dir, {recursive:true, mode:0o700});
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error(`not a directory: ${dir}`);
    await fs.chmod(dir,0o700);
  }
}
async function durableFile(file, bytes) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDir(dir) { try { const h=await fs.open(dir,constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); } } catch { /* unavailable on some filesystems */ } }
export async function publishExclusive(dir, name, bytes) {
  const tmp=path.join(dir,`.${name}.${random()}.tmp`), dest=path.join(dir,name);
  await durableFile(tmp,bytes);
  try { await fs.link(tmp,dest); await syncDir(dir); return true; }
  catch (e) { if (e.code !== 'EEXIST') throw e; return false; }
  finally { await fs.unlink(tmp).catch(()=>{}); }
}
export async function replaceAtomic(dir,name,bytes) {
  const tmp=path.join(dir,`.${name}.${random()}.tmp`);
  await durableFile(tmp,bytes);
  try { await fs.rename(tmp,path.join(dir,name)); await syncDir(dir); }
  finally { await fs.unlink(tmp).catch(()=>{}); }
}
async function readNoFollow(file) {
  const st=await fs.lstat(file);
  if (!st.isFile()) throw new Error('expected regular file, not symlink or directory');
  if (st.size > 65536) throw new Error('story exceeds 64 KiB');
  const h=await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes=await h.readFile(); if (bytes.length>65536) throw new Error('story exceeds 64 KiB'); return bytes; } finally { await h.close(); }
}
export async function parseStoryFile(file, expectedName) { const bytes=await readNoFollow(file); return {bytes,story:validateStory(parseJson(bytes),expectedName)}; }
export async function post(root, bytes) {
  await layout(root);
  const story=validateStory(parseJson(bytes));
  const name=`${story.id}.json`;
  const dest=path.join(root,'inbox',name);
  if (!await publishExclusive(folder(root,'inbox'),name,bytes)) {
    const existing=await readNoFollow(dest);
    if (!existing.equals(bytes)) throw new Error(`conflicting inbox story id: ${story.id}`);
  }
  const result=await ingestOne(root,name);
  if (result.status==='rejected') throw new Error(result.reason);
  return story.id;
}
async function reject(root,name,reason,bytes) {
  const stem=`${name.replace(/[^a-zA-Z0-9_.-]/g,'_')}.${random()}`;
  if (bytes) await publishExclusive(folder(root,'rejected'),`${stem}.json`,bytes).catch(()=>{});
  await publishExclusive(folder(root,'rejected'),`${stem}.reason.json`,Buffer.from(JSON.stringify({file:name,at:now(),reason:String(reason).slice(0,500)})+'\n'));
  return {status:'rejected',file:name,reason:String(reason)};
}
export async function ingestOne(root,name) {
  return withStateLock(root,()=>ingestOneLocked(root,name));
}
async function ingestOneLocked(root,name) {
  const input=path.join(root,'inbox',name);
  let bytes;
  try {
    if (!/^[^.][^/]*\.json$/.test(name)) throw new Error('expected visible .json file');
    const read=await parseStoryFile(input,name); bytes=read.bytes;
    const tombstoned=await fs.access(path.join(root,'tombstones',name)).then(()=>true,e=>{if(e.code==='ENOENT') return false; throw e;});
    if(tombstoned) {
      await fs.unlink(input);
      return {status:'pruned',id:read.story.id};
    }
    const dest=path.join(root,'store',name);
    if (!await publishExclusive(folder(root,'store'),name,bytes)) {
      const original=await readNoFollow(dest);
      if (!original.equals(bytes)) throw new Error(`conflicting stored story id: ${read.story.id}`);
    }
    await fs.unlink(input).catch(e=>{if(e.code!=='ENOENT') throw e;});
    return {status:'stored',id:read.story.id};
  } catch (e) {
    if (e.code==='ENOENT') return {status:'gone',file:name};
    const result=await reject(root,name,e.message,bytes);
    await fs.unlink(input).catch(()=>{});
    return result;
  }
}
export async function ingest(root) {
  await layout(root);
  const names=(await fs.readdir(folder(root,'inbox'))).filter(n=>!n.startsWith('.') && n.endsWith('.json')).sort();
  const results=[];
  for (const name of names) results.push(await ingestOne(root,name));
  return results;
}
export async function stored(root,id) {
  if (!ID.test(id)) throw new Error('invalid story id');
  const file=path.join(root,'store',`${id}.json`);
  const read=await parseStoryFile(file,`${id}.json`);
  const stat=await fs.stat(file);
  return {...read,hash:hash(read.bytes),received_at:stat.birthtime.toISOString()};
}
export async function withStateLock(root,fn) {
  await layout(root);
  const lock=path.join(root,'state','.lock');
  let owned=false;
  for (let i=0;i<100;i++) {
    try { await fs.mkdir(lock, {mode:0o700}); owned=true; break; }
    catch(e) { if (e.code!=='EEXIST') throw e; await sleep(25); }
  }
  if (!owned) throw new Error('operator state is busy');
  try { return await fn(); } finally { await fs.rmdir(lock); }
}
export async function readState(root,id) {
  if (!ID.test(id)) throw new Error('invalid story id');
  try { const raw=await fs.readFile(path.join(root,'state',`${id}.json`),'utf8'); const s=JSON.parse(raw); return s.v===1 ? s : {v:1}; }
  catch(e) { if (e.code==='ENOENT') return {v:1}; throw e; }
}
export async function setState(root,id,operation,until) {
  await stored(root,id);
  return withStateLock(root,async()=>{
    const s=await readState(root,id);
    if (operation==='read') s.read_at=now();
    else if (operation==='unread') delete s.read_at;
    else if (operation==='done') s.done_at=now();
    else if (operation==='undo') delete s.done_at;
    else if (operation==='snooze') { timestamp(until,'until'); s.snoozed_until=until; }
    else throw new Error('unknown state operation');
    await replaceAtomic(folder(root,'state'),`${id}.json`,Buffer.from(JSON.stringify({v:1,...s})+'\n'));
    return s;
  });
}
export async function list(root) {
  await ingest(root);
  const names=(await fs.readdir(folder(root,'store'))).filter(n=>ID.test(n.slice(0,-5))&&n.endsWith('.json'));
  const rows=[];
  for (const name of names) {
    try { const {story,hash:story_hash,received_at}=await stored(root,name.slice(0,-5)); rows.push({story,story_hash,received_at,state:await readState(root,story.id)}); }
    catch { /* a damaged stored record never becomes an actionable card */ }
  }
  rows.sort((a,b)=>Date.parse(b.received_at)-Date.parse(a.received_at)||a.story.id.localeCompare(b.story.id));
  return rows;
}
export async function rejections(root) {
  await layout(root);
  const names=(await fs.readdir(folder(root,'rejected'))).filter(n=>n.endsWith('.reason.json')).sort().reverse();
  return Promise.all(names.map(async n=>JSON.parse(await fs.readFile(path.join(root,'rejected',n),'utf8'))));
}
