import { Button } from "../Button";
import { GenerationStatus } from "../GenerationStatus";
import { MusicCreationForm } from "./MusicCreationForm";
import type { MusicWorkspaceProps } from "./MusicWorkspace";

export function MusicCreationPanel({
	creation,
	busy,
	draft,
	tab,
	onTab,
}: {
	creation: NonNullable<MusicWorkspaceProps["creation"]>;
	busy?: boolean;
	draft?: { prompt: string; revision: number };
	tab: "create" | "history";
	onTab: (value: "create" | "history") => void;
}) {
	return (
		<>
			<div
				className="music-workspace-creation-tabs"
				role="group"
				aria-label="制作画面の切替"
			>
				<Button
					type="button"
					variant="ghost"
					aria-pressed={tab === "create"}
					onClick={() => onTab("create")}
				>
					曲づくり
				</Button>
				<Button
					type="button"
					variant="ghost"
					aria-pressed={tab === "history"}
					onClick={() => onTab("history")}
				>
					生成履歴
				</Button>
			</div>
			<div hidden={tab !== "create"} className="music-workspace-composer">
				{creation.status && <GenerationStatus {...creation.status} />}
				<MusicCreationForm
					key={draft?.revision ?? 0}
					initialPrompt={draft?.prompt}
					options={creation.options}
					busy={busy || creation.busy}
					onGenerate={creation.onGenerate}
				/>
			</div>
		</>
	);
}
