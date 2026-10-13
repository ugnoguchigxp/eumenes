import { chatSend } from "./chat-send";
import { useChatAttachments } from "./useChatAttachments";
import { useDrawingArtifacts } from "../domains/excalidraw/useDrawingArtifacts";
import { useOpenDrawing } from "./WorkspaceArtifacts";
import { useRecognitionArtifacts } from "../domains/object-recognition";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import type { EumenesClient } from "../../../client";
import { useImageArtifacts } from "../domains/image";
import { useMusicArtifacts, usePlaylistArtifacts } from "../domains/music";
import { activeTimersQuery } from "../domains/timers/queries";
import { useTimerArtifacts } from "../domains/timers/useTimerArtifacts";
import { useTimerTone, type AudioStore } from "../domains/audio";
import { useArtifactWorkspace } from "../domains/artifact";
import { useConversation } from "../domains/conversation";
import {
	useCancel,
	useRuns,
	useSubmit,
	useRunProgress,
} from "../domains/dialogue";
import {
	useAutomaticSpeech,
	useReplay,
	useVoiceDialogue,
} from "../domains/voice-dialogue";
import { useSettings, useVoiceMute } from "../domains/settings";
import { useSettingsDraft } from "../domains/settings/SettingsDraftHost";
import { createUnsavedFlags } from "../unsavedFlags";
import { changeRoots, invalidateAllButLive, queryRoots } from "../queryKeys";
import {
	useOpenSettings,
	useOpenImage,
	useOpenRecognition,
	useOpenMusic,
	useOpenPlaylist,
	useOpenTimer,
} from "./WorkspaceArtifacts";

export function useWorkspace({
	client,
	store,
}: {
	client: EumenesClient;
	store: AudioStore;
}) {
	const [input, setInput] = useState({ text: "", dictated: false });
	const draft = input.text;
	const attachments = useChatAttachments(client, "main");
	const editedRecognition = useRef<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(
		window.location.hash.startsWith("#settings"),
	);
	// Unsaved settings edits are checked before leaving the page.
	const unsaved = useRef(createUnsavedFlags());
	const onDirty = useCallback((v: boolean) => {
		unsaved.current.set("settings", v);
	}, []);
	useEffect(() => {
		const prevent = (e: BeforeUnloadEvent) => {
			if (unsaved.current.any()) e.preventDefault();
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, []);
	const settingsDraft = useSettingsDraft();
	useEffect(() => {
		onDirty(settingsDraft.dirty);
	}, [onDirty, settingsDraft.dirty]);
	const artifacts = useArtifactWorkspace();
	const openSettings = useOpenSettings(artifacts.open);
	// Music generation and playback each own a stable screen, independent of record IDs.
	const openDrawing = useOpenDrawing(artifacts.open);
	useDrawingArtifacts(client, openDrawing);
	const openImage = useOpenImage(artifacts.open);
	const openRecognition = useOpenRecognition(artifacts.open);
	useRecognitionArtifacts(client, openRecognition);
	useImageArtifacts(client, "main", openImage);
	const openMusic = useOpenMusic(artifacts.open);
	const openPlaylist = useOpenPlaylist(artifacts.open);
	const openTimer = useOpenTimer(artifacts.open);
	useMusicArtifacts(client, "main", openMusic);
	usePlaylistArtifacts(client, "main", openPlaylist);
	const activeTimers = useQuery(activeTimersQuery(client));
	const openArtifact = artifacts.open;
	const openShowcase = useCallback(
		() =>
			openArtifact({
				id: "ui-showcase",
				title: "UIショーケース",
				kind: "showcase",
				content: "",
			}),
		[openArtifact],
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
	const timerAudio = useTimerTone(
		settings.data?.voice,
		voice.audio,
		(text, signal) => client.replayAudio(text, signal),
	);
	const replay = useReplay(client, settings.data?.voice, {
		sessionAudio: voice.audio,
		interruptLive: voice.interrupt,
	});
	useAutomaticSpeech({
		runs: runs.data,
		messages: conversation.data?.messages,
		enabled: settings.data?.voice.autoSpeak,
		player: replay,
		ownsSpeech: voice.ownsSpeech,
		blocked:
			!!voice.turn?.runId &&
			["responding", "synthesizing", "ready"].includes(voice.turn.status),
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
		if (revoked) {
			replay.stop();
			void voice.stop();
		}
	}, [settings.data, voice, replay]);
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
				// Queries refetch through refetchOnWindowFocus; only a stream that is not
				// live needs a nudge. A live stream already delivers changes, and
				// reconnecting would force a full reset.
				if (client.changesState() === "connected") return;
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
					void invalidateAllButLive(cache);
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
			void invalidateAllButLive(cache);
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
	function onHistoryScroll(target: HTMLDivElement) {
		followLatest.current =
			target.scrollHeight - target.scrollTop - target.clientHeight < 80;
		setShowLatest(!followLatest.current);
	}
	function editInput(text: string) {
		editedRecognition.current = recognitionId ?? null;
		setInput({ text, dictated: false });
	}
	const send = chatSend(
		input,
		setInput,
		attachments,
		submit,
		automaticInput,
		watchTimerRun,
	);
	useEffect(() => {
		if (voice.turn?.runId) watchTimerRun(voice.turn.runId);
	}, [voice.turn?.runId, watchTimerRun]);
	return {
		attachments,
		draft,
		settingsOpen,
		onDirty,
		artifacts,
		openSettings,
		openDrawing,
		openImage,
		openRecognition,
		openMusic,
		openPlaylist,
		openTimer,
		activeTimers,
		openShowcase,
		settings,
		actualModel,
		historyRef,
		showLatest,
		conversation,
		runs,
		voice,
		timerAudio,
		replay,
		mute,
		automaticInput,
		phase,
		audioError,
		cache,
		changesState,
		status,
		reconnect,
		connectionError,
		connectionState,
		latestRun,
		activeRun,
		streamingText,
		scrollLatest,
		onHistoryScroll,
		editInput,
		send,
		submit,
		cancel,
	};
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;
