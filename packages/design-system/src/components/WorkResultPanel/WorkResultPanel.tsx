import { useState } from "react";
import { Button } from "../Button";
import { Badge } from "../Badge";
import { Textarea } from "../Textarea";
export type WorkResultPanelProps = {
	title: string;
	status: string;
	summary?: string;
	sections?: readonly { title: string; items: readonly string[] }[];
	question?: { id: string; prompt: string; choices: readonly string[] };
	busy?: boolean;
	canPause?: boolean;
	canCancel?: boolean;
	onAnswer?: (text: string) => Promise<boolean>;
	onPause?: () => void;
	onCancel?: () => void;
	request?: string;
	conditions?: readonly string[];
	sessions?: readonly string[];
	message?: string;
};
/** Render host-provided work data and allowed actions; owns no API or lifecycle decisions. */
export function WorkResultPanel(props: WorkResultPanelProps) {
	const [tab, setTab] = useState("summary"),
		[answer, setAnswer] = useState("");
	return (
		<section className="min-w-0 space-y-4" aria-label="仕事の詳細">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-lg font-semibold break-words">{props.title}</h2>
				<Badge variant="secondary">{props.status}</Badge>
			</div>
			{props.message && (
				<p role="status" className="text-sm text-muted-foreground">
					{props.message}
				</p>
			)}
			{props.question && (
				<div className="rounded-lg border p-4 space-y-3">
					<h3 className="font-semibold">回答が必要です</h3>
					<p className="whitespace-pre-wrap break-words">
						{props.question.prompt}
					</p>
					{props.question.choices.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{props.question.choices.map((c) => (
								<Button
									key={c}
									variant="outline"
									disabled={props.busy}
									onClick={() => setAnswer(c)}
								>
									{c}
								</Button>
							))}
						</div>
					)}
					<Textarea
						aria-label="質問への回答"
						value={answer}
						maxLength={8000}
						disabled={props.busy}
						onChange={(e) => setAnswer(e.target.value)}
					/>
					<Button
						disabled={props.busy || !answer.trim()}
						onClick={async () => {
							if (await props.onAnswer?.(answer)) setAnswer("");
						}}
					>
						回答を送る
					</Button>
				</div>
			)}
			<div role="tablist" aria-label="仕事の表示" className="flex gap-2">
				{[
					["summary", "要約"],
					["results", "成果"],
					["request", "依頼内容"],
				].map(([id, label]) => (
					<Button
						key={id}
						role="tab"
						aria-selected={tab === id}
						variant={tab === id ? "secondary" : "ghost"}
						onClick={() => setTab(id!)}
					>
						{label}
					</Button>
				))}
			</div>
			<div role="tabpanel" className="space-y-3 break-words">
				{tab === "summary" && (
					<p className="whitespace-pre-wrap">
						{props.summary || "結果はまだ届いていません。"}
					</p>
				)}
				{tab === "results" && (
					<>
						{props.sections?.map((s) => (
							<div key={s.title} className="rounded-lg border p-3">
								<h3 className="font-semibold">{s.title}</h3>
								<ul className="list-disc pl-5">
									{s.items.map((v, i) => (
										<li key={i} className="whitespace-pre-wrap">
											{v}
										</li>
									))}
								</ul>
							</div>
						))}
						{!props.sections?.length && <p>保存された成果はありません。</p>}
						<p className="text-sm text-muted-foreground">
							{props.sessions?.length
								? `実作業Session: ${props.sessions.length}件`
								: "実作業Sessionの開始は未確認です。"}
						</p>
					</>
				)}
				{tab === "request" && (
					<>
						<p className="whitespace-pre-wrap">{props.request}</p>
						<h3>完了条件</h3>
						<ul className="list-disc pl-5">
							{props.conditions?.map((v, i) => (
								<li key={i}>{v}</li>
							))}
						</ul>
					</>
				)}
			</div>
			<div className="flex flex-wrap gap-2">
				{props.canPause && (
					<Button
						variant="outline"
						disabled={props.busy}
						onClick={props.onPause}
					>
						一時停止
					</Button>
				)}
				{props.canCancel && (
					<Button
						variant="outline"
						disabled={props.busy}
						onClick={props.onCancel}
					>
						取消
					</Button>
				)}
			</div>
			<p className="text-sm text-muted-foreground">続きの依頼は会話から</p>
		</section>
	);
}
