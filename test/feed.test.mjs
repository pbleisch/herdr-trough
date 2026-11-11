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
  assert.deepEqual(visible([a,b,c],{states:['unread']}).map(r=>r.story.id),['a','c']);
});
test('state predicates AND with each other and dimensions; selected values within a dimension OR',()=>{
  const now=Date.parse('2026-11-11T18:00:00Z'),future='2026-11-12T18:00:00Z';
  const rows=[
    row('one',{title:'Build done',kind:'ci',actions:[{id:'open'}]}, {done_at:'2026-11-11T18:01:00Z'}),
    row('two',{title:'Build failed',kind:'ci',actions:[{id:'open'}],subject:{key:'build',label:'Build'}}),
    row('three',{title:'Build warning',kind:'ci',source:{id:'monitor',label:'Monitor'},severity:'warning',actions:[{id:'open'}],subject:{key:'build',label:'Build'}}, {snoozed_until:future}),
    row('four',{title:'Monitor',kind:'health'}, {snoozed_until:future}),
    row('five',{title:'Build read',kind:'ci',actions:[{id:'open'}]}, {read_at:'2026-11-11T18:01:00Z'})
  ];
  assert.deepEqual(visible(rows,{},now).map(r=>r.story.id),['two','five']);
  assert.deepEqual(visible(rows,{all:true},now).map(r=>r.story.id),['one','two','three','four','five']);
  assert.deepEqual(visible(rows,{states:['unread','needs action'],source:['agent','monitor'],kind:['ci'],subject:['build'],text:'build'},now).map(r=>r.story.id),['two','three']);
  assert.deepEqual(visible(rows,{states:['snoozed','unread'],source:['monitor'],severity:['warning']},now).map(r=>r.story.id),['three']);
  assert.deepEqual(visible(rows,{states:['done','needs action']},now),[]);
  assert.deepEqual(visible(rows,{states:['done'],text:'build'},now).map(r=>r.story.id),['one']);
});
test('Inbox unions unread and unfinished actions, then intersects field filters and search',()=>{
  const now=Date.parse('2026-11-11T18:00:00Z'),future='2026-11-12T18:00:00Z';
  const read={read_at:'2026-11-11T18:01:00Z'};
  const rows=[
    row('new',{title:'Build new'}),
    row('waiting',{title:'Build waiting',actions:[{id:'open'}]},read),
    row('quiet',{title:'Build quiet'},read),
    row('done unread',{title:'Build done'}, {done_at:'2026-11-11T18:01:00Z'}),
    row('done read',{title:'Build filed',actions:[{id:'open'}]}, {...read,done_at:'2026-11-11T18:01:00Z'}),
    row('snoozed',{title:'Build snoozed'}, {snoozed_until:future}),
    row('other',{title:'Other waiting',source:{id:'monitor',label:'Monitor'},actions:[{id:'open'}]},read)
  ];
  assert.deepEqual(visible(rows,{inbox:true},now).map(r=>r.story.id),['new','waiting','done unread','snoozed','other']);
  assert.deepEqual(visible(rows,{inbox:true,source:['agent'],text:'build'},now).map(r=>r.story.id),['new','waiting','done unread','snoozed']);
});
