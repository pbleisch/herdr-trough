import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { configuredHome, integrationDir, slug, liveTask, holdIdentity, backlog, command, writeJson, storyHash, limited } from './common.js';
import { sync } from './sync.js';

const promptArgs={task_id:{type:'string',required:true,max_length:128},spawn_gen:{type:'string',required:true,max_length:128},text:{type:'string',required:true,max_length:8192}};
const decisionArgs={task_id:{type:'string',required:true,max_length:128},hold_identity:{type:'string',required:true,max_length:128}};
const recordName=/^[0-9]+\.msg$/;

export function producer(options) {
  const interval=options?.sync_interval_seconds??120;
  if(!Number.isSafeInteger(interval)||interval<1) throw new Error('sync_interval_seconds must be a positive integer');
  return {name:'Firstmate',interval_seconds:interval,run:({root})=>sync(root,options)};
}

async function inboxNames(home,taskId) {
  const dir=path.join(home,'state',`${taskId}.inbox`);
  const names=new Set();
  for (const sub of ['', 'handled']) {
    try { for (const name of await fs.readdir(path.join(dir,sub))) if(recordName.test(name)) names.add(name); }
    catch (error) { if(error.code!=='ENOENT') throw error; }
  }
  return names;
}

function recordBody(raw) {
  const cut=raw.indexOf('\n--\n');
  if(cut<0) return null;
  const header=raw.slice(0,cut),body=raw.slice(cut+4);
  return /(?:^|\n)body-terminator=1(?:\n|$)/.test(header) ? body.slice(0,-1) : body;
}

