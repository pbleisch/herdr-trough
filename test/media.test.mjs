import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, setState } from '../mods/trough/core/store.js';
import { prune, deleteStory } from '../mods/trough/core/prune.js';
import { imageInfo, checkLimits, readImage, storyMedia, withMedia, MAX_BYTES, CACHE } from '../mods/trough/core/media.js';
import { windows } from './support.mjs';

// The cache lives under the Herdr home: keep it, and the person's own open handler, out of these tests.
const home=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));
process.env.HERDR_APP_HOME=home;

const cli=path.resolve('mods/trough/bin/trough');
const root=()=>fs.mkdtemp(path.join(os.tmpdir(),'trough-media-'));
const run=(dir,...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,TROUGH_DIR:dir,HERDR_APP_HOME:home},encoding:'utf8'});

// Headers only: the module reads the size from the first bytes, and the tests need nothing more.
function png(width,height) {
  const b=Buffer.alloc(33); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b,0);
  b.writeUInt32BE(13,8); b.write('IHDR',12,'latin1'); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); b[24]=8; b[25]=6;
  return b;
}
const gif=(w,h)=>{ const b=Buffer.alloc(13); b.write('GIF89a',0,'latin1'); b.writeUInt16LE(w,6); b.writeUInt16LE(h,8); return b; };
const jpeg=(w,h)=>Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,1,1,0,0,1,0,1,0,0,
  0xff,0xdb,0x00,0x04,0x00,0x00, 0xff,0xc0,0x00,0x11,0x08,h>>8,h&255,w>>8,w&255,0x03,1,0x22,0,2,0x11,1,3,0x11,1, 0xff,0xd9]);
const webp=(chunk,w,h)=>{
  const b=Buffer.alloc(32); b.write('RIFF',0,'latin1'); b.writeUInt32LE(24,4); b.write('WEBP',8,'latin1'); b.write(chunk,12,'latin1'); b.writeUInt32LE(10,16);
  if(chunk==='VP8X') { b.writeUIntLE(w-1,24,3); b.writeUIntLE(h-1,27,3); }
  if(chunk==='VP8L') { b[20]=0x2f; b.writeUInt32LE(((w-1)|((h-1)<<14))>>>0,21); }
  if(chunk==='VP8 ') { b[23]=0x9d; b[24]=0x01; b[25]=0x2a; b.writeUInt16LE(w,26); b.writeUInt16LE(h,28); }
  return b;
};
const story=(file,extra={})=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'monitor',label:'Monitor'},kind:'incident',title:'Checkout is down',
  summary:'Every request returns 503.',occurred_at:'2026-11-14T10:09:00Z',severity:'critical',image:'chart',
  links:[{id:'chart',label:'Error rate',path:file,role:'screenshot',media_type:'image/png'}],...extra});
const add=(dir,s)=>post(dir,Buffer.from(JSON.stringify(s)+'\n'));
const cacheFiles=async()=>{ const out=[]; for(const key of await fs.readdir(path.join(home,CACHE)).catch(()=>[])) for(const name of await fs.readdir(path.join(home,CACHE,key))) out.push(`${key}/${name}`); return out; };

test('the picture type and size come from the file bytes, for PNG, JPEG, GIF and WebP only',()=>{
  assert.deepEqual(imageInfo(png(640,360)),{type:'image/png',ext:'png',width:640,height:360});
  assert.deepEqual(imageInfo(jpeg(800,600)),{type:'image/jpeg',ext:'jpg',width:800,height:600});
  assert.deepEqual(imageInfo(gif(32,16)),{type:'image/gif',ext:'gif',width:32,height:16});
  for(const chunk of ['VP8 ','VP8L','VP8X']) assert.deepEqual(imageInfo(webp(chunk,300,200)),{type:'image/webp',ext:'webp',width:300,height:200},chunk);
  assert.throws(()=>imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),/SVG is not shown/);
  assert.throws(()=>imageInfo(Buffer.from('<?xml version="1.0"?>\n<svg/>')),/SVG is not shown/);
  assert.throws(()=>imageInfo(Buffer.from('%PDF-1.7 not a picture')),/not a PNG, JPEG, GIF or WebP/);
  assert.throws(()=>imageInfo(png(0,10)),/no size/);
  assert.throws(()=>imageInfo(Buffer.from([0xff,0xd8,0xff,0xd9])),/no size/);
});

