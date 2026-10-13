import { useQuery } from "@tanstack/react-query";
import { Button, DropdownMenu } from "@eumenes/design-system";
import type { EumenesClient } from "../../../../../client";
import { activeTimersQuery } from "../../../domains/timers/queries";
import "./TimerArtifact.css";

/** Saved clocks are selected within the single timer screen. */
export function TimerPicker({
	client,
	onSelect,
}: {
	client: EumenesClient;
	onSelect: (ref: { timerId: string }, title: string) => void;
}) {
	const timers = useQuery(activeTimersQuery(client));
	if (!timers.data?.items.length) return null;
	return (
		<div className="timer-picker">
			<DropdownMenu
				align="right"
				trigger={
					<Button variant="secondary" size="sm">
						保存済みタイマーを選ぶ
					</Button>
				}
				items={timers.data.items.map((timer) => ({
					label: `${timer.label}（${timer.durationSeconds}秒・${new Date(timer.startedAt).toLocaleTimeString("ja-JP")}開始）`,
					onClick: () => onSelect({ timerId: timer.id }, timer.label),
				}))}
			/>
		</div>
	);
}
