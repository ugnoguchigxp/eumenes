import { useQueryClient } from "@tanstack/react-query";
import { queryRoots } from "../queryKeys";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import {
	attachmentLimits,
	type Attachment,
} from "../../../api/domains/conversation/contracts";
import { describeError } from "../errorMessages";

export type DraftImage = {
	id: string;
	file: File;
	url: string;
	saved?: Attachment;
};
export function useChatAttachments(
	client: EumenesClient,
	conversationId: string,
) {
	const cache = useQueryClient();
	const [checking, setChecking] = useState(false);
	const [items, setItems] = useState<DraftImage[]>([]);
	const current = useRef(items);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const urls = useRef(new Set<string>());
	useEffect(
		() => () => {
			for (const url of urls.current) URL.revokeObjectURL(url);
		},
		[],
	);
	function checkConnection() {
		setChecking(true);
		void client
			.connectLarm()
			.then((status) => {
				cache.setQueryData([queryRoots.larm, client.identity], status);
				if (!status.larm.chatInput)
					setError(
						"この接続先の画像入力を確認できません。接続を再確認してください。",
					);
			})
			.catch((e) => setError(describeError(e)))
			.finally(() => setChecking(false));
	}
	function add(files: File[]) {
		setError(undefined);
		if (current.current.length + files.length > attachmentLimits.maxImages) {
			setError("添付は8枚までです。画像を減らしてください。");
			return;
		}
		if (files.some((f) => f.size > attachmentLimits.maxBytes)) {
			setError("1画像は3 MiBまでです。小さくして追加してください。");
			return;
		}
		if (
			files.some(
				(f) =>
					!["image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp"].includes(
						f.type,
					) && !(f.type === "" && /\.(jpe?g|png|bmp)$/i.test(f.name)),
			)
		) {
			setError("JPG・PNG・BMPの画像を選んでください。");
			return;
		}
		const appended = files.map((file) => {
			const url = URL.createObjectURL(file);
			urls.current.add(url);
			return { id: crypto.randomUUID(), file, url };
		});
		current.current = [...current.current, ...appended];
		setItems(current.current);
		checkConnection();
	}
	function remove(id: string) {
		const item = current.current.find((i) => i.id === id);
		if (item) {
			URL.revokeObjectURL(item.url);
			urls.current.delete(item.url);
		}
		current.current = current.current.filter((i) => i.id !== id);
		setItems(current.current);
		setError(undefined);
	}
	async function upload(snapshot: DraftImage[]) {
		setBusy(true);
		setError(undefined);
		try {
			const ids: string[] = [];
			for (const item of snapshot) {
				const saved =
					item.saved ??
					(await client.uploadAttachment(conversationId, item.id, item.file));
				item.saved = saved;
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
	function clear(snapshot: DraftImage[]) {
		for (const item of snapshot) remove(item.id);
	}
	return { items, add, remove, upload, clear, busy: busy || checking, error };
}
