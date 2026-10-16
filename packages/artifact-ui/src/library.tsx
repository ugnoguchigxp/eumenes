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
import { useState } from "react";
import {
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
import { CollectionWorkspaceView } from "./collection-components";
import { RecordsWorkspaceView } from "./records-components";
import { ServiceTestWorkspaceView } from "./service-test-components";
import {
	UiWorkspaceView,
	TextBlockView,
	InfoCardView,
} from "./ui-composition-components";

const renderers = {
	"google-accounts": GoogleAccountsView,
	"ui-workspace": UiWorkspaceView,
	"text-block": TextBlockView,
	"info-card": InfoCardView,
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
function RegisteredView({ request }: { request: ArtifactRequest }) {
	const Component = renderers[request.view];
	return <Component request={request} />;
}
function CompositionView({
	request,
}: {
	request: z.infer<typeof layoutSchema>;
}) {
	const [selected, setSelected] = useState("0");
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
					request={request.children[0]!}
					supplement={<RegisteredView request={request.children[1]!} />}
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
						key={`${index}:${child.source ?? child.view}`}
					>
						<RegisteredView request={child} />
					</div>
				);
			})}
		</>
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
										request={request.children[tab.children[0]!]!}
										hideFooter={!!request.draftSource}
										supplement={
											<RegisteredView
												request={request.children[tab.children[1]!]!}
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
												key={`${childIndex}:${child.view}:${child.source ?? "inline"}`}
												request={child}
											/>
										);
									})
								)}
							</div>
						</TabsContent>
					))}
				</Tabs>
				{request.draftSource && (
					<SettingsDraftBarView source={request.draftSource} />
				)}
			</section>
		);
	return (
		<section
			aria-label={request.title ?? "組合せ表示"}
			className={`aui-composition aui-composition-${request.direction}`}
			data-appearance={request.appearance}
		>
			{request.children.map((child, index) => (
				<RegisteredView
					key={`${index}:${child.view}:${child.source ?? "inline"}`}
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
