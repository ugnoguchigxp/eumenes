import { Button, Modal } from "@eumenes/design-system";
import { useCallback, useState } from "react";

/**
 * A value a settled write returns to be shown exactly once (a new connection's local token):
 * kept only in this dialog's state, in no outbox, snapshot, query cache or storage.
 */
export function useSecretNotice() {
	const [token, setToken] = useState<string | null>(null);
	const reveal = useCallback((receipt: unknown) => {
		const value =
			receipt && typeof receipt === "object"
				? (receipt as { localToken?: unknown }).localToken
				: undefined;
		if (typeof value === "string" && value) setToken(value);
	}, []);
	return { token, reveal, close: () => setToken(null) };
}

export function SecretNotice({
	token,
	onClose,
}: {
	token: string | null;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Modal
			open={token !== null}
			onOpenChange={(open) => {
				if (!open) {
					setCopied(false);
					onClose();
				}
			}}
			title="一度だけ表示する値"
			description="閉じると再表示できません。必要な場所に控えてから閉じてください。"
		>
			<div className="aui-stack">
				<code aria-label="表示する値">{token}</code>
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						void navigator.clipboard
							?.writeText(token ?? "")
							.then(() => setCopied(true))
							.catch(() => setCopied(false));
					}}
				>
					{copied ? "コピーしました" : "コピー"}
				</Button>
				<Button type="button" onClick={onClose}>
					閉じる
				</Button>
			</div>
		</Modal>
	);
}
