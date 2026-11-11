import fs from 'node:fs/promises';
import path from 'node:path';
import { post, stored } from '../../mods/trough/core/store.js';
import { configuredHome, backlog, holdIdentity, integrationDir, iso, limited, sha, source, storyId, storyHash, writeJson } from './common.js';
import { findNewRecord } from './index.js';

const clean=(value,max)=>limited(value,max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ');
const atDate=value=>/^\d{4}-\d\d-\d\d$/.test(value??'')?`${value}T12:00:00Z`:null;
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const isHold=row=>row?.structured===true&&row?.hold_kind==='captain'&&row?.state!=='done';
const base=(home,type,identity,occurredAt)=>({v:1,id:storyId(home,type,identity),source:source(home),occurred_at:occurredAt,severity:'notice'});

async function readLines(file) {
  let body;
  try { body=await fs.readFile(file,'utf8'); }
  catch(error) { if(error.code==='ENOENT') return []; throw error; }
  return body.split('\n').filter(Boolean).map((line,index)=>{
    try { return JSON.parse(line); }
    catch { throw new Error(`invalid JSONL at ${file}:${index+1}`); }
  });
}

async function publish(root,story) {
  try { await stored(root,story.id); return false; }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  await post(root,json(story));
  return true;
}

async function mergeStories(home) {
  const events=await readLines(path.join(home,'state','fleet-ledger.jsonl'));
  const merged=[];
  const closedDir=path.join(home,'state','secondmate-prs','closed');
  let closed=[];
  try { closed=await fs.readdir(closedDir,{withFileTypes:true}); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  for(const entry of closed.filter(entry=>entry.isDirectory())) {
    const folder=path.join(closedDir,entry.name);
    const metaName=`${entry.name.replace(/-[0-9]+$/,'')}.meta`;
    let body;
    try { body=await fs.readFile(path.join(folder,metaName),'utf8'); }
    catch(error) { if(error.code==='ENOENT') continue; throw error; }
    const fields={};
    for(const line of body.split('\n')) { const cut=line.indexOf('='); if(cut>0) fields[line.slice(0,cut)]=line.slice(cut+1); }
    if(!fields.pr?.startsWith('https://')||!fields.outcome||!/^\d+$/.test(fields.closed_at??'')) continue;
    const task=metaName.slice(0,-'.meta'.length),successful=['merged','merged-elsewhere'].includes(fields.outcome);
    const identity=successful?`${task}:${fields.pr}`:`${task}:${fields.pr}:${fields.outcome}:${fields.closed_at}`;
    merged.push({...base(home,'merge',identity,iso(Number(fields.closed_at))),kind:'merge',
      title:`${successful?'Merged':'Merge outcome'}: ${clean(task,120)}`,
      summary:`Firstmate recorded ${fields.outcome} for ${fields.pr}${fields.authority==='grant'?' under a standing grant':''}.`,
      severity:successful?'notice':'warning',outcome:successful?'succeeded':'failed',group_key:`merge:${fields.secondmate||task}`,
      subject:{type:'task',key:clean(task,256)},provenance:{task_id:clean(task,128),event_id:identity,...(fields.pr_head?{head:clean(fields.pr_head,128)}:{})},
      links:[{id:'change',label:'Pull request',url:fields.pr}]});
  }
  for (const event of events) {
    if(event?.v!==1||!event.task||!Number.isFinite(event.ts)) continue;
    let url=null,via=null;
    if(event.event==='task.merged') { via=event.via;url=event.pr??null; }
    else if(event.event==='task.status'&&event.key?.startsWith('merged-')) {
      url=/(https:\/\/[^\s)<>]+)/.exec(event.text??'')?.[1]??null;
      via='pr';
    }
    else continue;
    if(via==='pr'&&(!url||!url.startsWith('https://'))) continue;
    const identity=via==='pr'?`${event.task}:${url}`:`${event.task}:local:${event.ts}`;
    merged.push({...base(home,'merge',identity,iso(event.ts)),kind:'merge',title:`Merged ${clean(event.task,120)}`,
      summary:via==='pr'?`Firstmate recorded the merge of ${url}.`:`Firstmate recorded a local branch landing for ${event.task}.`,
      outcome:'succeeded',group_key:`merge:${event.task}`,subject:{type:'task',key:clean(event.task,256)},
      provenance:{task_id:clean(event.task,128),event_id:identity},
      ...(via==='pr'?{links:[{id:'change',label:'Merged change',url}]}:{})});
  }
  const names=await fs.readdir(path.join(home,'state'));
  for(const name of names.filter(name=>name.endsWith('.status'))) {
    const parent=name.slice(0,-'.status'.length),file=path.join(home,'state',name);
    const lines=(await fs.readFile(file,'utf8')).split('\n');
    for(const line of lines) {
      const match=/^done\b.*\[key=merged-[^\]]+\].*:\s*merged\s+([A-Za-z0-9._-]+)\s+(https:\/\/[^\s)<>]+)/.exec(line);
      if(!match) continue;
      const task=match[1],url=match[2],epoch=Number(/\[at=(\d+)\]/.exec(line)?.[1]);
      const when=Number.isFinite(epoch)&&epoch>0?iso(epoch):(await fs.stat(file)).mtime.toISOString();
      const identity=`${task}:${url}`;
      merged.push({...base(home,'merge',identity,when),kind:'merge',title:`Merged ${clean(task,120)}`,
        summary:`Firstmate recorded the merge of ${url} through ${parent}.`,outcome:'succeeded',group_key:`merge:${parent}`,
        subject:{type:'task',key:clean(task,256)},provenance:{task_id:clean(task,128),event_id:identity},
        links:[{id:'change',label:'Merged change',url}]});
    }
  }
  for (const name of names.filter(name=>name.endsWith('.pr-poll-merge-notified')).sort()) {
    const task=name.slice(0,-'.pr-poll-merge-notified'.length);
    const file=path.join(home,'state',name),parts=(await fs.readFile(file,'utf8')).trim().split('\n');
    if(parts[0]!=='fm-pr-poll-merge-notified-v1'||!['github','forgejo','gitlab','gerrit'].includes(parts[1])) continue;
    const [,provider,host,repo,num]=parts;
    if(!/^[a-z0-9.-]+$/.test(host)||!/^\d+$/.test(num)||!repo||repo.includes('..')) continue;
    const segment=provider==='forgejo'?'pulls':provider==='gitlab'?'-/merge_requests':'pull';
    if(provider==='gerrit') continue;
    const url=`https://${host}/${repo}/${segment}/${num}`;
    const stat=await fs.stat(file),identity=`${task}:${url}`;
    merged.push({...base(home,'merge',identity,stat.mtime.toISOString()),kind:'merge',title:`Merged ${clean(task,120)}`,
      summary:`Firstmate recorded the merge of ${url}.`,outcome:'succeeded',group_key:`merge:${task}`,
      subject:{type:'task',key:clean(task,256)},provenance:{task_id:clean(task,128),event_id:identity},
      links:[{id:'change',label:'Merged change',url}]});
  }
  return merged;
}