test('sizes are limited before the picture is ever decoded',()=>{
  assert.deepEqual(checkLimits(imageInfo(png(4096,3906))).width,4096);
  assert.throws(()=>checkLimits(imageInfo(png(4097,10))),/at most 4096 pixels on each side/);
  assert.throws(()=>checkLimits(imageInfo(png(4096,4096))),/at most 16000000 are shown/);
});

test('only an absolute path to a regular file within the size limit is read',async()=>{
  const dir=await root(),file=path.join(dir,'shot.png');
  await fs.writeFile(file,png(10,10));
  assert.deepEqual(await readImage(file),png(10,10));
  await assert.rejects(readImage('shot.png'),/must be absolute/);
  await assert.rejects(readImage(path.join(dir,'missing.png')),/does not exist/);
  await assert.rejects(readImage(dir),/not a regular file/);
  const big=path.join(dir,'big.png'); await fs.writeFile(big,png(10,10)); await fs.truncate(big,MAX_BYTES+1);
  await assert.rejects(readImage(big),/images up to 5242880 bytes are shown/);
  if(!windows) {
    const alias=path.join(dir,'alias.png'); await fs.symlink(file,alias);
    await assert.rejects(readImage(alias),/symbolic link/);
    const fifo=path.join(dir,'pipe.png'); assert.equal(spawnSync('mkfifo',[fifo]).status,0);
    await assert.rejects(readImage(fifo),/not a regular file/);
  }
});

test('a story image is copied into the Herdr home once, under its hash, and later changes to the file do not reach the card',async()=>{
  const dir=await root(),file=path.join(dir,'shot.png'),s=story(file);
  await fs.writeFile(file,png(640,360));
  await add(dir,s);
  const first=await storyMedia(dir,s);
  const hash=crypto.createHash('sha256').update(png(640,360)).digest('hex');
  assert.match(first.src,new RegExp(`^${CACHE}/[0-9a-f]{16}/${hash}\\.png$`));
  assert.deepEqual([first.link,first.type,first.width,first.height],['chart','image/png',640,360]);
  assert.deepEqual(await fs.readFile(path.join(home,first.src)),png(640,360));
  // The producer rewrites the file: the card keeps what it first showed.
  await fs.writeFile(file,png(10,10));
  assert.deepEqual(await storyMedia(dir,s),first);
  // The cache was cleared: a changed file is not shown, the original one is copied again.
  await fs.unlink(path.join(home,first.src));
  await assert.rejects(storyMedia(dir,s),/changed after the story was first shown/);
  await fs.writeFile(file,png(640,360));
  assert.deepEqual(await storyMedia(dir,s),first);
  assert.deepEqual(await fs.readFile(path.join(home,first.src)),png(640,360));
});

test('a picture that cannot be shown leaves the story listed with the reason',async()=>{
  const dir=await root(),missing=story(path.join(dir,'missing.png'));
  const {image:_image,links:_links,...plain}=story('/x.png');
  await add(dir,missing); await add(dir,plain);
  const rows=await withMedia(dir,[{story:missing},{story:plain}]);
  assert.match(rows[0].media_error,/does not exist/);
  assert.equal(rows[0].media,undefined);
  assert.deepEqual(rows[1],{story:plain});
});

