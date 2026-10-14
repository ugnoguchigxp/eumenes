import type { MusicRecord } from "../../../../api/domains/music/contracts";
import { Button } from "../../design-system";

/** The action belongs to a saved result, never to text or a provider URL. */
export function MusicResultLink({
	runId,
	items,
	onOpen,
}: {
	runId: string | null;
	items: readonly MusicRecord[];
	onOpen: (id: string) => void;
}) {
	const music = runId
		? items.find((item) => item.runId === runId && item.state === "completed")
		: undefined;
	return music ? (
		<Button
			variant="secondary"
			size="sm"
			className="music-result-action"
			title={music.title}
			onClick={() => onOpen(music.id)}
		>
			<svg
				viewBox="0 0 24 24"
				width="15"
				height="15"
				fill="currentColor"
				aria-hidden="true"
			>
				<path d="M8 5.5v13l10-6.5z" />
			</svg>
			<span>アーティファクトで再生する</span>
		</Button>
	) : null;
}
