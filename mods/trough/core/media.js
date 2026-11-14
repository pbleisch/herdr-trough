// Pictures on cards.
//
// The pane draws pictures with GPUI's image(path), which loads only from the Herdr home. A story's
// image is a path link somewhere else, so the CLI copies the file into the Herdr home first, after
// checking it, under a name made from its SHA-256:
//
//   <Herdr home>/trough-media/<data folder key>/<sha256>.<ext>
//
// Nothing is ever fetched from the network. The pane only ever loads a name this module made, so a
// story cannot point it at any other file. The copy is taken the first time the story is listed and
// recorded in <data folder>/media/<story id>.json, so a producer that changes the file later does not
// change the card. The cache sits outside mods/, because Herdr reloads a mod when a file under mods/
// changes, and has one folder per data folder, so cleaning one data folder never touches another's.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID } from './schema.js';
import { appHome } from './open-handlers.js';
import { publishExclusive } from './store.js';

export const MAX_BYTES=5*1024*1024;
export const MAX_SIDE=4096;
// 16 megapixels: a picture at the side limit in both directions (4096×4096) is refused too.
export const MAX_PIXELS=16000000;
export const CACHE='trough-media';
const EXT={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
const CACHED=/^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=reason=>{ throw new Error(reason); };

// The type and size of a picture, read from its first bytes. The file's name and the link's
// media_type are not trusted: only PNG, JPEG, GIF and WebP are accepted, and never SVG.
export function imageInfo(bytes) {
  const b=Buffer.from(bytes), at=(i,n)=>b.length>=i+n;
  const done=(type,width,height)=>{
    if(!(width>0&&height>0)) fail(`the ${EXT[type].toUpperCase()} header has no size`);
    return {type,ext:EXT[type],width,height};
  };
  if(at(0,24)&&b.readUInt32BE(0)===0x89504e47&&b.readUInt32BE(4)===0x0d0a1a0a&&b.toString('latin1',12,16)==='IHDR')
    return done('image/png',b.readUInt32BE(16),b.readUInt32BE(20));
  if(at(0,10)&&/^GIF8[79]a$/.test(b.toString('latin1',0,6))) return done('image/gif',b.readUInt16LE(6),b.readUInt16LE(8));
  if(at(0,3)&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) {
    let i=2;
    while(at(i,4)) {
      if(b[i]!==0xff) fail('the JPEG is damaged');
      const marker=b[i+1];
      if(marker===0xff) { i++; continue; }
      if(marker===0x01||(marker>=0xd0&&marker<=0xd8)) { i+=2; continue; }
      if(marker===0xd9||marker===0xda) break;
      const length=b.readUInt16BE(i+2);
      if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)) {
        if(!at(i,9)) break;
        return done('image/jpeg',b.readUInt16BE(i+7),b.readUInt16BE(i+5));
      }
      if(length<2) fail('the JPEG is damaged');
      i+=2+length;
    }
    fail('the JPEG has no size before its image data');
  }
  if(at(0,30)&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP') {
    const chunk=b.toString('latin1',12,16);
    if(chunk==='VP8 '&&b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a) return done('image/webp',b.readUInt16LE(26)&0x3fff,b.readUInt16LE(28)&0x3fff);
    if(chunk==='VP8L'&&b[20]===0x2f) { const bits=b.readUInt32LE(21); return done('image/webp',(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1); }
    if(chunk==='VP8X') return done('image/webp',b.readUIntLE(24,3)+1,b.readUIntLE(27,3)+1);
    fail('the WebP header is not one Trough can read');
  }
  const head=b.toString('utf8',0,Math.min(b.length,512)).trimStart().toLowerCase();
  if(head.startsWith('<svg')||head.startsWith('<?xml')&&head.includes('<svg')) fail('SVG is not shown on cards; use PNG, JPEG, GIF or WebP');
  fail('not a PNG, JPEG, GIF or WebP file');
}

// The limits are checked from the header, before GPUI decodes the picture: a small file can
// claim a size that would take gigabytes to draw.
export function checkLimits(info) {
  if(info.width>MAX_SIDE||info.height>MAX_SIDE) fail(`the picture is ${info.width}×${info.height}; at most ${MAX_SIDE} pixels on each side are shown`);
  if(info.width*info.height>MAX_PIXELS) fail(`the picture has ${info.width*info.height} pixels; at most ${MAX_PIXELS} are shown`);
  return info;
}

// Reads a picture without following a symbolic link at the path and without opening anything
// but a regular file: a FIFO or a device could block or never end.
export async function readImage(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)) fail('the image path must be absolute');
  let st;
  try { st=await fs.lstat(file); }
  catch(error) { fail(error.code==='ENOENT'?`${file} does not exist`:`cannot read ${file}: ${error.code??error.message}`); }
  if(st.isSymbolicLink()) fail(`${file} is a symbolic link; link the file itself`);
  if(!st.isFile()) fail(`${file} is not a regular file`);
  if(st.size>MAX_BYTES) fail(`${file} is ${st.size} bytes; images up to ${MAX_BYTES} bytes are shown`);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try {
    const now=await handle.stat();
    if(!now.isFile()||now.ino!==st.ino||now.dev!==st.dev) fail(`${file} changed while it was being read`);
    const bytes=await handle.readFile();
    if(bytes.length>MAX_BYTES) fail(`${file} is larger than ${MAX_BYTES} bytes`);
    return bytes;
  } finally { await handle.close(); }
}

