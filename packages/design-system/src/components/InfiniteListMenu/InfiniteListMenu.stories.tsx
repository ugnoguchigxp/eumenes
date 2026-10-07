import type { Meta, StoryObj } from "@storybook/react-vite";
import { Filter, User } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import {
	InfiniteListMenu,
	type InfiniteListMenuItem,
} from "./InfiniteListMenu";

const meta: Meta<typeof InfiniteListMenu> = {
	title: "Components/InfiniteListMenu",
	component: InfiniteListMenu,
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
type Story = StoryObj<typeof InfiniteListMenu>;

const createPatients = () =>
	Array.from({ length: 120 }, (_, index) => {
		const id = index + 1;
		const age = 20 + (index % 70);
		const ward = (index % 6) + 1;
		const item: InfiniteListMenuItem = {
			id: `patient-${id}`,
			label: `患者 ${String(id).padStart(3, "0")}`,
			description: `病棟 ${ward} / ${age}歳`,
			meta: id % 12 === 0 ? "要注意" : undefined,
			badge: id % 15 === 0 ? "新規" : undefined,
			icon: <User className="h-4 w-4" />,
		};
		return item;
	});

export const PatientList: Story = {
	render: () => {
		const allPatients = useMemo(() => createPatients(), []);
		const [visibleCount, setVisibleCount] = useState(20);
		const [isLoading, setIsLoading] = useState(false);
		const [selectedId, setSelectedId] = useState<string | undefined>();
		const [isFilterOpen, setIsFilterOpen] = useState(false);

		const visibleItems = useMemo(
			() => allPatients.slice(0, visibleCount),
			[allPatients, visibleCount],
		);

		const hasMore = visibleCount < allPatients.length;

		const loadMore = () => {
			if (isLoading || !hasMore) return;
			setIsLoading(true);
			setTimeout(() => {
				setVisibleCount((count) => Math.min(count + 10, allPatients.length));
				setIsLoading(false);
			}, 400);
		};

		return (
			<div className="h-[420px] w-[320px]">
				<InfiniteListMenu
					title="患者一覧"
					headerMeta={
						<div className="flex items-center gap-2">
							<span className="text-xs text-primary-foreground/80">
								{visibleCount} / {allPatients.length}
							</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7 px-2 text-primary-foreground hover:text-primary-foreground/80"
								onClick={() => setIsFilterOpen(true)}
								aria-label="フィルターを開く"
							>
								<Filter className="h-4 w-4" />
							</Button>
						</div>
					}
					items={visibleItems}
					selectedId={selectedId}
					onSelect={(id) => setSelectedId(id)}
					onLoadMore={loadMore}
					hasMore={hasMore}
					isLoading={isLoading}
					loadingText="読み込み中..."
					endText="最後まで読み込みました"
					resizable
					resizeMinWidth={260}
				/>
				<Modal
					open={isFilterOpen}
					onOpenChange={setIsFilterOpen}
					title="患者フィルター"
					description="条件を選択して絞り込みます。"
				>
					<div className="text-sm text-muted-foreground">
						ここにフィルター項目が入ります。
					</div>
				</Modal>
			</div>
		);
	},
};

export const Empty: Story = {
	args: {
		title: "患者一覧",
		items: [],
		emptyText: "該当する患者がいません。",
	},
};

export const Resizable: Story = {
	render: () => {
		const items = Array.from({ length: 20 }, (_, index) => ({
			id: `patient-${index + 1}`,
			label: `患者 ${String(index + 1).padStart(3, "0")}`,
			description: `病棟 ${(index % 6) + 1}`,
		}));
		const [isFilterOpen, setIsFilterOpen] = useState(false);

		return (
			<div className="h-[320px] w-[520px]">
				<InfiniteListMenu
					title="患者一覧（リサイズ）"
					headerMeta={
						<div className="flex items-center gap-2">
							<span className="text-xs text-primary-foreground/80">
								{items.length} / 120
							</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7 px-2 text-primary-foreground hover:text-primary-foreground/80"
								onClick={() => setIsFilterOpen(true)}
								aria-label="フィルターを開く"
							>
								<Filter className="h-4 w-4" />
							</Button>
						</div>
					}
					items={items}
					resizable
					resizeMinWidth={220}
					resizeMaxWidth="100%"
				/>
				<Modal
					open={isFilterOpen}
					onOpenChange={setIsFilterOpen}
					title="患者フィルター"
					description="条件を選択して絞り込みます。"
				>
					<div className="text-sm text-muted-foreground">
						ここにフィルター項目が入ります。
					</div>
				</Modal>
			</div>
		);
	},
};

export const WithDividers: Story = {
	args: {
		title: "With Dividers",
		items: createPatients().slice(0, 10),
		showDividers: true,
	},
};

export const WithAdaptiveText: Story = {
	render: () => {
		const longItems = [
			{
				id: "1",
				label:
					"This is a very very long label that should definitely adapt to the container width because it is too long",
			},
			{ id: "2", label: "Short label" },
			{
				id: "3",
				label:
					"Another extremely long label that will hopefully scale down nicely or truncate if it is way too long",
			},
		];
		return (
			<div className="h-[300px] w-[250px]">
				<InfiniteListMenu
					title="Adaptive Text"
					items={longItems}
					enableAdaptiveText
					resizable
					resizeMinWidth={200}
				/>
			</div>
		);
	},
};

export const ResizableWithMetaAndDividers: Story = {
	render: () => {
		const items = useMemo(() => {
			const base = createPatients().slice(0, 50);
			// Make some items long to test adaptive text
			// Make some items long to test adaptive text
			if (base[0]) {
				base[0].label =
					"This is a very long patient name that needs adaptive text scaling to fit";
			}
			if (base[2]) {
				base[2].label = "Another long name for testing adaptive capabilities";
			}
			return base;
		}, []);
		const [isFilterOpen, setIsFilterOpen] = useState(false);

		return (
			<div className="h-[450px] w-[320px] border border-dashed border-muted p-4">
				{/* Container with dashed border to visualize resizing context */}
				<InfiniteListMenu
					title="患者一覧（全部入り）"
					headerMeta={
						<div className="flex items-center gap-1">
							<span className="text-xs text-primary-foreground/80 shrink-0">
								{items.length}件
							</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0 text-primary-foreground hover:text-primary-foreground/80 shrink-0"
								onClick={() => setIsFilterOpen(true)}
								aria-label="フィルター"
							>
								<Filter className="h-3.5 w-3.5" />
							</Button>
						</div>
					}
					items={items}
					showDividers
					enableAdaptiveText
					resizable
					resizeMinWidth={240}
					resizeMaxWidth="100%"
				/>
				<Modal
					open={isFilterOpen}
					onOpenChange={setIsFilterOpen}
					title="患者フィルター"
					description="絞り込み条件"
				>
					<div className="text-sm text-muted-foreground">
						フィルターの内容...
					</div>
				</Modal>
			</div>
		);
	},
};
