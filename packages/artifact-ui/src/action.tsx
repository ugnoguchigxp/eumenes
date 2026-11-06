import { useRef, useState } from "react";
import type { ArtifactEvent, ArtifactRequest, Receipt } from "./contracts";
import { useArtifactRuntime } from "./runtime";

export function useAction(request: ArtifactRequest) {
	const runtime = useArtifactRuntime();
	const lock = useRef(false);
	const [pending, setPending] = useState(false);
	const source = request.source ?? `inline-${request.view}`;
	// Where the screen stood when the last receipt arrived: an unsettled message is stale once
	// the source moved on or the host reported the settlement.
	const here = {
		revision: runtime.snapshot[source]?.revision ?? 0,
		epoch: runtime.settledEpoch ?? 0,
	};
	const [last, setLast] = useState<{
		receipt: Receipt;
		revision: number;
		epoch: number;
	}>({
		receipt: { status: "accepted", message: "" },
		...here,
	});
	const unsettled =
		last.receipt.status === "pending" ||
		last.receipt.status === "indeterminate";
	const result: Receipt =
		(unsettled || last.receipt.status === "accepted") &&
		(last.revision !== here.revision || last.epoch !== here.epoch)
			? { status: "accepted", message: "" }
			: last.receipt;
	async function send(
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"],
	): Promise<boolean> {
		if (lock.current) return false;
		lock.current = true;
		setPending(true);
		try {
			const receipt = await runtime.dispatch({
				id: crypto.randomUUID(),
				source,
				revision: runtime.snapshot[source]?.revision ?? 0,
				action,
				values,
			});
			setLast({ receipt, ...here });
			return receipt.status === "accepted";
		} catch {
			setLast({
				receipt: {
					status: "rejected",
					message: "操作に失敗しました。もう一度お試しください",
				},
				...here,
			});
			return false;
		} finally {
			lock.current = false;
			setPending(false);
		}
	}
	return {
		send,
		pending,
		message: pending ? "処理中です" : result.message,
		/** The last receipt's status; `pending` while a dispatch is in flight. */
		status: pending ? ("pending" as const) : result.status,
		source,
		resource: runtime.snapshot[source],
	};
}

export function Feedback({ message }: { message: string }) {
	return message ? (
		<output className="aui-feedback" aria-live="polite">
			{message}
		</output>
	) : null;
}
