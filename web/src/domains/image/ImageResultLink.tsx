import type { ImageRecord } from "../../../../api/domains/image/contracts";
import { Button } from "../../design-system";

/** Open the saved result for this answer run without exposing a media URL in speech. */
export function ImageResultLink({
	runId,
	items,
	onOpen,
}: {
	runId: string | null;
	items: readonly ImageRecord[];
	onOpen: (id: string) => void;
}) {
	const image = runId
		? items.find(
				(item) =>
					item.runId === runId &&
					item.action === "generate" &&
					item.state === "completed" &&
					item.artifactId,
			)
		: undefined;
	return image?.artifactId ? (
		<Button
			variant="secondary"
			size="sm"
			className="image-result-action"
			onClick={() => onOpen(image.artifactId!)}
		>
			<span>アーティファクトで画像を確認する</span>
		</Button>
	) : null;
}
