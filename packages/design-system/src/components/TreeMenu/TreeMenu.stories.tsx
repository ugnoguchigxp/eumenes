import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	AlertTriangle,
	Bandage,
	Bed,
	BellRing,
	Boxes,
	Calculator,
	Calendar,
	CalendarCheck,
	ClipboardList,
	Contact,
	Droplet,
	Eye,
	FileHeart,
	FileText,
	FlaskConical,
	Folder,
	GraduationCap,
	History,
	Home,
	Mail,
	MessageSquare,
	MessageSquareText,
	Monitor,
	Paperclip,
	Pill,
	Settings,
	Settings2,
	SquarePen,
	Syringe,
	User,
	Users,
} from "lucide-react";
import { useState } from "react";

import { TreeMenu, type TreeMenuItem } from "./TreeMenu";

const meta: Meta<typeof TreeMenu> = {
	title: "Components/TreeMenu",
	component: TreeMenu,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div className="p-8 bg-background text-foreground">
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof TreeMenu>;

const sampleItems: TreeMenuItem[] = [
	{
		id: "patients",
		label: "Patients",
		icon: <User className="h-4 w-4" />,
		badge: 12,
		children: [
			{ id: "patients/all", label: "All patients", badge: 120 },
			{
				id: "patients/favorites",
				label: "Favorites",
				badge: 4,
				children: [
					{ id: "patients/favorites/yamada", label: "山田 太郎" },
					{ id: "patients/favorites/sato", label: "佐藤 花子" },
				],
			},
			{
				id: "patients/recent",
				label: "Recent",
				children: [
					{ id: "patients/recent/1", label: "2025-12-15" },
					{ id: "patients/recent/2", label: "2025-12-14" },
					{ id: "patients/recent/3", label: "2025-12-13" },
				],
			},
		],
	},
	{
		id: "records",
		label: "Records",
		icon: <FileText className="h-4 w-4" />,
		children: [
			{
				id: "records/templates",
				label: "Templates",
				children: [
					{ id: "records/templates/dialysis", label: "Dialysis note" },
					{ id: "records/templates/vitals", label: "Vitals" },
				],
			},
			{
				id: "records/archive",
				label: "Archive",
				disabled: true,
				children: [{ id: "records/archive/2024", label: "2024" }],
			},
		],
	},
	{
		id: "settings",
		label: "Settings",
		icon: <Settings className="h-4 w-4" />,
		children: [
			{ id: "settings/profile", label: "Profile" },
			{ id: "settings/security", label: "Security" },
			{
				id: "settings/advanced",
				label: "Advanced",
				children: [
					{ id: "settings/advanced/featureFlags", label: "Feature flags" },
					{ id: "settings/advanced/logs", label: "Logs" },
				],
			},
		],
	},
];

export const Default: Story = {
	args: {
		title: "Menu",
		items: sampleItems,
		defaultExpandedIds: ["patients", "patients/favorites", "records"],
	},
};

export const Interactive: Story = {
	render: () => {
		const [selectedId, setSelectedId] = useState<string>(
			"patients/favorites/yamada",
		);
		const [expandedIds, setExpandedIds] = useState<string[]>([
			"patients",
			"patients/favorites",
			"records",
			"records/templates",
		]);

		return (
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				<div className="rounded border border-border bg-card p-3">
					<TreeMenu
						title="Navigation"
						items={sampleItems}
						selectedId={selectedId}
						onSelect={(id) => setSelectedId(id)}
						expandedIds={expandedIds}
						onExpandedChange={setExpandedIds}
					/>
				</div>

				<div className="rounded border border-border bg-card p-3">
					<div className="text-sm font-semibold text-foreground mb-2">
						Selected
					</div>
					<div className="text-sm text-muted-foreground break-all">
						{selectedId}
					</div>
					<div className="mt-4 text-xs text-muted-foreground">
						Click a row to select, click chevron to expand/collapse.
					</div>
				</div>
			</div>
		);
	},
};

export const Mobile: Story = {
	parameters: {
		viewport: { defaultViewport: "iphone6" },
		layout: "fullscreen",
	},
	render: () => {
		const [selectedId, setSelectedId] = useState<string>("patients/all");
		return (
			<div className="min-h-screen bg-background p-4">
				<div className="flex items-center gap-2 mb-3 text-foreground">
					<Folder className="h-5 w-5 text-muted-foreground" />
					<div className="text-sm font-semibold">Tree menu (mobile)</div>
				</div>
				<div className="rounded border border-border bg-card p-3">
					<TreeMenu
						title="Menu"
						items={sampleItems}
						dense
						selectedId={selectedId}
						onSelect={(id) => setSelectedId(id)}
						defaultExpandedIds={["patients"]}
					/>
				</div>
			</div>
		);
	},
};
export const FullFeatures: Story = {
	render: () => {
		const [selectedId, setSelectedId] = useState<string>(
			"patients/favorites/yamada",
		);

		return (
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				<div className="rounded border border-border bg-card p-3">
					<TreeMenu
						title="Menu with Control Bar"
						items={sampleItems}
						selectedId={selectedId}
						onSelect={(id) => setSelectedId(id)}
						defaultExpandedIds={["patients", "patients/favorites"]}
						showCloseButton={true}
						onCloseMenu={() => alert("Close menu clicked!")}
					/>
				</div>

				<div className="rounded border border-border bg-card p-3">
					<div className="text-sm font-semibold text-foreground mb-2">
						Features
					</div>
					<ul className="list-disc list-inside text-sm text-muted-foreground">
						<li>Control Bar (Top) with Expand All / Collapse All</li>
						<li>Close Menu Button (Left of title)</li>
						<li>Inset selection style</li>
					</ul>
				</div>
			</div>
		);
	},
};

// --- App Main Menu Data ---

const mainMenuData: TreeMenuItem[] = [
	{ id: "dashboard", label: "Dashboard", icon: <Home className="h-4 w-4" /> },
	{
		id: "hospital-schedule",
		label: "Hospital Schedule",
		icon: <Calendar className="h-4 w-4" />,
	},
	{
		id: "current-treatment",
		label: "Current Treatment",
		icon: <Bed className="h-4 w-4" />,
	},
	{
		id: "patients",
		label: "Patient List",
		icon: <Users className="h-4 w-4" />,
	},
	{
		id: "messages",
		label: "Messages",
		icon: <MessageSquare className="h-4 w-4" />,
	},
	{
		id: "bbs",
		label: "Bulletin Board",
		icon: <MessageSquareText className="h-4 w-4" />,
	},
	{
		id: "management",
		label: "Management",
		icon: <Settings2 className="h-4 w-4" />,
		children: [
			{
				id: "management-devices",
				label: "Devices",
				icon: <Monitor className="h-4 w-4" />,
			},
			{
				id: "management-personnel",
				label: "Personnel",
				icon: <Contact className="h-4 w-4" />,
			},
			{
				id: "management-roles",
				label: "Roles",
				icon: <GraduationCap className="h-4 w-4" />,
			},
			{
				id: "management-bed-layout",
				label: "Bed Layout",
				icon: <Bed className="h-4 w-4" />,
			},
			{
				id: "management-report-templates",
				label: "Report Templates",
				icon: <FileText className="h-4 w-4" />,
			},
			{
				id: "management-settings",
				label: "Basic Settings",
				icon: <Settings className="h-4 w-4" />,
			},
			{
				id: "management-audits",
				label: "Audit Logs",
				icon: <History className="h-4 w-4" />,
			},
		],
	},
	{
		id: "components",
		label: "Components",
		icon: <Boxes className="h-4 w-4" />,
		children: [
			{
				id: "component-notification-demo",
				label: "Notification Demo",
				icon: <BellRing className="h-4 w-4" />,
			},
			{
				id: "component-form-demo",
				label: "Form Demo",
				icon: <SquarePen className="h-4 w-4" />,
			},
			{
				id: "utility-calculator",
				label: "Calculator",
				icon: <Calculator className="h-4 w-4" />,
			},
		],
	},
];

export const AppMainMenu: Story = {
	args: {
		title: "Main Menu",
		items: mainMenuData,
		defaultExpandedIds: ["management", "components"],
		selectedId: "dashboard",
	},
	render: (args) => {
		const [selected, setSelected] = useState(args.selectedId);
		const [expanded, setExpanded] = useState(args.defaultExpandedIds);
		return (
			<div className="w-[14rem] border rounded-md bg-background">
				<TreeMenu
					{...args}
					selectedId={selected}
					onSelect={(id) => setSelected(id)}
					expandedIds={expanded}
					onExpandedChange={setExpanded}
				/>
			</div>
		);
	},
};

// --- App Patient Menu Data ---
const patientMenuData: TreeMenuItem[] = [
	{ id: "basic_info", label: "Basic Info", icon: <User className="h-4 w-4" /> },
	{
		id: "sessions_treatment",
		label: "Sessions & Treatment",
		icon: <CalendarCheck className="h-4 w-4" />,
	},
	{
		id: "patient_workflow",
		label: "Patient Workflow",
		icon: <ClipboardList className="h-4 w-4" />,
	},
	{
		id: "lab",
		label: "Lab Results",
		icon: <FlaskConical className="h-4 w-4" />,
	},
	{
		id: "medical_info",
		label: "Medical Info",
		icon: <FileHeart className="h-4 w-4" />,
	},
	{
		id: "fluid_balance",
		label: "Fluid Balance",
		icon: <Droplet className="h-4 w-4" />,
	},
	{
		id: "intradialytic_medication",
		label: "Intradialytic Medication",
		icon: <Syringe className="h-4 w-4" />,
	},
	{
		id: "ambulatory_medication",
		label: "Ambulatory Medication",
		icon: <Pill className="h-4 w-4" />,
	},
	{
		id: "medication_therapy_plans",
		label: "Medication Plans",
		icon: <FileText className="h-4 w-4" />,
	},
	{ id: "wounds", label: "Wounds", icon: <Bandage className="h-4 w-4" /> },
	{
		id: "complications",
		label: "Complications",
		icon: <AlertTriangle className="h-4 w-4" />,
	},
	{
		id: "observations",
		label: "Observations",
		icon: <Eye className="h-4 w-4" />,
	},
	{
		id: "consultations",
		label: "Consultations",
		icon: <MessageSquare className="h-4 w-4" />,
	},
	{
		id: "treatment_schedule",
		label: "Treatment Schedule",
		icon: <Calendar className="h-4 w-4" />,
	},
	{ id: "letters", label: "Letters", icon: <Mail className="h-4 w-4" /> },
	{
		id: "attachments",
		label: "Attachments",
		icon: <Paperclip className="h-4 w-4" />,
	},
];

export const AppPatientMenu: Story = {
	args: {
		title: "Patient Menu",
		items: patientMenuData,
		selectedId: "basic_info",
		hideControlBar: true,
		showCloseButton: false,
	},
	render: (args) => {
		const [selected, setSelected] = useState(args.selectedId);
		return (
			<div className="w-[14rem] border rounded-md bg-background">
				<TreeMenu
					{...args}
					selectedId={selected}
					onSelect={(id) => setSelected(id)}
				/>
			</div>
		);
	},
};