async function branchStories(home) {
  const rows=await readLines(path.join(home,'state','branch-outcomes.jsonl'));
  return rows.filter(row=>Number.isSafeInteger(row.seq)&&Number.isFinite(row.epoch)&&row.verdict==='captain'&&!row.silent)
    .map(row=>({...base(home,'branch',String(row.seq),iso(row.epoch)),kind:'agent',
      title:`Captain-relevant branch outcome for ${clean(row.task,110)}`,
      summary:clean(row.summary,4096)||'Firstmate recorded a captain-relevant branch outcome.',
      severity:'warning',group_key:`branch:${row.task}`,subject:{type:'task',key:clean(row.task,256)},
      provenance:{task_id:clean(row.task,128),event_id:`branch:${row.seq}`}}));
}

function configuredOptions(options,taskId) {
  const route=options.decisions?.[taskId];
  if(!route) return null;
  if(!Array.isArray(route.options)||route.options.length<2||route.options.length>10) throw new Error(`decision route ${taskId} needs 2-10 options`);
  const ids=new Set();
  for(const option of route.options) {
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(option.id??'')||ids.has(option.id)||
       typeof option.label!=='string'||!option.label||option.label.length>120||
       typeof option.answer_text!=='string'||!option.answer_text||option.answer_text.length>512||
       option.answer_text.trim().toLowerCase()==='reconcile'||!['done','release'].includes(option.mode)) throw new Error(`invalid decision option for ${taskId}`);
    ids.add(option.id);
  }
  return route.options;
}

