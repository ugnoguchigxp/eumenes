import { useNotificationAudio } from "./useNotificationAudio";
import { chatSend } from "./chat-send";
import { useChatAttachments } from "./useChatAttachments";
import { useDrawingArtifacts } from "../domains/excalidraw/useDrawingArtifacts";
import { useOpenDrawing, useOpenPlaylist } from "./open-artifacts";
import { useRecognitionArtifacts } from "../domains/object-recognition";
import { useRecognitionChatInbox } from "../domains/object-recognition/chat-inbox";
import type { RunViewing } from "../../../api/domains/dialogue/contracts";
import { useCurrentViewing } from "./useCurrentViewing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import type { EumenesClient } from "../../../client";
import { useImageArtifacts } from "../domains/image";
import { useMusicArtifacts, usePlaylistArtifacts } from "../domains/music";
import { activeTimersQuery } from "../domains/timers/queries";
import { TIMER_ADAPTER_REF } from "../domains/timers/toolchain-adapter";
import { useTimerArtifacts } from "../domains/timers/useTimerArtifacts";
import { useToolchainArtifacts } from "../domains/toolchain-artifacts";
import type { AudioStore } from "../domains/audio";
import { useArtifactWorkspace } from "../domains/artifact";
import { useConversation } from "../domains/conversation";
import { useCancel, useRuns, useSubmit } from "../domains/dialogue";
import { useSpecialistWorkspace } from "./useSpecialistWorkspace";
import { usePromptEdit } from "./usePromptEdit";
import { useDocumentTheme } from "./useDocumentTheme";
import {
	useAutomaticSpeech,
	useReplay,
	useVoiceDialogue,
} from "../domains/voice-dialogue";
import { useSettings, useVoiceMute } from "../domains/settings";
import { useKanbanNotices } from "../domains/kanban/useKanbanNotices";
import { useTodoNotices } from "../domains/dialogue";
import { useClaudeCodeArtifacts } from "../domains/terminals";
import { changeRoots, invalidateAllButLive, queryRoots } from "../queryKeys";

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
	const artifacts = useArtifactWorkspace();
	// Music generation and playback each own a stable screen, independent of record IDs.
	const openDrawing = useOpenDrawing(artifacts.open);
	useDrawingArtifacts(client, openDrawing);
	const openPlaylist = useOpenPlaylist(artifacts.open);
	// One launcher entry per registered artifact; the saved timer is chosen inside the screen.
	const toolchain = useToolchainArtifacts(client, artifacts.open);
	const { openByAdapter, openById } = toolchain;
	const openRecognition = useCallback(() => {
		void openById("object-recognition.workspace");
	}, [openById]);
	useRecognitionArtifacts(client, openRecognition);
	// The recognition screen's "会話に追加" lands in this chat input, not as a sent message.
	const inboxCount = useRecognitionChatInbox((s) => s.items.length);
	const addSavedImages = attachments.addSaved;
	useEffect(() => {
		if (!inboxCount) return;
		addSavedImages(useRecognitionChatInbox.getState().take());
	}, [inboxCount, addSavedImages]);
	const openClaudeCode = useCallback(() => {
		void openById("terminals.workspace");
	}, [openById]);
	const openImage = useCallback(() => {
		void openById("image.generation");
	}, [openById]);
	useImageArtifacts(client, "main", openImage);
	const openTimer = useCallback(
		(ref?: { timerId: string }) =>
			void openByAdapter(TIMER_ADAPTER_REF, ref?.timerId),
		[openByAdapter],
	);
	const openGeneratedMusic = useCallback(
		(_id: string, _title: string) => {
			void openById("music.generation");
		},
		[openById],
	);
	useMusicArtifacts(client, "main", openGeneratedMusic);
	usePlaylistArtifacts(client, "main", openPlaylist);
	const activeTimers = useQuery(activeTimersQuery(client));
	const settings = useSettings(client);
	const usage = useQuery({
		queryKey: [queryRoots.inferenceUsage, client.identity],
		queryFn: () => client.inferenceUsage(),
		retry: 0,
	});
	const stewardActivity = useQuery({
		queryKey: [queryRoots.steward, client.identity, "main"],
		queryFn: ({ signal }) => client.stewardActivity("main", signal),
		retry: 0,
	});
	const actualModel = usage.data?.find(
		(u) => u.purpose === "llm" && u.accepted,
	);
	useDocumentTheme(settings.data?.general.theme);
	const historyRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const [showLatest, setShowLatest] = useState(false);
	const conversation = useConversation(client, "main");
	const runs = useRuns(client, "main");
	const watchTimerRun = useTimerArtifacts(client, openTimer, runs.data);
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	// Filled once the screens are known below; a spoken message refers to what is shown, like a typed one.
	const viewingNow = useRef<() => RunViewing | undefined>(() => undefined);
	const voiceClient = useMemo(
		() => ({
			...client,
			voiceCommit: (id: string, revision: number) =>
				client.voiceCommit(id, revision, viewingNow.current()),
		}),
		[client],
	);
	const voice = useVoiceDialogue(
		voiceClient,
		store,
		undefined,
		settings.data?.voice,
	);
	const timerAudio = useNotificationAudio(
		settings.data?.voice,
		voice.audio,
		(text, signal) => client.replayAudio(text, signal),
	);
	const chime = timerAudio.chime;
	useClaudeCodeArtifacts(client, openClaudeCode, chime);
	const kanbanNotices = useKanbanNotices(client, chime, openById);
	const todoNotices = useTodoNotices(client, chime);
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
	// Streamed tokens are subscribed by the message list alone, so they never re-render the workspace.
	const followLatestIfPinned = useCallback(() => {
		if (followLatest.current && historyRef.current)
			historyRef.current.scrollTop = historyRef.current.scrollHeight;
	}, []);
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
	const specialist = useSpecialistWorkspace({
		client,
		artifacts,
		toolchain,
		runSignature: latestRun ? `${latestRun.id}:${latestRun.status}` : "",
	});
	const currentViewing = useCurrentViewing(
		specialist.viewing,
		artifacts.active,
	);
	useEffect(() => {
		viewingNow.current = currentViewing;
	}, [currentViewing]);
	const send = chatSend(
		input,
		setInput,
		attachments,
		submit,
		automaticInput,
		watchTimerRun,
		currentViewing,
		specialist.addresseeNow,
	);
	const edit = usePromptEdit({
		client,
		conversationId: "main",
		messages: conversation.data?.messages,
		runs: runs.data,
		recording: voice.active,
		input,
		setInput,
		watchRun: watchTimerRun,
	});
	useEffect(() => {
		if (voice.turn?.runId) watchTimerRun(voice.turn.runId);
	}, [voice.turn?.runId, watchTimerRun]);
	return {
		attachments,
		draft,
		artifacts,
		openDrawing,
		openRecognition,
		openPlaylist,
		toolchain,
		activeTimers,
		settings,
		actualModel,
		historyRef,
		showLatest,
		conversation,
		runs,
		voice,
		timerAudio,
		kanbanNotices,
		todoNotices,
		replay,
		mute,
		automaticInput,
		phase,
		audioError,
		changesState,
		status,
		reconnect,
		connectionError,
		connectionState,
		activeRun,
		followLatestIfPinned,
		scrollLatest,
		onHistoryScroll,
		editInput,
		send: edit.editing ? edit.send : send,
		edit,
		submit,
		cancel,
		specialist,
		stewardActivity,
		stewardErrorReport: (signal: AbortSignal) =>
			client.stewardErrorReport("main", signal),
	};
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;
