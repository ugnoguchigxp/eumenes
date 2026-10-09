import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Modal, Switch, Textarea } from "@eumenes/design-system";
import { useId, useRef, useState } from "react";
import type { ArtifactEvent, ArtifactRequest, Field, FormResource, ImageResource, MemoryResource, QuestionResource, SettingsResource } from "./contracts";
import { useArtifactRuntime } from "./runtime";

function useAction(request: ArtifactRequest) {
	const runtime = useArtifactRuntime();
	const lock = useRef(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const source = request.source ?? `inline-${request.view}`;
	async function send(action: ArtifactEvent["action"], values: ArtifactEvent["values"]) {
		if (lock.current) return;
		lock.current = true;
		setPending(true);
		try {
			const receipt = await runtime.dispatch({ id: crypto.randomUUID(), source, revision: runtime.snapshot[source]?.revision ?? 0, action, values });
			setMessage(receipt.message);
		} catch { setMessage("操作に失敗しました。もう一度お試しください"); }
		finally { lock.current = false; setPending(false); }
	}
	return { send, pending, message, source, resource: runtime.snapshot[source] };
}
function Feedback({ message }: { message: string }) { return <p role="status" className="aui-feedback">{message}</p>; }
export function ComponentsView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	return <Card><CardHeader><CardTitle>{request.title ?? "DesignSystem の基本部品"}</CardTitle></CardHeader><CardContent>
		<div className="aui-stack"><p>余白・色・入力部品を共通の DesignSystem で揃えます。</p><div className="aui-row"><Badge>OpenUI</Badge><Badge variant="secondary">Artifact</Badge></div>
		<div className="aui-grid"><Card><CardContent>Grid の左側</CardContent></Card><Card><CardContent>Grid の右側</CardContent></Card></div>
		<label>入力の見本<Input placeholder="ここに入力できます" /></label><div className="aui-row"><Button disabled={action.pending} onClick={() => void action.send("demo-click", {})}>試す</Button><Button variant="secondary" disabled>無効なボタン</Button></div><Feedback message={action.message} /></div>
	</CardContent></Card>;
}
export function ImageFrame({ request }: { request: ArtifactRequest }) {
	const { snapshot } = useArtifactRuntime();
	const image = snapshot[request.source!] as ImageResource;
	const [open, setOpen] = useState(false);
	const [brokenUrl, setBrokenUrl] = useState<string>();
	const ready = image.status === "succeeded" && image.url && brokenUrl !== image.url;
	const status = brokenUrl === image.url && image.url ? "画像を読み込めませんでした" : {queued:"生成を待っています",running:"画像を生成中です",succeeded:"画像が完成しました",failed:"画像生成に失敗しました",cancelled:"画像生成を取り消しました"}[image.status];
	return <Card><CardHeader><CardTitle>{request.title ?? "生成した画像"}</CardTitle></CardHeader><CardContent>
		<figure className="aui-frame">
			{ready ? <button type="button" className="aui-image-button" aria-label="画像を全画面で表示" onClick={() => setOpen(true)}><img src={image.url} alt={image.alt} onError={() => setBrokenUrl(image.url)} /></button> : <div className="aui-placeholder" aria-label="画像のプレースホルダー"><span aria-hidden="true">◇</span><span>{status}</span></div>}
			<figcaption role="status">{status}</figcaption>
		</figure>
		{ready && <a className="aui-download" href={image.url} download="generated-image.svg">画像をダウンロード</a>}
		<Modal open={!!ready && open} onOpenChange={setOpen} title="生成画像の全画面表示" draggable={false} className="aui-fullscreen"><img className="aui-fullscreen-image" src={image.url} alt={image.alt} /></Modal>
	</CardContent></Card>;
}
export function QuestionView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as QuestionResource;
	const [answer, setAnswer] = useState("");
	const prefix = useId();
	const disabled = action.pending || data.status !== "open";
	return <Card><CardHeader><CardTitle>{request.title ?? "少し教えてください"}</CardTitle></CardHeader><CardContent>
		<form className="aui-stack" onSubmit={event => {event.preventDefault(); if(answer.trim() && !disabled) void action.send("answer",{answer:answer.trim()});}}>
			<p>{data.question.prompt}</p>
			{data.question.options ? <fieldset disabled={disabled}><legend>回答を選択</legend>{data.question.options.map((option,i) => <label className="aui-row" key={option}><input id={`${prefix}-${i}`} type="radio" name={prefix} value={option} checked={answer === option} onChange={() => setAnswer(option)} required />{option}</label>)}</fieldset> : <label>回答<Textarea value={answer} onChange={e => setAnswer(e.target.value)} disabled={disabled} required maxLength={2000}/></label>}
			<Button type="submit" disabled={disabled || !answer.trim()}>回答する</Button>
			<Feedback message={data.status === "answered" ? `回答済み: ${data.answer}` : data.status === "expired" ? "この質問は期限切れです" : action.message} />
		</form>
	</CardContent></Card>;
}
function FieldInput({field,value,onChange,disabled,prefix}:{field:Field;value:string|boolean;onChange:(value:string|boolean)=>void;disabled:boolean;prefix:string}) {
	const id = `${prefix}-${field.id}`;
	return <label htmlFor={id} className="aui-field">{field.label}{field.required && "（必須）"}
		{field.type === "boolean" ? <input id={id} type="checkbox" checked={value === true} onChange={e=>onChange(e.target.checked)} disabled={disabled} required={field.required}/> : field.type === "select" ? <select id={id} value={String(value)} onChange={e=>onChange(e.target.value)} disabled={disabled} required={field.required}><option value="">選んでください</option>{field.options?.map(o=><option key={o}>{o}</option>)}</select> : field.type === "textarea" ? <Textarea id={id} value={String(value)} onChange={e=>onChange(e.target.value)} disabled={disabled} required={field.required} maxLength={2000}/> : <Input id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={e=>onChange(e.target.value)} disabled={disabled} required={field.required} maxLength={2000}/>}
	</label>;
}
export function SmallForm({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as FormResource;
	const [values,setValues] = useState(data.defaults);
	const prefix=useId();
	return <Card><CardHeader><CardTitle>{request.title ?? "希望を入力"}</CardTitle></CardHeader><CardContent>
		<form className="aui-stack" onSubmit={e=>{e.preventDefault(); if(!action.pending) void action.send("submit",values);}}>
			{data.fields.map(field=><FieldInput key={field.id} prefix={prefix} field={field} value={values[field.id] ?? (field.type === "boolean" ? false : "")} disabled={action.pending} onChange={value=>setValues(v=>({...v,[field.id]:value}))}/>)}
			<div className="aui-row"><Button type="submit" disabled={action.pending}>{action.pending ? "送信中" : "フォームを送信"}</Button><Button type="button" variant="secondary" disabled={action.pending} onClick={()=>setValues(data.defaults)}>入力をリセット</Button></div><Feedback message={action.message}/>
		</form>
	</CardContent></Card>;
}
export function MemoryReview({request}:{request:ArtifactRequest}) {
	const action=useAction(request);
	const data=action.resource as MemoryResource;
	const [drafts,setDrafts]=useState<Record<string,string>>({});
	return <Card><CardHeader><CardTitle>{request.title ?? "覚えている情報を確認"}</CardTitle></CardHeader><CardContent><div className="aui-stack">
		<p>試用データです。選んだ情報を会話に渡す操作と、内容の訂正を試せます。</p>
		{data.entries.map(entry=><div className="aui-stack aui-memory-entry" key={entry.id}><label className="aui-row"><input type="checkbox" checked={entry.selected} disabled={action.pending} onChange={e=>void action.send("memory-select",{id:entry.id,selected:e.target.checked})}/>会話に渡す: {entry.text}</label><label>メモリーの内容<Textarea value={drafts[entry.id] ?? entry.text} maxLength={2000} onChange={e=>setDrafts(v=>({...v,[entry.id]:e.target.value}))}/></label><Button disabled={action.pending || !(drafts[entry.id] ?? entry.text).trim()} onClick={()=>void action.send("memory-correct",{id:entry.id,text:(drafts[entry.id] ?? entry.text).trim()})}>訂正を反映</Button></div>)}<Feedback message={action.message}/>
	</div></CardContent></Card>;
}
export function SettingsForm({request}:{request:ArtifactRequest}) {
	const action=useAction(request);
	const data=action.resource as SettingsResource;
	const [values,setValues]=useState({theme:data.theme,autoSpeak:data.autoSpeak,volume:String(data.volume)});
	const prefix=useId();
	return <Card><CardHeader><CardTitle>{request.title ?? "表示と音声"}</CardTitle></CardHeader><CardContent><form className="aui-stack" onSubmit={e=>{e.preventDefault();void action.send("settings-save",values);}}>
		<p>この画面の試用データだけを変更します。</p><label>表示テーマ<select value={values.theme} onChange={e=>setValues(v=>({...v,theme:e.target.value as "light"|"dark"}))} disabled={action.pending}><option value="light">ライト</option><option value="dark">ダーク</option></select></label>
		<label className="aui-row" htmlFor={`${prefix}-speak`}>回答を読み上げる<Switch id={`${prefix}-speak`} checked={values.autoSpeak} onCheckedChange={autoSpeak=>setValues(v=>({...v,autoSpeak}))} disabled={action.pending}/></label>
		<label htmlFor={`${prefix}-volume`}>音量: {values.volume}<input id={`${prefix}-volume`} type="range" min="0" max="100" value={values.volume} onChange={e=>setValues(v=>({...v,volume:e.target.value}))} disabled={action.pending}/></label>
		<Button type="submit" disabled={action.pending}>設定を保存</Button><Feedback message={action.message}/>
	</form></CardContent></Card>;
}
