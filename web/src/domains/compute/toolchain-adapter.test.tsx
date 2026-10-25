import { afterEach, expect, test, vi } from "vitest";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { computeWebAdapter } from "./toolchain-adapter";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	document.body.innerHTML = "";
});
test("loads persisted source, refreshes after settlement and reconciles without resubmitting", async () => {
	const client = {
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 1,
			data: { jobs: [], environment: { protocol: "larm.compute.v1" } },
		})),
		compute: { reconcile: vi.fn(async () => {}), artifact: vi.fn() },
	};
	const context = {
		client,
		artifactRevisionId: "artifact:compute.workspace@1",
		visible: true,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => computeWebAdapter.useArtifact(context));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot.compute).toMatchObject({
		kind: "compute",
		available: true,
		jobs: [],
	});
	await act(async () => {
		await hook.result.current.local({} as never, {
			id: "e",
			source: "compute",
			revision: 1,
			action: "compute-reconcile",
			values: { jobId: "id" },
		});
	});
	expect(client.compute.reconcile).toHaveBeenCalledOnce();
	const before = client.toolchainArtifactSource.mock.calls.length;
	act(() =>
		hook.result.current.settled(
			{} as never,
			{} as never,
			{ sent: 0, sentAt: 0 },
			{},
		),
	);
	await waitFor(() =>
		expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			before,
		),
	);
});
test("failed source is explicit and SVG is never fetched for inline preview", async () => {
	const client = {
		toolchainArtifactSource: vi.fn(async () => {
			throw new Error("down");
		}),
		compute: { artifact: vi.fn() },
	};
	const hook = renderHook(() =>
		computeWebAdapter.useArtifact({
			client,
			visible: true,
			artifactRevisionId: "artifact:compute.workspace@1",
		} as unknown as AdapterHostContext),
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
	expect(client.compute.artifact).not.toHaveBeenCalled();
});

test("a failed PNG preview does not hide job state, results or SVG downloads", async () => {
	const job = {
		id: crypto.randomUUID(),
		state: "completed",
		stage: "completed",
		code: "plot()",
		cancelRequested: false,
		progress: null,
		result: {
			value: 2,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [],
		},
		error: null,
		artifactError: null,
		expiresAt: null,
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		artifacts: [
			{
				id: crypto.randomUUID(),
				name: "plot.png",
				mime: "image/png",
				bytes: 10,
				ready: true,
			},
			{
				id: crypto.randomUUID(),
				name: "plot.svg",
				mime: "image/svg+xml",
				bytes: 10,
				ready: true,
			},
		],
	};
	const client = {
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 1,
			data: { jobs: [job], environment: null },
		})),
		compute: {
			artifact: vi.fn(async () => {
				throw new Error("download unavailable");
			}),
		},
	};
	const hook = renderHook(() =>
		computeWebAdapter.useArtifact({
			client,
			visible: true,
			artifactRevisionId: "artifact:compute.workspace@1",
		} as unknown as AdapterHostContext),
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot.compute).toMatchObject({
		jobs: [
			{
				id: job.id,
				result: { value: 2 },
				artifacts: [
					{ mime: "image/png", ready: true },
					{ mime: "image/svg+xml", ready: true },
				],
			},
		],
	});
	expect(client.compute.artifact).toHaveBeenCalledTimes(1);
});

function savedJob(id: string) {
	return {
		id,
		state: "completed",
		stage: "completed",
		code: "1+1",
		cancelRequested: false,
		progress: null,
		result: {
			value: 2,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [],
		},
		error: null,
		artifactError: null,
		expiresAt: null,
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		artifacts: [],
	};
}

/** The result card the workspace draws for a job. */
function drawResult(jobId: string) {
	const root = document.createElement("section");
	root.className = "compute-workspace";
	const article = document.createElement("article");
	const id = document.createElement("span");
	id.title = jobId;
	id.setAttribute("aria-label", `計算ID ${jobId}`);
	article.append(id);
	article.scrollIntoView = vi.fn();
	root.append(article);
	document.body.append(root);
	return article;
}

function mount(jobIds: string[]) {
	const client = {
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 1,
			data: { jobs: jobIds.map(savedJob), environment: null },
		})),
		compute: { artifact: vi.fn() },
	};
	return renderHook(() =>
		computeWebAdapter.useArtifact({
			client,
			visible: true,
			artifactRevisionId: "artifact:compute.workspace@1",
		} as unknown as AdapterHostContext),
	);
}

test("focus selects the job, marks its result for two seconds and viewing names it", async () => {
	const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
	const hook = mount([first, second]);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const card = drawResult(second);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let done: Promise<boolean> | undefined;
	await act(async () => {
		done = computeWebAdapter.focus?.(second);
		await vi.advanceTimersByTimeAsync(200);
	});
	await expect(done).resolves.toBe(true);
	expect(hook.result.current.snapshot.compute).toMatchObject({
		selectedJobId: second,
	});
	expect(card.getAttribute("data-resource-focus")).toBe("true");
	expect(computeWebAdapter.viewing?.()).toBe(
		`eumenes://compute.result/${second}`,
	);
	await vi.advanceTimersByTimeAsync(2_010);
	expect(card.hasAttribute("data-resource-focus")).toBe(false);
});

test("focus says no to a job the screen lacks, and viewing is null without a shown job", async () => {
	const hook = mount([crypto.randomUUID()]);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(computeWebAdapter.viewing?.()).toBeNull();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const unknown = computeWebAdapter.focus?.("missing");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(unknown).resolves.toBe(false);
});
