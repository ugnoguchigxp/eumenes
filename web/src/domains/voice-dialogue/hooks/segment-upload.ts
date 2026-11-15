import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { VoiceIssue } from "./index";
import { queryRoots } from "../../../queryKeys";
import { type CreateAudio } from "../../audio";
import { createInputLedger } from "./input-timing";
import { createVoiceMachine } from "./machine";
import { type RecognitionCandidate } from "./input-session";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;
type Replacement = { id: string; previous: string | null } | null;
/** Serial uploads preserve the accepting session's token, retry and cancellation rules. */
export function createSegmentUploader(deps: {
	client: VoiceDialogueClient;
	cache: QueryClient;
	machine: ReturnType<typeof createVoiceMachine>;
	candidate: Ref<RecognitionCandidate | null>;
	upload: Ref<{ token: number; tail: Promise<void> } | null>;
	inputs: Ref<ReturnType<typeof createInputLedger>>;
	replacement: Ref<Replacement>;
	setInputVersion: Setter<number>;
	setRecognitionId: Setter<string | null>;
	submitted: (id: string) => void;
	setTurnId: Setter<string | null>;
	setError: Setter<VoiceIssue | null>;
	suspendInput: () => void;
	cancelPlayback: () => void;
	live: () => boolean;
	inputLive: () => boolean;
	sessionToken: number;
}): Parameters<CreateAudio>[2] {
	const {
		client,
		cache,
		machine,
		candidate,
		upload,
		inputs,
		replacement,
		setInputVersion,
		setRecognitionId,
		submitted,
		setTurnId,
		setError,
		suspendInput,
		cancelPlayback,
		live,
		inputLive,
		sessionToken,
	} = deps;
	return (wav, timing) => {
		const active = machine.get().session;
		if (!inputLive() || !active || active.failed) return;
		const pauseAfterUpload = active.pending >= 2;
		const old = machine.get().current;
		const pending = candidate.current;
		candidate.current = null;
		setInputVersion((v) => v + 1);
		const id = pending?.id ?? crypto.randomUUID();
		setRecognitionId(id);
		submitted(id);
		// Also becomes the current turn and drops the previous turn's delivered chunks.
		const sequence = machine.dispatch({
			type: "segment_accepted",
			utteranceId: id,
			preserveCurrent: true,
		}).session!.sequence;
		const uploads = upload.current;
		if (!uploads) return;
		uploads.tail = uploads.tail
			.then(async () => {
				if (!live() || machine.get().session?.failed) return;
				let accepted: VoiceTurn;
				try {
					accepted = await client.voiceSend(
						active.id,
						active.generation,
						sequence,
						id,
						wav,
					);
				} catch (error) {
					if (!(error instanceof TypeError) || !live()) throw error;
					await new Promise((resolve) => setTimeout(resolve, 250));
					if (!live()) return;
					accepted = await client.voiceSend(
						active.id,
						active.generation,
						sequence,
						id,
						wav,
					);
				}
				if (!live()) return;
				inputs.current.uploaded(id, timing);
				replacement.current = { id, previous: old };
				cache.setQueryData(
					[queryRoots.voiceDialogue, client.identity, id],
					accepted,
				);
				setTurnId(id);
			})
			.catch((e) => {
				if (!live()) return;
				setError({
					cause: e,
					turn: { utteranceId: id, sessionId: active.id, runId: null },
				});
				// The failed upload also drops any unsent segments behind it.
				candidate.current = null;
				machine.dispatch({
					type: "upload_failed",
					sessionToken,
					previous: old,
				});
				suspendInput();
				setRecognitionId(old);
				cancelPlayback();
				if (old)
					void cache.invalidateQueries({
						queryKey: [queryRoots.voiceDialogue, client.identity, old],
					});
			})
			.finally(() => {
				machine.dispatch({ type: "upload_settled", sessionToken });
				if (live()) setInputVersion((v) => v + 1);
			});
		if (pauseAfterUpload) {
			// Retain this final segment, then prevent more recording from piling up.
			suspendInput();
			setError({
				notice:
					"録音を送信待ちに追加しました。送信が進んだらマイクを再開してください。",
			});
		}
	};
}
