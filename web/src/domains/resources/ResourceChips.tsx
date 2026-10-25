import { Button } from "@eumenes/design-system";
import type {
	ConversationResourcesResponse,
	ResourceAction,
} from "../../../../api/domains/resources/contracts";
import { KindIcon } from "./kind-icon";
import "./ResourceChips.css";

/** The words of the actions a chip offers; `read` is for the conversation agent, not a button. */
const ACTION_LABEL: Partial<Record<ResourceAction, string>> = {
	open: "表示する",
	play: "再生する",
};

/** A preview that is an image address (same-origin API content only: nothing outside is fetched), not text. */
function isImagePreview(preview: string | undefined): preview is string {
	return !!preview && /^\/api\/\S+$/.test(preview);
}

/**
 * The resources a message links to, as chips: icon or thumbnail, name, and a button per action
 * (the kind's default first). A click is the user's own action, so playing is allowed to start.
 */
export function ResourceChips({
	messageId,
	data,
	onOpen,
}: {
	messageId: string;
	data: ConversationResourcesResponse | undefined;
	onOpen: (uri: string, action: ResourceAction) => void;
}) {
	const uris = data?.messages.find((m) => m.messageId === messageId)?.uris;
	if (!data || !uris?.length) return null;
	const chips = uris.flatMap((uri) => {
		const resource = data.resources.find((r) => r.uri === uri);
		return resource && !resource.forgotten ? [resource] : [];
	});
	if (!chips.length) return null;
	return (
		<ul className="resource-chips" aria-label="関連する生成物">
			{chips.map((resource) => {
				const actions = resource.actions.filter((a) => ACTION_LABEL[a]);
				const [main, ...rest] = actions;
				const content = (
					<>
						<span className="resource-chip-visual">
							{isImagePreview(resource.preview) ? (
								<img src={resource.preview} alt="" loading="lazy" />
							) : (
								<KindIcon kind={resource.kind} />
							)}
						</span>
						<span className="resource-chip-text">
							<span className="resource-chip-label">{resource.label}</span>
							<small>
								{resource.kindLabel}
								{main ? ` ・ ${ACTION_LABEL[main]}` : ""}
							</small>
						</span>
					</>
				);
				return (
					<li
						key={resource.uri}
						className="resource-chip"
						data-kind={resource.kind}
					>
						{main ? (
							<Button
								type="button"
								variant="secondary"
								className="resource-chip-main"
								aria-label={`${resource.label}を${ACTION_LABEL[main]}`}
								onClick={() => onOpen(resource.uri, main)}
							>
								{content}
							</Button>
						) : (
							<span className="resource-chip-main">{content}</span>
						)}
						{rest.map((action) => (
							<Button
								key={action}
								type="button"
								variant="ghost"
								size="sm"
								aria-label={`${resource.label}を${ACTION_LABEL[action]}`}
								onClick={() => onOpen(resource.uri, action)}
							>
								{ACTION_LABEL[action]}
							</Button>
						))}
					</li>
				);
			})}
		</ul>
	);
}
