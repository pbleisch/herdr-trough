import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { post, list } from '../mods/trough/core/store.js';
import { review, runReviewed, annotate } from '../mods/trough/core/actions.js';

// Firstmate and the stand-in Firstmate commands under fixtures/ are shell programs.
const test=process.platform==='win32'?name=>nodeTest(name,{skip:'Firstmate runs on POSIX systems only'},()=>{}):nodeTest;

process.env.HERDR_APP_HOME=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));
import { sync } from '../packages/firstmate/sync.js';

const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const packagePath=path.join(project,'packages','firstmate','index.js');
const fixtures=path.join(project,'test','fixtures','firstmate','bin');
const holdId='ship-gated';
const holdIdentity='2026-11-11T17:00:00Z#0';
const options={task_categories:{[holdId]:'hands_on'},decisions:{[holdId]:{options:[
  {id:'proceed',label:'Proceed',answer_text:'Proceed with launch',mode:'release'},
  {id:'stop',label:'Stop',answer_text:'Stop the launch',mode:'done'}
]}}};

async function setup() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-firstmate-'));
  const home=path.join(dir,'firstmate'),root=path.join(dir,'trough');
  await fs.mkdir(path.join(home,'bin'),{recursive:true});
  await fs.mkdir(path.join(home,'state'));
  await fs.mkdir(path.join(home,'data'));
  for(const name of await fs.readdir(fixtures)) await fs.copyFile(path.join(fixtures,name),path.join(home,'bin',name));
  await fs.writeFile(path.join(home,'data','projects.md'),'# Projects\n- alpha [local-only] - Alpha\n- beta [local-only] - Beta\n');
  await fs.writeFile(path.join(home,'fixture-state'),'state: working · source: pane · busy\n');
  await fs.writeFile(path.join(home,'state','crew.meta'),'endpoint_task_id=crew\nspawn_gen=s1\nbackend=hc\nkind=ship\n');
  await fs.writeFile(path.join(home,'state','mate.meta'),'endpoint_task_id=mate\nspawn_gen=s2\nbackend=hc\nkind=secondmate\n');
  await fs.writeFile(path.join(home,'state',`${holdId}.hold`),holdIdentity+'\n');
  const snapshot={backlog:{records:[
    {id:holdId,structured:true,state:'queued',kind:'ship',title:'Approve the launch',hold_kind:'captain',hold_reason:'Choose the launch outcome.',hold_set:'2026-11-11T17:00:00Z'},
    {id:'report-one',structured:true,state:'done',kind:'scout',title:'Finished analysis',hold_kind:null,completion:{date:'2026-11-11'},report_path:'data/report-one/report.md'},
    {id:'merge-one',structured:true,state:'done',kind:'ship',title:'Improve merge handling'},
    {id:'child-one',structured:true,state:'done',kind:'ship',title:'Ship child changes'}
  ]}};
  await fs.writeFile(path.join(home,'fixture-snapshot.json'),JSON.stringify(snapshot));
  await fs.mkdir(path.join(home,'data','report-one'));
  await fs.writeFile(path.join(home,'data','report-one','report.md'),'# Result\n');
  await fs.writeFile(path.join(home,'state','branch-outcomes.jsonl'),
    [
      {seq:1,epoch:1794416400,task:'crew',verdict:'captain',summary:'A choice needs review. The first outcome explains why.',silent:false},
      {seq:2,epoch:1794416500,task:'crew',verdict:'routine',summary:'Nothing to do.',silent:true},
      {seq:3,epoch:1794416550,task:'crew',verdict:'captain',summary:'The deployment needs approval. New facts arrived.',silent:false},
      {seq:4,epoch:1794416570,task:'merge-one',verdict:'captain',summary:'The pull request merged.',silent:false},
      {seq:5,epoch:1794416580,task:holdId,verdict:'captain',summary:'Choose the launch outcome.',silent:false}
    ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await fs.writeFile(path.join(home,'state','fleet-ledger.jsonl'),JSON.stringify({v:1,ts:1794416600,event:'task.merged',task:'merge-one',via:'pr',pr:'https://github.com/example/repo/pull/7'})+'\n');
  await fs.writeFile(path.join(home,'state','merge-one.pr-poll-merge-notified'),'fm-pr-poll-merge-notified-v1\ngithub\ngithub.com\nexample/repo\n7\n');
  const closed=path.join(home,'state','secondmate-prs','closed','mate-pr-repo-8-1794416700');
  await fs.mkdir(closed,{recursive:true});
  await fs.writeFile(path.join(closed,'mate-pr-repo-8.meta'),
    'secondmate=mate\npr=https://git.example.com/example/repo/pulls/8\npr_title=Improve encoder checks\npr_head=abc123\nauthority=grant\noutcome=merged\nclosed_at=1794416700\n');
  await fs.writeFile(path.join(home,'state','mate.status'),
    'done [key=merged-child-one] [at=1794416800]: merged child-one https://git.example.com/example/repo/pulls/9\n');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'handlers.json'),JSON.stringify({v:1,packages:[{path:packagePath,options:{home,...options}}]}));
  return {home,root,dir,packageOptions:{home,...options}};
}

