// Filing a card (done, undo, read, unread, snooze, delete) shows on the next frame: the pane changes its
// own copy first and the CLI write runs after. These tests drive the pane with the stand-in kit and a
// CLI whose answers they hold back, so each one sees the card before any write has landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { cx, host, walk, call } from './fake-kit.mjs';
import { post, readState } from '../mods/trough/core/store.js';

const { default: Trough } = await import('../mods/trough/main.js');

const source={id:'builder_0001',label:'Builder'};
const story=id=>({v:1,id,source,occurred_at:'2026-11-14T11:20:00.000Z',severity:'info',kind:'agent',title:`Story ${id}`,summary:'Ready.'});
const row=(id,state={v:1})=>({story:story(id),story_hash:`hash-${id}`,received_at:'2026-11-14T11:20:00.000Z',state,offers:[],badges:[]});
const A='a'.repeat(32),B='b'.repeat(32);

// The CLI as the pane calls it: each call waits until the test answers it.
function heldCli() {
  const calls=[];
  host.exec=(_command,args)=>new Promise(resolve=>calls.push({args:args.slice(5),resolve}));
  const answer=(i,value)=>calls[i].resolve({code:0,stdout:JSON.stringify(value),stderr:''});
  const refuse=(i,why)=>calls[i].resolve({code:1,stdout:'',stderr:`trough: ${why}`});
  return {calls,answer,refuse,args:()=>calls.map(c=>c.args)};
}
// A context that runs spawned work, the way Herdr does after the current frame.
function liveCx() {
  const work=[];
  const live={...cx,notified:0,notify(){ live.notified++; },spawn(fn){ work.push(Promise.resolve().then(()=>fn(live))); }};
  // Lets every spawned task run as far as it can without a CLI answer.
  live.idle=async()=>{ for(let i=0;i<20;i++) await new Promise(resolve=>setImmediate(resolve)); };
  return live;
}
function pane(rows) {
  const view=new Trough();
  view.init({},cx);
  view.rows=rows; view.alignSelection();
  return view;
}
const shown=view=>view.cardList().map(entry=>entry.row.story.id);
const stateOf=(view,id)=>view.rows.find(r=>r.story.id===id).state;

test('d marks the card done on the next frame, with one write and no reload',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A;
  view.keys({key:'d'},live);
  // Before any write has run: the card is done and has left the Inbox, and the pane asked to repaint.
  assert.ok(stateOf(view,A).done_at);
  assert.equal(stateOf(view,A).read_at,stateOf(view,A).done_at);
  assert.deepEqual(shown(view),[B]);
  assert.equal(live.notified,1);
  await live.idle();
  assert.deepEqual(cli.args(),[['done',A]]);
  cli.answer(0,{v:1,read_at:'2026-11-19T10:00:00.000Z',done_at:'2026-11-19T10:00:00.000Z'});
  await live.idle();
  // The card takes the state the store reports, and nothing re-reads the store.
  assert.equal(stateOf(view,A).done_at,'2026-11-19T10:00:00.000Z');
  assert.deepEqual(cli.args(),[['done',A]]);
  assert.equal(view.error,null);
});

test('the done button changes the card at once, the same as d',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A; view.filter.inbox=false;
  const button=[...walk(view.render(live))].find(node=>call(node,'id')?.[0]===`done-${A}`);
  call(button,'on_click')[0]({},live);
  assert.ok(stateOf(view,A).done_at);
  await live.idle();
  assert.deepEqual(cli.args(),[['done',A]]);
});

test('a write that fails puts the card back and says why',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A;
  view.keys({key:'d'},live);
  assert.deepEqual(shown(view),[B]);
  await live.idle();
  cli.refuse(0,'operator state is busy');
  await live.idle();
  assert.deepEqual(stateOf(view,A),{v:1});
  assert.deepEqual(shown(view),[A,B]);
  assert.equal(view.error,'Could not mark it done: operator state is busy');
  // Trying again keeps the story's error until that write lands.
  view.sel=A; view.keys({key:'d'},live);
  await live.idle();
  assert.equal(view.error,'Could not mark it done: operator state is busy');
  cli.answer(1,{v:1,read_at:'2026-11-19T10:00:00.000Z',done_at:'2026-11-19T10:00:00.000Z'});
  await live.idle();
  assert.equal(view.error,null);
  assert.deepEqual(shown(view),[B]);
});

test("one story's writes run in order, and the card ends on the last one",async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A; view.filter.inbox=false; view.filter.all=true;
  view.keys({key:'d'},live);
  view.keys({key:'d'},live);
  assert.equal(stateOf(view,A).done_at,undefined);
  await live.idle();
  // The undo waits for the done to land, so the store sees them in the order they were pressed.
  assert.deepEqual(cli.args(),[['done',A]]);
  cli.answer(0,{v:1,read_at:'2026-11-19T10:00:00.000Z',done_at:'2026-11-19T10:00:00.000Z'});
  await live.idle();
  assert.equal(stateOf(view,A).done_at,undefined,'the first answer does not flash the card back to done');
  assert.deepEqual(cli.args(),[['done',A],['undo',A]]);
  cli.answer(1,{v:1,read_at:'2026-11-19T10:00:00.000Z'});
  await live.idle();
  assert.deepEqual(stateOf(view,A),{v:1,read_at:'2026-11-19T10:00:00.000Z'});
});

