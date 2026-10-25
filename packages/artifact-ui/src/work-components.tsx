import {
	Button,
	WorkListMenu,
	WorkResultPanel,
	type WorkListMenuProps,
	type WorkResultPanelProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { Feedback, useAction } from "./components";
export type WorkMenuResource = {
	kind: "work-menu";
	revision: number;
	items: WorkListMenuProps["items"];
	selectedId?: string;
	selectedTitle?: string;
	hasMore?: boolean;
	loading?: boolean;
	message?: string;
};
export type WorkResultResource = {
	kind: "work-result";
	revision: number;
	targetRef?: string;
	work?: Omit<WorkResultPanelProps, "onAnswer" | "onPause" | "onCancel">;
};
export function WorkMenuView({ request }: { request: ArtifactRequest }) {
	const { resource, send, pending, message } = useAction(request);
	if (resource?.kind !== "work-menu") return null;
	return (
		<div className="space-y-2 min-w-0">
			<div className="flex flex-wrap items-center gap-2">
				<WorkListMenu
					items={resource.items}
					selectedId={resource.selectedId}
					loading={pending || resource.loading}
					hasMore={resource.hasMore}
					onSelect={(taskRef) => {
						void send("work-select", { taskRef });
					}}
					onLoadMore={() => {
						void send("work-more", {});
					}}
				/>
				<strong className="break-words min-w-0 flex-1">
					{resource.selectedTitle ?? "dotsの仕事"}
				</strong>
				<Button
					size="sm"
					variant="ghost"
					disabled={pending}
					onClick={() => {
						void send("work-refresh", {});
					}}
				>
					更新
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						void send("work-settings", {});
					}}
				>
					設定
				</Button>
			</div>
			{resource.message && (
				<output className="block text-sm text-muted-foreground">
					{resource.message}
				</output>
			)}
			<Feedback message={message} />
		</div>
	);
}
export function WorkResultView({ request }: { request: ArtifactRequest }) {
	const { resource, send, pending, message } = useAction(request);
	if (resource?.kind !== "work-result") return null;
	if (!resource.work)
		return (
			<p className="text-muted-foreground">
				仕事一覧から選んでください。新しい依頼は会話から行えます。
			</p>
		);
	return (
		<>
			<WorkResultPanel
				key={`${resource.targetRef}:${resource.work.question?.id ?? ""}`}
				{...resource.work}
				busy={pending}
				onAnswer={(answer) =>
					send("work-answer", {
						questionId: resource.work!.question!.id,
						answer,
					})
				}
				onPause={() => {
					void send("work-pause", { intent: "pause" });
				}}
				onCancel={() => {
					void send("work-cancel", { intent: "cancel" });
				}}
			/>
			<Feedback message={message} />
		</>
	);
}
