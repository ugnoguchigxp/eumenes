import '../../../packages/design-system/dist/design-system.css';
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import { MarkdownWorkspaceView, type MarkdownResource } from '../../../packages/artifact-ui/src/markdown-components';
import { ArtifactRuntimeContext } from '../../../packages/artifact-ui/src/runtime';
const id='ffedb2c6-0a8d-4b7d-b2dc-2e2daef64672';
const initial:MarkdownResource={kind:'markdown-workspace',revision:1,current:{id,title:'企画メモ',document:{formatVersion:1,nodes:[{type:'h1',children:[{text:'新しい企画'}]},{type:'p',children:[{text:'前文 '}]},{type:'h2',children:[{text:'検討すること'}]},{type:'p',children:[{text:'人とAIが同じ文書を編集できます。'}]}],originalMarkdown:'# 新しい企画\r\n\r\n前文  \r\n'},revision:1,sourceId:null,dirty:true,saveState:'unsaved',saveError:null},documents:[{id,title:'企画メモ'}],library:[],archiveAvailable:true,sessionState:'active',busy:false};
let current=initial,update:(v:MarkdownResource)=>void;
const staged=new Map<string,any>();let release:(()=>void)|null=null,hold=false,holdReceipt=false,releaseReceipt:(()=>void)|null=null;
const events:any[]=[];
function App(){const [data,setData]=useState(initial);update=v=>{current=v;setData(v);};return <ArtifactRuntimeContext.Provider value={{snapshot:{'markdown-workspace':data},uploadFile:async(_s,file)=>{const value=JSON.parse(await file.text()),key=crypto.randomUUID();staged.set(key,value);return {status:'accepted',message:'',value:key};},dispatch:async event=>{
 events.push(event);const input=event.values;
 if(event.action==='markdown-apply'){
  const frozen=staged.get(String(input.stageId));if(Number(input.expectedRevision)!==current.revision)return {status:'rejected',message:'revision_conflict'};
  if(hold)await new Promise<void>(resolve=>release=resolve);
  const revision=current.revision+1;update({...current,revision,current:{...current.current!,document:frozen.document,title:String(input.title),revision,dirty:true}});
  if(holdReceipt)await new Promise<void>(resolve=>releaseReceipt=resolve);
 }
 if(event.action==='markdown-archive' && JSON.stringify(staged.get(String(input.stageId)).document)!==JSON.stringify(current.current!.document))return {status:'rejected',message:'revision_conflict'};
 if(event.action==='markdown-archive')update({...current,current:{...current.current!,dirty:false,saveState:'saved',sourceId:'fixture-desk'}});
 return {status:'accepted',message:''};
 }}}><MarkdownWorkspaceView request={{view:'markdown-workspace',source:'markdown-workspace',title:'Markdown'}} /></ArtifactRuntimeContext.Provider>;}
(window as any).fixture={state:()=>({current,events,draft:JSON.parse(localStorage.getItem(`eumenes:markdown:draft:${id}`)??'null')}),remote:(text:string)=>{const d=structuredClone(current);d.revision++;d.current!.revision=d.revision;d.current!.document.nodes[1]={type:'p',children:[{text}]};update(d);},holdReceipt:()=>{holdReceipt=true;},releaseReceipt:()=>{holdReceipt=false;releaseReceipt?.();},hold:()=>{hold=true;},release:()=>{hold=false;release?.();},reset:()=>{localStorage.clear();location.reload();}};
createRoot(document.getElementById('root')!).render(<App/>);
