import {test,expect,manifest,saveManifest,apiCall,ready,main} from './support.js';
import {nextRemovalStep} from '../../apps/web/src/workspace/website-removal-model.js';
test('@mutation The owned Website can be removed through its real guarded removal lifecycle',async({liveApi,page})=>{
 test.setTimeout(240000);const m=manifest();expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);await ready(page,'/websites/'+m.fixture.domainId+'/settings');
 const r=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/removal');const current=manifest();current.fixture.operations.push({action:'site.removal.preview',httpStatus:r.status,code:r.body.error?.code,at:new Date().toISOString()});saveManifest(current);expect(r.status,'A ready Website must have a valid removal preview').toBe(200);
 const preview=r.data.preview;expect(preview.readyToStart).toBe(true);const start=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/removal',{previewDigest:preview.previewDigest,confirmation:preview.confirmation});expect(start.status).toBe(201);let op=start.data;
 for(let n=0;n<40&&op.status!=='removed';n++){const step=nextRemovalStep(op);expect(step).toBeTruthy();const result=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/website-removal-operations/'+op.id+'/continue',{expectedUpdatedAt:op.updatedAt,stepId:step.stepId,confirmation:step.confirmation});expect(result.status).toBe(200);op=result.data;expect(['failed','blocked']).not.toContain(op.status);}
 expect(op.status).toBe('removed');expect((await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId)).status).toBe(404);await expect(main(page)).not.toContainText('Silme akışı kullanılamıyor');
});
