import type { ArtifactEvent, ArtifactRequest, Receipt, Resource, Snapshot } from "@eumenes/artifact-ui/contracts";

function initial(): Snapshot {
	return {
		c1:{kind:"components",revision:0},
		g1:{kind:"generated-image",revision:0,status:"queued",alt:"山と湖のイラスト"},
		q1:{kind:"question",revision:0,status:"open",question:{prompt:"回答の長さはどのくらいが良いですか？",options:["短く","詳しく"]}},
		f1:{kind:"form",revision:0,fields:[{id:"name",label:"呼び名",type:"text",required:true},{id:"detail",label:"補足",type:"textarea"},{id:"style",label:"回答のスタイル",type:"select",options:["簡潔","詳しく"]},{id:"remember",label:"覚えておく",type:"boolean"}],defaults:{name:"",detail:"",style:"",remember:false}},
		m1:{kind:"memory",revision:0,entries:[{id:"preference",text:"回答は短く、結論から知りたい",selected:false}]},
		s1:{kind:"settings",revision:0,theme:"light",autoSpeak:false,volume:60},
	};
}
export type FixtureState = { resources: Snapshot; events: string[]; failNext: boolean; delayMs: number };
/** In-memory test adapter only. Does not import a product client or database. */
export function createShowcaseFixture() {
	let state: FixtureState = {resources:initial(),events:[],failNext:false,delayMs:500};
	const listeners = new Set<()=>void>();
	const receipts = new Map<string,Receipt>();
	let epoch=0, imageEpoch=0;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	function publish(next: FixtureState) { state=next; for(const listener of listeners) listener(); }
	function log(message:string) { publish({...state,events:[message,...state.events].slice(0,30)}); }
	function update(source:string, resource:Resource) { publish({...state,resources:{...state.resources,[source]:resource}}); }
	function later(callback:()=>void,ms:number) { const timer=setTimeout(()=>{timers.delete(timer);callback();},ms);timers.add(timer); }
	function image(status:"queued"|"running"|"succeeded"|"failed"|"cancelled",url?:string) {
		const data=state.resources.g1!; update("g1",{kind:"generated-image",alt:"山と湖のイラスト",revision:data.revision+1,status,url});
	}
	return {
		getSnapshot:()=>state,
		subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
		configure:(patch:Partial<Pick<FixtureState,"failNext"|"delayMs">>)=>publish({...state,...patch}),
		startImage:()=>{
			const generation=++imageEpoch; const runEpoch=epoch;
			image("queued");log("画像生成を開始");
			later(()=>{if(generation===imageEpoch && runEpoch===epoch) image("running");},50);
			later(()=>{if(generation!==imageEpoch || runEpoch!==epoch) {log("取消後の古い画像を無視");return;} image("succeeded","/showcase/landscape.svg");log("画像の完成を受信");},state.delayMs);
		},
		imageState:(status:"failed"|"cancelled"|"succeeded",broken=false)=>{imageEpoch++;image(status,status==="succeeded"?(broken?"/showcase/missing.svg":"/showcase/landscape.svg"):undefined);log(`画像: ${broken?"読込失敗":status}`);},
		questionMode:(free:boolean)=>{const q=state.resources.q1!;update("q1",{kind:"question",revision:q.revision+1,status:"open",question:free?{prompt:"どのようにお呼びすれば良いですか？"}:{prompt:"回答の長さはどのくらいが良いですか？",options:["短く","詳しく"]}});},
		expireQuestion:()=>{const q=state.resources.q1;if(q?.kind==="question")update("q1",{...q,revision:q.revision+1,status:"expired"});},
		refresh:()=>{publish({...state,resources:Object.fromEntries(Object.entries(state.resources).map(([key,value])=>[key,{...value,revision:value.revision+1}]))});log("参照データを更新（入力を保持）");},
		ensureInline:(request:ArtifactRequest)=>{
			if(request.source)return;
			const source=`inline-${request.view}`;
			if(request.view==="question" && request.question)update(source,{kind:"question",revision:0,status:"open",question:request.question});
			if(request.view==="form" && request.fields)update(source,{kind:"form",revision:0,fields:request.fields,defaults:{}});
		},
		dispatch:async(event:ArtifactEvent):Promise<Receipt>=>{
			if(receipts.has(event.id))return {status:"duplicate",message:"同じ操作は受付済みです"};
			// Reserve before awaiting: overlapping requests with the same id cannot mutate twice.
			receipts.set(event.id,{status:"rejected",message:"受付中"});
			const runEpoch=epoch;
			const fail=state.failNext;
			if(fail)publish({...state,failNext:false});
			await new Promise<void>(resolve=>setTimeout(resolve,200));
			const data=state.resources[event.source];
			let receipt:Receipt;
			if(runEpoch!==epoch || !data || data.revision!==event.revision) receipt={status:"conflict",message:"情報が更新されました。内容を確認して再操作してください"};
			else if(fail) receipt={status:"rejected",message:"試用の送信エラーです。再試行できます"};
			else {
				let next:Resource|undefined;
				const v=event.values;
				if(event.action==="answer" && data.kind==="question" && data.status==="open" && typeof v.answer==="string" && v.answer.trim() && v.answer.length<=2000 && (!data.question.options || data.question.options.includes(v.answer))) next={...data,status:"answered",answer:v.answer};
				if(event.action==="submit" && data.kind==="form" && Object.keys(v).every(key=>data.fields.some(f=>f.id===key)) && data.fields.every(f=>{
					const value=v[f.id];
					if(value===undefined)return !f.required;
					if(f.type==="boolean")return typeof value==="boolean" && (!f.required || value);
					return typeof value==="string" && value.length<=2000 && (!f.required || !!value.trim()) && (!value || f.type!=="number" || Number.isFinite(Number(value))) && (!value || f.type!=="select" || f.options?.includes(value));
				})) next={...data,submitted:v};
				if(data.kind==="memory" && data.entries.some(e=>e.id===v.id)) {
					if(event.action==="memory-correct" && typeof v.text==="string" && v.text.trim() && v.text.length<=2000)next={...data,entries:data.entries.map(e=>e.id===v.id?{...e,text:v.text as string}:e)};
					if(event.action==="memory-select" && typeof v.selected==="boolean")next={...data,entries:data.entries.map(e=>e.id===v.id?{...e,selected:v.selected as boolean}:e)};
				}
				if(event.action==="settings-save" && data.kind==="settings" && ["light","dark"].includes(String(v.theme)) && typeof v.autoSpeak==="boolean" && typeof v.volume==="string" && v.volume!=="" && Number.isFinite(Number(v.volume)) && Number(v.volume)>=0 && Number(v.volume)<=100)next={...data,theme:v.theme as "light"|"dark",autoSpeak:v.autoSpeak,volume:Number(v.volume)};
				if(event.action==="demo-click" && data.kind==="components")next=data;
				if(next) {update(event.source,{...next,revision:data.revision+1});receipt={status:"accepted",message:"操作を受け付けました（試用データ）"};}
				else receipt={status:"rejected",message:"この操作または入力は受け付けられません"};
			}
			receipts.set(event.id,receipt);
			log(`${event.action}: ${receipt.status}`);
			return receipt;
		},
		reset:()=>{epoch++;imageEpoch++;for(const timer of timers)clearTimeout(timer);timers.clear();receipts.clear();publish({resources:initial(),events:[],failNext:false,delayMs:500});},
		dispose:()=>{epoch++;imageEpoch++;for(const timer of timers)clearTimeout(timer);timers.clear();listeners.clear();},
	};
}
