import {mkdirSync,readFileSync,writeFileSync,cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here,'public'),{recursive:true});
cpSync(path.join(here,'ocr-assets'),path.join(here,'public','ocr'),{recursive:true});
for(const [name,target] of [['app.html','index.html'],['review.css','health.css'],['review.js','health.js']]){
 const source=readFileSync(path.join(here,name),'utf8');
 if(/\bstyle\s*=\s*["']|<style\b/i.test(source))throw Error('PUBLIC_ASSET_INLINE_STYLE_BLOCKED_BY_CSP');
 if(/127\.0\.0\.1|localhost|CHAT_BRIDGE_KEY|Bearer /.test(source))throw Error('PUBLIC_ASSET_DEPENDENCY_OR_SECRET');
 writeFileSync(path.join(here,'public',target),source);
}
const files=['holdings-extraction.mjs','worker.mjs','session.mjs','model.mjs','llm-gateway.mjs','gateway-policy.mjs','provider-adapter.mjs','cloud-transport.mjs','risk.mjs','gate.mjs','shared.mjs','trace.mjs','confirmation.mjs','review-tools.mjs','../../integrations/account-hub.js','account-hub-preview.mjs','account-hub-preview.jsonc','app.html','review.html','review.js','review.css','wrangler.jsonc','risk-wrangler.jsonc','staging.jsonc','staging-risk.jsonc','staging-smoke.mjs','staging-model-smoke.mjs','../../core/holdings-conversation.js','../../tools/holdings-readonly.js','public/index.html','public/health.js','public/health.css'];
const hashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(path.join(here,f))).digest('hex')]));
writeFileSync(path.join(here,'build-manifest.json'),JSON.stringify({built_at:new Date().toISOString(),files:hashes},null,2)+'\n');
console.log('Built integrated chat and holdings review assets; no local runtime dependencies; source manifest saved.');
