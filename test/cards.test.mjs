import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateStory } from '../mods/trough/core/schema.js';
import { post } from '../mods/trough/core/store.js';
import { review } from '../mods/trough/core/actions.js';
import { visible, cards } from '../mods/trough/feed.js';
import { bodyPaths, linkTarget } from '../mods/trough/links.js';
import { safeMarkdown } from '../mods/trough/markdown.js';
import { windows } from './support.mjs';

process.env.HERDR_APP_HOME=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));

const base=(extra={})=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'example',label:'Example'},kind:'report',title:'Result',summary:'Ready',occurred_at:'2026-11-11T18:00:00Z',severity:'info',...extra});
const shot={id:'shot',label:'Screenshot',path:'/tmp/shot.png',role:'screenshot',media_type:'image/png'};

test('a story may carry a markdown body of up to 16384 characters',()=>{
  assert.equal(validateStory(base({body:'## Heading\n\n- one\n- `two`\n'})).body,'## Heading\n\n- one\n- `two`\n');
  assert.ok(validateStory(base({body:'x'.repeat(16384)})));
  assert.throws(()=>validateStory(base({body:'x'.repeat(16385)})),/body: expected plain text of 1-16384 characters/);
  assert.throws(()=>validateStory(base({body:''})),/body: expected plain text/);
  assert.throws(()=>validateStory(base({body:'bell \u0007'})),/body: expected plain text/);
  assert.throws(()=>validateStory(base({body:42})),/body: expected plain text/);
});

test('an image names one of the story\'s path links with a picture media type',()=>{
  assert.equal(validateStory(base({image:'shot',links:[shot]})).image,'shot');
  for(const type of ['image/jpeg','image/gif','image/webp']) assert.ok(validateStory(base({image:'shot',links:[{...shot,media_type:type}]})));
  assert.throws(()=>validateStory(base({image:'shot'})),/image: must name one of the story's links/);
  assert.throws(()=>validateStory(base({image:'other',links:[shot]})),/image: must name one of the story's links/);
  assert.throws(()=>validateStory(base({image:'web',links:[{id:'web',label:'Web',url:'https://example.com/a.png',media_type:'image/png'}]})),/must name a path link; images are never fetched/);
  assert.throws(()=>validateStory(base({image:'shot',links:[{...shot,media_type:'image/svg+xml'}]})),/media_type must be one of image\/png/);
  const {media_type:_type,...untyped}=shot;
  assert.throws(()=>validateStory(base({image:'shot',links:[untyped]})),/media_type must be one of/);
  assert.throws(()=>validateStory(base({image:'Not A Key',links:[shot]})),/image: invalid key/);
});

test('stories written before body and image existed are still valid',()=>{
  assert.ok(validateStory(base()));
  assert.throws(()=>validateStory(base({bodies:'x'})),/bodies: unknown field/);
});

test('a story body cannot draw HTML or load a picture, and code stays as written',()=>{
  assert.equal(safeMarkdown('Hi <b>bold</b> <img src="https://t.example/p.gif">'),'Hi &lt;b>bold&lt;/b> &lt;img src="https://t.example/p.gif">');
  assert.equal(safeMarkdown('See <https://example.com/a>.'),'See <https://example.com/a>.');
  assert.equal(safeMarkdown('![chart](https://t.example/p.png) ![](/tmp/a.png) ![ref][r]'),'[chart](https://t.example/p.png) [image](/tmp/a.png) [ref][r]');
  assert.equal(safeMarkdown('Escaped \\![not](an/image).'),'Escaped \\![not](an/image).');
  assert.equal(safeMarkdown('Use `a<b` and ``x ` <y>`` then <i>'),'Use `a<b` and ``x ` <y>`` then &lt;i>');
  assert.equal(safeMarkdown('```html\n<img src=x>\n![a](b)\n```\nafter <br>'),'```html\n<img src=x>\n![a](b)\n```\nafter &lt;br>');
  assert.equal(safeMarkdown('~~~\n<b>\n~~~~\n<b>'),'~~~\n<b>\n~~~~\n&lt;b>');
  assert.equal(safeMarkdown('line one\r\nline <two>'),'line one\nline &lt;two>');
});

test('links in a body resolve to web links or absolute paths only',()=>{
  assert.deepEqual(linkTarget('https://example.com/x'),{url:'https://example.com/x'});
  assert.deepEqual(linkTarget('file:///Users/me/My%20Report.md'),{path:'/Users/me/My Report.md'});
  assert.deepEqual(linkTarget('/srv/report.md'),{path:'/srv/report.md'});
  assert.deepEqual(linkTarget('~/notes.md'),{path:'~/notes.md'});
  for(const other of ['file://server/share/x','javascript:alert(1)','mailto:a@example.com','relative/path.md','//host/x',undefined]) assert.equal(linkTarget(other),null,String(other));
  assert.deepEqual(bodyPaths('Read [the report](/srv/a%20b.md), [web](https://x.example) or /var/log/app.log and [f](file:///etc/hosts).').sort(),
    ['/etc/hosts','/srv/a b.md','/srv/a%20b.md','/var/log/app.log']);
});

test('a path a body links to can be opened, any other path cannot',{skip:windows&&'paths in story text are recognised in POSIX form only'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-cards-')),report=path.join(dir,'weekly report.md'),other=path.join(dir,'other.md');
  await fs.writeFile(report,'# Weekly'); await fs.writeFile(other,'# Other');
  const s=base({body:`The [weekly report](${report.replaceAll(' ','%20')}) is ready.`});
  await post(dir,Buffer.from(JSON.stringify(s)+'\n'));
  const sheet=await review(dir,s.id,'__open_local_path',{path:report});
  assert.deepEqual([sheet.plan.verb,sheet.plan.item],['open',report]);
  await assert.rejects(review(dir,s.id,'__open_local_path',{path:other}),/not present in this story/);
});

test('search finds words in the body',()=>{
  const rows=[{story:base({id:'a',body:'The checkout quote endpoint is slow.'}),state:{}},{story:base({id:'b'}),state:{}}];
  assert.deepEqual(visible(rows,{all:true,text:'endpoint'}).map(r=>r.story.id),['a']);
});

test('stories in one group stack into one card until the group is opened',()=>{
  const row=(id,extra={},state={})=>({story:base({id,source:{id:'release',label:'Release bot'},kind:'release',...extra}),state});
  const rows=[row('new',{group_key:'2.4.0'}),row('alone'),row('mid',{group_key:'2.4.0',actions:[{id:'tag',label:'Tag',handler:'release_tag'}]}),row('old',{group_key:'2.4.0'},{done_at:'2026-11-11T19:00:00Z'})];
  const closed=cards(rows);
  assert.deepEqual(closed.map(c=>[c.row.story.id,c.earlier,c.outstanding,c.nested]),[['new',2,1,false],['alone',0,0,false]]);
  const open=cards(rows,new Set([closed[0].key]));
  assert.deepEqual(open.map(c=>[c.row.story.id,c.nested]),[['new',false],['mid',true],['old',true],['alone',false]]);
  // A group of one is an ordinary card.
  assert.deepEqual(cards([row('solo',{group_key:'x'})]).map(c=>[c.earlier,c.nested]),[[0,false]]);
});
