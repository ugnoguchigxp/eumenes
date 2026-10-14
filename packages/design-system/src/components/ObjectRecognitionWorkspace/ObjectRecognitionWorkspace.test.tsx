import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ObjectRecognitionWorkspace } from "./ObjectRecognitionWorkspace";
import { DetectionPreview } from "./DetectionPreview";
import { CameraCapture } from "./CameraCapture";
import type { RecognitionItem } from "./types";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const item: RecognitionItem = { id: "one", name: "desk.png", mime: "image/png", state: "completed", errorCode: null, progress: null, result: { kind: "image", width: 1000, height: 500, objects: [{ classId: 41, label: "cup", confidence: .83, box: [100, 50, 300, 200] }] } };
it("renders source coordinates in an aspect-preserving SVG; exposes the selected observation", () => {
	const add = vi.fn(); const { container } = render(<DetectionPreview item={item} url="blob:fixture" onIncorporate={add} />);
	expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1000 500");
	expect(container.querySelector("rect")?.getAttribute("width")).toBe("200");
	expect(screen.getByText("[100, 50, 300, 200]")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "表示中の結果を会話に追加" })); expect(add).toHaveBeenCalledWith(undefined);
});
it("seek controls move the actual video to the frame and don't overlay unsampled moments", () => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const videoItem: RecognitionItem = { ...item, mime: "video/webm", result: { kind: "video", video: { width: 1000, height: 500 }, frames: [{ timestampSeconds: 0, objects: [] }, { timestampSeconds: 1.5, objects: item.result!.kind === "image" ? item.result!.objects : [] }] } };
	const add = vi.fn(); const { container } = render(<DetectionPreview item={videoItem} url="blob:fixture" onIncorporate={add} />);
	fireEvent.click(screen.getByRole("button", { name: "1.5秒 · 1件" })); const video = container.querySelector("video")!; expect(video.currentTime).toBe(1.5);
	fireEvent.click(screen.getByRole("button", { name: "表示中の結果を会話に追加" })); expect(add).toHaveBeenCalledWith(1);
	video.currentTime = 1.2; fireEvent.timeUpdate(video); expect(container.querySelector("svg")).toBeNull();
});
it("empty detections are a completed observation; cancel is available during processing", () => {
	const cancel = vi.fn(); const { rerender } = render(<ObjectRecognitionWorkspace items={[{ ...item, state: "running" }]} selectedId="one" configured onCancel={cancel} />);
	fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(cancel).toHaveBeenCalledWith("one");
	rerender(<ObjectRecognitionWorkspace items={[{ ...item, result: { kind: "image", width: 1000, height: 500, objects: [] } }]} selectedId="one" configured mediaUrl="blob:fixture" />);
	expect(screen.getByText("検出対象は見つかりませんでした。")).toBeTruthy(); expect(screen.queryByText("解析失敗")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("a camera stream obtained after unmount is stopped and never adopted", async () => {
	let resolve!: (s: MediaStream) => void; const stop = vi.fn();
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(r => { resolve = r; }) } });
	const { unmount } = render(<CameraCapture onCapture={async () => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "カメラを開く" })); unmount();
	resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream); await Promise.resolve(); expect(stop).toHaveBeenCalledOnce();
});
it("a result finished after cancellation is explicitly discarded without claiming the upstream execution stopped", () => {
	render(<ObjectRecognitionWorkspace items={[{ ...item, state: "cancelled", errorCode: "recognition_result_discarded", result: null }]} selectedId="one" configured mediaUrl="blob:fixture" />);
	expect(screen.getByText("取消済み（処理終了・結果不採用）", { exact: true })).toBeTruthy();
	expect(screen.getByRole("img", { name: "desk.png" })).toBeTruthy();
	expect(screen.queryByLabelText("検出枠")).toBeNull();
});
it("restores a failed video's source without displaying absent detections", () => {
	const failed = { ...item, mime: "video/webm", name: "clip.webm", state: "failed" as const, result: null };
	const { container } = render(<DetectionPreview item={failed} url="blob:fixture" />);
	const video = screen.getByLabelText("保存した動画");
	expect(video.getAttribute("src")).toBe("blob:fixture");
	fireEvent.timeUpdate(video);
	expect(container.querySelector("svg")).toBeNull();
});
it("distinguishes a saved camera image from an unconfirmed analysis submission", () => {
	render(<ObjectRecognitionWorkspace items={[{ ...item, name: "camera.jpg", state: "failed", errorCode: "recognition_submission_unconfirmed", result: null }]} selectedId="one" configured />);
	expect(screen.getByText(/画像・動画は保存済みです。解析サービスへの受付を確認できませんでした。/)).toBeTruthy();
});
it("opens saved media from the header menu and confirms deletion of a finished item", () => {
	const onSelect = vi.fn();
	const onRemove = vi.fn();
	render(<ObjectRecognitionWorkspace items={[item, { ...item, id: "two", name: "recording.webm", state: "running", result: null }]} selectedId="one" configured onSelect={onSelect} onRemove={onRemove} />);
	fireEvent.click(screen.getByRole("button", { name: "資料一覧" }));
	const menu = screen.getByRole("menu", { name: "資料一覧" });
	expect(menu).toBeTruthy();
	expect((screen.getByRole("button", { name: "recording.webmを削除" }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "desk.pngを削除" }));
	expect(onRemove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	expect(onRemove).toHaveBeenCalledWith("one");
	expect(screen.queryByRole("menu", { name: "資料一覧" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "資料一覧" }));
	fireEvent.click(screen.getByRole("menuitem", { name: /recording.webm/ }));
	expect(onSelect).toHaveBeenCalledWith("two");
});
it("offers only an available backend shared credential and sends the selected source without a secret", () => {
	const change = vi.fn();
	render(<ObjectRecognitionWorkspace items={[]} configured hasEndpoint credentialSource="dedicated" sharedCredentialAvailable onCredentialSourceChange={change} />);
	fireEvent.change(screen.getByRole("combobox", { name: "物体認識の認証方式" }), { target: { value: "larm" } });
	expect(change).toHaveBeenCalledWith("larm");
});

it("shows a labeled loading indicator while submitting and analyzing", async () => {
	let finishUpload!: () => void;
	const onFile = vi.fn(() => new Promise<void>((resolve) => { finishUpload = resolve; }));
	const { container, rerender } = render(
		<ObjectRecognitionWorkspace items={[]} configured onFile={onFile} />,
	);
	fireEvent.change(screen.getByLabelText("画像・動画を選ぶ"), {
		target: { files: [new File(["image"], "desk.png", { type: "image/png" })] },
	});
	const submitting = screen.getByRole("button", { name: "画像・動画を送信中" });
	expect(submitting.getAttribute("aria-busy")).toBe("true");
	expect(container.querySelector(".recognition-submit-loading .recognition-spinner")).toBeTruthy();
	await act(async () => finishUpload());
	rerender(
		<ObjectRecognitionWorkspace
			items={[{ ...item, state: "running", result: null }]}
			selectedId="one"
			configured
		/>,
	);
	expect(screen.getByRole("button", { name: "解析中" }).getAttribute("aria-busy")).toBe("true");
	expect(container.querySelectorAll(".recognition-spinner")).toHaveLength(2);
	rerender(<ObjectRecognitionWorkspace items={[item]} selectedId="one" configured />);
	expect(screen.getByRole("button", { name: "撮影して調べる" }).getAttribute("aria-busy")).toBe("false");
	expect(container.querySelector(".recognition-spinner")).toBeNull();
});
