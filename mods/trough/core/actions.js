import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { KEY } from './schema.js';
import { layout, stored, publishExclusive, replaceAtomic, withStateLock } from './store.js';
import * as macos from './platform/macos.js';
import { splitDetailLinks } from '../links.js';

const text=v=>JSON.stringify(v,null,2)+'\n';
const hash=v=>crypto.createHash('sha256').update(text(v)).digest('hex');
const random=()=>crypto.randomBytes(16).toString('hex');
const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
const fail=s=>{throw new Error(s);};
const exactKeys=(obj,allowed,label)=>{ for(const k of Object.keys(obj)) if(!allowed.includes(k)) fail(`${label}: unknown argument ${k}`); };
const linkFor=(story,args,want)=>{
  if(!plain(args)) fail('action args must be an object');
  const l=story.links?.find(l=>l.id===args.link);
  if(!l) fail('action references a missing link');
  if(want==='url'&&!l.url || want==='path'&&!l.path) fail(`action requires a ${want} link`);
  return l;
};
const commandPlan=(command,argv,description)=>({command,argv,effects:[description,`Run ${JSON.stringify([command,...argv])}`]});
const RUNS=new Set(['app','command','tool','terminal','workflow','action','pkg','mpkg','dmg','jar','scpt','scptd','applescript','osax','prefpane','saver','kext','plugin','bundle','framework','xpc','appex','webloc','inetloc','fileloc','afploc','ftploc','url','mobileconfig','configprofile','sh','bash','zsh','csh','tcsh','ksh','fish','py','pyw','rb','pl','php','lua','tcl','ps1','bat','cmd','exe','msi','vbs','scr']);
const extension=file=>path.extname(file).slice(1).toLowerCase();
async function localOpenPlan(target) {
  if(typeof target!=='string'||!(target.startsWith('/')&&!target.startsWith('//')||target.startsWith('~/'))) fail('expected an absolute or ~ local path');
  const file=target.startsWith('~/')?path.join(os.homedir(),target.slice(2)):target;
  let stat,real;
  try {stat=await fs.stat(file);real=await fs.realpath(file);}
  catch(e) {if(e.code==='ENOENT'||e.code==='ENOTDIR') fail(`Path does not exist: ${file}`);throw e;}
  if(!stat.isFile()&&!stat.isDirectory()) fail(`Path is not a file or folder: ${file}`);
  const couldRun=(stat.isFile()&&Boolean(stat.mode&0o111))||RUNS.has(extension(file))||RUNS.has(extension(real))||(stat.isDirectory()&&Boolean(extension(file)||extension(real)));
  const c=couldRun?macos.revealPath(file):macos.openPath(file);
  return commandPlan(c[0],c.slice(1),`${couldRun?'Reveal':'Open'} path ${file}${couldRun?' in Finder':''}`);
}
const linkArg={link:{type:'string',required:true,max_length:64}};
const BUILT_INS={
  open_url:{args:linkArg,effects:['Open the linked URL in the default browser'],platform:'darwin'},
  open_path:{args:linkArg,effects:['Reveal the linked path in Finder'],platform:'darwin'},
  open_file:{args:linkArg,effects:['Open the linked file or folder, or reveal it in Finder if it could run'],platform:'darwin'},
  answer_decision:{args:{},effects:['Write an immutable answer under answers/<source-id>/']}
};
const builtInReason=id=>BUILT_INS[id].platform&&BUILT_INS[id].platform!==process.platform?`${id} is currently available on macOS only`:null;
async function builtInPlan(id,story,args,context) {
  if(BUILT_INS[id]&&builtInReason(id)) fail(builtInReason(id));
  if(id==='open_url') { exactKeys(args,['link'],'open_url'); const l=linkFor(story,args,'url'); const c=macos.openUrl(l.url); return commandPlan(c[0],c.slice(1),`Open URL ${l.url}`); }
  if(id==='open_path') { exactKeys(args,['link'],'open_path'); const l=linkFor(story,args,'path'); const c=macos.revealPath(l.path); return commandPlan(c[0],c.slice(1),`Reveal path ${l.path} in Finder`); }
  if(id==='open_file') { exactKeys(args,context.inlinePath?['path']:['link'],'open_file'); const target=context.inlinePath?args.path:linkFor(story,args,'path').path; return localOpenPlan(target); }
  if(id==='answer_decision') {
    exactKeys(args,[],'answer_decision');
    const d=story.decision; if(!d) fail('story has no decision');
    const route=context.config.answer_routes?.[story.id];
    if(!route || route.story_hash!==context.story_hash || route.source_id!==story.source.id) fail('no trusted answer route bound to this story hash');
    const option=d.options.find(o=>o.id===context.option);
    if(!option) fail('select a valid decision option');
    const comment=context.comment??'';
    if(typeof comment!=='string'||comment.length>1024||(!d.allow_comment&&comment)) fail('comment unavailable or too long');
    const target=path.join(context.root,'answers',story.source.id);
    return {kind:'answer',question_id:d.question_id,option_id:option.id,answer_text:option.answer_text,comment,effects:[`Write immutable answer to ${target}`,`Question ${d.question_id}: ${option.label} — ${option.answer_text}${comment?` (${comment})`:''}`]};
  }
  return null;
}
function validateArgs(args,schema) {
  if(!plain(args)||!plain(schema)) fail('invalid action argument schema');
  exactKeys(args,Object.keys(schema),'handler');
  for(const [k,rule] of Object.entries(schema)) {
    if(!KEY.test(k)||!plain(rule)||!['string','number','boolean'].includes(rule.type)) fail(`invalid schema for ${k}`);
    if(args[k]===undefined) {if(rule.required) fail(`missing argument ${k}`);continue;}
    if(typeof args[k]!==rule.type || (rule.type==='number'&&!Number.isFinite(args[k]))) fail(`wrong type for ${k}`);
    if(rule.type==='string'&&rule.max_length!==undefined&&args[k].length>rule.max_length) fail(`${k} too long`);
    if(rule.enum&&!rule.enum.includes(args[k])) fail(`${k} outside allowed values`);
  }
}
export function validateConfig(raw) {
  if(!plain(raw)||raw.v!==1||!plain(raw.handlers??{})||!Array.isArray(raw.packages??[])||!plain(raw.answer_routes??{})) fail('invalid handlers.json');
  for(const [storyId,route] of Object.entries(raw.answer_routes??{})) if(!/^[0-9a-f]{32}$|^[0-9A-HJKMNP-TV-Z]{26}$/.test(storyId)||!plain(route)||!KEY.test(route.source_id)||!/^[0-9a-f]{64}$/.test(route.story_hash)) fail('invalid answer route');
  return raw;
}
export async function loadConfig(root) {
  let raw;
  try { raw=JSON.parse(await fs.readFile(path.join(root,'handlers.json'),'utf8')); }
  catch(e) { if(e.code==='ENOENT') return {v:1,handlers:{},answer_routes:{},packages:[]}; throw e; }
  validateConfig(raw);
  return {v:1,handlers:raw.handlers??{},answer_routes:raw.answer_routes??{},packages:raw.packages??[]};
}
const brief=error=>String(error?.message??error).slice(0,500);
export const packEntry=entry=>({file:typeof entry==='string'?entry:entry?.path,options:typeof entry==='string'?{}:entry?.options??{}});
// A pack is named by its `name` export, or by its folder (for index.js) or file name.
export function packName(file,module) {
  if(typeof module?.name==='string'&&KEY.test(module.name)) return module.name;
  const stem=path.basename(file,path.extname(file));
  return stem==='index'?path.basename(path.dirname(file)):stem;
}
// Loads one configured pack. A pack that cannot load reports `error` and contributes nothing.
export async function loadPack(entry) {
  const {file,options}=packEntry(entry);
  const pack={path:file,name:typeof file==='string'?packName(file):'(invalid)',options,module:null,handlers:{}};
  try {
    if(typeof file!=='string'||!path.isAbsolute(file)) fail('package path must be absolute');
    if(!plain(options)) fail('package options must be an object');
    pack.module=await import(pathToFileURL(file).href);
    pack.name=packName(file,pack.module);
    if(typeof pack.module.handlers!=='function'&&typeof pack.module.producer!=='function') fail('package must export handlers() or producer()');
    const entries=pack.module.handlers?await pack.module.handlers(options):{};
    if(!plain(entries)) fail('handlers() must return an object keyed by handler ID');
    for(const id of Object.keys(entries)) if(!KEY.test(id)) fail(`invalid handler ID ${id}`);
    pack.handlers=entries;
  } catch(error) { pack.error=brief(error); }
  return pack;
}
async function handlerState(origin,id,def) {
  try {
    if(origin==='config') {
      if(!plain(def)||def.kind!=='command'||typeof def.executable!=='string'||!path.isAbsolute(def.executable)) return 'invalid command handler definition';
      try { await fs.access(def.executable,constants.X_OK); } catch { return `${def.executable} is missing or not executable`; }
      return null;
    }
    if(origin==='built-in') return builtInReason(id);
    if(!plain(def)||typeof def.plan!=='function'||typeof def.run!=='function'||!Array.isArray(def.effects)) return 'invalid integration handler';
    if(def.unavailable===undefined) return null;
    if(typeof def.unavailable!=='function') return 'invalid integration handler';
    const reason=await def.unavailable();
    return reason?String(reason).slice(0,300):null;
  } catch(error) { return brief(error); }
}
// The installed action handlers. Operator `handlers` win over packs, packs win over built-ins,
// and a later pack wins over an earlier one.
export async function handlerCatalog(root) {
  const config=await loadConfig(root),packs=[],handlers=new Map();
  const put=async(id,origin,def,pack)=>{
    const reason=await handlerState(origin,id,def);
    handlers.set(id,{id,origin,...(pack?{pack:pack.name,path:pack.path}:{}),args:plain(def?.args)?def.args:{},effects:Array.isArray(def?.effects)?def.effects:[],available:!reason,...(reason?{reason}:{}),def});
  };
  for(const [id,def] of Object.entries(BUILT_INS)) await put(id,'built-in',def);
  for(const entry of config.packages) {
    const pack=await loadPack(entry); packs.push(pack);
    for(const [id,def] of Object.entries(pack.handlers)) await put(id,'pack',def,pack);
  }
  for(const [id,def] of Object.entries(config.handlers)) await put(id,'config',def);
  return {config,packs,handlers};
}
const missingReason=(catalog,id)=>{
  const broken=catalog.packs.filter(pack=>pack.error).map(pack=>`pack ${pack.name} failed to load: ${pack.error}`);
  return [`handler ${id} is not installed`,...broken].join('; ').slice(0,500);
};
export async function listActions(root) {
  return [...(await handlerCatalog(root)).handlers.values()].map(({def,...shown})=>shown).sort((a,b)=>a.id.localeCompare(b.id));
}
// Per-story action availability, so a view can disable an action and say why before a click.
export async function actionStatus(root,rows) {
  if(!rows.some(row=>row.story.actions?.length)) return rows;
  const catalog=await handlerCatalog(root);
  return rows.map(row=>{
    if(!row.story.actions?.length) return row;
    const status={};
    for(const action of row.story.actions) {
      const entry=catalog.handlers.get(action.handler);
      let reason=!entry?missingReason(catalog,action.handler):entry.available?null:entry.reason;
      if(!reason&&entry.origin==='built-in'&&action.handler==='answer_decision') {
        const route=catalog.config.answer_routes[row.story.id];
        if(!route||route.story_hash!==row.story_hash||route.source_id!==row.story.source.id) reason='no trusted answer route is bound to this story';
      }
      status[action.id]=reason?{available:false,reason}:{available:true};
    }
    return {...row,action_status:status};
  });
}
function configPlan(def,args) {
  if(!plain(def)||def.kind!=='command'||typeof def.executable!=='string'||!path.isAbsolute(def.executable)||!Array.isArray(def.argv)||!Array.isArray(def.effects)||!def.effects.length||!def.effects.every(x=>typeof x==='string'&&x.length&&x.length<=500)) fail('invalid command handler definition');
  validateArgs(args,def.args??{});
  const argv=def.argv.map(x=>{
    if(!plain(x)||Object.keys(x).length!==1) fail('argv must use literal or arg slots');
    if(typeof x.literal==='string') return x.literal;
    if(typeof x.arg==='string'&&Object.hasOwn(args,x.arg)) return String(args[x.arg]);
    fail('argv references missing or invalid argument');
  });
  return {command:def.executable,argv,effects:[...def.effects,`Run ${JSON.stringify([def.executable,...argv])}`]};
}
async function planFor(root,storyId,actionId,choice={}) {
  const {story,hash:story_hash}=await stored(root,storyId);
  const inlinePath=actionId==='__open_local_path';
  if(inlinePath && (typeof choice.path!=='string'||![...(story.links??[]).map(l=>l.path),...splitDetailLinks(story.summary).map(p=>p.path),...splitDetailLinks(story.decision?.prompt??'').map(p=>p.path)].includes(choice.path))) fail('path is not present in this story');
  const action=inlinePath?{id:actionId,handler:'open_file',args:{path:choice.path}}:story.actions?.find(a=>a.id===actionId); if(!action) fail('action not found');
  const args=action.args??{};
  let plan;
  if(inlinePath) plan=await builtInPlan(action.handler,story,args,{inlinePath:true});
  else {
    const catalog=await handlerCatalog(root),entry=catalog.handlers.get(action.handler);
    if(!entry) fail(missingReason(catalog,action.handler));
    if(!entry.available) fail(`handler ${action.handler} is unavailable: ${entry.reason}`);
    if(entry.origin==='config') plan=configPlan(entry.def,args);
    else if(entry.origin==='pack') {
      const h=entry.def; validateArgs(args,h.args??{});
      plan=await h.plan({story,action,args,root,choice});
      if(!plain(plan)||!Array.isArray(plan.effects)||!plan.effects.every(x=>typeof x==='string')) fail('integration plan must declare exact effects');
      plan={...plan,kind:'package',package_id:action.handler,declared_effects:h.effects};
    } else plan=await builtInPlan(action.handler,story,args,{root,config:catalog.config,story_hash,option:choice.option,comment:choice.comment});
  }
  if(!plan) fail(`handler ${action.handler} is not installed`);
  return {story_id:storyId,action_id:actionId,handler:action.handler,source:story.source,story_hash,plan};
}
export async function openLocalPath(root,storyId,target) {
  const sheet=await review(root,storyId,'__open_local_path',{path:target});
  return runReviewed(root,sheet.token);
}
export async function review(root,storyId,actionId,choice={}) {
  return withStateLock(root,async()=>{
    const reviewed=await planFor(root,storyId,actionId,choice),token=random();
    const record={v:1,token,created_at:new Date().toISOString(),choice,reviewed};
    await fs.mkdir(path.join(root,'reviews'),{recursive:true,mode:0o700});
    await publishExclusive(path.join(root,'reviews'),`${token}.json`,Buffer.from(text(record)));
    return {token,...reviewed};
  });
}
async function executeAnswer(root,token,reviewed) {
  const {story}=await stored(root,reviewed.story_id),d=story.decision,source=story.source.id;
  const dir=path.join(root,'answers',source); await fs.mkdir(dir,{recursive:true,mode:0o700}); await fs.mkdir(path.join(dir,'handled'),{recursive:true,mode:0o700});
  const lock=path.join(dir,'.lock');
  let held=false;
  for(let i=0;i<100;i++) { try {await fs.mkdir(lock,{mode:0o700});held=true;break;} catch(e){if(e.code!=='EEXIST') throw e; await new Promise(resolve=>setTimeout(resolve,25));} }
  if(!held) fail('answer route busy');
  try {
    const entries=(await fs.readdir(dir)).filter(n=>n.endsWith('.json'));
    for(const name of entries) { const old=JSON.parse(await fs.readFile(path.join(dir,name),'utf8')); if(old.question_id===d.question_id) fail('decision already answered or pending'); }
    const receiptsDir=path.join(root,'receipts');
    for(const name of (await fs.readdir(receiptsDir)).filter(n=>n.endsWith('.json')&&n!==`${token}.json`)) {
      const old=JSON.parse(await fs.readFile(path.join(receiptsDir,name),'utf8'));
      if(old.source_id===source&&old.question_id===d.question_id&&old.handler==='answer_decision'&&old.outcome!=='failed') fail('decision already answered or pending');
    }
    const answer={v:1,answer_id:token,story_id:story.id,story_hash:reviewed.story_hash,question_id:d.question_id,option_id:reviewed.plan.option_id,answer_text:reviewed.plan.answer_text,comment:reviewed.plan.comment,operator_time:new Date().toISOString()};
    await publishExclusive(dir,`${token}.json`,Buffer.from(text(answer)));
    return `${dir}/${token}.json`;
  } finally { await fs.rmdir(lock); }
}
export async function runReviewed(root,token) {
  if(!/^[0-9a-f]{32}$/.test(token)) fail('invalid review token');
  const receiptDir=path.join(root,'receipts');
  const prepared=await withStateLock(root,async()=>{
    const record=JSON.parse(await fs.readFile(path.join(root,'reviews',`${token}.json`),'utf8'));
    if(Date.now()-Date.parse(record.created_at)>300000) fail('review expired; review the action again');
    const fresh=await planFor(root,record.reviewed.story_id,record.reviewed.action_id,record.choice);
    if(hash(fresh)!==hash(record.reviewed)) fail('story or handler changed; review again');
    const pending={v:1,receipt_id:token,created_at:new Date().toISOString(),story_id:fresh.story_id,source_id:fresh.source.id,question_id:fresh.plan.question_id,action_id:fresh.action_id,story_hash:fresh.story_hash,handler:fresh.handler,effects:fresh.plan.effects,outcome:'pending'};
    if(!await publishExclusive(receiptDir,`${token}.json`,Buffer.from(text(pending))))
      return {existing:JSON.parse(await fs.readFile(path.join(receiptDir,`${token}.json`),'utf8'))};
    return {fresh,pending,record};
  });
  if(prepared.existing) return prepared.existing;
  const {fresh,pending,record}=prepared;
  let result,outcome='succeeded';
  try {
    if(fresh.plan.kind==='answer') result=await executeAnswer(root,token,fresh);
    else if(fresh.plan.kind==='package') {
      const entry=(await handlerCatalog(root)).handlers.get(fresh.handler);
      if(entry?.origin!=='pack'||!entry.available) fail(`handler ${fresh.handler} is no longer available`);
      result=await entry.def.run({root,reviewed:fresh,choice:record.choice,token});
    } else {
      const r=spawnSync(fresh.plan.command,fresh.plan.argv,{encoding:'utf8',shell:false,timeout:30000,maxBuffer:65536});
      if(r.error) throw r.error;
      if(r.status!==0) throw new Error((r.stderr||r.stdout||`exit ${r.status}`).trim().slice(0,500));
      result=(r.stdout||'').trim().slice(0,500);
    }
  } catch(e) { outcome='failed'; result=String(e.message).slice(0,500); }
  const receipt={...pending,finished_at:new Date().toISOString(),outcome,result};
  await replaceAtomic(receiptDir,`${token}.json`,Buffer.from(text(receipt)));
  return receipt;
}
export async function receipts(root,storyId) {
  await layout(root);
  const names=(await fs.readdir(path.join(root,'receipts'))).filter(n=>n.endsWith('.json'));
  const all=await Promise.all(names.map(async n=>JSON.parse(await fs.readFile(path.join(root,'receipts',n),'utf8'))));
  return all.filter(r=>!storyId||r.story_id===storyId).sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
