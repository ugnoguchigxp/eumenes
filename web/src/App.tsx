import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { createClient, type EumenesClient } from "../../client";
import { MessageList } from "./components/domains/conversation/MessageList";
import {
	BookmarkList,
	CreateBookmarkForm,
} from "./components/domains/continuity";
import { StatusBadge } from "./components/ui/StatusBadge";
import { Button, Textarea } from "./design-system";
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
	const [sidePanel, setSidePanel] = useState<"continuity" | "runs">(
		"continuity",
	);
	const historyRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const [showLatest, setShowLatest] = useState(false);
	const conversation = useConversation(client, "main");
	const runs = useRuns(client, "main");
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	const voice = useVoiceDialogue(client, store);
	const phase = useStore(store, (state) => state.phase);
	const level = useStore(store, (state) => state.level);
	const audioError = useStore(store, (state) => state.error);
	const status = useQuery({
		queryKey: ["larm", client.identity],
		queryFn: () => client.status(),
		refetchInterval: 5000,
		retry: 0,
	});
	const activeRun = runs.data?.find(
		(run) => run.status === "queued" || run.status === "running",
	);
	const messageCount = conversation.data?.messages.length ?? 0;
	useEffect(() => {
		if (followLatest.current && historyRef.current)
			historyRef.current.scrollTop = historyRef.current.scrollHeight;
	}, [messageCount, activeRun?.id]);
	function scrollLatest() {
		const history = historyRef.current;
		if (!history) return;
		history.scrollTop = history.scrollHeight;
		followLatest.current = true;
		setShowLatest(false);
	}
	function send(event: FormEvent) {
		event.preventDefault();
		const text = draft.trim();
		if (!text || submit.isPending) return;
		void submit
			.mutateAsync(text)
			.then(() => {
				setDraft((current) => (current.trim() === text ? "" : current));
			})
			.catch(() => {});
	}
	const route = [
		{
			id: "microphone",
			label: "マイク",
			active: voice.active && phase === "listening",
		},
		{ id: "asr", label: "音声認識", active: !!voice.turn && !voice.turn.text },
		{ id: "llm", label: "Gemma 4", active: !!activeRun },
		{ id: "speech", label: "音声再生", active: phase === "playing" },
	];
	return (
		<main className="app-shell">
			<header className="app-header">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">
						E
					</span>
					<span>Eumenes</span>
				</div>
				<div className="header-status">
					<span>ローカル会話</span>
					<StatusBadge
						status={
							status.data?.larm.state ??
							(status.isError ? "failed" : "connecting")
						}
					/>
				</div>
			</header>
			<div className="workspace-layout">
				<section className="chat-panel" aria-label="会話">
					<header className="chat-header">
						<div>
							<span className="section-kicker">CONVERSATION</span>
							<h1>会話</h1>
						</div>
						<span className="model-label">Gemma 4 26B-A4B</span>
					</header>
					{status.isError && (
						<p className="chat-error" role="alert">
							ローカル API に接続できません。Eumenes の backend
							と設定を確認してください。
						</p>
					)}
					{conversation.isError && (
						<p className="chat-error" role="alert">
							会話履歴を取得できませんでした。
						</p>
					)}
					<div
						className="chat-history"
						ref={historyRef}
						onScroll={(event) => {
							const target = event.currentTarget;
							followLatest.current =
								target.scrollHeight - target.scrollTop - target.clientHeight <
								80;
							setShowLatest(!followLatest.current);
						}}
					>
						<MessageList conversation={conversation.data} />
						{activeRun && (
							<div className="thinking">
								<span className="thinking-dots" aria-hidden="true">
									<i />
									<i />
									<i />
								</span>
								<output>
									{activeRun.status === "queued"
										? "応答を準備中"
										: "Gemma が応答中"}
								</output>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => cancel.mutate(activeRun.id)}
									disabled={cancel.isPending}
								>
									中止
								</Button>
							</div>
						)}
					</div>
					{showLatest && (
						<button
							className="latest-button"
							type="button"
							onClick={scrollLatest}
						>
							最新の発言へ ↓
						</button>
					)}
					<div className="chat-bottom">
						<div className="route-track" aria-label="回答の経路">
							{route.map((node, index) => (
								<div className="route-part" key={node.id}>
									{index > 0 && (
										<span className="route-arrow" aria-hidden="true">
											→
										</span>
									)}
									<span className={`route-node${node.active ? " active" : ""}`}>
										<i aria-hidden="true" />
										{node.label}
									</span>
								</div>
							))}
						</div>
						<form className="chat-composer" onSubmit={send}>
							<div className="composer-row">
								<div className="voice-controls">
									<Button
										type="button"
										variant={voice.active ? "destructive" : "secondary"}
										onClick={() =>
											void (voice.active ? voice.stop() : voice.start())
										}
										disabled={!voice.active && phase !== "idle"}
										aria-label={voice.active ? "停止" : "音声を開始"}
									>
										{voice.active ? "停止" : "音声を開始"}
									</Button>
									<meter
										className="level"
										aria-label="マイク音量"
										min={0}
										max={100}
										value={Math.min(100, level * 800)}
									/>
								</div>
								<Textarea
									aria-label="メッセージ"
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (
											(event.metaKey || event.ctrlKey) &&
											event.key === "Enter"
										)
											event.currentTarget.form?.requestSubmit();
									}}
									placeholder="メッセージを入力、または話しかけてください"
									maxLength={8000}
									rows={2}
								/>
								<Button
									type="submit"
									disabled={!draft.trim() || submit.isPending}
									aria-label="送信"
								>
									送信
								</Button>
							</div>
							<div className="composer-meta">
								<span>
									{voice.turn?.status ??
										(voice.active ? "音声を待機中" : "待機中")}
								</span>
								{voice.turn?.text && <span>認識: {voice.turn.text}</span>}
								<span className="composer-shortcut">⌘/Ctrl + Enter で送信</span>
							</div>
						</form>
						{(submit.isError || voice.error || audioError) && (
							<p className="chat-error" role="alert">
								{submit.isError
									? `送信できませんでした: ${String(submit.error)}`
									: voice.error || audioError}
							</p>
						)}
					</div>
				</section>
				<aside className="side-panel" aria-label="会話の補助情報">
					<div className="side-tabs" role="tablist" aria-label="補助情報">
						<button
							role="tab"
							aria-selected={sidePanel === "continuity"}
							onClick={() => setSidePanel("continuity")}
						>
							継続情報
						</button>
						<button
							role="tab"
							aria-selected={sidePanel === "runs"}
							onClick={() => setSidePanel("runs")}
						>
							実行記録
						</button>
					</div>
					{sidePanel === "continuity" ? (
						<section className="side-content" role="tabpanel">
							<h2>継続情報</h2>
							<p className="side-intro">残したい発言をしおりに保存できます。</p>
							<CreateBookmarkForm
								client={client}
								conversationId="main"
								messages={
									conversation.data?.messages
										.filter((message) => message.role === "user")
										.map((message) => ({
											id: message.id,
											text: message.text,
										})) ?? []
								}
							/>
							<BookmarkList client={client} conversationId="main" />
						</section>
					) : (
						<section className="side-content" role="tabpanel">
							<h2>実行記録</h2>
							<ul className="runs">
								{runs.data?.length ? (
									runs.data.map((run) => (
										<li key={run.id}>
											<div>
												<code>{run.id.slice(0, 8)}</code>{" "}
												<StatusBadge status={run.status} />
												{run.error && (
													<small className="error"> {run.error}</small>
												)}
											</div>
											{["queued", "running"].includes(run.status) && (
												<Button
													variant="secondary"
													size="sm"
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
					)}
				</aside>
			</div>
		</main>
	);
}

export function App() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { refetchOnWindowFocus: true } },
			}),
		[],
	);
	const store = useMemo(() => createAudioStore(), []);
	const client = useMemo(() => createClient(window.location.origin), []);
	return (
		<QueryClientProvider client={queryClient}>
			<Workspace client={client} store={store} />
		</QueryClientProvider>
	);
}