test('a reload that read the store before the write does not undo the card',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  const feed=rows=>({rows,receipts:[],rejected:0,packs:[],allowed:[]});
  view.sel=A;
  view.reload(live);
  view.keys({key:'d'},live);
  await live.idle();
  assert.deepEqual(cli.args(),[['feed'],['done',A]]);
  cli.answer(1,{v:1,read_at:'2026-11-19T10:00:00.000Z',done_at:'2026-11-19T10:00:00.000Z'});
  await live.idle();
  cli.answer(0,feed([row(A),row(B)]));
  await live.idle();
  assert.equal(stateOf(view,A).done_at,'2026-11-19T10:00:00.000Z');
  assert.deepEqual(shown(view),[B]);
  // A reload asked for during that read runs once it ends, and a fresh read is taken as it is.
  view.reload(live); view.reload(live);
  await live.idle();
  assert.deepEqual(cli.args().slice(2),[['feed']]);
  cli.answer(2,feed([row(A,{v:1,read_at:'2026-11-19T11:00:00.000Z'}),row(B)]));
  await live.idle();
  assert.deepEqual(cli.args().slice(2),[['feed'],['feed']]);
  cli.answer(3,feed([row(A,{v:1,read_at:'2026-11-19T11:00:00.000Z'}),row(B)]));
  await live.idle();
  assert.deepEqual(stateOf(view,A),{v:1,read_at:'2026-11-19T11:00:00.000Z'});
});

test('snooze, read and unread change the card at once',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A; view.filter.inbox=false;
  view.keys({key:'r'},live);
  assert.ok(stateOf(view,A).read_at);
  view.keys({key:'r'},live);
  assert.equal(stateOf(view,A).read_at,undefined);
  view.keys({key:'z'},live);
  assert.ok(Date.parse(stateOf(view,A).snoozed_until)>Date.now());
  assert.deepEqual(shown(view),[B],'a snoozed story leaves the active view at once');
  await live.idle();
  assert.deepEqual(cli.args(),[['read',A]]);
});

test('a deleted card goes at once and comes back if the delete fails',async()=>{
  const cli=heldCli(),live=liveCx(),view=pane([row(A),row(B)]);
  view.sel=A;
  view.keys({key:'shift-d'},live);
  view.deleteSelected(live);
  assert.deepEqual(shown(view),[B]);
  assert.equal(view.sel,B);
  await live.idle();
  assert.deepEqual(cli.args(),[['delete',A]]);
  cli.refuse(0,'effects are still in flight');
  await live.idle();
  assert.deepEqual(shown(view),[A,B]);
  assert.equal(view.error,'Could not delete the story: effects are still in flight');
  view.sel=B; view.keys({key:'shift-d'},live); view.deleteSelected(live);
  await live.idle();
  cli.answer(1,{deleted:B});
  await live.idle();
  assert.deepEqual(view.rows.map(r=>r.story.id),[A]);
});

test('through the real CLI, done is written to the store and the card keeps it',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-filing-')),cliPath=path.resolve('mods/trough/bin/trough');
  const id=crypto.randomBytes(16).toString('hex');
  await post(dir,Buffer.from(JSON.stringify(story(id))+'\n'));
  host.props={dir};
  const calls=[];
  host.exec=(_command,args)=>new Promise(resolve=>{
    calls.push(args.slice(5));
    execFile(process.execPath,[cliPath,...args.slice(1)],(error,stdout,stderr)=>resolve({code:error?error.code??1:0,stdout,stderr}));
  });
  const live=liveCx(),view=pane([]);
  try {
    await view.reload(live);
    assert.deepEqual(shown(view),[id]);
    view.keys({key:'d'},live);
    assert.deepEqual(shown(view),[]);
    for(let i=0;i<100&&view.writes.size;i++) await new Promise(resolve=>setTimeout(resolve,20));
    const stored=await readState(dir,id);
    assert.ok(stored.done_at);
    assert.deepEqual(stateOf(view,id),{...stored,v:1});
    assert.deepEqual(calls,[['feed'],['done',id]]);
    assert.equal(view.error,null);
  } finally { host.props={}; await fs.rm(dir,{recursive:true,force:true}); }
});

test('feed gives the pane, in one process, what the five separate lists give',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-feed-')),cliPath=path.resolve('mods/trough/bin/trough');
  const run=(...args)=>new Promise((resolve,reject)=>execFile(process.execPath,[cliPath,'--dir',dir,...args],(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))));
  try {
    for(const id of [A,B]) await post(dir,Buffer.from(JSON.stringify(story(id))+'\n'));
    await fs.mkdir(path.join(dir,'inbox'),{recursive:true});
    await fs.writeFile(path.join(dir,'inbox','bad.json'),'{');
    const feed=await run('feed');
    assert.deepEqual(feed,{rows:await run('ls','--all','--json'),receipts:await run('receipts'),rejected:(await run('rejections')).length,
      packs:await run('packages','list','--json'),allowed:await run('allow','list','--json')});
    assert.equal(feed.rows.length,2);
    assert.equal(feed.rejected,1);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
