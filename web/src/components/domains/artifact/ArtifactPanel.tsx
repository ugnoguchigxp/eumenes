import {
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
	Button,
} from "@eumenes/design-system";
import {
	Component,
	lazy,
	Suspense,
	useEffect,
	useRef,
	type ReactNode,
} from "react";
import type { ArtifactTab } from "../../../domains/artifact";
import { renderSafeMarkdown } from "../conversation";

const ArtifactShowcase = lazy(() =>
	import("./ArtifactShowcase").then((module) => ({
		default: module.ArtifactShowcase,
	})),
);

class ShowcaseBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? (
			<div role="alert" className="aui-stack">
				<p>
					ショーケースを読み込めませんでした。画面を再読み込みしてください。
				</p>
				<Button onClick={() => window.location.reload()}>
					画面を再読み込み
				</Button>
			</div>
		) : (
			this.props.children
		);
	}
}

export function ArtifactPanel({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	renderToolchain,
	renderOpenUI,
}: {
	tabs: ArtifactTab[];
	activeTabId: string | null;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	/** Registered (data-driven) artifacts stay mounted while hidden, like their clocks. */
	renderToolchain?: (
		tab: Extract<ArtifactTab, { kind: "toolchain" }>,
		visible: boolean,
	) => ReactNode;
	renderOpenUI?: (definition: string) => ReactNode;
}) {
	const active = tabs.find((tab) => tab.id === activeTabId);
	const panel = useRef<HTMLElement>(null);
	function close(tabId: string) {
		const content = [
			...(panel.current?.querySelectorAll<HTMLElement>("[data-artifact-tab]") ??
				[]),
		].find((el) => el.dataset.artifactTab === tabId);
		const event = new CustomEvent("eumenes:artifact-close", {
			cancelable: true,
			detail: { close: () => onClose(tabId) },
		});
		content?.dispatchEvent(event);
		if (!event.defaultPrevented) onClose(tabId);
	}
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
								onClose={() => close(tab.id)}
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
							<ShowcaseBoundary>
								<Suspense fallback={<output>UIを準備中です</output>}>
									<ArtifactShowcase />
								</Suspense>
							</ShowcaseBoundary>
						</TabsContent>
					))}
				{tabs.map((tab) =>
					tab.kind === "toolchain" ? (
						<TabsContent
							key={tab.id}
							value={tab.id}
							forceMount
							className="artifact-panel-body"
							hidden={tab.id !== activeTabId}
						>
							{renderToolchain?.(tab, tab.id === activeTabId)}
						</TabsContent>
					) : null,
				)}
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
				{tabs
					.filter(
						(tab): tab is Extract<ArtifactTab, { kind: "openui" }> =>
							tab.kind === "openui" &&
							(tab.id === activeTabId || tab.keepMounted === true),
					)
					.map((tab) => (
						<TabsContent
							key={tab.id}
							value={tab.id}
							data-artifact-tab={tab.id}
							forceMount
							hidden={tab.id !== activeTabId}
							className="artifact-panel-body"
						>
							{renderOpenUI?.(tab.definition)}
						</TabsContent>
					))}
			</aside>
		</Tabs>
	);
}
