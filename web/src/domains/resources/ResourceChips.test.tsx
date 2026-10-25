import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationResourcesResponse } from "../../../../api/domains/resources/contracts";
import { ResourceChips } from "./ResourceChips";

afterEach(cleanup);

const data: ConversationResourcesResponse = {
	resources: [
		{
			ref: "a1",
			uri: "eumenes://music.track/m1",
			kind: "music.track",
			kindLabel: "曲",
			label: "夜のドライブ",
			actions: ["play", "open", "read"],
			forgotten: false,
		},
		{
			ref: "a2",
			uri: "eumenes://image/i1",
			kind: "image",
			kindLabel: "画像",
			label: "決戦前",
			actions: ["open", "read"],
			preview: "/api/images/i1/content",
			forgotten: false,
		},
		{
			ref: "a3",
			uri: "eumenes://report/r1",
			kind: "report",
			kindLabel: "調査報告",
			label: "講演の要点",
			actions: ["read", "open"],
			preview: "要点を一行にした文章",
			forgotten: false,
		},
		{
			ref: "a4",
			uri: "eumenes://event/e1",
			kind: "event",
			kindLabel: "会話の出来事",
			label: "出来事",
			actions: ["read"],
			forgotten: false,
		},
		{
			ref: "a5",
			uri: "eumenes://image/forgotten",
			kind: "image",
			kindLabel: "画像",
			label: "忘れた画像",
			actions: ["open"],
			forgotten: true,
		},
	],
	messages: [
		{
			messageId: "m-1",
			uris: [
				"eumenes://music.track/m1",
				"eumenes://image/i1",
				"eumenes://report/r1",
				"eumenes://event/e1",
				"eumenes://image/forgotten",
				"eumenes://image/unknown",
			],
		},
		{ messageId: "m-empty", uris: [] },
	],
};

test("a chip per linked resource: the default action first, the others after it", () => {
	const onOpen = vi.fn();
	render(<ResourceChips messageId="m-1" data={data} onOpen={onOpen} />);
	const chips = screen.getAllByRole("listitem");
	// Forgotten and unknown resources are not shown; an event has nothing to press.
	expect(chips.map((c) => c.getAttribute("data-kind"))).toEqual([
		"music.track",
		"image",
		"report",
		"event",
	]);
	const track = within(chips[0]!).getAllByRole("button");
	expect(track.map((b) => b.getAttribute("aria-label"))).toEqual([
		"夜のドライブを再生する",
		"夜のドライブを表示する",
	]);
	fireEvent.click(track[0]!);
	fireEvent.click(track[1]!);
	expect(onOpen.mock.calls).toEqual([
		["eumenes://music.track/m1", "play"],
		["eumenes://music.track/m1", "open"],
	]);
	// `read` is for the conversation agent; a report whose default is read opens on screen.
	expect(
		within(chips[2]!)
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label")),
	).toEqual(["講演の要点を表示する"]);
	expect(within(chips[3]!).queryByRole("button")).toBeNull();
});

test("an image shows its thumbnail, text previews and other kinds show the kind's icon", () => {
	const { container } = render(
		<ResourceChips messageId="m-1" data={data} onOpen={() => {}} />,
	);
	const images = [...container.querySelectorAll("img")];
	expect(images.map((i) => i.getAttribute("src"))).toEqual([
		"/api/images/i1/content",
	]);
	const chips = container.querySelectorAll(".resource-chip");
	expect(chips[0]?.querySelector("svg")).not.toBeNull();
	expect(chips[2]?.querySelector("img")).toBeNull();
	expect(chips[2]?.querySelector("svg")).not.toBeNull();
});

test("a message without linked resources renders nothing", () => {
	const none = render(
		<ResourceChips messageId="m-empty" data={data} onOpen={() => {}} />,
	);
	expect(none.container.firstChild).toBeNull();
	const missing = render(
		<ResourceChips messageId="other" data={data} onOpen={() => {}} />,
	);
	expect(missing.container.firstChild).toBeNull();
	const loading = render(
		<ResourceChips messageId="m-1" data={undefined} onOpen={() => {}} />,
	);
	expect(loading.container.firstChild).toBeNull();
});
