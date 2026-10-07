import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { useStore } from "zustand";
import { createClient, type EumenesClient } from "../../client";
import { MessageList } from "./components/domains/conversation/MessageList";
import {
	BookmarkList,
	CreateBookmarkForm,
} from "./components/domains/continuity";
import { Button } from "./components/ui/Button";
import { StatusBadge } from "./components/ui/StatusBadge";
import { type AudioStore, createAudioStore } from "./domains/audio";
import { useConversation } from "./domains/conversation";
import { useCancel, useRuns, useSubmit } from "./domains/dialogue";
import { useVoiceDialogue } from "./domains/voice-dialogue";

function Workspace({
	client,
	store,
}: {
	client: EumenesClient;
	store: AudioStore;
}) {
	const [draft, setDraft] = useState("");
	const conversation = useConversation(client, "main");
	const runs = useRuns(client, "main");
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	const voice = useVoiceDialogue(client, store);
	const phase = useStore(store, (s) => s.phase);
	const level = useStore(store, (s) => s.level);
	const audioError = useStore(store, (s) => s.error);
	const status = useQuery({
		queryKey: ["larm", client.identity],
		queryFn: () => client.status(),
		refetchInterval: 5000,
		retry: 0,
	});
	function send(event: FormEvent) {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		submit.mutate(text);
		setDraft("");
	}
	return (
		<main className="shell">
			<p className="eyebrow">Personal voice companion</p>
			<h1 className="title">Eumenes</h1>
			<p className="sub">
				日本語で話しかけてください。会話と実行状況はローカルの保存先から読み直されます。
			</p>
			<section className="panel">
				<div className="row">
					<strong>音声対話</strong>
					<StatusBadge status={phase} />
					<StatusBadge status={status.data?.larm.state ?? "connecting"} />
					<meter
						className="level"
						aria-label="マイク音量"
						min={0}
						max={100}
						value={Math.min(100, level * 800)}
					/>
				</div>
				<p className="hint">
					マイクとヘッドホンで使ってください。再生中もマイク入力を受け付けます。
				</p>
				<div className="row">
					<Button
						onClick={() => void voice.start()}
						disabled={voice.active || phase !== "idle"}
					>
						音声を開始
					</Button>
					<Button
						className="secondary"
						onClick={() => void voice.stop()}
						disabled={!voice.active}
					>
						停止
					</Button>
					<span>{voice.turn?.status ?? "待機中"}</span>
				</div>
				{voice.turn?.text && <p>認識: {voice.turn.text}</p>}
				{(voice.error || audioError) && (
					<p className="error" role="alert">
						{voice.error || audioError}
					</p>
				)}
			</section>
			<section className="panel">
				<h2>会話</h2>
				{conversation.isError && <p className="error">履歴を取得できません</p>}
				<MessageList conversation={conversation.data} />
				<form className="composer" onSubmit={send}>
					<input
						aria-label="メッセージ"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="文字で話しかける"
						maxLength={8000}
					/>
					<Button disabled={!draft.trim() || submit.isPending}>送信</Button>
				</form>
				{submit.isError && (
					<p className="error" role="alert">
						送信できませんでした: {String(submit.error)}
					</p>
				)}
			</section>
			<section className="panel">
				<h2>継続情報</h2>
				<CreateBookmarkForm
					client={client}
					conversationId="main"
					messages={
						conversation.data?.messages
							.filter((message) => message.role === "user")
							.map((message) => ({ id: message.id, text: message.text })) ?? []
					}
				/>
				<BookmarkList client={client} conversationId="main" />
			</section>
			<section className="panel">
				<h2>実行記録</h2>
				<ul className="runs">
					{runs.data?.length ? (
						runs.data.map((run) => (
							<li key={run.id}>
								<div>
									<code>{run.id.slice(0, 8)}</code>{" "}
									<StatusBadge status={run.status} />
									{run.error && <small className="error"> {run.error}</small>}
								</div>
								{["queued", "running"].includes(run.status) && (
									<Button
										className="secondary"
										onClick={() => cancel.mutate(run.id)}
									>
										取消
									</Button>
								)}
							</li>
						))
					) : (
						<li className="hint">記録はまだありません</li>
					)}
				</ul>
			</section>
		</main>
	);
}
export function App() {
	const [input, setInput] = useState("");
	const [token, setToken] = useState("");
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { refetchOnWindowFocus: true } },
			}),
		[],
	);
	const store = useMemo(() => createAudioStore(), []);
	const client = useMemo(
		() => (token ? createClient(window.location.origin, token) : null),
		[token],
	);
	if (!client)
		return (
			<main className="shell">
				<p className="eyebrow">Local setup</p>
				<h1 className="title">Eumenes</h1>
				<section className="panel">
					<h2>ローカル API に接続</h2>
					<p className="hint">
						起動時に設定した EUMENES_API_TOKEN
						を入力してください。画面内の一時状態として使います。
					</p>
					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault();
							if (input.trim()) setToken(input.trim());
						}}
					>
						<input
							className="token-input"
							type="password"
							aria-label="API トークン"
							value={input}
							onChange={(e) => setInput(e.target.value)}
						/>
						<Button>接続</Button>
					</form>
				</section>
			</main>
		);
	return (
		<QueryClientProvider client={queryClient}>
			<Workspace client={client} store={store} />
		</QueryClientProvider>
	);
}
