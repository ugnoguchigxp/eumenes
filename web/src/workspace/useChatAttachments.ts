import { useSettings } from "../domains/settings";
import type { ImageInputStatus } from "../../../api/domains/inference/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import {
	attachmentLimits,
	type Attachment,
} from "../../../api/domains/conversation/contracts";
import { describeError } from "../errorMessages";

const acceptsImages = (status: ImageInputStatus | undefined) =>
	status?.primary.status === "supported" ||
	(status?.primary.status === "failed" &&
		status.fallback?.status === "supported");

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
	const settingsRevision = useSettings(client).data?.revision;
	const [capability, setCapability] = useState<ImageInputStatus>();
	const check = useRef<AbortController | null>(null);
	const [checking, setChecking] = useState(false);
	const [items, setItems] = useState<DraftImage[]>([]);
	const current = useRef(items);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const urls = useRef(new Set<string>());
	useEffect(
		() => () => {
			check.current?.abort();
			for (const url of urls.current) URL.revokeObjectURL(url);
		},
		[],
	);
	const checkConnection = useCallback(() => {
		check.current?.abort();
		const controller = new AbortController();
		check.current = controller;
		setChecking(true);
		setCapability(undefined);
		setError(undefined);
		void client
			.imageInput(controller.signal)
			.then((status) => {
				if (controller.signal.aborted) return;
				setCapability(status);
				if (!acceptsImages(status))
					setError(
						"選択中の接続先の画像入力を確認できません。接続先を確認してください。",
					);
			})
			.catch((e) => {
				if (!controller.signal.aborted) setError(describeError(e));
			})
			.finally(() => {
				if (!controller.signal.aborted) setChecking(false);
			});
	}, [client]);

	useEffect(() => {
		if (current.current.length) checkConnection();
		// Each revision selects a new route. Old requests are aborted by checkConnection.
		return () => {
			check.current?.abort();
		};
	}, [checkConnection, settingsRevision]);

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
	/** Attachments the host already saved (e.g. a still with its detections from another screen). */
	function addSaved(saved: { attachment: Attachment; file: File }[]) {
		setError(undefined);
		const fresh = saved.filter(
			(s) => !current.current.some((i) => i.id === s.attachment.id),
		);
		if (current.current.length + fresh.length > attachmentLimits.maxImages) {
			setError("添付は8枚までです。画像を減らしてください。");
			return;
		}
		const appended = fresh.map(({ attachment, file }) => {
			const url = URL.createObjectURL(file);
			urls.current.add(url);
			return { id: attachment.id, file, url, saved: attachment };
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
			if (snapshot.length && !acceptsImages(capability))
				throw new Error(
					capability?.primary.status === "unsupported"
						? "image_not_supported"
						: "image_capability_unknown",
				);
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
	return {
		items,
		capability,
		add,
		addSaved,
		remove,
		upload,
		clear,
		busy: busy || checking,
		error,
	};
}
