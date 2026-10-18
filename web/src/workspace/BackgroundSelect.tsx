import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import {
	type BackgroundKind,
	backgroundKinds,
} from "../../../api/domains/settings/contracts";
import type { useBackground } from "../domains/settings";

// Same labels as the settings page's 会話の背景 options.
const labels: Record<BackgroundKind, string> = {
	"light-fairy": "光の妖精",
	spatial: "Spatial",
};

export function BackgroundSelect({
	background,
}: {
	background: ReturnType<typeof useBackground>;
}) {
	return (
		<Select
			value={background.selected}
			onValueChange={(kind) => void background.select(kind as BackgroundKind)}
			disabled={!background.ready || background.busy}
		>
			<SelectTrigger
				variant="ghost"
				size="sm"
				className="model-select"
				aria-label="会話の背景"
				title={`背景: ${labels[background.selected]}`}
			>
				<SelectValue placeholder="会話の背景">
					背景: {labels[background.selected]}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{backgroundKinds.map((kind) => (
					<SelectItem key={kind} value={kind}>
						{labels[kind]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