export async function findNewRecord(home,taskId,before,text,deliveryId,minSequence=0) {
  const dir=path.join(home,'state',`${taskId}.inbox`),found=[];
  for (const sub of ['', 'handled']) {
    let names=[];
    try { names=await fs.readdir(path.join(dir,sub)); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    for (const name of names) {
      if(!recordName.test(name)||before.has(name)||Number(name.slice(0,-4))<=minSequence) continue;
      const file=path.join(dir,sub,name);
      let body;
      try { body=recordBody(await fs.readFile(file,'utf8')); }
      catch(error) { if(error.code==='ENOENT') continue; throw error; }
      if(body===text || (deliveryId && body?.includes(`delivery=${deliveryId} `) && body.endsWith(text))) found.push(name);
    }
  }
  return [...new Set(found)].length===1 ? found[0] : null;
}

async function decisionRoute(root,home,story,args) {
  const file=path.join(integrationDir(root,home),'routes',`${story.id}.json`);
  let route;
  try { route=JSON.parse(await fs.readFile(file,'utf8')); }
  catch(error) { if(error.code==='ENOENT') throw new Error('no trusted Firstmate decision route for this story'); throw error; }
  if(route.story_hash!==await storyHash(root,story.id) || route.task_id!==args.task_id || route.hold_identity!==args.hold_identity) throw new Error('Firstmate decision route does not match this story and hold');
  return route;
}

export function handlers(options) {
  const home=configuredHome(options);
  return {
    deliver_prompt:{
      args:promptArgs,effects:['Queue an asynchronous Firstmate steering message'],
      async plan({args}) {
        if(!slug.test(args.task_id)||!args.text.trim()) throw new Error('invalid Firstmate task or empty prompt');
        if(args.text.startsWith('/')||args.text.startsWith('$')) throw new Error('prompt starts with / or $ and would enter fm-send typed delivery');
        await liveTask(home,args.task_id,args.spawn_gen);
        return {home,task_id:args.task_id,spawn_gen:args.spawn_gen,text:args.text,
          effects:[`Queue to Firstmate task ${args.task_id} (spawn ${args.spawn_gen}) in ${home}`,
            `Exact prompt: ${JSON.stringify(args.text)}`,'Delivery is asynchronous; this action does not wait for a reply']};
      },
      async run({root,reviewed,token}) {
        const plan=reviewed.plan,taskId=plan.task_id;
        const meta=await liveTask(home,taskId,plan.spawn_gen);
        const dir=path.join(integrationDir(root,home),'deliveries');
        const deliveryId=meta.kind==='secondmate'?token.slice(0,16):null;
        const before=await inboxNames(home,taskId);
        let beforeMax=0;
        for(const name of before) beforeMax=Math.max(beforeMax,Number(name.slice(0,-4)));
        const base={v:1,token,story_id:reviewed.story_id,task_id:taskId,spawn_gen:plan.spawn_gen,text:plan.text,delivery_id:deliveryId,before_max:beforeMax,at:new Date().toISOString()};
        await writeJson(dir,`${token}.json`,{...base,status:'sending'});
        const argv=[taskId];
        if(deliveryId) argv.push('--fire-and-forget',deliveryId);
        argv.push(plan.text);
        const sent=command(home,'fm-send.sh',argv,{FM_SEND_EXPECTED_SPAWN_GEN:plan.spawn_gen});
        if(sent.status!==0) {
          await writeJson(dir,`${token}.json`,{...base,status:'uncertain',detail:limited(sent.stderr||sent.stdout||`exit ${sent.status}`,600)});
          throw new Error(`Firstmate steering was not confirmed; inspect the delivery record: ${limited(sent.stderr||sent.stdout,500)}`);
        }
        try {
          const record=await findNewRecord(home,taskId,before,plan.text,deliveryId);
          const status=record?'queued':'queued_unobserved';
          await writeJson(dir,`${token}.json`,{...base,status,record});
          return record?`queued: ${taskId} inbox record ${record}; acknowledgement pending`:`queued: ${taskId}; inbox record could not be identified, acknowledgement pending`;
        } catch(error) {
          return `queued: ${taskId}; inbox observation failed after delivery: ${limited(error.message,180)}`;
        }
      }
    },
    answer_firstmate_decision:{
      args:decisionArgs,effects:['Record the selected words in the Firstmate captain hold'],
      async plan({story,args,root,choice}) {
        if(story.kind!=='decision') throw new Error('Firstmate answer requires a decision story');
        const route=await decisionRoute(root,home,story,args);
        if(holdIdentity(home,args.task_id)!==args.hold_identity) throw new Error('Firstmate captain hold closed or changed lifecycle');
        const selected=route.options?.find(option=>option.id===choice.option);
        const shown=story.decision?.options.find(option=>option.id===choice.option);
        if(!selected||!shown||selected.answer_text!==shown.answer_text||selected.label!==shown.label) throw new Error('select a configured Firstmate decision option');
        if(choice.comment) throw new Error('Firstmate decision comments are not available; select exact configured words');
        if(selected.answer_text.trim().toLowerCase()==='reconcile') throw new Error('reconcile is reserved by Firstmate');
        if(!['done','release'].includes(selected.mode)) throw new Error('Firstmate decision close mode is invalid');
        const consequence=selected.mode==='release'?'Release the held work item to resume':'Complete the captain-held task';
        return {home,task_id:args.task_id,hold_identity:args.hold_identity,option_id:selected.id,answer_text:selected.answer_text,mode:selected.mode,
          effects:[`Record exact Firstmate answer for ${args.task_id}: ${JSON.stringify(selected.answer_text)}`,consequence]};
      },
      async run({root,reviewed}) {
        const plan=reviewed.plan;
        if(holdIdentity(home,plan.task_id)!==plan.hold_identity) throw new Error('Firstmate captain hold closed or changed lifecycle');
        const temp=path.join(os.tmpdir(),`trough-firstmate-answer-${process.pid}-${crypto.randomUUID()}`);
        await fs.writeFile(temp,plan.answer_text,{mode:0o600,flag:'wx'});
        try {
          const argv=['answer',plan.task_id,'--decision-file',temp];
          if(plan.mode==='release') argv.push('--release');
          const result=command(home,'fm-captain-hold.sh',argv);
          if(result.status!==0) throw new Error(`Firstmate answer failed: ${limited(result.stderr||result.stdout,600)}`);
        } finally { await fs.unlink(temp).catch(()=>{}); }
        let row;
        try { row=(await backlog(home)).find(item=>item.id===plan.task_id); }
        catch { return `pending: Firstmate accepted the answer for ${plan.task_id}, but its task state could not be reread`; }
        const applied=plan.mode==='done'?row?.state==='done':Boolean(row&&row.state!=='done'&&row.hold_kind!=='captain');
        return `${applied?'applied':'pending'}: ${plan.mode==='release'?'released':'completed'} Firstmate captain hold ${plan.task_id}`;
      }
    }
  };
}
