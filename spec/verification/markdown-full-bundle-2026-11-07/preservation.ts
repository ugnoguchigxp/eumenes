import {writeFile} from 'node:fs/promises';
import {unified} from '../markdown-plate-2026-11-07/node_modules/unified/index.js';
import remarkParse from '../markdown-plate-2026-11-07/node_modules/remark-parse/index.js';
import remarkGfm from '../markdown-plate-2026-11-07/node_modules/remark-gfm/index.js';
import remarkFrontmatter from '../markdown-plate-2026-11-07/node_modules/remark-frontmatter/index.js';
import remarkMath from '../markdown-plate-2026-11-07/node_modules/remark-math/index.js';
import {fixtures} from '../markdown-plate-2026-11-07/fixtures';
import {createMarkdownEditor,importMarkdown,serializeMarkdown} from '../../../packages/design-system/src/components/MarkdownWorkspace/editor';
import {encodeArchive,decodeArchive} from '../../../api/domains/markdown';
const parser=unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkMath);
// The same semantic comparison as the frozen minimal experiment, without changing its cases.
function canonical(text:string){const tree=parser.parse(text);const definitions=new Map<string,any>();function collect(n:any){if(n.type==='definition')definitions.set(n.identifier,n);for(const c of n.children??[])collect(c);}collect(tree);function clean(n:any):any{if(Array.isArray(n))return n.filter(c=>c?.type!=='definition').map(clean);if(!n||typeof n!=='object')return n;if(['linkReference','imageReference'].includes(n.type)){const d=definitions.get(n.identifier);if(d)return clean({type:n.type==='linkReference'?'link':'image',url:d.url,title:d.title,...(n.type==='imageReference'?{alt:n.alt}:{children:n.children})});}return Object.fromEntries(Object.entries(n).filter(([k])=>k!=='position').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,clean(v)]));}return clean(tree);}
const results=[];
for(const fixture of fixtures){try{const document=importMarkdown(fixture.text),editor=createMarkdownEditor(document),output=serializeMarkdown(editor);const restored=decodeArchive(encodeArchive(crypto.randomUUID(),fixture.id,document as any,output));results.push({id:fixture.id,group:fixture.group,byteEqual:fixture.text===output,astEqual:JSON.stringify(canonical(fixture.text))===JSON.stringify(canonical(output)),exactEditor:JSON.stringify(restored.document)===JSON.stringify(document),exactOriginal:restored.document.originalMarkdown===fixture.text,output});}catch(error){results.push({id:fixture.id,group:fixture.group,error:String(error)});}}
const summary={total:results.length,byteEqual:results.filter(r=>r.byteEqual).length,astEqual:results.filter(r=>r.astEqual).length,exactEditor:results.filter(r=>r.exactEditor).length,exactOriginal:results.filter(r=>r.exactOriginal).length,coreFailures:results.filter(r=>r.group==='core'&&!r.astEqual).map(r=>r.id),extendedFailures:results.filter(r=>r.group==='extended'&&!r.astEqual).map(r=>r.id)};
await writeFile(`${import.meta.dir}/preservation-results.json`,JSON.stringify({summary,results},null,2)+'\n');console.log(JSON.stringify(summary));
if(summary.exactEditor!==27||summary.exactOriginal!==27)process.exitCode=1;
