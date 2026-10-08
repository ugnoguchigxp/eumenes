import {
	QueryClient,
	QueryClientProvider,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import { createClient, type EumenesClient } from "../../client";
import { MessageList } from "./components/domains/conversation/MessageList";
import { LightAvatarBackground } from "./components/domains/conversation/LightAvatarBackground";
import { Button, Textarea } from "./design-system";
import { Subtitle } from "./components/domains/subtitle/Subtitle";
import { ArtifactPanel } from "./components/domains/artifact/ArtifactPanel";
import { useArtifactWorkspace } from "./domains/artifact";
import { type AudioStore, createAudioStore } from "./domains/audio";
import { useConversation } from "./domains/conversation";
import {
	useCancel,
	useRuns,
	useSubmit,
	useRunProgress,
} from "./domains/dialogue";
import { useVoiceDialogue } from "./domains/voice-dialogue";
import { SettingsPage, useSettings } from "./domains/settings";

function Workspace({
	client,
	store,
}: {
	client: EumenesClient;
	store: AudioStore;
}) {
	const [input, setInput] = useState({ text: "", dictated: false });
	const draft = input.text;
	const editedRecognition = useRef<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(
		window.location.hash.startsWith("#settings"),
	);
	const dirtySettings = useRef(false);
	const onDirty = useCallback((v: boolean) => {
		dirtySettings.current = v;
	}, []);
	const artifacts = useArtifactWorkspace();
	const settings = useSettings(client);
	const usage = useQuery({
		queryKey: ["inference-usage", client.identity],
		queryFn: () => client.inferenceUsage(),
		retry: 0,
	});
	const actualModel = usage.data?.find(
		(u) => u.purpose === "llm" && u.accepted,
	);
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const theme = settings.data?.general.theme ?? "system";
			document.documentElement.dataset.theme =
				theme === "system" ? (media.matches ? "dark" : "light") : theme;
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [settings.data?.general.theme]);
	useEffect(() => {
		const navigate = () => {
			const open = window.location.hash.startsWith("#settings");
			if (
				!open &&
				dirtySettings.current &&
				!window.confirm("設定の未保存の変更を破棄して会話に戻りますか？")
			) {
				window.history.replaceState(null, "", "#settings");
				return;
			}
			dirtySettings.current = false;
			setSettingsOpen(open);
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	const historyRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const [showLatest, setShowLatest] = useState(false);
	const conversation = useConversation(client, "main");
	const runs = useRuns(client, "main");
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	const voice = useVoiceDialogue(
		client,
		store,
		undefined,
		settings.data?.voice,
	);
	const automaticInput = input.dictated && voice.active;
	const recognitionId = voice.recognitionId;
	const recognitionText = voice.transcription?.text;
	useEffect(() => {
		if (
			!recognitionId ||
			!recognitionText ||
			editedRecognition.current === recognitionId
		)
			return;
		// This is the external ASR result; manual edits take ownership for this utterance.
		// oxlint-disable-next-line react/set-state-in-effect
		setInput({ text: recognitionText, dictated: true });
	}, [recognitionId, recognitionText]);
	const previousSettings = useRef(settings.data);
	useEffect(() => {
		const old = previousSettings.current;
		const next = settings.data;
		previousSettings.current = next;
		if (!old || !next || old.revision === next.revision) return;
		const revoked =
			(["llm", "asr", "tts"] as const).some(
				(p) => old.routes[p].epoch !== next.routes[p].epoch,
			) ||
			old.connections.some((c) => {
				const n = next.connections.find((n) => n.id === c.id);
				return !n || n.epoch !== c.epoch || (c.enabled && !n.enabled);
			});
		if (revoked) void voice.stop();
	}, [settings.data, voice]);
	const phase = useStore(store, (state) => state.phase);
	const level = useStore(store, (state) => state.level);
	const audioError = useStore(store, (state) => state.error);
	const cache = useQueryClient();
	const changesState = useSyncExternalStore(
		client.subscribeChangesState,
		client.changesState,
	);
	useEffect(() => {
		let pending: ReturnType<typeof setTimeout> | undefined;
		const resume = () => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(pending);
			pending = setTimeout(() => {
				client.reconnectChanges();
				void cache.invalidateQueries();
			}, 100);
		};
		window.addEventListener("focus", resume);
		document.addEventListener("visibilitychange", resume);
		return () => {
			clearTimeout(pending);
			window.removeEventListener("focus", resume);
			document.removeEventListener("visibilitychange", resume);
		};
	}, [client, cache]);
	useEffect(
		() =>
			client.subscribeChanges(() => {
				void cache.invalidateQueries();
			}),
		[client, cache],
	);
	const status = useQuery({
		queryKey: ["larm", client.identity],
		queryFn: () => client.status(),
		retry: 0,
	});
	const reconnect = useMutation({
		mutationFn: () => client.connectLarm(),
		retry: false,
		onSuccess: (data) => {
			cache.setQueryData(["larm", client.identity], data);
			client.reconnectChanges();
			void cache.invalidateQueries();
		},
	});
	const connectionError = status.data?.larm.error;
	const connectionState =
		status.data?.larm.state ?? (status.isError ? "failed" : "connecting");
	const latestRun = runs.data?.at(-1);
	const activeRun = runs.data?.find(
		(run) => run.status === "queued" || run.status === "running",
	);
	const messageCount = conversation.data?.messages.length ?? 0;
	const streamingText = useRunProgress(client, activeRun?.id);
	useEffect(() => {
		if (followLatest.current && historyRef.current)
			historyRef.current.scrollTop = historyRef.current.scrollHeight;
	}, [messageCount, activeRun?.id, streamingText]);
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
		if (!text || automaticInput || submit.isPending) return;
		const sentInput = input;
		void submit
			.mutateAsync(text)
			.then(() => {
				setInput((current) =>
					current === sentInput ? { text: "", dictated: false } : current,
				);
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
		{ id: "llm", label: "回答", active: !!activeRun },
		{ id: "speech", label: "音声再生", active: phase === "playing" },
	];
	return (
		<main className="app-shell">
			<Button
				className={`floating-settings${settingsOpen ? " floating-settings-close" : ""}`}
				variant="secondary"
				size="icon"
				aria-label={settingsOpen ? "会話に戻る" : "設定"}
				title={settingsOpen ? "会話に戻る" : "設定"}
				onClick={() => {
					window.location.hash = settingsOpen ? "conversation" : "settings";
				}}
			>
				<svg
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={settingsOpen ? 2.2 : 1.8}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					{settingsOpen ? (
						<path d="M6 6l12 12M18 6 6 18" />
					) : (
						<>
							<path d="m9.5 3-.5 2-2 1.2-2-.6-2.5 4.3L4 11.3v2l-1.5 1.4L5 19l2-.6 2 1.2.5 2.4h5l.5-2.4 2-1.2 2 .6 2.5-4.3-1.5-1.4v-2l1.5-1.4L19 5.6l-2 .6L15 5l-.5-2z" />
							<circle cx="12" cy="12" r="3" />
						</>
					)}
				</svg>
			</Button>
			{settingsOpen && (
				<SettingsPage
					client={client}
					onDirty={onDirty}
					onSaved={() => {
						void cache.invalidateQueries();
					}}
				/>
			)}
			{settings.data?.general.subtitles.enabled &&
				voice.subtitle &&
				phase === "playing" &&
				!settingsOpen && (
					<Subtitle
						text={voice.subtitle}
						style={settings.data.general.subtitles.style}
						size={settings.data.general.subtitles.size}
					/>
				)}
			<div
				className={`workspace-layout${artifacts.tabs.length ? " workspace-layout-split" : ""}`}
				hidden={settingsOpen}
			>
				<section className="chat-panel" aria-label="会話">
					<LightAvatarBackground active={!settingsOpen} />
					<div className="conversation-status" aria-label="接続状態とモデル">
						<span
							className="connection-health"
							data-state={connectionState}
							aria-label={`LARMの接続状態: ${connectionState}`}
						>
							<i className="health-dot" aria-hidden="true" />
							<span>LARM</span>
							<span className="health-state">{connectionState}</span>
						</span>
						<span className="model-label">
							{actualModel?.source === "cloud" && "クラウド / "}
							{actualModel?.model ?? settings.data?.larm.profile}
						</span>
					</div>
					{status.isError && (
						<p className="chat-error" role="alert">
							ローカル API に接続できません。Eumenes の backend
							と設定を確認してください。
						</p>
					)}
					{connectionError && (
						<p className="chat-error" role="alert">
							LARM に接続できませんでした: {connectionError}
						</p>
					)}
					{changesState === "failed" && !status.isError && (
						<p className="chat-error" role="alert">
							更新情報に接続できません。文字起こしや回答の表示が遅れる場合があります。
						</p>
					)}
					{(status.isError ||
						changesState === "failed" ||
						["failed", "unconfigured", "idle"].includes(
							status.data?.larm.state ?? "",
						)) && (
						<Button
							variant="secondary"
							onClick={() => reconnect.mutate()}
							disabled={reconnect.isPending}
						>
							{reconnect.isPending ? "接続を確認中" : "接続を再確認"}
						</Button>
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
						<MessageList
							conversation={conversation.data}
							streaming={streamingText}
							onOpenArtifact={(message) =>
								artifacts.open({
									id: `message:${message.id}`,
									title:
										message.text.replace(/\s+/g, " ").trim().slice(0, 24) ||
										"回答",
									kind: "markdown",
									content: message.text,
								})
							}
						/>
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
										: "回答を作成中"}
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
									onChange={(event) => {
										editedRecognition.current = recognitionId ?? null;
										setInput({ text: event.target.value, dictated: false });
									}}
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
									disabled={!draft.trim() || automaticInput || submit.isPending}
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
								<span className="composer-shortcut">
									{automaticInput
										? "音声入力は自動送信されます"
										: "⌘/Ctrl + Enter で送信"}
								</span>
							</div>
						</form>
						{(submit.isError || voice.error || audioError) && (
							<p className="chat-error" role="alert">
								{submit.isError
									? `送信できませんでした: ${String(submit.error)}`
									: voice.error || audioError}
							</p>
						)}
						{latestRun?.status === "failed" && (
							<p className="chat-error" role="alert">
								回答を取得できませんでした:{" "}
								{latestRun.error ?? "応答に失敗しました"}
							</p>
						)}
					</div>
				</section>
				{artifacts.tabs.length > 0 && (
					<ArtifactPanel
						tabs={artifacts.tabs}
						activeTabId={artifacts.activeTabId}
						onSelect={artifacts.select}
						onClose={artifacts.close}
						onCloseAll={artifacts.closeAll}
					/>
				)}
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
