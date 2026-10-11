import { Check, CircleDashed, X } from "lucide-react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import "./GenerationStatus.css";

export type GenerationStatusProps = {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	title: string;
	/** Actual phase reported by the host. Never infer progress from elapsed time. */
	description?: string;
	/** Omit when the provider does not report measurable progress. */
	progress?: number;
	onCancel?: () => void;
	cancelling?: boolean;
	onRetry?: () => void;
	className?: string;
};

export function GenerationStatus({
	status,
	title,
	description,
	progress,
	onCancel,
	cancelling = false,
	onRetry,
	className,
}: GenerationStatusProps) {
	const busy = status === "pending" || status === "running";
	const percent =
		progress !== undefined && Number.isFinite(progress)
			? Math.min(100, Math.max(0, progress))
			: undefined;
	const Icon = busy ? CircleDashed : status === "completed" ? Check : X;
	return (
		<section className={cn("generation-status", className)} aria-label={title}>
			<div role={status === "failed" ? "alert" : "status"}>
				<div className="generation-status-heading">
					<Icon
						className="generation-status-mark"
						data-busy={busy}
						aria-hidden="true"
					/>
					<h3>{title}</h3>
				</div>
				{description && <p>{description}</p>}
			</div>
			{busy && percent !== undefined && (
				<label>
					<span>進捗 {Math.round(percent)}%</span>
					<progress aria-label="生成の進捗" max={100} value={percent} />
				</label>
			)}
			{busy && onCancel && (
				<div>
					<Button
						type="button"
						variant="outline"
						disabled={cancelling}
						onClick={onCancel}
					>
						{cancelling ? "取消中…" : "生成を取り消す"}
					</Button>
				</div>
			)}
			{status === "failed" && onRetry && (
				<div>
					<Button type="button" variant="outline" onClick={onRetry}>
						再試行
					</Button>
				</div>
			)}
		</section>
	);
}