test('backfill publishes plain merge and branch stories once, groups outcomes, and observes registry changes',async()=>{
  const {home,root,packageOptions}=await setup();
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  const first=await list(root);
  assert.equal(first.filter(row=>row.story.kind==='merge').length,3);
  assert.ok(first.some(row=>row.story.kind==='merge'&&row.story.summary.includes('standing grant')));
  assert.equal(first.filter(row=>row.story.kind==='agent').length,1);
  assert.equal(first.find(row=>row.story.kind==='agent').story.title,'The deployment needs approval.');
  assert.equal(first.find(row=>row.story.kind==='agent').story.group_key,'branch:crew');
  assert.equal(first.find(row=>row.story.kind==='agent').story.severity,'notice');
  assert.ok(first.filter(row=>row.story.kind==='merge').every(row=>row.story.severity==='info'));
  assert.ok(first.some(row=>row.story.title==='Merged Improve encoder checks in example/repo #8'));
  assert.ok(first.some(row=>row.story.title==='Merged Improve merge handling in example/repo #7'));
  assert.equal(first.filter(row=>row.story.kind==='report').length,1);
  assert.equal(first.filter(row=>row.story.kind==='hands_on').length,1);
  const decision=first.find(row=>row.story.kind==='decision');
  assert.equal(decision.story.decision.options.length,2);
  assert.equal(decision.story.severity,'notice');
  assert.equal(first.find(row=>row.story.kind==='hands_on').story.severity,'notice');
  assert.equal(first.filter(row=>row.story.kind==='project').length,0);
  await sync(root,packageOptions);
  assert.equal((await list(root)).length,first.length);
  await fs.writeFile(path.join(home,'data','projects.md'),'# Projects\n- beta [local-only] - Beta\n- gamma [local-only] - Gamma\n');
  await sync(root,packageOptions);
  const changed=await list(root);
  assert.deepEqual(changed.filter(row=>row.story.kind==='project').map(row=>row.story.title).sort(),
    ['Project offboarded: alpha','Project onboarded: gamma']);
  const sheet=await review(root,decision.story.id,'answer',{option:'proceed'});
  assert.match(sheet.plan.effects.join(' '),/Release the held work item/);
  assert.equal((await runReviewed(root,sheet.token)).outcome,'succeeded');
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(home,'answers.log'),'utf8')).trim()),
    {task:holdId,words:'Proceed with launch',mode:'release'});
  await sync(root,packageOptions);
  const closed=await list(root);
  assert.equal(closed.length,changed.length);
  assert.equal(closed.find(row=>row.story.id===decision.story.id).state.done_by,'firstmate-sync');
  assert.ok(closed.find(row=>row.story.id===decision.story.id).state.done_at);
  assert.ok(closed.find(row=>row.story.id===decision.story.id).state.read_at);
  assert.ok(!closed.some(row=>row.story.title.startsWith('Captain hold released:')));
});

