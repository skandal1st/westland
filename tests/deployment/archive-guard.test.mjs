import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { inspectArchive } from '../../scripts/backup-restore.mjs';

// Small malicious archives are generated in memory; no unsafe path is extracted.
function entry(name, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
  h.write('00000000000\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);
  if(type==='2')h.write('../../outside',157);
  h.write('ustar\0',257);h.write('00',263);
  const checksum=[...h].reduce((a,b)=>a+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
  return h;
}
test('rejects traversal, links, duplicate and unexpected archive paths before extraction', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'axima-archive-test-'));
  try {
    const cases=[entry('../outside'),entry('/outside'),entry('deployment/config/link','2'),entry('outside.txt'),entry('manifest.json')];
    for(let i=0;i<cases.length;i++) {
      const f=path.join(root,`${i}.tar.gz`);
      fs.writeFileSync(f,gzipSync(Buffer.concat([entry('manifest.json'),cases[i],Buffer.alloc(1024)])));
      assert.throws(()=>inspectArchive(f));
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
