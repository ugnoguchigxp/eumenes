import { ResearchTaskCard } from "./domains/agent-runtime";
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
import { ResizableWorkspace } from "./components/domains/artifact/ResizableWorkspace";
import { TimerArtifact } from "./components/domains/timers/TimerArtifact";
import { useTimerArtifacts } from "./domains/timers/useTimerArtifacts";
import { TimerNotifications } from "./components/domains/timers/TimerNotifications";
import { useTimerTone } from "./domains/audio";
import { useArtifactWorkspace } from "./domains/artifact";
import { type AudioStore, createAudioStore } from "./domains/audio";
import { useConversation } from "./domains/conversation";
import {
	useCancel,
	useRuns,
	useSubmit,
	useRunProgress,
} from "./domains/dialogue";
import { useReplay, useVoiceDialogue } from "./domains/voice-dialogue";
import { ServiceTestsPanel } from "./domains/service-tests";
import { ResearchRoutesPanel } from "./domains/research-routes";
import { createUnsavedFlags } from "./unsavedFlags";
import { SettingsPage, useSettings, useVoiceMute } from "./domains/settings";
import { changeRoots, queryRoots } from "./queryKeys";
import {
	describeConnectionState,
	describeError,
	describeTurnStatus,
} from "./errorMessages";

function MicLevelMeter({ store }: { store: AudioStore }) {
	const level = useStore(store, (state) => state.level);
	return (
		<meter
			className="level"
			aria-label="マイク音量"
			min={0}
			max={100}
			value={Math.min(100, level * 800)}
		/>
	);
}

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
	// Settings and research-route edits are tracked apart; leaving the page checks both.
	const unsaved = useRef(createUnsavedFlags());
	const onDirty = useCallback((v: boolean) => {
		unsaved.current.set("settings", v);
	}, []);
	const onRoutesDirty = useCallback((v: boolean) => {
		unsaved.current.set("routes", v);
	}, []);
	useEffect(() => {
		const prevent = (e: BeforeUnloadEvent) => {
			if (unsaved.current.any()) e.preventDefault();
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, []);
	const artifacts = useArtifactWorkspace();
	const openTimer = useCallback(
		(ref: { timerId: string }, title: string) => {
			artifacts.open({
				id: `timer:${ref.timerId}`,
				kind: "timer",
				title,
				timerId: ref.timerId,
			});
		},
		[artifacts],
	);
	const settings = useSettings(client);
	const usage = useQuery({
		queryKey: [queryRoots.inferenceUsage, client.identity],
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
				unsaved.current.any() &&
				!window.confirm("設定の未保存の変更を破棄して会話に戻りますか？")
			) {
				window.history.replaceState(null, "", "#settings");
				return;
			}
			unsaved.current.reset();
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
	const watchTimerRun = useTimerArtifacts(client, openTimer, runs.data);
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	const voice = useVoiceDialogue(
		client,
		store,
		undefined,
		settings.data?.voice,
	);
	const playTimerTone = useTimerTone(
		settings.data?.voice,
		voice.audio,
		(text, signal) => client.replayAudio(text, signal),
	);
	const replay = useReplay(client, settings.data?.voice, {
		sessionAudio: voice.audio,
		interruptLive: voice.interrupt,
	});
	const mute = useVoiceMute(client);
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
				// Queries refetch through refetchOnWindowFocus; only the stream needs a nudge.
				client.reconnectChanges();
			}, 100);
		};
		window.addEventListener("focus", resume);
		document.addEventListener("visibilitychange", resume);
		return () => {
			clearTimeout(pending);
			window.removeEventListener("focus", resume);
			document.removeEventListener("visibilitychange", resume);
		};
	}, [client]);
	useEffect(
		() =>
			client.subscribeChanges((kind) => {
				if (kind === "reset") {
					void cache.invalidateQueries();
					return;
				}
				for (const root of changeRoots)
					void cache.invalidateQueries({ queryKey: [root] });
			}),
		[client, cache],
	);
	const status = useQuery({
		queryKey: [queryRoots.larm, client.identity],
		queryFn: () => client.status(),
		retry: 0,
	});
	const reconnect = useMutation({
		mutationFn: () => client.connectLarm(),
		retry: false,
		onSuccess: (data) => {
			cache.setQueryData([queryRoots.larm, client.identity], data);
			client.reconnectChanges();
			void cache.invalidateQueries();
		},
	});
	const connectionError = status.data?.larm.error;
	const connectionState =
		status.data?.larm.state ?? (status.isError ? "failed" : "connecting");
	const latestRun = runs.data?.at(-1);
	const activeRun = runs.data
		?.slice()
		.reverse()
		.find((run) => run.status === "queued" || run.status === "running");
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
			.then((run) => {
				if (run?.id) watchTimerRun(run.id);
				setInput((current) =>
					current === sentInput ? { text: "", dictated: false } : current,
				);
			})
			.catch(() => {});
	}
	useEffect(() => {
		if (voice.turn?.runId) watchTimerRun(voice.turn.runId);
	}, [voice.turn?.runId, watchTimerRun]);
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
					renderServiceTests={(disabled) => (
						<ServiceTestsPanel client={client} disabled={disabled} />
					)}
					renderResearchRoutes={(disabled) => (
						<ResearchRoutesPanel
							client={client}
							disabled={disabled}
							onDirty={onRoutesDirty}
						/>
					)}
					client={client}
					onDirty={onDirty}
					onSaved={() => {
						void cache.invalidateQueries();
					}}
				/>
			)}
			{settings.data?.general.subtitles.enabled &&
				!settingsOpen &&
				(replay.subtitle ?? (phase === "playing" ? voice.subtitle : null)) && (
					<Subtitle
						text={
							replay.subtitle ??
							(phase === "playing" ? voice.subtitle : null) ??
							""
						}
						style={settings.data.general.subtitles.style}
						size={settings.data.general.subtitles.size}
					/>
				)}
			<ResizableWorkspace
				hidden={settingsOpen}
				artifact={
					artifacts.tabs.length > 0 ? (
						<ArtifactPanel
							tabs={artifacts.tabs}
							activeTabId={artifacts.activeTabId}
							onSelect={artifacts.select}
							onClose={artifacts.close}
							renderTimer={(timerId) => (
								<TimerArtifact client={client} timerId={timerId} />
							)}
						/>
					) : null
				}
			>
				<section className="chat-panel" aria-label="会話">
					<LightAvatarBackground
						active={!settingsOpen}
						cue={replay.avatarCue ?? voice.avatarCue}
						phase={
							phase === "playing"
								? "neutral"
								: activeRun
									? "thinking"
									: voice.active
										? "listening"
										: "neutral"
						}
					/>
					<div className="conversation-status" aria-label="接続状態とモデル">
						<span
							className="connection-health"
							data-state={connectionState}
							aria-label={`LARMの接続状態: ${describeConnectionState(connectionState)}`}
						>
							<i className="health-dot" aria-hidden="true" />
							<span>LARM</span>
							<span className="health-state">
								{describeConnectionState(connectionState)}
							</span>
						</span>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								artifacts.open({
									id: "ui-showcase",
									title: "UIショーケース",
									kind: "showcase",
									content: "",
								})
							}
						>
							UIショーケース
						</Button>
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
					{replay.error && (
						<p className="chat-error" role="alert">
							{replay.error}
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
						<MessageList
							conversation={conversation.data}
							renderFollowingMessage={(message) => {
								const run = runs.data?.find(
									(r) => r.inputMessageId === message.id,
								);
								return run?.agentTaskId ? (
									<ResearchTaskCard
										client={client}
										rootRunId={run.id}
										title={message.text}
										agentName={settings.data?.general.agentName}
									/>
								) : null;
							}}
							streaming={streamingText}
							agentName={settings.data?.general.agentName}
							replayingId={replay.playingId}
							onReplay={(message) =>
								replay.playingId === message.id
									? replay.stop()
									: void replay.play(message.id, message.text, message.runId)
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
						<TimerNotifications
							client={client}
							playTone={playTimerTone}
							inputBusy={() => voice.audio()?.isInputBusy?.() ?? false}
							muted={mute.muted || settings.data?.voice.outputVolume === 0}
							busy={
								!mute.ready ||
								settings.isPending ||
								!!activeRun ||
								(!!voice.turn &&
									[
										"recognizing",
										"responding",
										"synthesizing",
										"ready",
									].includes(voice.turn.status)) ||
								replay.playingId !== null
							}
						/>
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
											void (voice.active
												? voice.pause()
												: (replay.stop(), voice.start()))
										}
										disabled={!voice.active && phase !== "idle"}
										aria-label={voice.active ? "マイクを停止" : "音声を開始"}
									>
										{voice.active ? "マイクを停止" : "音声を開始"}
									</Button>
									<Button
										type="button"
										variant={mute.muted ? "destructive" : "secondary"}
										size="icon"
										onClick={() => void mute.toggle()}
										disabled={!mute.ready || mute.busy}
										aria-pressed={mute.muted}
										aria-label={mute.muted ? "ミュートを解除" : "ミュート"}
										title={
											mute.error ??
											(mute.muted
												? "読み上げをオフにしています"
												: "読み上げをオフにする")
										}
									>
										<svg
											width="20"
											height="20"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.8"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="M11 5 6 9H3v6h3l5 4z" />
											{mute.muted ? (
												<path d="m16 9 5 6M21 9l-5 6" />
											) : (
												<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
											)}
										</svg>
									</Button>
									<MicLevelMeter store={store} />
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
									{(voice.turn?.status
										? describeTurnStatus(voice.turn.status)
										: null) ?? (voice.active ? "音声を待機中" : "待機中")}
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
									? `送信できませんでした: ${describeError(submit.error)}`
									: voice.error ||
										(audioError ? describeError(audioError) : null)}
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
			</ResizableWorkspace>
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
