// Builds the pane's element tree in Node with the stand-in kit, which checks every builder call the
// way Herdr's kit does. `herdr-app check` renders the pane only once, before any story has loaded, so
// these tests are what draw the cards.
//
// TROUGH_RENDER_ROWS=<file> also renders every row of a `trough ls --all --json` dump in every state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cx, walk, call, text } from './fake-kit.mjs';

const { default: Trough } = await import('../mods/trough/main.js');

const builder={id:'builder_0001',label:'Builder',instance:'builder'};
const story=(id,extra={})=>({v:1,id,source:builder,occurred_at:'2026-11-14T11:20:00.000Z',severity:'info',kind:'agent',title:`Story ${id}`,summary:'Ready.',...extra});
const row=(s,extra={})=>({story:s,story_hash:`hash-${s.id}`,received_at:s.occurred_at,state:{},offers:[],badges:[],...extra});
const LONG='The card-feed build is ready on branch feature/card-feed, a local-only branch that fast-forwards onto main. '
  +'It passed its 87 tests and the mod check; the pane was not opened in a live window, so the screenshot is still to come. '
  +'See https://example.com/pulls/137 and /tmp/trough-report.md for the details, then merge when the checks are green.';

// The shapes in a real store: agent notes with long summaries in groups, merge outcomes with a
// link the core pack offers to open, decisions with and without options, and a report with a body,
// a picture, a declared action and a receipt.
const rows=[
  row(story('note',{title:'Branch outcome for agent-dev',summary:LONG,group_key:'branch:agent-dev',subject:{type:'task',key:'agent-dev'}})),
  row(story('note-earlier',{summary:LONG,group_key:'branch:agent-dev',subject:{type:'task',key:'agent-dev'}}),{state:{read_at:'2026-11-14T11:21:00.000Z'}}),
  row(story('merge',{kind:'merge',severity:'warning',outcome:'failed',summary:'PR checks failed on main.',group_key:'merge:agent-dev',subject:{type:'task',key:'agent-dev'},
    links:[{id:'change',label:'Pull request',url:'https://example.com/pulls/59',role:'pr'}]}),
    {offers:[{id:'core.open.change',pack:'core',label:'Open',handler:'open_url',args:{link:'change'},link:'change',available:true}],badges:[{label:'core'}]}),
  row(story('hold',{kind:'decision',severity:'notice',summary:LONG,decision:{question_id:'hold_1',prompt:`Your call. ${LONG}`,options:[]}})),
  row(story('ask',{kind:'decision',severity:'critical',summary:'Pick one.',decision:{question_id:'ask_1',prompt:'Ship it?',allow_comment:true,options:[{id:'yes',label:'Yes',answer_text:'Ship it.'},{id:'no',label:'No',answer_text:'Hold it.'}]},
    actions:[{id:'answer',label:'Answer',handler:'answer_decision'}]}),{action_status:{answer:{available:true}}}),
  row(story('report',{kind:'report',summary:LONG,body:'## Result\n\n- one\n- `two` <b>x</b>\n',image:'shot',
    links:[{id:'report',label:'Report',path:'/tmp/report.md',role:'report'},{id:'shot',label:'Screenshot',path:'/tmp/shot.png',role:'screenshot',media_type:'image/png'}],
    actions:[{id:'read_later',label:'Add to reading list',handler:'add_to_reading_list',args:{link:'report'}},{id:'mail',label:'Mail it',handler:'mail'}]}),
    {media:{link:'shot',src:'trough-media/x/abc.png',type:'image/png',width:1280,height:720},action_status:{read_later:{available:true},mail:{available:false,reason:'handler not installed'}}}),
  row(story('snoozed',{summary:'Later.'}),{state:{snoozed_until:'2999-01-01T00:00:00.000Z',done_at:'2026-11-14T11:22:00.000Z'},media_error:'the file is gone'}),
];
const receipts=[{receipt_id:'r1',story_id:'report',outcome:'failed',result:'handler exited 1'}];

function pane(list=rows) {
  const view=new Trough();
  view.init({},cx);
  view.rows=structuredClone(list); view.receipts=receipts; view.filter.inbox=false; view.filter.states=[];
  view.alignSelection();
  return view;
}
const broken=tree=>[...walk(tree)].flatMap(n=>n._children.filter(c=>typeof c==='string'&&/could not be drawn/.test(c)));
const node=(tree,id)=>[...walk(tree)].find(n=>call(n,'id')?.[0]===id);