test('Firstmate branch outcomes use structured results before text and classify unstructured summaries',async()=>{
  const {home,root,packageOptions}=await setup();
  const cases=[
    ['landing','Composable features landing. The change is complete.','info'],
    ['auto','Ready and auto-landing after checks.',null],
    ['approval','The deployment needs approval.','notice'],
    ['review','Pull request ready for review.','notice'],
    ['blocked','Work is blocked on a failed check.','warning'],
    ['missed','The check missed its target.','warning'],
    ['structured-done','This needs approval.', 'info',{status_verb:'done'}],
    ['structured-failed','The feature landed.', 'warning',{status_verb:'failed'}],
    ['structured-decision','The feature landed.', 'notice',{outcome_kind:'decision'}],
    ['structured-paused','The feature landed.', null,{status_verb:'paused'}],
    ['structured-closed','Approval needed.', null,{outcome_kind:'decision',hold_state:'closed'}],
    ['progress','Still working on landing. No action needed.',null],
    ['vague','Here is an update on the work.',null],
    ['build','Waiting on a build; no action needed.',null],
    ['owner-wait','Waiting for the owner to provide a credential.','notice'],
    ['structured-hold-open','Checks passed.', 'notice',{hold_state:'open',status_verb:'paused'}],
    ['structured-blocked','Work finished.', 'warning',{status_verb:'blocked'}]
  ];
  await fs.writeFile(path.join(home,'state','branch-outcomes.jsonl'),cases.map(([task,summary,,extra],index)=>
    JSON.stringify({seq:index+10,epoch:1794416900+index,task,verdict:'captain',summary,silent:false,...extra})).join('\n')+'\n');
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  const stories=(await list(root)).filter(row=>row.story.kind==='agent');
  assert.equal(stories.length,cases.filter(([, ,severity])=>severity).length);
  for(const [task,,severity] of cases) assert.equal(stories.find(row=>row.story.subject.key===task)?.story.severity, severity??undefined,task);
});

test('Firstmate failed and refused merges are warnings',async()=>{
  const {home,root,packageOptions}=await setup();
  for(const [index,outcome] of ['failed','refused'].entries()) {
    const folder=path.join(home,'state','secondmate-prs','closed',`bad-${index}-1794416900`);
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,`bad-${index}.meta`),
      `secondmate=bad-${index}\npr=https://github.com/example/repo/pull/${20+index}\noutcome=${outcome}\nclosed_at=1794416900\n`);
  }
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  const failures=(await list(root)).filter(row=>row.story.kind==='merge'&&row.story.outcome==='failed');
  assert.equal(failures.length,2);
  assert.ok(failures.every(row=>row.story.severity==='warning'));
});

test('external hold closure quietly completes and reads the existing decision without answering',async()=>{
  const {home,root,packageOptions}=await setup();
  await sync(root,packageOptions);
  const decision=(await list(root)).find(entry=>entry.story.kind==='decision');
  const oldResolution={...decision.story,id:'3'.repeat(32),title:`Captain hold completed: ${holdId}`,
    summary:'Firstmate records the captain hold as completed.',outcome:'succeeded',actions:undefined,
    decision:{question_id:'resolution_legacy',prompt:'The hold is completed.',options:[]}};
  await post(root,Buffer.from(JSON.stringify(oldResolution)+'\n'));
  const before=await list(root);
  const snapshot=JSON.parse(await fs.readFile(path.join(home,'fixture-snapshot.json'),'utf8'));
  const held=snapshot.backlog.records.find(row=>row.id===holdId);
  held.hold_kind=null;
  held.state='done';
  await fs.writeFile(path.join(home,'fixture-snapshot.json'),JSON.stringify(snapshot));
  await fs.rename(path.join(home,'state',`${holdId}.hold`),path.join(home,'state',`${holdId}.closed`));
  await sync(root,packageOptions);
  const after=await list(root),closed=after.find(entry=>entry.story.id===decision.story.id);
  assert.equal(after.length,before.length);
  assert.ok(closed.state.done_at);
  assert.equal(closed.state.read_at,closed.state.done_at);
  assert.equal(closed.state.done_by,'firstmate-sync');
  assert.equal(after.find(entry=>entry.story.id===oldResolution.id).state.done_by,'firstmate-sync');
  assert.ok(after.find(entry=>entry.story.id===oldResolution.id).state.read_at);
  await assert.rejects(fs.access(path.join(home,'answers.log')));
  await sync(root,packageOptions);
  assert.deepEqual((await list(root)).find(entry=>entry.story.id===decision.story.id).state,closed.state);
});

