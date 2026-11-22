import { useEffect, useRef, useState } from "react";
import type { ImageGridItem } from "./ImageGrid";
import type { ImagePickerProps, ImagePickerUploadResult } from "./ImagePicker";

export type LocalPickedFile = {
	name: string;
	url: string;
	value: File;
	requestId: string;
};

export function useImagePicker(props: ImagePickerProps) {
	const { images, selectedId, onRefresh, onCancel, onDelete, onUpload } = props;
	const max = props.multiple ? props.maxSelected : 1;
	const [draftIds, setDraftIds] = useState<string[]>(
		selectedId ? [selectedId] : [],
	);
	const [previewId, setPreviewId] = useState<string>();
	const [deleteId, setDeleteId] = useState<string>();
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	const [gridRevision, setGridRevision] = useState(0);
	const [provider, setProvider] = useState("larm");
	const [file, setFile] = useState<LocalPickedFile>();
	const [uploading, setUploading] = useState(false);
	const [uploadResult, setUploadResult] = useState<ImagePickerUploadResult>();
	const [uploaded, setUploaded] = useState<ImageGridItem>();
	const current = useRef<AbortController | undefined>(undefined);
	const fileInput = useRef<HTMLInputElement>(null);

	const cancelUpload = () => {
		current.current?.abort();
		current.current = undefined;
		setUploading(false);
	};
	useEffect(() => () => current.current?.abort(), []);
	useEffect(() => {
		return () => {
			if (file) URL.revokeObjectURL(file.url);
		};
	}, [file]);

	const candidates =
		uploaded && !images.some((i) => i.id === uploaded.id)
			? [uploaded, ...images]
			: images;

	const pick = (id: string, deselect = false) =>
		setDraftIds((ids) => {
			if (!props.multiple) return [id];
			if (deselect && ids.includes(id))
				return ids.filter((value) => value !== id);
			const kept = ids.filter((value) =>
				candidates.some((image) => image.id === value && !image.disabledReason),
			);
			return kept.includes(id) || kept.length >= max ? kept : [...kept, id];
		});
	const toggle = (id: string) => pick(id, true);

	const selected = draftIds.flatMap(
		(id) =>
			candidates.find((image) => image.id === id && !image.disabledReason) ??
			[],
	);
	const preview = images.find((image) => image.id === previewId);
	const deleteTarget = candidates.find((image) => image.id === deleteId);

	async function upload(newAttempt = false) {
		if (!file || !onUpload) return;
		cancelUpload();
		const controller = new AbortController();
		current.current = controller;
		const requestId = newAttempt ? crypto.randomUUID() : file.requestId;
		if (newAttempt) setFile({ ...file, requestId });
		setUploading(true);
		setUploadResult(undefined);
		try {
			const result = await onUpload(file.value, requestId, controller.signal);
			if (controller.signal.aborted || current.current !== controller) return;
			setUploadResult(result);
			if (result.status === "succeeded") {
				setUploaded(result.image);
				pick(result.image.id);
				setFile(undefined);
				onRefresh?.();
			}
		} catch {
			if (!controller.signal.aborted && current.current === controller)
				setUploadResult({
					status: "pending",
					message:
						"アップロード結果を確認できません。同じ受付番号で再確認してください。",
				});
		} finally {
			if (current.current === controller) {
				current.current = undefined;
				setUploading(false);
			}
		}
	}

	async function confirmDelete() {
		if (!deleteTarget || !onDelete || deleting) return;
		const id = deleteTarget.id;
		setDeleting(true);
		try {
			if (await onDelete(id)) {
				setDraftIds((ids) => ids.filter((value) => value !== id));
				setUploaded((currentImage) =>
					currentImage?.id === id ? undefined : currentImage,
				);
				setDeleteId(undefined);
			} else
				setDeleteError(
					"削除結果を確認できませんでした。一覧を更新してください。",
				);
		} catch {
			setDeleteError(
				"削除結果を確認できませんでした。一覧を更新してください。",
			);
		} finally {
			setDeleting(false);
		}
	}

	const leave = () => {
		cancelUpload();
		onCancel();
	};

	const chooseFile = (picked: File) => {
		cancelUpload();
		setUploadResult(undefined);
		setFile({
			name: picked.name,
			url: URL.createObjectURL(picked),
			value: picked,
			requestId: crypto.randomUUID(),
		});
		setDraftIds([]);
	};

	const clearFile = () => {
		cancelUpload();
		setFile(undefined);
		setUploadResult(undefined);
	};

	const selectFromGrid = (id: string) => {
		cancelUpload();
		setUploadResult(undefined);
		toggle(id);
		setFile(undefined);
	};

	const selectFromGoogle = (image: ImageGridItem) => {
		cancelUpload();
		setFile(undefined);
		setUploadResult(undefined);
		setUploaded(image);
		pick(image.id);
		setProvider("larm");
		onRefresh?.();
	};

	return {
		max,
		fileInput,
		candidates,
		selected,
		preview,
		deleteTarget,
		deleting,
		deleteError,
		gridRevision,
		provider,
		file,
		uploading,
		uploadResult,
		setPreviewId,
		setDeleteId,
		setDeleteError,
		setGridRevision,
		setProvider,
		upload,
		confirmDelete,
		leave,
		chooseFile,
		clearFile,
		selectFromGrid,
		selectFromGoogle,
	};
}
