import { useVoiceSettingsRevocation } from "./useVoiceSettingsRevocation";
import { useConversationScroll } from "./useConversationScroll";
import { useVoiceDraft } from "./useVoiceDraft";
import { useNotificationAudio } from "./useNotificationAudio";
import { useAgencyAttention, useTyping } from "./useAgencyAttention";
import { useScreenSound } from "./useScreenSound";
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
import { TIMER_ADAPTER_REF } from "../domains/timers/adapter-ref";
import { useTimerArtifacts } from "../domains/timers/useTimerArtifacts";
import { useToolchainArtifacts } from "../domains/toolchain-artifacts/launcher";
import { createScreenOutput, type AudioStore } from "../domains/audio";
import { useArtifactWorkspace } from "../domains/artifact";
import { useConversation } from "../domains/conversation";
import {
	useAssignmentArtifacts,
	useCancel,
	useRuns,
	useSubmit,
} from "../domains/dialogue";
import { useSpecialistWorkspace } from "./useSpecialistWorkspace";
import { usePromptEdit } from "./usePromptEdit";
import { useDocumentTheme } from "./useDocumentTheme";
import {
	useAutomaticSpeech,
	useReplay,
	useVoiceDialogue,
} from "../domains/voice-dialogue";
import { useSettings, useVoiceMute } from "../domains/settings";
import { useWorkspaceLive } from "./useWorkspaceLive";
import { useKanbanNotices } from "../domains/kanban/useKanbanNotices";
import { useClaudeCodeArtifacts } from "../domains/terminals/useClaudeCodeArtifacts";
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
	useAssignmentArtifacts(client, "main", openByAdapter);
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
	const historyScroll = useConversationScroll();
	const conversation = useConversation(client, "main");
	// The agenda's thoughts, shown between the messages (display only; none while the agenda does not run).
	const thoughts = useQuery({
		queryKey: [queryRoots.dialogue, client.identity, "main", "agency-thoughts"],
		queryFn: ({ signal }) => client.agencyThoughts("main", signal),
		select: (data) => data.thoughts,
		retry: 0,
	});
	const debugMode =
		settings.data?.agency.debugMode === true && !settings.isError;
	const debugDiagnostics = useQuery({
		queryKey: [
			queryRoots.dialogue,
			client.identity,
			"main",
			"debug-diagnostics",
			debugMode,
		],
		queryFn: ({ signal }) => client.debugDiagnostics("main", signal),
		enabled: debugMode,
		retry: false,
	});
	const runs = useRuns(client, "main");
	const watchTimerRun = useTimerArtifacts(client, openTimer, runs.data);
	const submit = useSubmit(client, "main");
	const cancel = useCancel(client, "main");
	// Filled once the screens are known below; a spoken message refers to what is shown, like a typed one.
	const viewingNow = useRef<() => RunViewing | undefined>(() => undefined);
	const voiceClient = useMemo<EumenesClient>(
		() => ({
			...client,
			voiceCommit: (id, revision, viewing, timing) =>
				client.voiceCommit(
					id,
					revision,
					viewing ?? viewingNow.current(),
					timing,
				),
		}),
		[client],
	);
	const [screenOutput] = useState(() => createScreenOutput());
	const voice = useVoiceDialogue(
		voiceClient,
		store,
		undefined,
		settings.data?.voice,
		screenOutput.noticeQuiet,
	);
	const sound = useScreenSound(client, screenOutput, voice);
	const timerAudio = useNotificationAudio(
		settings.data?.voice,
		voice.audio,
		(text, signal) => client.replayAudio(text, signal),
		sound.notice,
	);
	const chime = timerAudio.chime;
	useClaudeCodeArtifacts(client, openClaudeCode, chime);
	const kanbanNotices = useKanbanNotices(client, chime, openById);
	const replay = useReplay(client, settings.data?.voice, {
		sessionAudio: voice.audio,
		interruptLive: voice.interrupt,
		output: screenOutput,
	});
	const live = useWorkspaceLive(client, settings.data, voice, replay);
	const speaking = useSyncExternalStore(
		screenOutput.subscribe,
		screenOutput.speaking,
	);
	const typing = useTyping(input);
	useAgencyAttention(client, "main", {
		typing,
		playing: speaking || live.playing,
	});
	const mute = useVoiceMute(client);
	const { automaticInput, editInput } = useVoiceDraft(
		input,
		setInput,
		voice,
		watchTimerRun,
	);
	useVoiceSettingsRevocation(settings.data, voice.stop, replay.stop);
	const phase = useStore(store, (state) => state.phase);
	const audioError = useStore(store, (state) => state.error);
	const cache = useQueryClient();
	useEffect(() => {
		if (!debugMode)
			cache.removeQueries({
				queryKey: [
					queryRoots.dialogue,
					client.identity,
					"main",
					"debug-diagnostics",
				],
			});
	}, [cache, client.identity, debugMode]);
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
	const larm = status.data?.phase === "ready" ? status.data.larm : undefined;
	const connectionError = larm?.error;
	const connectionState =
		larm?.state ?? (status.isError ? "failed" : "connecting");
	const latestRun = runs.data?.at(-1);
	const activeRun = runs.data
		?.slice()
		.reverse()
		.find((run) => run.status === "queued" || run.status === "running");
	const specialist = useSpecialistWorkspace({
		client,
		artifacts,
		toolchain,
		runSignature: latestRun ? `${latestRun.id}:${latestRun.status}` : "",
	});
	useAutomaticSpeech({
		runs: runs.data,
		messages: conversation.data?.messages,
		enabled: !live.active && settings.data?.voice.autoSpeak,
		player: replay,
		ownsSpeech: voice.ownsSpeech,
		blocked:
			!!voice.turn?.runId &&
			["responding", "synthesizing", "ready"].includes(voice.turn.status),
		screen: sound,
		speaker: specialist.session,
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
		voice.takeInputOwnership,
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
	return {
		attachments,
		live,
		playbackScreen: sound.playbackScreen,
		openLiveSettings: () => void openById("settings.live"),
		openAsrSettings: () => void openById("settings.ai-connections"),
		draft,
		artifacts,
		openDrawing,
		openRecognition,
		openPlaylist,
		toolchain,
		activeTimers,
		settings,
		actualModel,
		...historyScroll,
		conversation,
		thoughts,
		debugMode,
		debugDiagnostics,
		runs,
		voice,
		timerAudio,
		kanbanNotices,
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
