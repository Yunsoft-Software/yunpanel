// Inspect Nginx's effective named-user access without changing ACL receipts.
// Canonical receipts omit getfacl's comments, so derive access from the mask.
export function nginxAclHas(output,entry){
 const separator=entry.lastIndexOf(':'),identity=entry.slice(0,separator+1),required=entry.slice(separator+1);
 const rows=String(output??'').split(/\r?\n/).map(line=>line.trim().match(
  /^((?:default:)?(?:user|group|mask|other):[^\s]*:)([rwx-]{3})(?:\s+#effective:([rwx-]{3}))?$/,
 )).filter(Boolean);
 const entries=rows.filter(row=>row[1]===identity),masks=rows.filter(row=>row[1]===(identity.startsWith('default:')?'default:mask::':'mask::'));
 if(entries.length!==1||masks.length>1||entries[0][2].includes('w'))return false;
 const actual=entries[0],mask=masks[0]?.[2];
 const effective=mask?[...actual[2]].map((value,index)=>value!=='-'&&mask[index]===value?value:'-').join(''):(actual[3]??actual[2]);
 if(mask&&actual[3]&&actual[3]!==effective)return false;
 return effective===required;
}
