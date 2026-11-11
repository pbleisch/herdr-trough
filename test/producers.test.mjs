import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProducerSchedule } from '../mods/trough/producer-schedule.js';
import { configuredProducers, listProducers, runProducer } from '../mods/trough/core/producers.js';
import { producer as firstmateProducer } from '../packages/firstmate/index.js';

const root=()=>fs.mkdtemp(path.join(os.tmpdir(),'trough-producers-'));

test('pane schedule runs on opening and on each configured interval without overlap',()=>{
  const a={id:'a',interval_seconds:120},b={id:'b',interval_seconds:30};
  const schedule=new ProducerSchedule([a,b]);
  assert.deepEqual(schedule.due(1000),[a,b]);
  assert.deepEqual(schedule.due(31000),[]);
  schedule.complete('b');
  assert.deepEqual(schedule.due(31000),[b]);
  schedule.complete('a');
  assert.deepEqual(schedule.due(120999),[]);
  assert.deepEqual(schedule.due(121000),[a]);
  assert.equal(firstmateProducer({}).interval_seconds,120);
  assert.equal(firstmateProducer({sync_interval_seconds:45}).interval_seconds,45);
  assert.throws(()=>firstmateProducer({sync_interval_seconds:0}),/positive integer/);
});

test('one runner holds the data-directory lock and a failed producer does not block another',async()=>{
  const dir=await root(),slow=path.join(dir,'slow.mjs'),bad=path.join(dir,'bad.mjs'),good=path.join(dir,'good.mjs'),invalid=path.join(dir,'invalid.mjs');
  const started=path.join(dir,'started'),release=path.join(dir,'release'),output=path.join(dir,'output');
  await fs.writeFile(slow,`import fs from 'node:fs/promises';
export function producer() { return {name:'Slow',interval_seconds:2,async run() {
  await fs.writeFile(${JSON.stringify(started)},'started');
  while (!(await fs.stat(${JSON.stringify(release)}).catch(()=>null))) await new Promise(resolve=>setTimeout(resolve,10));
}}; }`);
  await fs.writeFile(bad,"export function producer() { return {name:'Bad',interval_seconds:1,run() { throw new Error('source unavailable'); }}; }");
  await fs.writeFile(good,`import fs from 'node:fs/promises'; export function producer() { return {name:'Good',interval_seconds:1,run() { return fs.writeFile(${JSON.stringify(output)},'done'); }}; }`);
  await fs.writeFile(invalid,"export function producer() { throw new Error('invalid setup'); }");
  await fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify({v:1,packages:[slow,bad,good,invalid]}));
  const entries=await configuredProducers(dir);
  const running=runProducer(dir,entries[0].id);
  for(let i=0;i<100&&!await fs.stat(started).catch(()=>null);i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await runProducer(dir,entries[0].id)).busy,true);
  const failure=await runProducer(dir,entries[1].id);
  assert.equal(failure.status.last_error,'source unavailable');
  const success=await runProducer(dir,entries[2].id);
  assert.equal(success.status.last_error,null);
  assert.equal(await fs.readFile(output,'utf8'),'done');
  assert.equal((await runProducer(dir,entries[2].id)).skipped,true);
  await fs.writeFile(release,'go');
  assert.equal((await running).busy,false);
  const status=await listProducers(dir);
  assert.equal(status[1].status.last_error,'source unavailable');
  assert.equal(status[3].status.last_error,'invalid setup');
  assert.deepEqual(new ProducerSchedule(status).due(0).map(item=>item.name),['Slow','Bad','Good']);
  assert.ok(status.slice(0,3).every(item=>item.status?.last_run));
});
