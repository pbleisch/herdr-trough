import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './actions.js';
import { replaceAtomic } from './store.js';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const key=file=>crypto.createHash('sha256').update(file).digest('hex').slice(0,24);
const statusDir=root=>path.join(root,'producers');

export async function configuredProducers(root) {
  const {packages}=await loadConfig(root), found=[];
  const seen=new Set();
  for(const entry of packages) {
    const file=typeof entry==='string'?entry:entry?.path;
    const options=typeof entry==='string'?{}:entry?.options??{};
    if(typeof file!=='string'||!path.isAbsolute(file)||!plain(options)) throw new Error('invalid producer package configuration');
    const id=key(file);
    if(seen.has(id)) throw new Error(`duplicate producer package: ${file}`);
    seen.add(id);
    try {
      const module=await import(pathToFileURL(file).href);
      if(module.producer===undefined) continue;
      if(typeof module.producer!=='function') throw new Error('invalid producer hook');
      const descriptor=await module.producer(options);
      if(!plain(descriptor)||typeof descriptor.name!=='string'||!descriptor.name.trim()||
        !Number.isSafeInteger(descriptor.interval_seconds)||descriptor.interval_seconds<1||typeof descriptor.run!=='function')
        throw new Error('invalid producer descriptor');
      found.push({id,name:descriptor.name,interval_seconds:descriptor.interval_seconds,run:descriptor.run});
    } catch(error) {
      found.push({id,name:path.basename(file),interval_seconds:0,error:String(error?.message??error).slice(0,500)});
    }
  }
  return found;
}

async function readStatus(root,id) {
  try { return JSON.parse(await fs.readFile(path.join(statusDir(root),`${id}.json`),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; throw error; }
}

export async function listProducers(root) {
  return Promise.all((await configuredProducers(root)).map(async({id,name,interval_seconds,error})=>{
    const status=await readStatus(root,id);
    return {id,name,interval_seconds,...(error?{error}:{}),status:error?{...status,last_error:error}:status};
  }));
}

export async function runProducer(root,id) {
  const producer=(await configuredProducers(root)).find(item=>item.id===id);
  if(!producer) throw new Error(`unknown producer: ${id}`);
  if(producer.error) throw new Error(`${producer.name}: ${producer.error}`);
  const dir=statusDir(root),lock=path.join(dir,`${id}.lock`);
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  try { await fs.mkdir(lock,{mode:0o700}); }
  catch(error) { if(error.code==='EEXIST') return {busy:true,status:await readStatus(root,id)}; throw error; }
  try {
    const previous=await readStatus(root,id);
    if(previous?.last_run&&Date.now()-Date.parse(previous.last_run)<producer.interval_seconds*1000)
      return {busy:false,skipped:true,status:previous};
    let error=null;
    try { await producer.run({root}); }
    catch(cause) { error=String(cause?.message??cause).slice(0,500); }
    const status={last_run:new Date().toISOString(),last_error:error};
    await replaceAtomic(dir,`${id}.json`,Buffer.from(JSON.stringify(status)+'\n'));
    return {busy:false,status};
  } finally { await fs.rmdir(lock); }
}
