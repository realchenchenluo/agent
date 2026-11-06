// Local maintenance helper. Secrets and visitor cookies stay in ignored .runtime.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),privateDir=path.resolve(here,'../local/.runtime/public-deploy');
const config=JSON.parse(fs.readFileSync(path.join(here,'wrangler.jsonc'),'utf8')),origin=config.vars.PUBLIC_ORIGIN;
const secrets=JSON.parse(fs.readFileSync(path.join(privateDir,'secrets.json'),'utf8'));
const action=process.argv[2]||'status';
const save=(name,data)=>fs.writeFileSync(path.join(privateDir,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});
async function call(route,{visitor,body,headers={}}={}){
 const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{...(visitor?{Cookie:visitor.cookie,'X-CSRF-Token':visitor.csrf}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function newVisitor(){const r=await call('/api/session');if(r.status!==200)throw Error('SESSION_FAILED');return {cookie:r.cookie,csrf:r.data.csrf};}
if(action==='status'){
 const r=await call('/api/admin/status',{headers:{Authorization:'Bearer '+secrets.ADMIN_TOKEN}});
 if(r.status!==200)throw Error('ADMIN_STATUS_'+r.status);
 const evidence={checked_at:new Date().toISOString(),url:origin,...r.data};save('last-status.json',evidence);console.log(JSON.stringify(evidence,null,2));
}else if(action==='isolation'){
 const a=await newVisitor(),b=await newVisitor(),chat=await call('/api/local/chats',{visitor:a,body:{}});
 if(chat.status!==201)throw Error('CREATE_FAILED');
 const cid=chat.data.id,own=await call('/api/local/chats/'+cid,{visitor:a}),foreign=await call('/api/local/chats/'+cid,{visitor:b});
 const otherList=await call('/api/local/chats',{visitor:b}),forged=await call('/api/local/chats/'+cid,{visitor:b,headers:{'X-Verified-Owner':'f'.repeat(64)}});
 const noCsrf=await call('/api/local/chats',{visitor:a,body:{},headers:{'X-CSRF-Token':'wrong'}}),admin=await call('/api/admin/status');
 const result={checked_at:new Date().toISOString(),method:'Two independent HTTP cookie jars; no account login',own_read:own.status,foreign_read:foreign.status,forged_owner_read:forged.status,other_visitor_empty:otherList.data.conversations?.length===0,bad_csrf:noCsrf.status,anonymous_admin:admin.status,empty_actual:chat.data.state.actual.length===0};
 if(own.status!==200||foreign.status!==404||forged.status!==404||!result.other_visitor_empty||noCsrf.status!==403||admin.status!==403||!result.empty_actual)throw Error('ISOLATION_FAILED');
 save('isolation-visitors.json',{a,b,cid});save('isolation-result.json',result);console.log(JSON.stringify(result,null,2));
}else if(action==='persistence'){
 const {a,cid}=JSON.parse(fs.readFileSync(path.join(privateDir,'isolation-visitors.json'),'utf8'));const r=await call('/api/local/chats/'+cid,{visitor:a});
 if(r.status!==200||r.data.id!==cid)throw Error('PERSISTENCE_FAILED');
 const result={checked_at:new Date().toISOString(),persisted_conversation_id:cid,status:r.status,created_at:r.data.created_at};save('persistence-result.json',result);console.log(JSON.stringify(result,null,2));
}else throw Error('Use status, isolation, or persistence');
