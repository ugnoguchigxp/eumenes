import { Button, DropdownMenu } from "@eumenes/design-system";
import "./ArtifactLauncher.css";

export type ArtifactLauncherEntry = {
	label: string;
	onSelect: () => void;
};

/** Reopens any artifact the user closed; the workspace keeps one tab per tool. */
export function ArtifactLauncher({
	entries,
}: {
	entries: ArtifactLauncherEntry[];
}) {
	return (
		<DropdownMenu
			className="artifact-launcher"
			align="right"
			minWidthPx={240}
			items={entries.map((entry) => ({
				label: entry.label,
				onClick: entry.onSelect,
			}))}
			trigger={
				<Button
					type="button"
					variant="secondary"
					size="icon"
					className="artifact-launcher-trigger"
					aria-label="アーティファクトを開く"
					title="アーティファクトを開く"
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.7"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<rect x="3" y="3" width="7" height="7" rx="1.5" />
						<rect x="14" y="3" width="7" height="7" rx="1.5" />
						<rect x="3" y="14" width="7" height="7" rx="1.5" />
						<rect x="14" y="14" width="7" height="7" rx="1.5" />
					</svg>
				</Button>
			}
		/>
	);
}