test('branch outcomes repeat neither PR merges nor previously posted landings',async()=>{
  const {home,root,packageOptions}=await setup();
  await fs.appendFile(path.join(home,'state','branch-outcomes.jsonl'),[
    {seq:6,epoch:1794416900,task:'other-task',verdict:'captain',status_verb:'done',summary:'Merged independently.',pr_url:'https://github.com/example/repo/pull/7/?view=files'},
    {seq:7,epoch:1794416901,task:'landing-task',verdict:'captain',status_verb:'done',summary:'Local landing completed.'}
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  let agents=(await list(root)).filter(entry=>entry.story.kind==='agent');
  assert.ok(!agents.some(entry=>entry.story.subject.key==='other-task'));
  assert.equal(agents.find(entry=>entry.story.subject.key==='landing-task').story.severity,'info');
  await fs.appendFile(path.join(home,'state','branch-outcomes.jsonl'),
    JSON.stringify({seq:8,epoch:1794416902,task:'landing-task',verdict:'captain',summary:'The local branch was landed.',silent:false})+'\n');
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  agents=(await list(root)).filter(entry=>entry.story.kind==='agent');
  assert.equal(agents.filter(entry=>entry.story.subject.key==='landing-task').length,1);
});

test('later progress does not hide a warning waiting in the same branch outcome batch',async()=>{
  const {home,root,packageOptions}=await setup();
  await fs.appendFile(path.join(home,'state','branch-outcomes.jsonl'),[
    {seq:6,epoch:1794416900,task:'broken-task',verdict:'captain',status_verb:'failed',summary:'The merge failed.'},
    {seq:7,epoch:1794416901,task:'broken-task',verdict:'captain',status_verb:'working',summary:'Still working on the fix.'}
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  const story=(await list(root)).find(entry=>entry.story.subject?.key==='broken-task');
  assert.equal(story.story.severity,'warning');
});

test('story kind switches and minimum severity filter published stories',async()=>{
  const {home,root,packageOptions}=await setup();
  await fs.appendFile(path.join(home,'state','branch-outcomes.jsonl'),[
    {seq:6,epoch:1794416900,task:'warning-task',verdict:'captain',status_verb:'blocked',summary:'Still working.'},
    {seq:7,epoch:1794416901,task:'done-task',verdict:'captain',status_verb:'done',summary:'Work finished.'}
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const configured={...packageOptions,story_kinds:{decision:{enabled:false},hands_on:{enabled:false},merge:{min_severity:'warning'},
    agent:{min_severity:'warning'},report:{enabled:false},project:{enabled:false}}};
  await sync(root,configured,{backfillSince:'2026-11-01'});
  const stories=(await list(root)).map(entry=>entry.story);
  assert.deepEqual(stories.map(story=>story.kind),['agent']);
  assert.equal(stories[0].subject.key,'warning-task');
  assert.equal(stories[0].severity,'warning');
  await assert.rejects(sync(root,{...packageOptions,story_kinds:{agent:{min_severity:'severe'}}}),/invalid Firstmate story_kinds rule/);
  await assert.rejects(sync(root,{...packageOptions,story_kinds:{unknown:{enabled:true}}}),/invalid Firstmate story_kinds rule/);
});

test('first sync baselines historical records and later sync publishes only new records',async()=>{
  const {home,root,packageOptions}=await setup();
  await sync(root,packageOptions);
  const initial=await list(root);
  assert.deepEqual(initial.map(row=>row.story.kind).sort(),['decision','hands_on']);
  const state=JSON.parse(await fs.readFile(path.join(root,'integrations','firstmate',
    (await fs.readdir(path.join(root,'integrations','firstmate')))[0],'sync.json'),'utf8'));
  assert.ok(Date.parse(state.baseline_at)>0);
  assert.equal(state.baseline_ids.length,5);
  const after=Math.floor(Date.parse(state.baseline_at)/1000);
  await fs.appendFile(path.join(home,'state','branch-outcomes.jsonl'),
    JSON.stringify({seq:6,epoch:after,task:'new-crew',verdict:'captain',summary:'The release needs a manual check. Inspect the logs.',silent:false})+'\n');
  await fs.appendFile(path.join(home,'state','fleet-ledger.jsonl'),
    JSON.stringify({v:1,ts:after,event:'task.merged',task:'new-merge',via:'pr',pr:'https://github.com/example/repo/pull/10',title:'Fix queue ordering'})+'\n');
  await sync(root,packageOptions);
  const later=await list(root);
  assert.equal(later.filter(row=>row.story.kind==='merge').length,1);
  assert.equal(later.filter(row=>row.story.kind==='agent').length,1);
  assert.ok(later.some(row=>row.story.title==='The release needs a manual check.'));
  assert.ok(later.some(row=>row.story.title==='Merged Fix queue ordering in example/repo #10'));
  assert.equal(later.filter(row=>row.story.kind==='report').length,0);
  await sync(root,packageOptions);
  assert.equal((await list(root)).length,later.length);
  await sync(root,packageOptions,{backfillSince:'2026-11-01'});
  const backfilled=await list(root);
  assert.equal(backfilled.filter(row=>row.story.kind==='merge').length,4);
  assert.equal(backfilled.filter(row=>row.story.kind==='agent').length,2);
  assert.equal(backfilled.filter(row=>row.story.kind==='report').length,1);
});

test('prompt delivery uses the exact task generation and durable inbox, then observes acknowledgement',async()=>{
  const {home,root,packageOptions}=await setup();
  const story={v:1,id:'b'.repeat(32),source:{id:'example',label:'Example'},kind:'agent',title:'Ask crew to inspect',summary:'A follow-up',
    occurred_at:'2026-11-11T18:00:00Z',severity:'notice',actions:[{id:'steer',label:'Send to crew',handler:'deliver_prompt',
      args:{task_id:'crew',spawn_gen:'s1',text:'Inspect the result and report back.'}}]};
  await post(root,Buffer.from(JSON.stringify(story)+'\n'));
  const sheet=await review(root,story.id,'steer');
  assert.match(sheet.plan.effects.join(' '),/Inspect the result and report back/);
  const receipt=await runReviewed(root,sheet.token);
  assert.equal(receipt.outcome,'succeeded');
  assert.match(receipt.result,/acknowledgement pending/);
  assert.equal((await fs.readFile(path.join(home,'send.log'),'utf8')).trim(),'crew');
  const record=path.join(home,'state','crew.inbox','1.msg');
  assert.match(await fs.readFile(record,'utf8'),/Inspect the result and report back/);
  await fs.rename(record,path.join(home,'state','crew.inbox','handled','1.msg'));
  await sync(root,packageOptions);
  assert.ok(!(await list(root)).some(row=>row.story.title==='Prompt acknowledged by crew'));
  await sync(root,{...packageOptions,story_kinds:{prompt_ack:{enabled:true}}});
  assert.ok((await list(root)).some(row=>row.story.title==='Prompt acknowledged by crew'));
});

test('prompt handler refuses typed text, stale generations and nonworking tasks',async()=>{
  const {home,root}=await setup();
  const base={v:1,source:{id:'example',label:'Example'},kind:'agent',title:'Steer',summary:'Follow up',occurred_at:'2026-11-11T18:00:00Z',severity:'notice'};
  for(const [id,text] of [['c'.repeat(32),'/help'],['d'.repeat(32),'$skill']]) {
    await post(root,Buffer.from(JSON.stringify({...base,id,actions:[{id:'steer',label:'Steer',handler:'deliver_prompt',args:{task_id:'crew',spawn_gen:'s1',text}}]})+'\n'));
    await assert.rejects(review(root,id,'steer'),/typed delivery/);
  }
  const id='e'.repeat(32);
  await post(root,Buffer.from(JSON.stringify({...base,id,actions:[{id:'steer',label:'Steer',handler:'deliver_prompt',args:{task_id:'crew',spawn_gen:'old',text:'Ordinary text'}}]})+'\n'));
  await assert.rejects(review(root,id,'steer'),/replaced/);
  await fs.writeFile(path.join(home,'fixture-state'),'state: parked · source: pane · native question\n');
  const another='f'.repeat(32);
  await post(root,Buffer.from(JSON.stringify({...base,id:another,actions:[{id:'steer',label:'Steer',handler:'deliver_prompt',args:{task_id:'crew',spawn_gen:'s1',text:'Ordinary text'}}]})+'\n'));
  await assert.rejects(review(root,another,'steer'),/unavailable/);
  await assert.rejects(fs.access(path.join(home,'send.log')));
});

test('secondmate prompt uses fire-and-forget without a reply expectation',async()=>{
  const {home,root}=await setup();
  const story={v:1,id:'1'.repeat(32),source:{id:'example',label:'Example'},kind:'agent',title:'Steer mate',summary:'Follow up',
    occurred_at:'2026-11-11T18:00:00Z',severity:'notice',actions:[{id:'steer',label:'Steer',handler:'deliver_prompt',
      args:{task_id:'mate',spawn_gen:'s2',text:'Check the merge.'}}]};
  await post(root,Buffer.from(JSON.stringify(story)+'\n'));
  const sheet=await review(root,story.id,'steer');
  assert.equal((await runReviewed(root,sheet.token)).outcome,'succeeded');
  assert.match((await fs.readFile(path.join(home,'send.log'),'utf8')).trim(),/^--fire-and-forget [0-9a-f]{16} mate$/);
});

test('reviewed prompt refuses a replacement generation before delivery',async()=>{
  const {home,root}=await setup();
  const story={v:1,id:'2'.repeat(32),source:{id:'example',label:'Example'},kind:'agent',title:'Steer crew',summary:'Follow up',
    occurred_at:'2026-11-11T18:00:00Z',severity:'notice',actions:[{id:'steer',label:'Steer',handler:'deliver_prompt',
      args:{task_id:'crew',spawn_gen:'s1',text:'Check the result.'}}]};
  await post(root,Buffer.from(JSON.stringify(story)+'\n'));
  const sheet=await review(root,story.id,'steer');
  await fs.writeFile(path.join(home,'state','crew.meta'),'endpoint_task_id=crew\nspawn_gen=s3\nbackend=hc\nkind=ship\n');
  await assert.rejects(runReviewed(root,sheet.token),/replaced/);
  await assert.rejects(fs.access(path.join(home,'send.log')));
});

test('trough-firstmate sync CLI reads the operator-listed home',async()=>{
  const {root}=await setup();
  const cli=path.join(project,'packages','firstmate','bin','trough-firstmate');
  const run=spawnSync(process.execPath,[cli,'sync','--dir',root,'--backfill','2026-11-01'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.ok(JSON.parse(run.stdout).posted>0);
  assert.ok((await list(root)).some(row=>row.story.kind==='report'));
  const invalid=spawnSync(process.execPath,[cli,'sync','--dir',root,'--backfill','2026-02-30'],{encoding:'utf8'});
  assert.equal(invalid.status,1);
  assert.match(invalid.stderr,/--backfill requires a valid date/);
});

test('report and pull request links carry roles, and packs offer the link actions',async()=>{
  const {root,home}=await setup();
  const config=JSON.parse(await fs.readFile(path.join(root,'handlers.json'),'utf8'));
  config.packages.push(path.join(project,'packages','reading-list','index.js'));
  await fs.writeFile(path.join(root,'handlers.json'),JSON.stringify(config));
  await sync(root,{home,...options},{backfillSince:'2026-11-01'});
  const rows=await annotate(root,await list(root)),report=rows.find(row=>row.story.kind==='report');
  assert.equal(report.story.actions,undefined);
  assert.equal(report.story.summary,'Firstmate finished this report.');
  assert.deepEqual(report.story.links,[{id:'report',label:'Finished report',path:path.join(home,'data','report-one','report.md'),role:'report',media_type:'text/markdown'}]);
  assert.deepEqual(report.offers.map(o=>o.id),['core.open.report','core.reveal.report','reading-list.add.report']);
  assert.ok(rows.filter(row=>row.story.kind==='merge'&&row.story.links).every(row=>row.story.links[0].role==='pr'));
});
