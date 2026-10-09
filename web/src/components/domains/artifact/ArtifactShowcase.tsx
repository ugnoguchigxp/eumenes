import { ArtifactRenderer, compileArtifact, compileLang, viewRegistry, type View } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { Button, Textarea } from "@eumenes/design-system";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createShowcaseFixture } from "../../../domains/artifact";

const sources:Record<View,string>={components:"c1","generated-image":"g1",question:"q1",form:"f1",memory:"m1",settings:"s1"};
const sample=(view:View)=>JSON.stringify({view,source:sources[view]});
export function ArtifactShowcase() {
	const [fixture]=useState(createShowcaseFixture);
	const state=useSyncExternalStore(fixture.subscribe,fixture.getSnapshot);
	const [draft,setDraft]=useState(sample("components"));
	const [compiled,setCompiled]=useState(()=>compileArtifact(sample("components"),state.resources));
	const [mode,setMode]=useState<"json"|"lang">("json");
	const [error,setError]=useState("");
	const [theme,setTheme]=useState("light");
	const [width,setWidth]=useState("full");
	const [density,setDensity]=useState("comfortable");
	const [resetKey,setResetKey]=useState(0);
	useEffect(()=>()=>fixture.dispose(),[fixture]);
	function apply(input=draft,inputMode=mode) {
		try {const result=inputMode==="json"?compileArtifact(input,state.resources):compileLang(input,state.resources);fixture.ensureInline(result.request);setCompiled(result);setError("");}
		catch {setError("定義を表示できません。登録された view・source と入力形式を確認してください。");}
	}
	function choose(view:View) {const json=sample(view);setMode("json");setDraft(json);apply(json,"json");}
	return <section className="aui-showcase" aria-label="UIショーケース">
		<header><h2>UIショーケース</h2><p>短い定義から、操作できるアーティファクトへ。すべて試用データです。</p></header>
		<nav className="aui-row" aria-label="表示サンプル">{Object.entries(viewRegistry).map(([view,entry])=><Button key={view} size="sm" variant={compiled.request.view===view?"default":"secondary"} aria-pressed={compiled.request.view===view} onClick={()=>choose(view as View)}>{entry.label}</Button>)}</nav>
		<div className="aui-row aui-controls">
			<label>プレビューのテーマ<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="light">ライト</option><option value="dark">ダーク</option></select></label>
			<label>プレビューの幅<select value={width} onChange={e=>setWidth(e.target.value)}><option value="full">全幅</option><option value="narrow">狭い幅（320px）</option></select></label>
			<label>表示の密度<select value={density} onChange={e=>setDensity(e.target.value)}><option value="comfortable">ゆったり</option><option value="compact">コンパクト</option></select></label>
		</div>
		<div className={`aui-preview ${theme === "dark"?"dark":""}`} data-theme={theme} data-density={density} data-width={width} aria-label="プレビュー">
			<ArtifactRenderer key={resetKey} lang={compiled.lang} runtime={{snapshot:state.resources,dispatch:fixture.dispatch}}/>
		</div>
		<details open className="aui-definition"><summary>定義を編集</summary><div className="aui-stack">
			<label>定義の形式<select value={mode} onChange={e=>{const next=e.target.value as "json"|"lang";setMode(next);setDraft(next==="json"?JSON.stringify(compiled.request):compiled.lang);}}><option value="json">短い JSON</option><option value="lang">OpenUI Lang（登録した表示のみ）</option></select></label>
			<label>UIの定義<Textarea className="aui-code" rows={4} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={20000}/></label>
			<div className="aui-row"><Button onClick={()=>apply()}>定義を表示</Button><span>{new TextEncoder().encode(draft).length} bytes</span></div>{error && <p role="alert">{error}</p>}
			<details><summary>変換後の OpenUI Lang</summary><pre>{compiled.lang}</pre></details>
		</div></details>
		<details open><summary>状態と操作を試す</summary><div className="aui-stack aui-fixture-controls">
			<div className="aui-row"><label>画像の完成まで<select value={state.delayMs} onChange={e=>fixture.configure({delayMs:Number(e.target.value)})}><option value="500">0.5秒</option><option value="60000">1分</option></select></label><Button variant="secondary" onClick={fixture.startImage}>画像生成を開始</Button><Button variant="secondary" onClick={()=>fixture.imageState("succeeded")}>画像を完成</Button><Button variant="secondary" onClick={()=>fixture.imageState("failed")}>生成失敗</Button><Button variant="secondary" onClick={()=>fixture.imageState("succeeded",true)}>画像読込失敗</Button><Button variant="secondary" onClick={()=>fixture.imageState("cancelled")}>生成を取消</Button></div>
			<div className="aui-row"><Button variant="secondary" onClick={()=>fixture.questionMode(true)}>自由回答に変更</Button><Button variant="secondary" onClick={()=>fixture.questionMode(false)}>選択回答に変更</Button><Button variant="secondary" onClick={fixture.expireQuestion}>質問を期限切れにする</Button><Button variant="secondary" onClick={fixture.refresh}>参照データを更新</Button><Button variant="secondary" aria-pressed={state.failNext} onClick={()=>fixture.configure({failNext:!state.failNext})}>次の送信を失敗させる</Button><Button variant="secondary" onClick={()=>{fixture.reset();setResetKey(k=>k+1);choose("components");}}>試用データを初期化</Button></div>
		</div></details>
		<details><summary>参照データ</summary><pre aria-label="参照データ">{JSON.stringify(state.resources,null,2)}</pre></details>
		<details open><summary>操作イベント</summary><ol className="aui-events" aria-label="操作イベント">{state.events.map((event,i)=><li key={`${i}:${event}`}>{event}</li>)}</ol></details>
	</section>;
}
