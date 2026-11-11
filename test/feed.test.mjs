import test from 'node:test';
import assert from 'node:assert/strict';
import { visible, groups } from '../mods/trough/feed.js';

const row=(id,extra={},state={})=>({story:{id,source:{id:'agent',label:'Agent'},kind:'report',title:id,summary:'Ready',severity:'info',occurred_at:'2026-11-11T18:00:00Z',...extra},state});
test('group identity includes source and kind, and unread state remains per story',()=>{
  const a=row('a',{group_key:'work'}),b=row('b',{group_key:'work',severity:'warning'}, {read_at:'2026-11-11T18:01:00Z'}),c=row('c',{group_key:'work',source:{id:'monitor',label:'Monitor'}});
  const grouped=groups([a,b,c]);
  assert.equal(grouped.length,2);
  assert.equal(grouped[0].items.length,2);
  assert.equal(grouped[0].severity,'warning');
  assert.deepEqual(visible([a,b,c],{view:'unread'}).map(r=>r.story.id),['a','c']);
});
test('search and filters respect done and snoozed states',()=>{
  const future=new Date(Date.now()+3600000).toISOString();
  const rows=[row('one',{title:'Build done',kind:'ci'}, {done_at:'2026-11-11T18:01:00Z'}),row('two',{title:'Build failed',kind:'ci',actions:[{id:'open'}]}),row('three',{title:'Monitor',kind:'health'}, {snoozed_until:future})];
  assert.deepEqual(visible(rows,{view:'needs action',kind:'ci'}).map(r=>r.story.id),['two']);
  assert.deepEqual(visible(rows,{view:'done',text:'build'}).map(r=>r.story.id),['one']);
  assert.deepEqual(visible(rows,{view:'snoozed'}).map(r=>r.story.id),['three']);
});
