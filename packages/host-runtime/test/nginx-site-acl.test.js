import test from 'node:test';
import assert from 'node:assert/strict';
import {nginxAclHas} from '../src/nginx-site-acl.js';

test('raw getfacl and canonical receipts both recognize inherited read-only file access',()=>{
 const raw='user:www-data:r-x\t#effective:r--\nmask::r--\n';
 assert.equal(nginxAclHas(raw,'user:www-data:r--'),true);
 assert.equal(nginxAclHas(raw.replace(/\s+#effective:r--/,''),'user:www-data:r--'),true);
 assert.equal(nginxAclHas('user:www-data:r-x\nmask::r-x\n','user:www-data:r-x'),true);
 assert.equal(nginxAclHas('default:user:www-data:r-x\ndefault:mask::r-x\nmask::---\n','default:user:www-data:r-x'),true);
});
test('masked-out access, extra execute access, latent write, duplicate and inconsistent ACL entries fail closed',()=>{
 for(const raw of ['user:www-data:r--\nmask::---','user:www-data:r-x\nmask::r-x','user:www-data:rwx\nmask::r--',
  'user:www-data:r--\nuser:www-data:r-x\nmask::r--','user:www-data:r-x #effective:r--\nmask::---',
  'user:www-data:r--\nmask::r--\nmask::rwx'])assert.equal(nginxAclHas(raw,'user:www-data:r--'),false,raw);
});
