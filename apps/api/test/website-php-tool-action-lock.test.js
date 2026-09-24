import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsitePhpToolActionLock } from '../src/website-php-tool-action-lock.js';

const applicationId='22222222-2222-4222-8222-222222222222';

test('application lock rejects a second live process lock and releases after completion', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'yunpanel-php-lock-'));
  try {
    const lock=createWebsitePhpToolActionLock({root,pid:1234,signalProcess:(pid)=>{ if(pid===1234) return true; throw Object.assign(new Error(),{code:'ESRCH'}); }});
    let release;
    const pending=new Promise((resolve)=>{release=resolve;});
    const first=lock.withApplicationLock(applicationId,async()=>{await pending;return'first';});
    await new Promise((resolve)=>setTimeout(resolve,10));
    await assert.rejects(()=>lock.withApplicationLock(applicationId,async()=> 'second'),(e)=>e.code==='website_php_action_locked');
    release();
    assert.equal(await first,'first');
    assert.equal(await lock.withApplicationLock(applicationId,async()=> 'third'),'third');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('application lock removes a dead-process stale lock before enqueue', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'yunpanel-php-lock-'));
  try {
    const lock=createWebsitePhpToolActionLock({root,pid:2222,signalProcess:()=>{throw Object.assign(new Error(),{code:'ESRCH'});}});
    const target=path.join(root,`${applicationId}.lock`);
    const {mkdir,writeFile}=await import('node:fs/promises');
    await mkdir(root,{recursive:true}); await writeFile(target,JSON.stringify({pid:1111,applicationId}));
    assert.equal(await lock.withApplicationLock(applicationId,async()=> 'recovered'),'recovered');
  } finally { await rm(root,{recursive:true,force:true}); }
});
