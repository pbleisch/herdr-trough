// Manages the operator's pack list in $TROUGH_DIR/handlers.json and reports what each pack provides.
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, loadConfig, loadPack, packEntry, handlerCatalog, augmentProblems } from './actions.js';
import { listProducers, producerId } from './producers.js';
import { replaceAtomic, withStateLock, list } from './store.js';
import { userHandler } from './open-handlers.js';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);

// stories: the stored stories when the caller has read them already, so the store is read once.
export async function listPacks(root,stories) {
  const catalog=await handlerCatalog(root);
  let producers=[],producerError=null;
  try { producers=await listProducers(root); } catch(error) { producerError=String(error?.message??error).slice(0,500); }
  const own=await userHandler();
  const seen=new Map(),augmentFailures=augmentProblems(catalog,stories??(await list(root)).map(row=>row.story));
  return catalog.packs.map(pack=>{
    const problems=[],producer=typeof pack.path==='string'?producers.find(item=>item.id===producerId(pack.path)):null;
    if(pack.error) problems.push(pack.error);
    if(producer?.error&&producer.error!==pack.error) problems.push(`producer: ${producer.error}`);
    if(producerError&&typeof pack.module?.producer==='function') problems.push(`producer: ${producerError}`);
    if(pack.built_in&&own.state==='stopped') problems.push(`your handler is not used: ${own.why}. Run \`trough handler on\` to use it as it is now, or \`trough handler off\`.`);
    const failed=augmentFailures.get(pack.name);
    if(failed) problems.push(`augment failed for ${failed.count} ${failed.count===1?'story':'stories'}: ${failed.first}`);
    if(typeof pack.path==='string') { if(seen.has(pack.path)) problems.push('listed more than once'); seen.set(pack.path,true); }
    const handlers=Object.keys(pack.handlers).sort().map(id=>{
      const effective=catalog.handlers.get(id),mine=effective.origin==='pack'&&effective.def===pack.handlers[id];
      if(!mine) return {id,available:false,reason:effective.origin==='config'?'overridden by an operator handler in handlers.json':`overridden by pack ${effective.pack}`};
      if(!effective.available&&effective.reason==='invalid integration handler') problems.push(`handler ${id}: invalid integration handler`);
      return {id,available:effective.available,...(effective.reason?{reason:effective.reason}:{})};
    });
    return {name:pack.name,path:pack.path,...(pack.built_in?{built_in:true}:{}),options:pack.options,ok:!problems.length,problems,handlers,
      augments:pack.augment?pack.rules:null,...(pack.built_in?{user_handler:own}:{}),
      producer:producer&&!producer.error?{id:producer.id,name:producer.name,interval_seconds:producer.interval_seconds,last_run:producer.status?.last_run??null,last_error:producer.status?.last_error??null}:null};
  });
}

export async function checkPacks(root) {
  const packs=await listPacks(root);
  return {ok:packs.every(pack=>pack.ok),packs};
}

// Rewrites only `packages`; every other field of handlers.json is kept as the operator wrote it.
async function editPacks(root,change) {
  return withStateLock(root,async()=>{
    let file=path.join(root,'handlers.json'),raw={v:1};
    try { file=await fs.realpath(file); raw=JSON.parse(await fs.readFile(file,'utf8')); }
    catch(error) {
      if(error.code!=='ENOENT') throw new Error(`cannot edit handlers.json until it is valid JSON: ${error.message}`);
    }
    validateConfig(raw);
    const {packages=raw.packages??[],core,result}=await change([...(raw.packages??[])]);
    const next={...raw,packages};
    if(core===true) delete next.core; else if(core===false) next.core=false;
    await replaceAtomic(path.dirname(file),path.basename(file),Buffer.from(JSON.stringify(next,null,2)+'\n'));
    return result;
  });
}

async function resolvePack(target) {
  if(typeof target!=='string'||!target) throw new Error('a pack path is required');
  let file;
  try { file=await fs.realpath(path.resolve(target)); if((await fs.stat(file)).isDirectory()) file=await fs.realpath(path.join(file,'index.js')); }
  catch(error) { if(error.code==='ENOENT'||error.code==='ENOTDIR') throw new Error(`pack not found: ${path.resolve(target)}`); throw error; }
  return file;
}

export async function addPack(root,target,options) {
  if(target==='core') {
    if(options!==undefined) throw new Error('the core pack takes no options');
    return editPacks(root,()=>({core:true,result:{added:'core'}}));
  }
  const file=await resolvePack(target);
  if(options!==undefined&&!plain(options)) throw new Error('pack options must be a JSON object');
  const entry=options===undefined?file:{path:file,options};
  const pack=await loadPack(entry);
  if(!pack.error&&typeof pack.module.producer==='function') { try { await pack.module.producer(pack.options); } catch(error) { pack.error=String(error?.message??error).slice(0,500); } }
  if(pack.error) throw new Error(`pack ${pack.name} did not load, so nothing was changed: ${pack.error}${options===undefined?' (pass its options with --options-file FILE)':''}`);
  return editPacks(root,packages=>{
    const at=packages.findIndex(item=>packEntry(item).file===file);
    if(at>=0&&options===undefined) throw new Error(`pack ${pack.name} is already listed: ${file}`);
    if(at>=0) packages[at]=entry; else packages.push(entry);
    return {packages,result:{[at>=0?'updated':'added']:pack.name,path:file,handlers:Object.keys(pack.handlers).sort(),producer:typeof pack.module.producer==='function'}};
  });
}

export async function removePack(root,target) {
  if(typeof target!=='string'||!target) throw new Error('a pack name or path is required');
  // The core pack is built in: removing it records `"core": false`, and `packages add core` restores it.
  if(target==='core') return editPacks(root,()=>({core:false,result:{removed:'core'}}));
  const loaded=await Promise.all((await loadConfig(root)).packages.map(loadPack));
  const resolved=path.resolve(target);
  let matches=loaded.filter(pack=>pack.path===target||pack.path===resolved);
  if(!matches.length) matches=loaded.filter(pack=>pack.name===target);
  if(!matches.length) throw new Error(`no listed pack matches ${target}`);
  if(new Set(matches.map(pack=>pack.path)).size>1) throw new Error(`${target} matches more than one pack; remove it by path: ${matches.map(pack=>pack.path).join(', ')}`);
  const file=matches[0].path;
  return editPacks(root,packages=>({packages:packages.filter(item=>packEntry(item).file!==file),result:{removed:matches[0].name,path:file}}));
}
