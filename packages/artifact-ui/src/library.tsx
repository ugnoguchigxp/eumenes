import { GoogleAccountsView } from "./google-accounts-components";
import { OcrMediaView, OcrPanelView } from "./ocr-components";
import { ObjectRecognitionWorkspaceView } from "./object-recognition-components";
import { TerminalWorkspaceView } from "./terminal-components";
import { KanbanBoardView } from "./kanban-components";
import { ActivityTimelineView } from "./activity-components";
import { DrawingWorkspaceView } from "./drawing-components";
import {
	ImageWorkspaceView,
	ImageCreationView,
	ImagePreviewView,
	ImageGalleryView,
} from "./image-components";
import { createLibrary, defineComponent } from "./sdk";
import {
	SettingsSectionView,
	SettingsNavigationView,
	SettingsChangesView,
	SettingsDraftBarView,
} from "./settings-components";
import { z } from "zod";
import { type ComponentType, lazy, Suspense, useState } from "react";
import {
	Slides,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@eumenes/design-system";
import {
	ComponentsView,
	ImageFrame,
	MemoryReview,
	QuestionView,
	SettingsForm,
	SmallForm,
} from "./components";
import {
	layoutSchema,
	parseRequest,
	viewRegistry,
	type ArtifactRequest,
	type Layout,
} from "./contracts";

import {
	MusicView,
	PlaylistView,
	GenerationView,
	MusicLibraryView,
	MusicWorkspaceView,
} from "./media-components";
import { TimerWorkspaceView } from "./timer-components";
import { SubtitlePreviewView } from "./subtitle-components";
import { AvatarMotionLabView } from "./avatar-components";
import { ComputeWorkspaceView } from "./compute-components";
import { Model3dWorkspaceView } from "./model3d-components";
import {
	BrowserSettingsView,
	BrowserWorkspaceView,
} from "./browser-components";
import { CollectionWorkspaceView } from "./collection-components";
import { RecordsWorkspaceView } from "./records-components";
import { ServiceTestWorkspaceView } from "./service-test-components";
import { TextBlockView, InfoCardView } from "./ui-composition-components";
import { UiStudioView } from "./ui-studio-components";
import {
	CompositionModelProvider,
	useCompositionModel,
} from "./composition-model";
import {
	ContentImageView,
	CtaBannerView,
	FeatureCardView,
	HeroView,
	MediaCardView,
	ProductCardView,
	TestimonialView,
} from "./composition-marketing-components";
import {
	ChoiceView,
	ComparisonTableView,
	FaqView,
	NumberInputView,
	PricingCardView,
	SliderView,
	StatView,
	TimelineView,
	ToggleView,
} from "./composition-content-components";
import { DiagramView, StepperView } from "./composition-diagram-components";

type ViewProps = { request: ArtifactRequest };
/** Charts, formulas and the calculator pull in recharts and KaTeX; load them on first use. */
function lazyView(load: () => Promise<ComponentType<ViewProps>>) {
	const Loaded = lazy(() =>
		load().then((component) => ({ default: component })),
	);
	return function LazyView(props: ViewProps) {
		return (
			<Suspense
				fallback={<p className="aui-composition-loading">読み込み中…</p>}
			>
				<Loaded {...props} />
			</Suspense>
		);
	};
}
const dataViews = () => import("./composition-data-components");
const ChartView = lazyView(() => dataViews().then((m) => m.ChartView));
const DataTableView = lazyView(() => dataViews().then((m) => m.DataTableView));
const FormulaView = lazyView(() => dataViews().then((m) => m.FormulaView));
const CalculatorView = lazyView(() =>
	dataViews().then((m) => m.CalculatorView),
);

const renderers = {
	"google-accounts": GoogleAccountsView,
	"ui-studio": UiStudioView,
	"text-block": TextBlockView,
	"info-card": InfoCardView,
	hero: HeroView,
	image: ContentImageView,
	"media-card": MediaCardView,
	"product-card": ProductCardView,
	"feature-card": FeatureCardView,
	testimonial: TestimonialView,
	"cta-banner": CtaBannerView,
	"pricing-card": PricingCardView,
	"comparison-table": ComparisonTableView,
	faq: FaqView,
	timeline: TimelineView,
	stat: StatView,
	"number-input": NumberInputView,
	slider: SliderView,
	choice: ChoiceView,
	toggle: ToggleView,
	chart: ChartView,
	"data-table": DataTableView,
	formula: FormulaView,
	calculator: CalculatorView,
	diagram: DiagramView,
	stepper: StepperView,
	"object-recognition-workspace": ObjectRecognitionWorkspaceView,
	"ocr-media": OcrMediaView,
	"ocr-panel": OcrPanelView,
	"terminal-workspace": TerminalWorkspaceView,
	"kanban-board": KanbanBoardView,
	"activity-timeline": ActivityTimelineView,
	"drawing-workspace": DrawingWorkspaceView,
	"image-workspace": ImageWorkspaceView,
	"image-creation-form": ImageCreationView,
	"image-preview": ImagePreviewView,
	"image-gallery": ImageGalleryView,
	"records-workspace": RecordsWorkspaceView,
	"collection-workspace": CollectionWorkspaceView,
	"service-test-workspace": ServiceTestWorkspaceView,
	"avatar-motion-lab": AvatarMotionLabView,
	"model3d-workspace": Model3dWorkspaceView,
	"compute-workspace": ComputeWorkspaceView,
	"browser-workspace": BrowserWorkspaceView,
	"browser-settings": BrowserSettingsView,
	"subtitle-preview": SubtitlePreviewView,
	"settings-section": SettingsSectionView,
	"settings-navigation": SettingsNavigationView,
	"settings-changes": SettingsChangesView,
	"timer-workspace": TimerWorkspaceView,
	"music-workspace": MusicWorkspaceView,
	"music-library": MusicLibraryView,
	"music-player": MusicView,
	playlist: PlaylistView,
	"generation-status": GenerationView,
	components: ComponentsView,
	"generated-image": ImageFrame,
	question: QuestionView,
	form: SmallForm,
	memory: MemoryReview,
	settings: SettingsForm,
};
type Node = ArtifactRequest | Layout;
function RegisteredView({ request }: { request: Node }) {
	if (request.view === "layout")
		return <CompositionView request={request} nested />;
	const Component = renderers[request.view];
	return <Component request={request} />;
}
/** The settings form-preview arrangements are validated to hold plain views. */
function plain(node: Node | undefined): ArtifactRequest {
	if (!node || node.view === "layout")
		throw new Error("組合せの構成が正しくありません");
	return node;
}
const keyOf = (node: Node) =>
	node.view === "layout" ? "layout" : (node.source ?? node.view);
/**
 * A layout. A nested stack/grid layout is a section: its title is shown as the section heading. The
 * outermost layout's title names the composition and stays an accessible label only.
 */
function CompositionView({
	request,
	nested = false,
}: {
	request: Layout;
	nested?: boolean;
}) {
	// The outermost layout holds the composition's shared state for all of its views.
	return nested ? (
		<ShownLayout request={request} nested />
	) : (
		<CompositionModelProvider model={request.model}>
			<ShownLayout request={request} nested={false} />
		</CompositionModelProvider>
	);
}
/** A layout with `when` shows its children only while the expression is true. */
function ShownLayout({
	request,
	nested,
}: {
	request: Layout;
	nested: boolean;
}) {
	const model = useCompositionModel();
	if (request.when && model && model.evaluate(request.when) !== true)
		return null;
	return <LayoutView request={request} nested={nested} />;
}
function LayoutView({ request, nested }: { request: Layout; nested: boolean }) {
	const [selected, setSelected] = useState("0");
	const model = useCompositionModel();
	const tabs: NonNullable<typeof request.tabs> =
		request.tabs ??
		request.children.map((child, index) => ({
			label: child.title ?? `画面 ${index + 1}`,
			children: [index],
		}));
	if (request.direction === "form-preview")
		return (
			<section
				aria-label={request.title ?? "組合せ表示"}
				className="aui-composition aui-composition-form-preview"
			>
				<SettingsSectionView
					request={plain(request.children[0])}
					supplement={<RegisteredView request={plain(request.children[1])} />}
				/>
			</section>
		);
	const heading = (
		<>
			{request.title && (
				<h2 className="aui-composition-title">{request.title}</h2>
			)}
			{request.headerChildren?.map((index) => {
				const child = request.children[index]!;
				return (
					<div
						className="aui-composition-header-child"
						key={`${index}:${keyOf(child)}`}
					>
						<RegisteredView request={child} />
					</div>
				);
			})}
		</>
	);
	if (request.direction === "slides")
		return (
			<section
				aria-label={request.title ?? "組合せ表示"}
				className="aui-composition aui-composition-slides"
				data-appearance={request.appearance}
				data-width={request.width}
			>
				<Slides
					title={nested ? request.title : undefined}
					slides={request.children
						// A scene whose `when` is false is left out rather than shown blank.
						.filter(
							(child) =>
								child.view !== "layout" ||
								!child.when ||
								!model ||
								model.evaluate(child.when) === true,
						)
						.map((child, index) => ({
							label: child.title ?? `場面 ${index + 1}`,
							content: (
								<RegisteredView
									key={`${index}:${child.view}:${keyOf(child)}`}
									request={child}
								/>
							),
						}))}
				/>
			</section>
		);
	if (request.direction === "tabs")
		return (
			<section
				aria-label={request.title ?? "組合せ表示"}
				className="aui-composition aui-composition-tabs"
			>
				{request.headerLayout === "inline" ? (
					<div className="aui-composition-heading">{heading}</div>
				) : (
					heading
				)}
				{request.draftSource && (
					<SettingsDraftBarView source={request.draftSource} />
				)}
				<Tabs value={selected} onValueChange={setSelected}>
					<TabsList aria-label={`${request.title ?? "画面"}の区分`}>
						{tabs.map((tab, index) => (
							<TabsTrigger key={index} value={String(index)}>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
					{tabs.map((tab, index) => (
						<TabsContent
							key={index}
							value={String(index)}
							forceMount
							hidden={selected !== String(index)}
						>
							<div className="aui-composition-tab-body">
								{tab.arrangement === "form-preview" ? (
									<SettingsSectionView
										request={plain(request.children[tab.children[0]!])}
										hideFooter={!!request.draftSource}
										supplement={
											<RegisteredView
												request={plain(request.children[tab.children[1]!])}
											/>
										}
									/>
								) : (
									tab.children.map((childIndex) => {
										const child = request.children[childIndex]!;
										return child.view === "settings-section" &&
											request.draftSource ? (
											<SettingsSectionView
												key={`${childIndex}:${child.source}`}
												request={child}
												hideFooter
											/>
										) : (
											<RegisteredView
												key={`${childIndex}:${child.view}:${keyOf(child)}`}
												request={child}
											/>
										);
									})
								)}
							</div>
						</TabsContent>
					))}
				</Tabs>
			</section>
		);
	return (
		<section
			aria-label={request.title ?? "組合せ表示"}
			className={`aui-composition aui-composition-${request.direction}`}
			data-appearance={request.appearance}
			data-gap={request.gap}
			data-width={request.width}
		>
			{nested && request.title && (
				<h3 className="aui-composition-section-title">{request.title}</h3>
			)}
			{request.children.map((child, index) => (
				<RegisteredView
					key={`${index}:${child.view}:${keyOf(child)}`}
					request={child}
				/>
			))}
		</section>
	);
}
export const artifactLibrary = createLibrary({
	id: "eumenes-artifact-v1",
	components: [
		...Object.values(viewRegistry).map((definition) =>
			defineComponent({
				name: definition.name,
				description: definition.label,
				props: z.object({ request: definition.schema }),
				component: ({ props }) => (
					<RegisteredView request={parseRequest(props.request)} />
				),
			}),
		),
		defineComponent({
			name: "Composition",
			description: "登録済みの表示を並べる",
			props: z.object({ request: layoutSchema }),
			component: ({ props }) => (
				<CompositionView request={layoutSchema.parse(props.request)} />
			),
		}),
	],
});