test('pruning and deleting remove the image record and the cached copy',async()=>{
  const dir=await root(),a=path.join(dir,'a.png'),b=path.join(dir,'b.png'),kept=story(a),gone=story(b);
  await fs.writeFile(a,png(20,20)); await fs.writeFile(b,png(30,30));
  await add(dir,kept); await add(dir,gone);
  const keptSrc=(await storyMedia(dir,kept)).src,goneSrc=(await storyMedia(dir,gone)).src;
  await setState(dir,gone.id,'read');
  const result=await prune(dir,{now:Date.now()+4*86400000});
  assert.deepEqual(result.ids,[gone.id]);
  await assert.rejects(fs.access(path.join(dir,'media',`${gone.id}.json`)));
  await assert.rejects(fs.access(path.join(home,goneSrc)));
  await fs.access(path.join(home,keptSrc));
  await deleteStory(dir,kept.id);
  await assert.rejects(fs.access(path.join(dir,'media',`${kept.id}.json`)));
  await assert.rejects(fs.access(path.join(home,keptSrc)));
});

test('trough emit takes a markdown body and an image, and ls --json lists the cached copy',async()=>{
  const dir=await root(),file=path.join(dir,'chart.png'),body=path.join(dir,'body.md');
  await fs.writeFile(file,png(320,180)); await fs.writeFile(body,'Last deploy: [8812](https://ci.example.com/8812).\n\n- one\n- two\n');
  const emitted=run(dir,'emit','--source','monitor','--kind','incident','--title','Down','--summary','Every request fails.','--body-file',body,'--image',file);
  assert.equal(emitted.status,0,emitted.stderr);
  const [row]=JSON.parse(run(dir,'ls','--all','--json').stdout);
  assert.equal(row.story.body,'Last deploy: [8812](https://ci.example.com/8812).\n\n- one\n- two');
  assert.equal(row.story.image,'image');
  assert.deepEqual(row.story.links.at(-1),{id:'image',label:'chart.png',path:file,role:'screenshot',media_type:'image/png'});
  assert.deepEqual([row.media.width,row.media.height,row.media.type],[320,180,'image/png']);
  assert.deepEqual(await fs.readFile(path.join(home,row.media.src)),png(320,180));
  const shown=JSON.parse(run(dir,'show',row.story.id).stdout);
  assert.deepEqual(shown.media,row.media);
  // --app-home names the Herdr home the pane loads pictures from.
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'trough-other-home-')),otherDir=await root();
  assert.equal(run(otherDir,'--app-home',other,'emit','--source','a','--kind','b','--title','t','--summary','s','--image',file).status,0);
  const [elsewhere]=JSON.parse(run(otherDir,'--app-home',other,'ls','--json').stdout);
  await fs.access(path.join(other,elsewhere.media.src));
  assert.match(run(otherDir,'--app-home','relative/home','ls').stderr,/--app-home must be an absolute path/);
});

test('trough emit refuses a file that is not a picture, and a body given twice',async()=>{
  const dir=await root(),svgFile=path.join(dir,'logo.svg');
  await fs.writeFile(svgFile,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.match(run(dir,'emit','--source','a','--kind','b','--title','t','--summary','s','--image',svgFile).stderr,/SVG is not shown/);
  assert.match(run(dir,'emit','--source','a','--kind','b','--title','t','--summary','s','--body','x','--body-file',svgFile).stderr,/--body or --body-file, not both/);
  assert.match(run(dir,'emit','--source','a','--kind','b','--title','t','--summary','s','--body','x'.repeat(16385)).stderr,/body: expected plain text of 1-16384 characters/);
  assert.equal(run(dir,'ls','--all','--json').stdout.trim(),'[]');
});

test('the cache key keeps two data folders apart',async()=>{
  const one=await root(),two=await root(),file=path.join(one,'shot.png');
  await fs.writeFile(file,png(12,12));
  const a=story(file),b=story(file);
  await add(one,a); await add(two,b);
  const [x,y]=[await storyMedia(one,a),await storyMedia(two,b)];
  assert.notEqual(path.dirname(x.src),path.dirname(y.src));
  assert.equal(path.basename(x.src),path.basename(y.src));
  await deleteStory(one,a.id);
  await fs.access(path.join(home,y.src));
  assert.ok((await cacheFiles()).includes(path.relative(CACHE,y.src)));
});
