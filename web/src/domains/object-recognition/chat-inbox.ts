import { create } from "zustand";
import type { EumenesClient } from "../../../../client";
import { artifactIdOf } from "../toolchain-artifacts/launcher";

type Attachment = Awaited<ReturnType<EumenesClient["recognitionAttach"]>>;

/** A saved chat attachment (a still with its detections) waiting for the chat input to take it. */
export type RecognitionChatImage = { attachment: Attachment; file: File };

/** The screen hands attachments to the chat input through this queue; the input drains it. */
export const useRecognitionChatInbox = create<{
	items: RecognitionChatImage[];
	push: (item: RecognitionChatImage) => void;
	take: () => RecognitionChatImage[];
}>((set, get) => ({
	items: [],
	push: (item) => set((s) => ({ items: [...s.items, item] })),
	take: () => {
		const items = get().items;
		if (items.length) set({ items: [] });
		return items;
	},
}));

const workspaceArtifactId = "object-recognition.workspace";
/** The still the focused recognition tab shows, sent with a message so "this photo" has a referent. */
export function recognitionViewing(
	tab:
		| { kind: string; artifactRevisionId?: string; targetRef?: string }
		| null
		| undefined,
): { artifactRevisionId: string; targetRef: string } | undefined {
	return tab?.kind === "toolchain" &&
		tab.artifactRevisionId &&
		tab.targetRef &&
		artifactIdOf(tab.artifactRevisionId) === workspaceArtifactId
		? { artifactRevisionId: tab.artifactRevisionId, targetRef: tab.targetRef }
		: undefined;
}
