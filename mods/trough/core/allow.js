// The operator's standing approvals ("always allow"), kept in $TROUGH_DIR/allow.json.
//
// An approval names one handler as offered by one pack, for example core/open_path. It is written
// only when the operator confirms a review with "Always allow", never by a story or a pack, and it
// pins a fingerprint of what the handler runs. actions.js decides what may be approved and when an
// approval still holds; this file only reads and writes the record.
import fs from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from './store.js';

const FILE='allow.json';
const KEY=/^[a-z][a-z0-9_-]{0,63}\/[a-z][a-z0-9_-]{0,63}$/;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>{throw new Error(`invalid ${FILE}; fix it, or delete it to clear every standing approval`);};

export const allowKey=(pack,handler)=>`${pack}/${handler}`;
export const isAllowKey=key=>typeof key==='string'&&KEY.test(key);

// {"<pack>/<handler>": {pack, handler, fingerprint, label, effects, at}}
export async function readAllowed(root) {
  let raw;
  try { raw=JSON.parse(await fs.readFile(path.join(root,FILE),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return {}; if(error instanceof SyntaxError) invalid(); throw error; }
  if(!plain(raw)||raw.v!==1||!plain(raw.allowed)) invalid();
  for(const [key,entry] of Object.entries(raw.allowed)) {
    if(!KEY.test(key)||!plain(entry)||allowKey(entry.pack,entry.handler)!==key||!/^[0-9a-f]{64}$/.test(entry.fingerprint??'')) invalid();
  }
  return raw.allowed;
}
// Call with the state lock held.
export async function writeAllowed(root,allowed) {
  await replaceAtomic(root,FILE,Buffer.from(JSON.stringify({v:1,allowed},null,2)+'\n'));
}
