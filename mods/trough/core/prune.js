import fs from 'node:fs/promises';
import path from 'node:path';
import { ID } from './schema.js';
import { ingest, layout, readState, replaceAtomic, stored, withStateLock } from './store.js';
import { cleanMedia, removeMediaRecord } from './media.js';

const DAY=86400000;
const TOMBSTONE_DAYS=365;
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const files=async dir=>fs.readdir(dir).catch(error=>{if(error.code==='ENOENT') return []; throw error;});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function ageMilliseconds(value) {
  if(typeof value!=='string'||!/^\d+d$/.test(value)) throw new Error('older-than must be a positive number of days, such as 3d');
  const days=Number(value.slice(0,-1));
  if(!Number.isSafeInteger(days)||days<1||days>3650) throw new Error('older-than must be between 1d and 3650d');
  return days*DAY;
}

async function configuredAge(root) {
  let config;
  try { config=await json(path.join(root,'trough.json')); }
  catch(error) { if(error.code==='ENOENT') return '3d'; throw error; }
  if(!plain(config)||config.v!==1||!plain(config.retention)||typeof config.retention.older_than!=='string')
    throw new Error('invalid trough.json retention configuration');
  ageMilliseconds(config.retention.older_than);
  return config.retention.older_than;
}

async function recordIndex(dir) {
  const found=new Map();
  for(const name of await files(dir)) {
    if(!name.endsWith('.json')) continue;
    const file=path.join(dir,name),record=await json(file);
    const id=record.story_id??record.reviewed?.story_id;
    if(id) found.set(id,[...(found.get(id)??[]),{file,record}]);
  }
  return found;
}

async function pendingAnswers(root) {
  const pending=new Set();
  for(const source of await files(path.join(root,'answers'))) {
    const dir=path.join(root,'answers',source);
    if(!(await fs.stat(dir)).isDirectory()) continue;
    for(const id of (await recordIndex(dir)).keys()) pending.add(id);
  }
  return pending;
}

async function pendingDeliveries(root) {
  const pending=new Set();
  const base=path.join(root,'integrations','firstmate');
  for(const home of await files(base)) {
    const dir=path.join(base,home,'deliveries');
    for(const [id,entries] of await recordIndex(dir))
      if(entries.some(({record})=>record.status!=='acknowledged')) pending.add(id);
  }
  return pending;
}

async function sidecars(root) {
  return {reviews:await recordIndex(path.join(root,'reviews')),receipts:await recordIndex(path.join(root,'receipts')),
    answers:await pendingAnswers(root),deliveries:await pendingDeliveries(root)};
}

async function removeStory(root,id,indexes,now) {
  await replaceAtomic(path.join(root,'tombstones'),`${id}.json`,Buffer.from(JSON.stringify({v:1,pruned_at:new Date(now).toISOString()})+'\n'));
  for(const file of [path.join(root,'inbox',`${id}.json`),path.join(root,'store',`${id}.json`),path.join(root,'state',`${id}.json`),
    ...(indexes.reviews.get(id)??[]).map(x=>x.file),...(indexes.receipts.get(id)??[]).map(x=>x.file)])
    await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT') throw error;});
  await removeMediaRecord(root,id);
}

export async function deleteStory(root,id) {
  if(!ID.test(id)) throw new Error('invalid story id');
  await ingest(root);
  return withStateLock(root,async()=>{
    await stored(root,id);
    const indexes=await sidecars(root),receipts=indexes.receipts.get(id)??[];
    if(receipts.some(({record})=>record.outcome==='pending'||record.outcome==='uncertain'))
      throw new Error('cannot delete story: a pending or uncertain receipt has an effect in flight');
    if(indexes.answers.has(id)) throw new Error('cannot delete story: an answer has not been delivered');
    if(indexes.deliveries.has(id)) throw new Error('cannot delete story: a delivery is pending');
    await removeStory(root,id,indexes,Date.now());
    await cleanMedia(root);
    return {id,deleted:true};
  });
}

async function candidate(root,id,cutoff,now,indexes) {
  const {story}=await stored(root,id),state=await readState(root,id);
  if(!state.read_at||story.kind==='decision'&&story.decision?.options.length>0||story.actions?.length&&!state.done_at||story.outcome==='pending') return null;
  if(state.snoozed_until&&Date.parse(state.snoozed_until)>now) return null;
  const last=Math.max(Date.parse(state.read_at),state.done_at?Date.parse(state.done_at):0);
  if(!Number.isFinite(last)||last>cutoff) return null;
  const reviews=indexes.reviews.get(id)??[];
  const receipts=indexes.receipts.get(id)??[];
  if(reviews.some(({record})=>Date.parse(record.created_at)+300000>now)) return null;
  if(receipts.some(({record})=>record.outcome==='pending'||record.outcome==='uncertain')) return null;
  if(indexes.answers.has(id)||indexes.deliveries.has(id)) return null;
  return {id};
}

async function expireTombstones(root,now) {
  const dir=path.join(root,'tombstones');
  for(const name of await files(dir)) {
    if(!ID.test(name.slice(0,-5))||!name.endsWith('.json')) continue;
    const record=await json(path.join(dir,name));
    if(record.v===1&&Date.parse(record.pruned_at)+TOMBSTONE_DAYS*DAY<=now) await fs.unlink(path.join(dir,name));
  }
}

export async function prune(root,{olderThan,dryRun=false,now=Date.now()}={}) {
  await layout(root);
  const ageText=olderThan??await configuredAge(root),age=ageMilliseconds(ageText);
  if(!dryRun) await ingest(root);
  return withStateLock(root,async()=>{
    const selected=[];
    const indexes=await sidecars(root);
    for(const name of await files(path.join(root,'store'))) {
      if(!name.endsWith('.json')||!ID.test(name.slice(0,-5))) continue;
      const item=await candidate(root,name.slice(0,-5),now-age,now,indexes);
      if(item) selected.push(item);
    }
    selected.sort((a,b)=>a.id.localeCompare(b.id));
    if(dryRun) return {dry_run:true,older_than:ageText,ids:selected.map(x=>x.id),count:selected.length};
    for(const item of selected) {
      await removeStory(root,item.id,indexes,now);
    }
    await expireTombstones(root,now);
    await cleanMedia(root);
    return {dry_run:false,older_than:ageText,ids:selected.map(x=>x.id),count:selected.length};
  });
}
