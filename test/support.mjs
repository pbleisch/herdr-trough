// Shared by the test files. It is not a test file itself: the runner picks up *.test.mjs only.
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const windows=process.platform==='win32';
export const posix=!windows;

// A command handler that runs and does nothing, on every platform.
export const noop=effects=>({kind:'command',executable:process.execPath,argv:[{literal:'-e'},{literal:''}],args:{},effects});

// On Linux, open and reveal are unavailable without xdg-open, and a real one would open things
// on the desktop. A stand-in that does nothing goes first on PATH, so the tests behave the same
// with or without xdg-utils installed.
if(process.platform==='linux') {
  const tools=await fs.mkdtemp(path.join(os.tmpdir(),'trough-tools-'));
  await fs.writeFile(path.join(tools,'xdg-open'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  process.env.PATH=tools+path.delimiter+(process.env.PATH??'');
  process.on('exit',()=>rmSync(tools,{recursive:true,force:true}));
}
