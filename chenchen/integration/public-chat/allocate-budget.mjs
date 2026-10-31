// One-time cloud allocation from the existing local stage authorization.
// This is a conservative budget hold, never a payment or a platform invoice.
import {readFileSync,mkdirSync,rmdirSync,appendFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHealthModel} from '../local/health-model.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(here,'../../..');
const runtime=path.resolve(here,'../local/.runtime'),directory=path.join(runtime,'health-model');
const request_id='public-chat-allocation-20261024-v1',reserved_cents=100;
const model=createHealthModel({enabled:false,directory,history:[
 {ledgerPath:path.join(runtime,'live-model-budget.json'),responsePath:path.join(repository,'docs/evidence/stage3-live-model-chain.json')},
 {ledgerPath:path.join(runtime,'live-model-quality-budget.json'),responsePath:path.join(runtime,'live-model-quality-budget.json.response.json')}
]});
const journal=path.join(directory,'budget.ndjson'),lock=path.join(directory,'budget.lock');
mkdirSync(lock);
try{
 const rows=readFileSync(journal,'utf8').trim().split('\n').map(JSON.parse),before=model.status();
 const previous=rows.find(x=>x.request_id===request_id&&x.type==='CHAT_RESERVE');
 if(previous){if(previous.reserved_cents!==reserved_cents)throw Error('ALLOCATION_MISMATCH');}
 else{
  if(Math.round(before.conservative_used_cny*100)+reserved_cents>Math.round(before.stage_cap_cny*100))throw Error('STAGE_BUDGET_EXHAUSTED');
  appendFileSync(journal,JSON.stringify({type:'CHAT_RESERVE',purpose:'CLOUD_BUDGET_ALLOCATION',request_id,at:new Date().toISOString(),reserved_cents,state:'ALLOCATED_TO_CLOUD_GATE',service:'personal-ai-fund-chat',actual_billing_cny:null,basis:'Entire cloud cap held locally; cloud usage is not additive to this hold.'})+'\n',{mode:0o600});
  const fd=openSync(journal,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 }
 const after=model.status();console.log(JSON.stringify({request_id,cloud_allocation_cny:reserved_cents/100,stage_cap_cny:after.stage_cap_cny,local_conservative_including_cloud_hold_cny:after.conservative_used_cny,unallocated_remaining_cny:after.stage_cap_cny-after.conservative_used_cny,actual_billing_cny:null}));
}finally{rmdirSync(lock);}