// Reads and checks a picture: what `trough emit --image` and the cache copy both do.
export async function checkedImage(file) {
  const bytes=await readImage(file);
  return {bytes,...checkLimits(imageInfo(bytes))};
}

async function cacheFolder(root) {
  const real=await fs.realpath(root).catch(()=>path.resolve(root));
  const key=sha256(real).slice(0,16);
  return {abs:path.join(appHome(),CACHE,key),rel:`${CACHE}/${key}`};
}
const recordFile=(root,id)=>path.join(root,'media',`${id}.json`);
async function readRecord(root,id) {
  try { return JSON.parse(await fs.readFile(recordFile(root,id),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; throw error; }
}
const exists=file=>fs.access(file).then(()=>true,()=>false);
async function writeCache(folder,record,bytes) {
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  await publishExclusive(folder,`${record.sha256}.${record.ext}`,bytes);
}
const shown=(folder,record)=>({link:record.link,src:`${folder.rel}/${record.sha256}.${record.ext}`,type:record.type,width:record.width,height:record.height});

// The cached copy of a story's image: {link, src, type, width, height}, where src is relative to
// the Herdr home. Throws with the reason when it cannot be shown. Null when the story has no image.
export async function storyMedia(root,story) {
  if(!story.image) return null;
  if(!ID.test(story.id)) fail('invalid story id');
  const link=(story.links??[]).find(item=>item.id===story.image);
  if(!link?.path) fail('the image link is missing');
  const folder=await cacheFolder(root);
  const recorded=await readRecord(root,story.id);
  if(recorded?.v===1&&recorded.link===link.id&&CACHED.test(`${recorded.sha256}.${recorded.ext}`)) {
    if(await exists(path.join(folder.abs,`${recorded.sha256}.${recorded.ext}`))) return shown(folder,recorded);
    // The cache was cleared. Copy the file again only if it still has the bytes the card first showed.
    const bytes=await readImage(link.path);
    if(sha256(bytes)!==recorded.sha256) fail(`${link.path} changed after the story was first shown`);
    await writeCache(folder.abs,recorded,bytes);
    return shown(folder,recorded);
  }
  const {bytes,type,ext,width,height}=await checkedImage(link.path);
  const record={v:1,link:link.id,sha256:sha256(bytes),type,ext,width,height,copied_at:new Date().toISOString()};
  await writeCache(folder.abs,record,bytes);
  await fs.mkdir(path.join(root,'media'),{recursive:true,mode:0o700});
  if(await publishExclusive(path.join(root,'media'),`${story.id}.json`,Buffer.from(JSON.stringify(record)+'\n'))) return shown(folder,record);
  // Another process recorded it first: show what it recorded.
  const first=await readRecord(root,story.id);
  if(first?.v!==1||first.link!==link.id||!CACHED.test(`${first.sha256}.${first.ext}`)) fail('the image record for this story is damaged');
  if(!await exists(path.join(folder.abs,`${first.sha256}.${first.ext}`))) fail('the image is still being copied');
  return shown(folder,first);
}

// Adds `media` (or `media_error`) to each listed row whose story has an image.
export async function withMedia(root,rows) {
  return Promise.all(rows.map(async row=>{
    if(!row.story.image) return row;
    try { return {...row,media:await storyMedia(root,row.story)}; }
    catch(error) { return {...row,media_error:String(error.message).slice(0,300)}; }
  }));
}

export const removeMediaRecord=(root,id)=>fs.unlink(recordFile(root,id)).catch(error=>{if(error.code!=='ENOENT') throw error;});

// Removes records of stories that are gone, and cached copies no record of this data folder uses.
// Call with the state lock held.
export async function cleanMedia(root) {
  const dir=path.join(root,'media'),used=new Set(),removed=[];
  for(const name of await fs.readdir(dir).catch(()=>[])) {
    const id=name.slice(0,-5);
    if(!name.endsWith('.json')||!ID.test(id)) continue;
    const stored=await exists(path.join(root,'store',`${id}.json`));
    if(!stored) { await removeMediaRecord(root,id); continue; }
    const record=await readRecord(root,id).catch(()=>null);
    if(record) used.add(`${record.sha256}.${record.ext}`);
  }
  const folder=await cacheFolder(root);
  for(const name of await fs.readdir(folder.abs).catch(()=>[])) {
    if(!CACHED.test(name)||used.has(name)) continue;
    await fs.unlink(path.join(folder.abs,name)).catch(error=>{if(error.code!=='ENOENT') throw error;});
    removed.push(name);
  }
  return removed;
}
