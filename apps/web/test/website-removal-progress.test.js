import {register} from 'node:module';
register('./jsx-loader.js',import.meta.url);
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';
const {default:Progress}=await import('../src/workspace/WebsiteRemovalProgress.jsx');
const operation={id:'ws-rem-proof',status:'running',execution:{mode:'automatic'},
 steps:[{id:'one',kind:'domain_removal',status:'succeeded'},{id:'two',kind:'file_cleanup',status:'running'}],actions:{runConfirmation:'resume'}};
const render=value=>renderToStaticMarkup(createElement(Progress,{operation:value,onResume(){},onDone(){}}));
test('automatic progress renders actual phase/count and no per-step action',()=>{
 const html=render(operation);assert.match(html,/Site siliniyor/);assert.match(html,/1 \/ 2/);assert.match(html,/Dosyalar ve dosya yöneticisi/);
 assert.equal((html.match(/<button/g)??[]).length,0);assert.match(html,/<details/);
});
test('a stopped operation shows one explicit whole-operation resume action',()=>{
 const html=render({...operation,status:'blocked',steps:[operation.steps[0],{...operation.steps[1],status:'blocked',error:{code:'website_cleanup_elfinder_unverified'}}]});
 assert.equal((html.match(/<button/g)??[]).length,1);assert.match(html,/Silme işlemine devam et/);assert.match(html,/İşlem durdu/);assert.match(html,/PHP havuzu/);
});
test('completion presents only the return action after all steps succeed',()=>{
 const html=render({...operation,status:'removed',steps:operation.steps.map(step=>({...step,status:'succeeded'}))});
 assert.match(html,/Site silindi/);assert.match(html,/2 \/ 2/);assert.equal((html.match(/<button/g)??[]).length,1);assert.match(html,/Web sitelerine dön/);
});