async function holdStories(home,root,options,rows) {
  const stories=[],current={};
  for(const row of rows.filter(isHold)) {
    const identity=holdIdentity(home,row.id);
    if(!identity) continue;
    current[row.id]={identity,title:row.title,kind:row.kind};
    const event=`${row.id}:${identity}`,routeOptions=configuredOptions(options,row.id);
    const date=/^\d{4}-\d\d-\d\dT[^#]+/.exec(identity)?.[0]??row.hold_set??atDate(row.since)??new Date().toISOString();
    const decision={question_id:`hold_${sha(event).slice(0,16)}`,prompt:clean(row.hold_reason||row.title||`Captain decision for ${row.id}`,4096),
      options:(routeOptions??[]).map(({id,label,answer_text})=>({id,label,answer_text}))};
    const story={...base(home,'hold',event,date),kind:'decision',title:clean(row.title||`Captain decision: ${row.id}`,200),
      summary:routeOptions?
        `Firstmate is holding this ${row.kind==='captain'?'decision':'work item'} for the captain. Review a configured option to answer.`:
        `Firstmate is holding this ${row.kind==='captain'?'decision':'work item'} for the captain. Answer through Firstmate; no exact option route is configured.`,
      severity:'warning',outcome:'pending',group_key:`decision:${row.id}`,subject:{type:'task',key:clean(row.id,256)},
      provenance:{task_id:clean(row.id,128),event_id:event},decision};
    if(routeOptions) story.actions=[{id:'answer',label:'Answer in Firstmate',handler:'answer_firstmate_decision',choice:true,args:{task_id:row.id,hold_identity:identity}}];
    stories.push({story,routeOptions});
    const category=options.task_categories?.[row.id]??(['credential','hands_on'].includes(row.kind)?row.kind:null);
    if(['credential','hands_on'].includes(category)) stories.push({story:{...base(home,category,event,date),kind:category,
      title:clean(row.title||`Hands-on step: ${row.id}`,200),summary:'Captain action is required for this Firstmate hold. Inspect the hold in Firstmate; no secret value is copied to this card.',
      severity:'warning',outcome:'pending',group_key:`decision:${row.id}`,subject:{type:'task',key:clean(row.id,256)},
      provenance:{task_id:clean(row.id,128),event_id:event}}});
  }
  return {stories,current};
}

async function reportStories(home,rows) {
  const stories=[];
  for(const row of rows) {
    if(row?.state!=='done'||!row?.structured) continue;
    const suggested=row.report_path?path.resolve(home,row.report_path):path.join(home,'data',row.id,'report.md');
    if(!suggested.startsWith(path.join(home,'data')+path.sep)) continue;
    let stat;
    try { stat=await fs.stat(suggested); }
    catch(error) { if(error.code==='ENOENT') continue; throw error; }
    if(!stat.isFile()) continue;
    const identity=`${row.id}:${suggested}:${row.completion?.date??''}`;
    const date=atDate(row.completion?.date)??stat.mtime.toISOString();
    stories.push({...base(home,'report',identity,date),kind:'report',title:clean(row.title||`Finished report: ${row.id}`,200),
      summary:'Firstmate finished this report. The report can be added to the reading list.',outcome:'succeeded',
      group_key:`report:${row.id}`,subject:{type:'task',key:clean(row.id,256)},
      provenance:{task_id:clean(row.id,128),event_id:identity},
      links:[{id:'report',label:'Finished report',path:suggested}],
      actions:[{id:'read_later',label:'Add to reading list',handler:'add_to_reading_list',args:{link:'report'}}]});
  }
  return stories;
}

async function projectNames(home) {
  const body=await fs.readFile(path.join(home,'data','projects.md'),'utf8');
  return [...new Set(body.split('\n').map(line=>/^- ([A-Za-z0-9][A-Za-z0-9._-]*)\s/.exec(line)?.[1]).filter(Boolean))].sort();
}

function projectChanges(home,oldState,names,now) {
  const previous=new Set(oldState.projects??[]),current=new Set(names),generations={...oldState.project_generations},events=[];
  if(oldState.projects!==null) {
    for(const name of names) if(!previous.has(name)) {
      const generation=(generations[name]??0)+1;generations[name]=generation;
      events.push({...base(home,'project',`${name}:added:${generation}`,now),kind:'project',title:`Project onboarded: ${name}`,
        summary:`${name} was added to the Firstmate project registry.`,group_key:`project:${name}`,subject:{type:'project',key:name},
        provenance:{event_id:`project:${name}:added:${generation}`}});
    }
    for(const name of previous) if(!current.has(name)) {
      const generation=(generations[name]??0)+1;generations[name]=generation;
      events.push({...base(home,'project',`${name}:removed:${generation}`,now),kind:'project',title:`Project offboarded: ${name}`,
        summary:`${name} was removed from the Firstmate project registry.`,group_key:`project:${name}`,subject:{type:'project',key:name},
        provenance:{event_id:`project:${name}:removed:${generation}`}});
    }
  }
  return {events,generations};
}

async function observeDeliveries(home,root) {
  const dir=path.join(integrationDir(root,home),'deliveries');
  let names=[];
  try { names=await fs.readdir(dir); }
  catch(error) { if(error.code==='ENOENT') return []; throw error; }
  const stories=[];
  for(const name of names.filter(name=>/^[0-9a-f]{32}\.json$/.test(name))) {
    let delivery=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
    if(!delivery.record&&['sending','uncertain','queued_unobserved'].includes(delivery.status)) {
      const record=await findNewRecord(home,delivery.task_id,new Set(),delivery.text,delivery.delivery_id,delivery.before_max??0);
      if(record) {
        delivery={...delivery,status:'queued',record};
        await writeJson(dir,name,delivery);
      }
    }
    if(!delivery.record) continue;
    if(delivery.status==='queued') {
      const handled=path.join(home,'state',`${delivery.task_id}.inbox`,'handled',delivery.record);
      let stat;
      try { stat=await fs.stat(handled); }
      catch(error) { if(error.code==='ENOENT') continue; throw error; }
      delivery={...delivery,status:'acknowledged',acknowledged_at:stat.mtime.toISOString()};
      await writeJson(dir,name,delivery);
    }
    if(delivery.status!=='acknowledged'||!delivery.acknowledged_at) continue;
    stories.push({...base(home,'prompt_ack',delivery.token,delivery.acknowledged_at),kind:'agent',
      title:`Prompt acknowledged by ${delivery.task_id}`,summary:`Firstmate task ${delivery.task_id} handled steering inbox record ${delivery.record}.`,
      outcome:'succeeded',group_key:`prompt:${delivery.task_id}`,subject:{type:'task',key:delivery.task_id},
      provenance:{task_id:delivery.task_id,event_id:`prompt_ack:${delivery.token}`}});
  }
  return stories;
}

export async function sync(root,options) {
  const home=configuredHome(options),dir=integrationDir(root,home),lock=path.join(dir,'.sync.lock');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  try { await fs.mkdir(lock,{mode:0o700}); }
  catch(error) { if(error.code==='EEXIST') throw new Error('Firstmate sync is already running'); throw error; }
  try {
    let state={v:1,projects:null,project_generations:{},holds:{},pending_events:[]};
    try { state={...state,...JSON.parse(await fs.readFile(path.join(dir,'sync.json'),'utf8'))}; }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    const rows=await backlog(home),names=await projectNames(home),now=new Date().toISOString();
    const holds=await holdStories(home,root,options,rows);
    const projects=projectChanges(home,state,names,now);
    const byId=new Map(rows.map(row=>[row.id,row]));
    const resolutions=[];
    for(const [task,prior] of Object.entries(state.holds??{})) {
      if(holds.current[task]?.identity===prior.identity) continue;
      const row=byId.get(task);
      if(!row||isHold(row)) continue;
      const identity=`${task}:${prior.identity}`,mode=row.state==='done'?'completed':'released';
      resolutions.push({...base(home,'hold_resolution',identity,now),kind:'decision',
        title:`Captain hold ${mode}: ${task}`,summary:`Firstmate records the captain hold on ${task} as ${mode}.`,
        outcome:'succeeded',group_key:`decision:${task}`,subject:{type:'task',key:task},
        provenance:{task_id:task,event_id:identity},decision:{question_id:`resolution_${sha(identity).slice(0,16)}`,prompt:`The captain hold on ${task} is ${mode}.`,options:[]}});
    }
    const pending=[...(state.pending_events??[]),...projects.events,...resolutions];
    await writeJson(dir,'sync.json',{v:1,projects:names,project_generations:projects.generations,holds:holds.current,pending_events:pending});
    const stories=[...pending,...await mergeStories(home),...await branchStories(home),...holds.stories.map(entry=>entry.story),...await reportStories(home,rows),...await observeDeliveries(home,root)];
    let posted=0;
    for(const story of stories) if(await publish(root,story)) posted++;
    for(const {story,routeOptions} of holds.stories) {
      if(!routeOptions) continue;
      const actual=await stored(root,story.id);
      if(JSON.stringify(actual.story.decision.options)!==JSON.stringify(story.decision.options)) continue;
      const route={v:1,story_hash:await storyHash(root,story.id),task_id:story.provenance.task_id,
        hold_identity:story.actions[0].args.hold_identity,options:routeOptions};
      await writeJson(path.join(dir,'routes'),`${story.id}.json`,route);
    }
    await writeJson(dir,'sync.json',{v:1,projects:names,project_generations:projects.generations,holds:holds.current,pending_events:[]});
    return {home,stories:stories.length,posted};
  } finally { await fs.rmdir(lock); }
}