// Every card in the states the pointer and keyboard put it in. The summary height is set the way
// on_size_change sets it after layout: the second render is where a clamped summary is first cut.
function renderEveryState(view) {
  const failures=[];
  const render=label=>{ const tree=view.render(cx); for(const why of broken(tree)) failures.push(`${label}: ${why}`); return tree; };
  render('first render');
  for(const entry of view.cardList()) {
    const s=entry.row.story;
    view.measured.set(s.id,400); render(`${s.id} measured`);
    view.choose(s.id); view.hovered=s.id; render(`${s.id} selected`);
    view.openMenu({id:s.id},cx); render(`${s.id} menu`);
    for(const link of s.links??[]) { view.openMenu({id:s.id,link:link.id},cx); render(`${s.id} ${link.id} menu`); }
    view.menu=null;
    if(s.decision) { view.pick=view.choiceAction(entry.row); render(`${s.id} pick`); }
    view.review={story_id:s.id,source:s.source,offered_by:'core',offer:{label:'Open'},plan:{effects:['Open the link']},always_allow:{state:'changed',key:'core/open_url',effects:['Open links']}};
    view.alwaysAllow=true; render(`${s.id} review`);
    view.review=null; view.deleteConfirm=s.id; render(`${s.id} delete`);
    view.deleteConfirm=null; view.expanded.add(s.id); render(`${s.id} open`);
    view.hovered=null;
  }
  view.filterPicker=true; view.allowView=true; view.allowed=[{key:'core/open_url',effects:['Open links'],state:'changed',reason:'handler changed',at:'2026-11-14T11:00:00.000Z'}]; view.search=true;
  render('header panels');
  for(const field of ['source','kind','severity','subject']) { view.filterField=field; render(`filter ${field}`); }
  return failures;
}

test('every card draws in every state, including the re-render after the summary is measured',()=>{
  assert.deepEqual(renderEveryState(pane()),[]);
});

test('a cut summary keeps two lines of 17 pixels and ends in an ellipsis, not a gradient',()=>{
  const view=pane(); view.measured.set('note',120);
  const tree=view.render(cx),lede=node(tree,'lede-note');
  const box=[...walk(tree)].find(n=>n._children.includes(lede));
  assert.deepEqual(call(box,'max_h'),[34]);
  assert.deepEqual(call(lede._children[0],'line_height'),['17px']);
  assert.ok(box._children.some(c=>text(c)==='…'),'a cut summary ends in an ellipsis');
  // An open card shows the whole summary.
  view.expanded.add('note');
  const openTree=view.render(cx),open=[...walk(openTree)].find(n=>n._children.includes(node(openTree,'lede-note')));
  assert.equal(call(open,'max_h'),undefined);
});

test('a summary that fits is neither clamped short nor marked as cut',()=>{
  const view=pane(); view.measured.set('merge',17);
  const tree=view.render(cx),lede=node(tree,'lede-merge');
  const box=[...walk(tree)].find(n=>n._children.includes(lede));
  assert.ok(!box._children.some(c=>text(c)==='…'));
});

test('a decision that can be answered labels each option button, numbered while selected',()=>{
  const view=pane(),label=(tree,id)=>text(node(tree,`option-ask-${id}`));
  let tree=view.render(cx);
  assert.equal(label(tree,'yes'),'Yes');
  assert.equal(label(tree,'no'),'No');
  view.choose('ask'); tree=view.render(cx);
  assert.equal(label(tree,'yes'),'1  Yes');
  assert.equal(label(tree,'no'),'2  No');
});

test('a card that cannot be drawn shows its error in its place, and the rest of the feed still draws',()=>{
  const view=pane([row(story('bad',{title:'Bad one',links:[{id:'odd',label:{nested:true},url:'https://example.com/a'}]})),row(story('good',{title:'Good one'}))]);
  const tree=view.render(cx);
  assert.match(broken(tree).join('\n'),/This card could not be drawn/);
  assert.match(text(node(tree,'story-bad')),/Bad one/);
  assert.match(text(node(tree,'story-good')),/Good one/);
});

test('a header that cannot be drawn leaves the feed in place',()=>{
  const view=pane();
  view.headerBar=()=>{ throw new TypeError('child: unsupported argument type'); };
  const tree=view.render(cx);
  assert.match(text(tree),/The header could not be drawn: child: unsupported argument type/);
  assert.ok(node(tree,'story-note'));
});

test('the rows of a real store draw in every state',{skip:!process.env.TROUGH_RENDER_ROWS&&'set TROUGH_RENDER_ROWS to a `trough ls --all --json` file'},async()=>{
  const list=JSON.parse(await fs.readFile(process.env.TROUGH_RENDER_ROWS,'utf8'));
  // Every story, done and snoozed ones included, with every group open.
  const view=pane(list); view.filter.all=true; view.groupOpen=new Set(view.cardList().map(entry=>entry.key));
  assert.equal(view.cardList().length,list.length);
  assert.deepEqual(renderEveryState(view),[]);
});
