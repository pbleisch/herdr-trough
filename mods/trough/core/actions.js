import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { KEY } from './schema.js';
import { layout, stored, publishExclusive, replaceAtomic, withStateLock } from './store.js';
import { localOpenPlan } from './core-pack.js';
import { spawnSync } from 'node:child_process';
import { splitDetailLinks } from '../links.js';
import { readAllowed, writeAllowed, allowKey, isAllowKey } from './allow.js';

const text=v=>JSON.stringify(v,null,2)+'\n';
const hash=v=>crypto.createHash('sha256').update(text(v)).digest('hex');
const random=()=>crypto.randomBytes(16).toString('hex');
const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
const fail=s=>{throw new Error(s);};
const exactKeys=(obj,allowed,label)=>{ for(const k of Object.keys(obj)) if(!allowed.includes(k)) fail(`${label}: unknown argument ${k}`); };
const CORE_PACK=fileURLToPath(new URL('./core-pack.js',import.meta.url));
const BUILT_INS={answer_decision:{args:{},effects:['Write an immutable answer under answers/<source-id>/']}};
async function builtInPlan(id,story,args,context) {
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
  if(!plain(raw)||raw.v!==1||!plain(raw.handlers??{})||!Array.isArray(raw.packages??[])||!plain(raw.answer_routes??{})||!['boolean','undefined'].includes(typeof raw.core)) fail('invalid handlers.json');
  for(const [storyId,route] of Object.entries(raw.answer_routes??{})) if(!/^[0-9a-f]{32}$|^[0-9A-HJKMNP-TV-Z]{26}$/.test(storyId)||!plain(route)||!KEY.test(route.source_id)||!/^[0-9a-f]{64}$/.test(route.story_hash)) fail('invalid answer route');
  return raw;
}
export async function loadConfig(root) {
  let raw;
  try { raw=JSON.parse(await fs.readFile(path.join(root,'handlers.json'),'utf8')); }
  catch(e) { if(e.code==='ENOENT') return {v:1,core:true,handlers:{},answer_routes:{},packages:[]}; throw e; }
  validateConfig(raw);
  return {v:1,core:raw.core!==false,handlers:raw.handlers??{},answer_routes:raw.answer_routes??{},packages:raw.packages??[]};
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
  const pack={path:file,name:typeof file==='string'?packName(file):'(invalid)',options,module:null,handlers:{},states:{}};
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
    if(pack.module.augment!==undefined) {
      if(typeof pack.module.augment!=='function') fail('augment must be a function');
      if(!KEY.test(pack.name)) fail('a pack that augments stories needs a `name` export of lowercase letters, digits, - and _');
      const rules=pack.module.rules??[];
      if(!Array.isArray(rules)||!rules.every(rule=>typeof rule==='string'&&rule.length<=300)) fail('rules must be an array of short strings');
      const facts=pack.module.facts===undefined?{}:await pack.module.facts(options);
      if(!plain(facts)) fail('facts() must return an object');
      pack.facts=JSON.parse(JSON.stringify(facts)); pack.rules=rules; pack.augment=pack.module.augment;
    }
  } catch(error) { pack.error=brief(error); pack.handlers={}; delete pack.augment; }
  return pack;
}
async function handlerState(origin,id,def) {
  try {
    if(origin==='config') {
      if(!plain(def)||def.kind!=='command'||typeof def.executable!=='string'||!path.isAbsolute(def.executable)) return 'invalid command handler definition';
      try { await fs.access(def.executable,constants.X_OK); } catch { return `${def.executable} is missing or not executable`; }
      return null;
    }
    if(origin==='built-in') return null;
    if(!plain(def)||typeof def.plan!=='function'||typeof def.run!=='function'||!Array.isArray(def.effects)) return 'invalid integration handler';
    if(!['boolean','undefined'].includes(typeof def.always_allow)||!['function','undefined'].includes(typeof def.fingerprint)) return 'invalid integration handler';
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
  for(const entry of [...(config.core?[CORE_PACK]:[]),...config.packages]) {
    const pack=await loadPack(entry); packs.push(pack);
    if(entry===CORE_PACK) pack.built_in=true;
    for(const [id,def] of Object.entries(pack.handlers)) {
      await put(id,'pack',def,pack);
      const {available,reason}=handlers.get(id); pack.states[id]={available,...(reason?{reason}:{})};
    }
  }
  for(const [id,def] of Object.entries(config.handlers)) await put(id,'config',def);
  return {config,packs,handlers};
}
const missingReason=(catalog,id)=>{
  const broken=catalog.packs.filter(pack=>pack.error).map(pack=>`pack ${pack.name} failed to load: ${pack.error}`);
  return [`handler ${id} is not installed`,...broken].join('; ').slice(0,500);
};

// --- Augmentation -------------------------------------------------------------------------------
// A pack's augment(story, context) adds action offers and badges to a story at processing time.
// The stored story never changes. Offers are additions only, run the offering pack's own handler,
// and are recomputed at review and at run, so an offer that is gone by then cannot execute.
const OFFER_ID=/^[a-z][a-z0-9_.-]{0,127}$/;
const scalar=v=>typeof v==='string'?v.length<=8192:typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v));
function offersFrom(pack,story) {
  const result=pack.augment(structuredClone(story),{options:structuredClone(pack.options),facts:structuredClone(pack.facts),platform:process.platform});
  if(result===undefined||result===null) return {actions:[],badges:[]};
  if(typeof result?.then==='function') fail('augment must be synchronous');
  if(!plain(result)) fail('augment must return an object');
  for(const k of Object.keys(result)) if(!['actions','badges'].includes(k)) fail(`augment may only add actions and badges, not ${k}`);
  const actions=result.actions??[],badges=result.badges??[];
  if(!Array.isArray(actions)||actions.length>48) fail('augment actions must be an array of at most 48 offers');
  if(!Array.isArray(badges)||badges.length>4||!badges.every(b=>typeof b==='string'&&b.length>=1&&b.length<=24)) fail('augment badges must be at most 4 strings of 1-24 characters');
  const seen=new Set();
  return {badges:[...badges],actions:actions.map(a=>{
    if(!plain(a)) fail('augment action must be an object');
    for(const k of Object.keys(a)) if(!['id','label','handler','args','link'].includes(k)) fail(`augment action has unknown field ${k}`);
    if(typeof a.id!=='string'||!OFFER_ID.test(a.id)||seen.has(a.id)) fail('augment action needs a unique id');
    seen.add(a.id);
    if(typeof a.label!=='string'||!a.label||a.label.length>120) fail(`augment action ${a.id} needs a label of 1-120 characters`);
    if(!Object.hasOwn(pack.handlers,a.handler)) fail(`augment action ${a.id} must use a handler of its own pack`);
    const args=a.args??{};
    if(!plain(args)||Object.keys(args).length>12||!Object.values(args).every(scalar)) fail(`augment action ${a.id} has invalid args`);
    validateArgs(args,pack.handlers[a.handler].args??{});
    if(a.link!==undefined&&!story.links?.some(l=>l.id===a.link)) fail(`augment action ${a.id} names a missing link`);
    return {id:`${pack.name}.${a.id}`,pack:pack.name,label:a.label,handler:a.handler,args:{...args},...(a.link!==undefined?{link:a.link}:{})};
  })};
}
// Packs augment in configured order. A pack that throws loses only its own additions for that story.
export function augmentStory(catalog,story) {
  const offers=[],badges=[],errors=[],names=new Set();
  for(const pack of catalog.packs) {
    if(!pack.augment) continue;
    try {
      if(names.has(pack.name)) fail('another pack with the same name already augments stories');
      names.add(pack.name); const added=offersFrom(pack,story); offers.push(...added.actions); badges.push(...added.badges.map(label=>({pack:pack.name,label}))); }
    catch(error) { errors.push({pack:pack.name,error:brief(error)}); }
  }
  return {offers,badges,errors};
}
export async function listActions(root) {
  const catalog=await handlerCatalog(root);
  return {handlers:[...catalog.handlers.values()].map(({def,...shown})=>shown).sort((a,b)=>a.id.localeCompare(b.id)),
    augmenters:catalog.packs.filter(pack=>pack.augment).map(pack=>({pack:pack.name,rules:pack.rules,facts:pack.facts}))};
}
// Adds what a view needs to each row: availability of the story's own actions (`action_status`),
// the offers packs attach (`offers`) and their badges. The pane disables anything unavailable and says why.
export async function annotate(root,rows) {
  const catalog=await handlerCatalog(root);
  return rows.map(row=>{
    const status={};
    for(const action of row.story.actions??[]) {
      const entry=catalog.handlers.get(action.handler);
      let reason=!entry?missingReason(catalog,action.handler):entry.available?null:entry.reason;
      if(!reason&&entry.origin==='built-in'&&action.handler==='answer_decision') {
        const route=catalog.config.answer_routes[row.story.id];
        if(!route||route.story_hash!==row.story_hash||route.source_id!==row.story.source.id) reason='no trusted answer route is bound to this story';
      }
      status[action.id]=reason?{available:false,reason}:{available:true};
    }
    const {offers,badges}=augmentStory(catalog,row.story);
    const byName=new Map(catalog.packs.map(pack=>[pack.name,pack]));
    return {...row,...(row.story.actions?.length?{action_status:status}:{}),
      offers:offers.map(offer=>({...offer,...byName.get(offer.pack).states[offer.handler]})),badges};
  });
}
// Augment failures across the stored stories, per pack, for `trough packages check` and the pane header.
export function augmentProblems(catalog,stories) {
  const found=new Map();
  for(const story of stories) for(const {pack,error} of augmentStory(catalog,story).errors) {
    const entry=found.get(pack)??{count:0,first:error}; entry.count++; found.set(pack,entry);
  }
  return found;
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

// --- Standing approvals ("always allow") --------------------------------------------------------
// The operator may let one handler, as offered by one pack, run without the review sheet. Only an
// offer whose handler sets `always_allow: true` qualifies: never an action a story declares, a
// decision answer or a prompt delivery. The approval pins a fingerprint of what the handler runs:
// the pack's module file and options, the handler's arguments and declared effects, and whatever
// its own `fingerprint()` reports (the core pack reports the open handler chain). When that
// changes, the approval stops counting until the operator confirms a review again.
const offeringPack=(catalog,name)=>catalog.packs.find(item=>item.name===name&&item.augment);
async function standingFingerprint(pack,id,def) {
  const module=crypto.createHash('sha256').update(await fs.readFile(pack.path)).digest('hex');
  const own=def.fingerprint?await def.fingerprint():null;
  return hash({pack:pack.name,path:pack.path,module,options:pack.options,handler:id,args:def.args??{},effects:def.effects,own:own??null});
}
// new: not approved. active: approved, runs without the sheet. changed: approved, but what the
// handler runs changed since, so the sheet is shown once more.
const standingState=(allowed,standing)=>!allowed[standing.key]?'new':allowed[standing.key].fingerprint===standing.fingerprint?'active':'changed';
export async function listAllowed(root) {
  const allowed=await readAllowed(root),catalog=await handlerCatalog(root),rows=[];
  for(const [key,entry] of Object.entries(allowed).sort(([a],[b])=>a.localeCompare(b))) {
    const pack=offeringPack(catalog,entry.pack),def=pack?.handlers[entry.handler];
    let state='changed',reason;
    if(!pack) reason=`pack ${entry.pack} is not installed or offers no actions`;
    else if(!def) reason=`pack ${entry.pack} no longer has handler ${entry.handler}`;
    else if(def.always_allow!==true) reason=`handler ${entry.handler} no longer accepts a standing approval`;
    else if(await standingFingerprint(pack,entry.handler,def).catch(()=>null)===entry.fingerprint) state='active';
    else reason='the handler changed since you allowed it; the next run asks you to confirm';
    rows.push({key,pack:entry.pack,handler:entry.handler,label:entry.label??null,effects:Array.isArray(entry.effects)?entry.effects:[],at:entry.at??null,state,...(reason?{reason}:{})});
  }
  return rows;
}
export async function revokeAllowed(root,key) {
  if(key!=='all'&&!isAllowKey(key)) fail('revoke needs PACK/HANDLER, as `trough allow` lists it, or all');
  return withStateLock(root,async()=>{
    const allowed=await readAllowed(root),revoked=key==='all'?Object.keys(allowed):[key];
    if(key!=='all'&&!allowed[key]) fail(`${key} is not always allowed`);
    for(const item of revoked) delete allowed[item];
    if(revoked.length) await writeAllowed(root,allowed);
    return {revoked};
  });
}

async function planFor(root,storyId,actionId,choice={}) {
  const {story,hash:story_hash}=await stored(root,storyId);
  const inlinePath=actionId==='__open_local_path';
  if(inlinePath && (typeof choice.path!=='string'||![...(story.links??[]).map(l=>l.path),...splitDetailLinks(story.summary).map(p=>p.path),...splitDetailLinks(story.decision?.prompt??'').map(p=>p.path)].includes(choice.path))) fail('path is not present in this story');
  const catalog=await handlerCatalog(root);
  const base={story_id:storyId,action_id:actionId,source:story.source,story_hash};
  const packPlan=async(h,action)=>{
    validateArgs(action.args??{},h.args??{});
    const plan=await h.plan({story,action,args:action.args??{},root,choice});
    if(!plain(plan)||!Array.isArray(plan.effects)||!plan.effects.every(x=>typeof x==='string')) fail('integration plan must declare exact effects');
    return {...plan,kind:'package',package_id:action.handler,declared_effects:h.effects};
  };
  if(inlinePath) {
    const core=catalog.packs.find(pack=>pack.built_in),state=core?.states.open_file;
    if(!core||core.error) fail('opening a local path needs the core pack; restore it with `trough packages add core`');
    if(!state.available) fail(state.reason);
    return {reviewed:{...base,handler:'open_file',offered_by:'core',plan:{...await localOpenPlan(choice.path),kind:'package',package_id:'open_file'}},def:core.handlers.open_file,
      ineligible:'it is not an action a pack offers'};
  }
  if(actionId.includes('.')) {
    // A pack offer: recomputed here, so review and run both see what the pack offers right now.
    const {offers,errors}=augmentStory(catalog,story),offer=offers.find(o=>o.id===actionId);
    if(!offer) fail(`action ${actionId} is not offered for this story${errors.length?` (${errors.map(e=>`pack ${e.pack}: ${e.error}`).join('; ')})`:''}`.slice(0,500));
    const pack=offeringPack(catalog,offer.pack),state=pack.states[offer.handler];
    if(!state.available) fail(`handler ${offer.handler} is unavailable: ${state.reason}`);
    const def=pack.handlers[offer.handler];
    const reviewed={...base,handler:offer.handler,offered_by:offer.pack,offer,plan:await packPlan(def,{id:offer.id,label:offer.label,handler:offer.handler,args:offer.args})};
    if(def.always_allow!==true) return {reviewed,def,ineligible:`handler ${offer.handler} of pack ${offer.pack} does not accept a standing approval`};
    return {reviewed,def,standing:{key:allowKey(pack.name,offer.handler),pack:pack.name,handler:offer.handler,label:offer.label,effects:[...def.effects],fingerprint:await standingFingerprint(pack,offer.handler,def)}};
  }
  const action=story.actions?.find(a=>a.id===actionId); if(!action) fail('action not found');
  const entry=catalog.handlers.get(action.handler);
  if(!entry) fail(missingReason(catalog,action.handler));
  if(!entry.available) fail(`handler ${action.handler} is unavailable: ${entry.reason}`);
  const args=action.args??{};
  let plan;
  if(entry.origin==='config') plan=configPlan(entry.def,args);
  else if(entry.origin==='pack') plan=await packPlan(entry.def,action);
  else plan=await builtInPlan(action.handler,story,args,{root,config:catalog.config,story_hash,option:choice.option,comment:choice.comment});
  if(!plan) fail(`handler ${action.handler} is not installed`);
  return {reviewed:{...base,handler:action.handler,offered_by:'story',plan},def:entry.def,
    ineligible:'the story declares this action; only actions a pack offers can be always allowed'};
}
export async function openLocalPath(root,storyId,target) {
  const sheet=await review(root,storyId,'__open_local_path',{path:target});
  return runReviewed(root,sheet.token);
}
// Call with the state lock held. `always_allow` is on the sheet only for an action that may be always allowed.
async function reviewLocked(root,storyId,actionId,choice) {
  const {reviewed,standing}=await planFor(root,storyId,actionId,choice),token=random();
  const record={v:1,token,created_at:new Date().toISOString(),choice,reviewed};
  await fs.mkdir(path.join(root,'reviews'),{recursive:true,mode:0o700});
  await publishExclusive(path.join(root,'reviews'),`${token}.json`,Buffer.from(text(record)));
  const state=standing?standingState(await readAllowed(root),standing):null;
  return {token,...reviewed,...(standing?{always_allow:{key:standing.key,state,effects:standing.effects}}:{})};
}
export async function review(root,storyId,actionId,choice={}) {
  return withStateLock(root,()=>reviewLocked(root,storyId,actionId,choice));
}
// What a click does: an action the operator always allows runs at once and returns {receipt};
// anything else returns {review}, the sheet to confirm with `runReviewed`.
export async function act(root,storyId,actionId,choice={}) {
  const sheet=await review(root,storyId,actionId,choice);
  if(sheet.always_allow?.state!=='active') return {review:sheet};
  return {receipt:await runReviewed(root,sheet.token,{standing:true})};
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
// `alwaysAllow` records a standing approval for this kind of action before running it (the operator
// ticked "Always allow" on the sheet). `standing` runs on an existing approval, without a sheet.
export async function runReviewed(root,token,{alwaysAllow=false,standing:onApproval=false}={}) {
  if(!/^[0-9a-f]{32}$/.test(token)) fail('invalid review token');
  const receiptDir=path.join(root,'receipts');
  const prepared=await withStateLock(root,async()=>{
    const record=JSON.parse(await fs.readFile(path.join(root,'reviews',`${token}.json`),'utf8'));
    if(Date.now()-Date.parse(record.created_at)>300000) fail('review expired; review the action again');
    const {reviewed:fresh,def,standing,ineligible}=await planFor(root,record.reviewed.story_id,record.reviewed.action_id,record.choice);
    if(hash(fresh)!==hash(record.reviewed)) fail('story, offer or handler changed; review again');
    if(alwaysAllow&&!standing) fail(`this action cannot be always allowed: ${ineligible}`);
    if(onApproval&&(!standing||standingState(await readAllowed(root),standing)!=='active')) fail('this action is not always allowed any more; review it');
    const pending={v:1,receipt_id:token,created_at:new Date().toISOString(),story_id:fresh.story_id,source_id:fresh.source.id,question_id:fresh.plan.question_id,action_id:fresh.action_id,story_hash:fresh.story_hash,handler:fresh.handler,offered_by:fresh.offered_by,
      ...(onApproval?{approval:'always-allow',allow_key:standing.key}:{}),effects:fresh.plan.effects,outcome:'pending'};
    if(!await publishExclusive(receiptDir,`${token}.json`,Buffer.from(text(pending))))
      return {existing:JSON.parse(await fs.readFile(path.join(receiptDir,`${token}.json`),'utf8'))};
    if(alwaysAllow) {
      const {key,fingerprint,...shown}=standing;
      await writeAllowed(root,{...await readAllowed(root),[key]:{...shown,fingerprint,at:new Date().toISOString()}});
    }
    return {fresh,pending,record,def};
  });
  if(prepared.existing) return prepared.existing;
  const {fresh,pending,record,def}=prepared;
  let result,outcome='succeeded';
  try {
    if(fresh.plan.kind==='answer') result=await executeAnswer(root,token,fresh);
    else if(fresh.plan.kind==='package') result=await def.run({root,reviewed:fresh,choice:record.choice,token});
    else {
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

