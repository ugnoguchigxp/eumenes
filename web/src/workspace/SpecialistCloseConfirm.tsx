import { ConfirmModal } from "@eumenes/design-system";
import type { SpecialistWorkspace } from "./useSpecialistWorkspace";

/** Closing a specialist's screen with unsaved work: discard and close, or keep editing. */
export function SpecialistCloseConfirm({
	confirm,
}: {
	confirm: SpecialistWorkspace["confirm"];
}) {
	if (!confirm) return null;
	return (
		<ConfirmModal
			open
			onOpenChange={(open) => {
				if (!open && !confirm.busy) confirm.keep();
			}}
			title="未保存の案があります"
			description={`保存していない案は、閉じると破棄されます。${confirm.error ? ` ${confirm.error}` : ""}`}
			confirmText="破棄して閉じる"
			cancelText="編集を続ける"
			variant="destructive"
			loading={confirm.busy}
			onConfirm={() => void confirm.discard()}
			onCancel={confirm.keep}
		/>
	);
}
