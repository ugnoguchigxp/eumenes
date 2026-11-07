import { useSettings } from "../domains/settings";
import type { ImageInputStatus } from "../../../api/domains/inference/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import {
	attachmentLimits,
	type Attachment,
} from "../../../api/domains/conversation/contracts";
import { describeError } from "../errorMessages";
import { useChatFiles } from "./useChatFiles";
import {
	imageContentUrl,
	libraryLoadError,
	libraryPickerItems,
	useImageLibrary,
} from "../media/use-image-library";

const acceptsImages = (status: ImageInputStatus | undefined) =>
	status?.primary.status === "supported" ||
	(status?.primary.status === "failed" &&
		status.fallback?.status === "supported");

/** A device file is uploaded on send; a library image is converted to an attachment on send. */
export type DraftImage = {
	id: string;
	name: string;
	url: string;
	source: { kind: "file"; file: File } | { kind: "library"; imageId: string };
	saved?: Attachment;
};
export function useChatAttachments(
	client: EumenesClient,
	conversationId: string,
) {
	const settingsRevision = useSettings(client).data?.revision;
	// The other files a message carries are shared files, uploaded beside the images on send.
	const files = useChatFiles(client, conversationId);
	const [capability, setCapability] = useState<ImageInputStatus>();
	const check = useRef<AbortController | null>(null);
	const [checking, setChecking] = useState(false);
	const [items, setItems] = useState<DraftImage[]>([]);
	const current = useRef(items);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const urls = useRef(new Set<string>());
	// The saved images are read only once the library picker has been opened.
	const [libraryWanted, setLibraryWanted] = useState(false);
	const libraryQuery = useImageLibrary(client, false, libraryWanted);
	const libraryImages = useMemo(
		() => libraryPickerItems(libraryQuery.data),
		[libraryQuery.data],
	);
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
		const appended = files.map((file): DraftImage => {
			const url = URL.createObjectURL(file);
			urls.current.add(url);
			return {
				id: crypto.randomUUID(),
				name: file.name,
				url,
				source: { kind: "file", file },
			};
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
		const appended = fresh.map(({ attachment, file }): DraftImage => {
			const url = URL.createObjectURL(file);
			urls.current.add(url);
			return {
				id: attachment.id,
				name: file.name,
				url,
				source: { kind: "file", file },
				saved: attachment,
			};
		});
		current.current = [...current.current, ...appended];
		setItems(current.current);
		checkConnection();
	}
	/** Saved library images, shown from the library and converted to attachments on send. */
	function addLibrary(images: { id: string; title: string }[]) {
		setError(undefined);
		const fresh = images.filter(
			(image) =>
				!current.current.some(
					(i) => i.source.kind === "library" && i.source.imageId === image.id,
				),
		);
		if (current.current.length + fresh.length > attachmentLimits.maxImages) {
			setError("添付は8枚までです。画像を減らしてください。");
			return;
		}
		const appended = fresh.map((image): DraftImage => ({
			id: crypto.randomUUID(),
			name: image.title,
			url: imageContentUrl(image.id),
			source: { kind: "library", imageId: image.id },
		}));
		current.current = [...current.current, ...appended];
		setItems(current.current);
		checkConnection();
	}
	function remove(id: string) {
		const item = current.current.find((i) => i.id === id);
		if (item && urls.current.has(item.url)) {
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
					(item.source.kind === "file"
						? await client.uploadAttachment(
								conversationId,
								item.id,
								item.source.file,
							)
						: await client.attachLibraryImage(
								conversationId,
								item.id,
								item.source.imageId,
							));
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
		addLibrary,
		library: {
			images: libraryImages,
			loading: libraryWanted && libraryQuery.isPending,
			error: libraryQuery.error ? libraryLoadError : undefined,
			/** Reads the list on first open, then refreshes it on each later open. */
			open: () => {
				if (libraryWanted) void libraryQuery.refetch();
				else setLibraryWanted(true);
			},
			refresh: () => void libraryQuery.refetch(),
		},
		remove,
		upload,
		clear,
		busy: busy || checking,
		error,
		files,
	};
}
