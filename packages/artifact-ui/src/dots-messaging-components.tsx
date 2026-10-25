import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Textarea,
} from "@eumenes/design-system";
import {
	DotsConnectionGuide,
	type DotsConnectionSetup,
} from "./dots-connection-guide";
import { useId, useState } from "react";
import type { ArtifactRequest } from "./contracts";
import { useAction, Feedback } from "./components";
export type DotsMessagingResource = {
	kind: "dots-messaging";
	setup?: DotsConnectionSetup;
	revision: number;
	connections: Array<{ id: string; label: string }>;
	connectionRef: string;
	enabled: boolean;
	subscribed: boolean;
	confirmed: boolean;
	busy: boolean;
	canSend: boolean;
	hasMore?: boolean;
	items: Array<{
		id: string;
		revision: number;
		state: string;
		delivery?: { state: string; httpStatus: number | null } | null;
		text: string | null;
		reply: {
			replyText: string | null;
			summary: string | null;
			limitations: string[];
		} | null;
	}>;
};
const states: Record<string, string> = {
	pending: "受付済み・返答を待っています",
	claimed: "dots が取得・返答を待っています",
	answered: "返答受信",
	failed: "返答できませんでした",
	cancelled: "取消済み",
	expired: "期限切れ",
};
export function DotsMessagingView({ request }: { request: ArtifactRequest }) {
	const { resource, send, pending, message } = useAction(request);
	const r = resource as DotsMessagingResource;
	const [text, setText] = useState("");
	const selectId = useId(),
		inputId = useId();
	const active = r.items.find(
		(x) => x.state === "pending" || x.state === "claimed",
	);
	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>{request.title ?? "dots メッセージ"}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<label htmlFor={selectId}>接続先</label>
					<select
						id={selectId}
						value={r.connectionRef}
						disabled={pending || r.busy}
						onChange={(e) => {
							void send("dots-message-select", {
								connectionRef: e.target.value,
							});
						}}
					>
						<option value="">接続先を選択</option>
						{r.connections.map((c) => (
							<option key={c.id} value={c.id}>
								{c.label}
							</option>
						))}
					</select>
					<output>
						{!r.connectionRef
							? "接続先を選んでください。"
							: !r.enabled
								? "メッセージ連携は停止中です。"
								: !r.subscribed
									? "dots 側で監視を開始・更新してください。"
									: "" +
										(r.confirmed ? "送信可能" : "初回の返答で接続を確認します")}
					</output>
					<div className="flex gap-2">
						<Button
							disabled={!r.connectionRef || pending || r.busy}
							onClick={() => {
								void send("dots-message-toggle", {});
							}}
						>
							{r.enabled
								? "メッセージ連携を解除"
								: "メッセージ連携を有効にする"}
						</Button>
						<Button
							variant="outline"
							disabled={pending}
							onClick={() => {
								void send("dots-message-refresh", {});
							}}
						>
							状態を更新
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						dots
						の監視登録後に送信できます。連携後のやり取りから返答と要約を受け取ります。
					</p>
				</CardContent>
			</Card>
			{r.setup && <DotsConnectionGuide setup={r.setup} />}
			<section aria-label="dotsとのやり取り" className="space-y-3">
				{r.items.map((m) => (
					<Card key={m.id}>
						<CardContent className="space-y-2 pt-4">
							<p className="text-sm text-muted-foreground">
								{m.state === "pending" && m.delivery?.state === "delivered"
									? "通知受付済み・返答を待っています"
									: (states[m.state] ?? m.state)}
							</p>
							<p className="whitespace-pre-wrap">
								{m.text ?? "本文の保持期間が終了しました"}
							</p>
							{m.reply && (
								<>
									<h3>dots の返答</h3>
									<p className="whitespace-pre-wrap">
										{m.reply.replyText ?? "本文は削除済みです"}
									</p>
									{m.reply.summary !== null && (
										<details>
											<summary>dots の要約</summary>
											<p className="whitespace-pre-wrap">{m.reply.summary}</p>
										</details>
									)}
									{m.reply.limitations.map((v, i) => (
										<p key={i} className="text-sm">
											{v}
										</p>
									))}
								</>
							)}
							{["pending", "claimed"].includes(m.state) && (
								<Button
									variant="outline"
									disabled={pending}
									onClick={() => {
										void send("dots-message-cancel", {
											messageId: m.id,
											expectedRevision: String(m.revision),
										});
									}}
								>
									送信を取り消す
								</Button>
							)}
						</CardContent>
					</Card>
				))}
			</section>
			{r.hasMore && (
				<Button
					variant="outline"
					disabled={pending}
					onClick={() => {
						void send("dots-message-more", {});
					}}
				>
					続きの履歴を表示
				</Button>
			)}
			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					void send("dots-message-send", { text }).then((ok) => {
						if (ok) setText("");
					});
				}}
			>
				<label htmlFor={inputId}>dotsへのメッセージ</label>
				<Textarea
					id={inputId}
					value={text}
					onChange={(e) => setText(e.target.value)}
					disabled={pending || r.busy}
				/>
				<Button
					type="submit"
					disabled={!r.canSend || !!active || pending || r.busy || !text.trim()}
				>
					送信
				</Button>
			</form>
			<Feedback message={message} />
		</div>
	);
}
