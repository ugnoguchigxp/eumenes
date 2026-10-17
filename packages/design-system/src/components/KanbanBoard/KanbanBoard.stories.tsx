import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { KanbanBoard } from "./KanbanBoard";
import {
	baseProps,
	blockerActions,
	blockerCard,
	card,
	doneActions,
	doneCard,
	longReport,
	runningCard,
	todoCards,
} from "./KanbanBoard.fixtures";
import type { KanbanBoardCard, KanbanBoardProps } from "./types";

const meta: Meta<typeof KanbanBoard> = {
	title: "Components/KanbanBoard",
	component: KanbanBoard,
	tags: ["autodocs"],
	args: baseProps,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div style={{ height: 640 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof KanbanBoard>;

const queued = (id: string, n: number, title: string) =>
	card(id, {
		title,
		column: "running",
		statusText: `キュー待ち（${n}番目）`,
		actions: ["cancel"],
	});

export const Empty: Story = {};
export const Columns: Story = {
	args: { cards: [...todoCards, runningCard, doneCard, blockerCard] },
};
export const Queued: Story = {
	args: {
		cards: [
			runningCard,
			queued("q1", 1, "リリースノートの下書き"),
			queued("q2", 2, "依存パッケージの確認"),
		],
		queue: { state: "running", waiting: 2, runningTitle: runningCard.title },
	},
};
export const Sending: Story = {
	args: {
		cards: [{ ...runningCard, statusText: "送信待ち", actions: ["cancel"] }],
		queue: { state: "running", waiting: 0, runningTitle: runningCard.title },
	},
};
export const Working: Story = {
	args: {
		cards: [runningCard],
		queue: { state: "running", waiting: 0, runningTitle: runningCard.title },
	},
};
export const WaitingForPermission: Story = {
	args: {
		cards: [{ ...runningCard, statusText: "許可を待っています" }],
		queue: { state: "running", waiting: 0, runningTitle: runningCard.title },
	},
};
export const StopUnconfirmed: Story = {
	args: {
		cards: [{ ...runningCard, statusText: "停止を確認中", actions: ["open"] }],
		queue: {
			state: "paused",
			reasonText: "止めたタスクの終了を確認できていません",
			waiting: 1,
			runningTitle: runningCard.title,
		},
	},
};
export const DoneWithReport: Story = { args: { cards: [doneCard] } };
export const DoneLongReport: Story = {
	args: { cards: [{ ...doneCard, lastReport: longReport }] },
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "詳細を見る" }),
		);
	},
};
export const DoneReviewed: Story = {
	args: {
		cards: [
			{
				...doneCard,
				reviewed: true,
				actions: doneActions.filter((a) => a !== "review"),
			},
		],
	},
};
export const DoneCommitPushReported: Story = {
	args: {
		cards: [{ ...doneCard, reviewed: true, commitPushReported: true }],
	},
};
export const DoneFollowedByOtherRun: Story = {
	args: { cards: [{ ...doneCard, followedByOtherRun: true }] },
};

const reasons: Array<[string, string]> = [
	["interrupted", "途中で止まりました（Esc などで中断されました）"],
	["ended", "作業担当が終了しました"],
	["unknown", "実行状況を確認できません（送信中に停止または再起動しました）"],
	[
		"tracking_lost",
		"状態を追えません。フックが届いていません（管理設定・プロキシ・curl を確認してください）",
	],
	["cancelled", "送る前に取り消しました"],
	["send_failed", "送信に失敗しました"],
	["stopped_by_person", "利用者が止めました"],
	["resume_failed", "前の会話を再開できませんでした"],
];
export const BlockerReasons: Story = {
	args: {
		cards: reasons.map(([id, reasonText]) =>
			card(id, {
				title: `Blocker: ${id}`,
				column: "finished",
				label: "blocker",
				reasonText,
				actions: blockerActions,
			}),
		),
	},
};
export const QueuePaused: Story = {
	args: {
		cards: [blockerCard, ...todoCards],
		queue: {
			state: "paused",
			reasonText: "状態を追えないため止めました",
			waiting: 2,
		},
	},
};
export const NotRunnable: Story = {
	args: {
		cards: todoCards,
		runnable: false,
		notRunnableText: "この環境では作業の状態を追えないため実行できません",
	},
};
export const Conflict: Story = {
	args: {
		cards: todoCards,
		message:
			"状態が変わりました。最新の表示を読み込みました。もう一度お試しください。",
	},
};
export const Busy: Story = { args: { cards: todoCards, busy: true } };
export const Narrow: Story = {
	args: { cards: [...todoCards, runningCard, doneCard, blockerCard] },
	decorators: [
		(Story) => (
			<div style={{ width: 360, height: 900 }}>
				<Story />
			</div>
		),
	],
};

function Playground(props: KanbanBoardProps) {
	const [cards, setCards] = useState<KanbanBoardCard[]>(props.cards);
	return (
		<KanbanBoard
			{...props}
			cards={cards}
			onAdd={({ title, prompt }) =>
				setCards((all) => [
					...all,
					card(`new-${all.length}`, {
						title,
						prompt,
						actions: ["run", "edit", "remove"],
					}),
				])
			}
			onEdit={(id, revision, change) =>
				setCards((all) =>
					all.map((c) =>
						c.id === id ? { ...c, ...change, revision: revision + 1 } : c,
					),
				)
			}
			onMove={(id, revision, column, before) =>
				setCards((all) => {
					const moved = all.find((c) => c.id === id);
					if (!moved) return all;
					const next: KanbanBoardCard = {
						...moved,
						revision: revision + 1,
						column,
						label: column === "finished" ? "done" : undefined,
					};
					const rest = all.filter((c) => c.id !== id);
					const at = before ? rest.findIndex((c) => c.id === before) : -1;
					return at < 0
						? [...rest, next]
						: [...rest.slice(0, at), next, ...rest.slice(at)];
				})
			}
			onAction={(action, id) => {
				if (action === "remove")
					setCards((all) => all.filter((c) => c.id !== id));
			}}
		/>
	);
}
export const Interactive: Story = {
	args: { cards: [...todoCards, doneCard] },
	render: (args) => <Playground {...args} />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const cardB = canvas.getByRole("article", { name: "ログ出力の見直し" });
		await userEvent.click(within(cardB).getByRole("button", { name: "移動" }));
		await userEvent.selectOptions(
			canvas.getByRole("combobox", { name: "位置" }),
			"a",
		);
		await userEvent.click(canvas.getByRole("button", { name: "移動する" }));
		const todo = canvas.getByRole("list", { name: "未着手＋Planningのタスク" });
		await expect(
			within(todo)
				.getAllByRole("heading", { level: 4 })
				.map((h) => h.textContent),
		).toEqual(["ログ出力の見直し", "README の手順修正", "設定画面の文言統一"]);
	},
};
