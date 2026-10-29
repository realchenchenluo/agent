// Copy pinned, same-origin OCR assets. No runtime CDN or image upload is used.
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=process.argv[2];
if(!source)throw Error('Supply a node_modules folder installed from the pinned ocr-package.json dependency list.');
const dest=path.join(here,'ocr-assets'),files=[];
const copy=(src,target)=>{const output=path.join(dest,target);mkdirSync(path.dirname(output),{recursive:true});copyFileSync(path.join(source,src),output);files.push({path:target,sha256:createHash('sha256').update(readFileSync(output)).digest('hex')});};
copy('tesseract.js/dist/tesseract.min.js','tesseract.min.js');
copy('tesseract.js/dist/worker.min.js','worker.min.js');
for(const base of ['tesseract-core-lstm','tesseract-core-simd-lstm'])copy(`tesseract.js-core/${base}.wasm.js`,`core/${base}.wasm.js`);
for(const lang of ['eng','chi_sim'])copy(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,`lang/${lang}.traineddata.gz`);
copy('tesseract.js/LICENSE.md','LICENSE-tesseract.js');
copy('tesseract.js-core/LICENSE','LICENSE-tesseract-core');
writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({tesseract:'6.0.1',core:JSON.parse(readFileSync(path.join(source,'tesseract.js-core/package.json'))).version,language_data:'1.0.0 / 4.0.0_best_int',data_license:'Apache-2.0 (tesseract-ocr/tessdata_best)',files},null,2)+'\n');
