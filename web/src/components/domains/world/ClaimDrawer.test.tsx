import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../../client";
import type {
	ClaimDetail,
	ClaimRow,
} from "../../../../../api/domains/world/contracts/view";
import { ClaimDrawer } from "./ClaimDrawer";

const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
});

const claim: ClaimRow = {
	id: "claim-1",
	revision: 3,
	target: { subjectId: "svc-1" },
	claim: {
		predicate: "launch",
		content: { kind: "value", value: { kind: "string", value: "9月" } },
	},
	adoption: "adopted",
	origin: "user_report",
	evidenceKinds: ["user_statement"],
	freshness: "fresh",
	tone: "adopted",
};
const detail: ClaimDetail = {
	claim,
	scopeKey: "profile:owner",
	asOf: 1,
	recordedAt: 1,
	condition: {
		kind: "unspecified",
		text: "条件は記述されていません",
		evaluation: "unknown",
		reasons: ["UNSPECIFIED_CONDITION"],
	},
	supports: [],
	refutations: { evidence: [], claims: [] },
	sources: [],
	history: [
		{
			revision: 3,
			lifecycle: "active",
			origin: "user_report",
			recordedAt: 1,
			content: claim.claim.content,
		},
	],
	historyTruncated: false,
};
const reasons = [{ id: "m1", text: "いいえ10月からです" }];

function setup(
	over: {
		worldClaim?: () => Promise<ClaimDetail>;
		correctWorldClaim?: () => Promise<unknown>;
	} = {},
) {
	const client = {
		identity: "claim-drawer-test",
		worldClaim: vi.fn(over.worldClaim ?? (async () => detail)),
		correctWorldClaim: vi.fn(
			over.correctWorldClaim ??
				(async () => ({ status: "applied", claimId: "claim-1" })),
		),
		retractWorldClaim: vi.fn(),
		forgetWorldClaim: vi.fn(),
	};
	const props = {
		onClose: vi.fn(),
		onPick: vi.fn(),
		onDone: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<ClaimDrawer
				client={client as never}
				scopeKey="profile:owner"
				claimId="claim-1"
				reasons={reasons}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { client, ...props };
}
const ready = () =>
	screen.findByText("条件は記述されていません", { exact: false });
const fillCorrection = () => {
	fireEvent.change(screen.getByLabelText("理由にする、あなたの発言"), {
		target: { value: "m1" },
	});
	fireEvent.change(screen.getAllByLabelText("新しい値")[0]!, {
		target: { value: "10月" },
	});
};

test("it shows a loading state, then the claim, and closes by button and Escape", async () => {
	const { onClose } = setup();
	expect(screen.getByText("読み込み中…")).toBeTruthy();
	await ready();
	expect(screen.getByText(/launch : 9月/)).toBeTruthy();
	expect(document.activeElement?.textContent).toBe("主張の詳細");
	fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
	expect(onClose).toHaveBeenCalledTimes(1);
	fireEvent.keyDown(document, { key: "Escape" });
	expect(onClose).toHaveBeenCalledTimes(2);
});

test("a claim that cannot be loaded says so and offers no operations", async () => {
	setup({
		worldClaim: async () => {
			throw new ApiError(500, "world_unavailable");
		},
	});
	await screen.findByText(/この主張を表示できません/);
	expect(screen.queryByRole("button", { name: "訂正する" })).toBeNull();
});

test("the correction needs a reason and a value, then sends the shown revision", async () => {
	const { client, onDone } = setup();
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
	const send = screen.getByRole("button", { name: "訂正を送る" });
	expect((send as HTMLButtonElement).disabled).toBe(true);
	fillCorrection();
	expect((send as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(send);
	await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
	expect(onDone.mock.calls[0]![0]).toContain("訂正しました");
	expect(client.correctWorldClaim).toHaveBeenCalledWith(
		expect.objectContaining({
			scopeKey: "profile:owner",
			expectedRevision: 3,
			target: { claimId: "claim-1" },
			reasonMessageId: "m1",
			value: { kind: "string", value: "10月" },
		}),
	);
});

test("a revision conflict is reported, the claim is reloaded and nothing is marked done", async () => {
	const { client, onDone } = setup({
		correctWorldClaim: async () => {
			throw new ApiError(409, "revision_conflict");
		},
	});
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
	fillCorrection();
	fireEvent.click(screen.getByRole("button", { name: "訂正を送る" }));
	const alert = await screen.findByText(/他の操作で変わりました/);
	expect(alert.getAttribute("role")).toBe("alert");
	expect(onDone).not.toHaveBeenCalled();
	await waitFor(() =>
		expect(client.worldClaim.mock.calls.length).toBeGreaterThan(1),
	);
});

test("an unexpected failure shows a generic message without reloading", async () => {
	const { client, onDone } = setup({
		correctWorldClaim: async () => {
			throw new ApiError(500, "internal_error");
		},
	});
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
	fillCorrection();
	fireEvent.click(screen.getByRole("button", { name: "訂正を送る" }));
	await screen.findByText("操作できませんでした。");
	expect(onDone).not.toHaveBeenCalled();
	expect(client.worldClaim).toHaveBeenCalledTimes(1);
});

test("an ambiguous target lists candidates that can be opened", async () => {
	const other: ClaimRow = { ...claim, id: "claim-2" };
	const { onPick, onDone } = setup({
		correctWorldClaim: async () => ({
			status: "unresolved",
			candidates: [other],
		}),
	});
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
	fillCorrection();
	fireEvent.click(screen.getByRole("button", { name: "訂正を送る" }));
	await screen.findByText(/対象が一つに決まりません/);
	expect(onDone).not.toHaveBeenCalled();
	const list = screen.getByRole("list", { name: "候補の主張" });
	fireEvent.click(within(list).getByRole("button"));
	expect(onPick).toHaveBeenCalledWith(other);
});
