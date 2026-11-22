import { lazy, Suspense } from "react";
import type { EumenesClient } from "../../../client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Modal } from "../design-system";
import {
	libraryLoadError,
	libraryPickerItems,
	useImageLibrary,
} from "../media/use-image-library";

const ImagePicker = lazy(() =>
	import("@eumenes/design-system").then(({ ImagePicker }) => ({
		default: ImagePicker,
	})),
);

/** Picks one saved image to show behind the Live2D model; the library is read only while open. */
export function AvatarBackdropPicker({
	client,
	open,
	selectedId,
	onClose,
	onConfirm,
}: {
	client: EumenesClient;
	open: boolean;
	selectedId: string | null;
	onClose(): void;
	onConfirm(id: string): void;
}) {
	const library = useImageLibrary(client, false, open);
	return (
		<Modal
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			title="画像一覧から背景を選ぶ"
			description="保存した画像を1枚選んで、桃瀬ひよりの後ろに表示します。"
			draggable={false}
		>
			{open && (
				<ErrorBoundary label="画像一覧" onReset={onClose}>
					<Suspense fallback={<output>画像一覧を読み込んでいます</output>}>
						<ImagePicker
							savedOnly
							images={libraryPickerItems(library.data)}
							selectedId={selectedId ?? undefined}
							loading={library.isPending}
							error={library.error ? libraryLoadError : undefined}
							onRefresh={() => void library.refetch()}
							onCancel={onClose}
							onConfirm={(id) => {
								onClose();
								onConfirm(id);
							}}
						/>
					</Suspense>
				</ErrorBoundary>
			)}
		</Modal>
	);
}
