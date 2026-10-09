import {
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
} from "@eumenes/design-system";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import type { ArtifactTab } from "../../../domains/artifact";
import { renderSafeMarkdown } from "../conversation";

const ArtifactShowcase = lazy(() =>
	import("./ArtifactShowcase").then((module) => ({
		default: module.ArtifactShowcase,
	})),
);

export function ArtifactPanel({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	renderTimer,
}: {
	tabs: ArtifactTab[];
	activeTabId: string | null;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	renderTimer?: (timerId: string) => ReactNode;
}) {
	const active = tabs.find((tab) => tab.id === activeTabId);
	const panel = useRef<HTMLElement>(null);
	useEffect(() => {
		if (window.matchMedia("(max-width: 700px)").matches)
			panel.current?.scrollIntoView({ block: "start" });
	}, [activeTabId]);
	return (
		<Tabs value={activeTabId ?? ""} onValueChange={onSelect} asChild>
			<aside
				ref={panel}
				className="artifact-panel"
				aria-label="アーティファクト"
			>
				<header className="artifact-panel-header">
					<TabsList variant="workspace" aria-label="アーティファクトのタブ">
						{tabs.map((tab) => (
							<TabsTrigger
								key={tab.id}
								value={tab.id}
								onClose={() => onClose(tab.id)}
								closeLabel={`${tab.title}を閉じる`}
							>
								{tab.title}
							</TabsTrigger>
						))}
					</TabsList>
				</header>
				{tabs
					.filter((tab) => tab.kind === "showcase")
					.map((tab) => (
						<TabsContent
							key={tab.id}
							value={tab.id}
							forceMount
							className="artifact-panel-body"
							hidden={tab.id !== activeTabId}
						>
							<Suspense fallback={<output>UIを準備中です</output>}>
								<ArtifactShowcase />
							</Suspense>
						</TabsContent>
					))}
				{active?.kind === "markdown" && (
					<TabsContent value={active.id} className="artifact-panel-body">
						<div
							className="markdown-content"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderSafeMarkdown
							dangerouslySetInnerHTML={{
								__html: renderSafeMarkdown(active.content),
							}}
						/>
					</TabsContent>
				)}
				{active?.kind === "timer" && (
					<TabsContent value={active.id} className="artifact-panel-body">
						{renderTimer?.(active.timerId)}
					</TabsContent>
				)}
			</aside>
		</Tabs>
	);
}
