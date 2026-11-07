import { useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import { scratchLimits } from "../../../api/domains/scratch/contracts";
import { describeError } from "../errorMessages";

/** The files besides images a message can carry: shared with the agents, never the model's input (scratch spec §12). */
export const CHAT_FILE_ACCEPT = ".md,.markdown,.txt,.csv,.json,.pdf,.glb";
const ACCEPTED = /\.(md|markdown|txt|csv|json|pdf|glb)$/i;
const MAX_FILES = 8;

export type DraftFile = { id: string; name: string; size: number; file: File };

export function fileSizeText(bytes: number) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** The files chosen for the next message; each is uploaded as a shared file on send, under its own id. */
export function useChatFiles(client: EumenesClient, conversationId: string) {
	const [items, setItems] = useState<DraftFile[]>([]);
	const current = useRef(items);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const set = (next: DraftFile[]) => {
		current.current = next;
		setItems(next);
	};
	function add(files: File[]) {
		setError(undefined);
		if (current.current.length + files.length > MAX_FILES) {
			setError(`ファイルは${MAX_FILES}件までです。`);
			return;
		}
		if (files.some((f) => !ACCEPTED.test(f.name))) {
			setError("Markdown・テキスト・CSV・JSON・PDF・GLBのファイルを選んでください。");
			return;
		}
		if (files.some((f) => f.size > scratchLimits.itemBytes)) {
			setError("1ファイルは100 MiBまでです。");
			return;
		}
		if (files.some((f) => f.size === 0)) {
			setError("空のファイルは添付できません。");
			return;
		}
		set([
			...current.current,
			...files.map((file) => ({
				id: crypto.randomUUID(),
				name: file.name,
				size: file.size,
				file,
			})),
		]);
	}
	function remove(id: string) {
		set(current.current.filter((item) => item.id !== id));
		setError(undefined);
	}
	/** Uploads the snapshot (a resend finds each file under the same id) and returns their ids. */
	async function upload(snapshot: DraftFile[]) {
		if (!snapshot.length) return [];
		setBusy(true);
		setError(undefined);
		try {
			const ids: string[] = [];
			for (const item of snapshot) {
				const saved = await client.uploadScratchFile(
					conversationId,
					item.id,
					item.file,
				);
				ids.push(saved.id);
			}
			return ids;
		} catch (e) {
			setError(describeError(e));
			throw e;
		} finally {
			setBusy(false);
		}
	}
	function clear(snapshot: DraftFile[]) {
		const sent = new Set(snapshot.map((item) => item.id));
		set(current.current.filter((item) => !sent.has(item.id)));
	}
	return { items, add, remove, upload, clear, busy, error };
}
export type ChatFiles = ReturnType<typeof useChatFiles>;
