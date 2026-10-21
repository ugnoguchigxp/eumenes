import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputeWorkspace, type ComputeJob } from ".";
const job: ComputeJob = {
	id: "job-a",
	state: "running",
	stage: "running",
	code: "result = 2",
	cancelRequested: true,
	progress: { message: "half", ratio: 0.5 },
	result: null,
	error: null,
	artifactError: null,
	artifacts: [],
};
test("pending cancellation is never shown as cancelled", () => {
	render(
		<ComputeWorkspace
			jobs={[job]}
			available
			onCancel={vi.fn()}
			onReconcile={vi.fn()}
			onRefresh={vi.fn()}
			onDownload={vi.fn()}
		/>,
	);
	expect(screen.getByText("実行中")).toBeInTheDocument();
	expect(
		screen.getByText("取消を要求しました。停止を確認しています。"),
	).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "計算を取り消す" })).toBeDisabled();
});
test("SVG remains a download and external strings render as text", () => {
	const download = vi.fn();
	render(
		<ComputeWorkspace
			jobs={[
				{
					...job,
					state: "completed",
					cancelRequested: false,
					error: { code: "runtime_error", message: "<script>bad</script>" },
					artifacts: [
						{
							id: "artifact",
							name: "figure.svg",
							mime: "image/svg+xml",
							bytes: 6,
							ready: true,
							url: "blob:svg",
						},
					],
				},
			]}
			available
			onCancel={vi.fn()}
			onReconcile={vi.fn()}
			onRefresh={vi.fn()}
			onDownload={download}
		/>,
	);
	expect(screen.queryByRole("img")).toBeNull();
	expect(screen.getByText("<script>bad</script>")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "ダウンロード" }));
	expect(download).toHaveBeenCalledWith("job-a", "artifact", "figure.svg");
});

test("library table keeps the selected past calculation through updates and targets its actions", async () => {
	const user = userEvent.setup();
	const cancel = vi.fn();
	const props = {
		available: true,
		onCancel: cancel,
		onReconcile: vi.fn(),
		onRefresh: vi.fn(),
		onDownload: vi.fn(),
	};
	const past = {
		...job,
		id: "job-past",
		cancelRequested: false,
		code: "past calculation",
		artifacts: [
			{
				id: "past-file",
				name: "past.csv",
				mime: "text/csv",
				bytes: 4,
				ready: true,
			},
		],
	};
	const jobs = [job, past];
	const { rerender } = render(<ComputeWorkspace {...props} jobs={jobs} />);
	expect(screen.queryByRole("combobox")).toBeNull();
	await user.click(screen.getByRole("tab", { name: "ライブラリ" }));
	expect(screen.getByRole("table")).toBeInTheDocument();
	expect(screen.queryByText("past calculation")).toBeNull();
	await user.click(screen.getByRole("button", { name: "計算 job-pastを開く" }));
	expect(screen.getByRole("tab", { name: "計算結果" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await user.click(
		screen.getByRole("button", { name: "実行したPythonコード" }),
	);
	expect(screen.getByText("past calculation")).toBeInTheDocument();
	rerender(
		<ComputeWorkspace
			{...props}
			jobs={[{ ...job, stage: "collecting" }, past]}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "計算 job-past" }),
	).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "計算を取り消す" }));
	expect(cancel).toHaveBeenCalledWith("job-past");
	await user.click(screen.getByRole("button", { name: "ダウンロード" }));
	expect(props.onDownload).toHaveBeenCalledWith(
		"job-past",
		"past-file",
		"past.csv",
	);
});

test("code precedes the open result accordion, whose graph and downloads collapse together", async () => {
	const user = userEvent.setup();
	const completed: ComputeJob = {
		...job,
		state: "completed",
		cancelRequested: false,
		result: {
			value: 5050,
			stdout: "sum complete",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
		},
		artifacts: [
			{
				id: "png",
				name: "graph.png",
				mime: "image/png",
				bytes: 20,
				ready: true,
				url: "blob:png",
			},
		],
	};
	const props = {
		available: true,
		onCancel: vi.fn(),
		onReconcile: vi.fn(),
		onRefresh: vi.fn(),
		onDownload: vi.fn(),
	};
	const { rerender } = render(
		<ComputeWorkspace {...props} jobs={[completed]} />,
	);
	const code = screen.getByRole("button", { name: "実行したPythonコード" });
	const result = screen.getByRole("button", { name: /^結果$/ });
	expect(code).toHaveAttribute("aria-expanded", "false");
	expect(result).toHaveAttribute("aria-expanded", "true");
	expect(
		code.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	const resultContent = document.getElementById(
		result.getAttribute("aria-controls")!,
	)!;
	expect(within(resultContent).getByText("5050")).toBeVisible();
	expect(within(resultContent).getByText("標準出力")).toBeInTheDocument();
	expect(
		within(resultContent).getByRole("img", { name: "graph.png" }),
	).toBeVisible();
	expect(
		within(resultContent).getByRole("button", { name: "ダウンロード" }),
	).toBeVisible();
	await user.click(code);
	await user.click(result);
	rerender(
		<ComputeWorkspace {...props} jobs={[{ ...completed, stage: "updated" }]} />,
	);
	expect(code).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByText("result = 2")).toBeVisible();
	expect(result).toHaveAttribute("aria-expanded", "false");
	expect(screen.queryByRole("img")).toBeNull();
	expect(screen.queryByRole("button", { name: "ダウンロード" })).toBeNull();
	rerender(
		<ComputeWorkspace {...props} jobs={[{ ...completed, id: "another" }]} />,
	);
	expect(
		screen.getByRole("button", { name: "実行したPythonコード" }),
	).toHaveAttribute("aria-expanded", "false");
	expect(screen.getByRole("button", { name: /^結果$/ })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
});
