import { expect, test, vi } from "vitest";
import { imageClient } from "../image";
test("image client sends DELETE and rejects invalid IDs before sending", async () => {
	const call = vi.fn(async () => Response.json({ id: "saved", deleted: true }));
	const client = imageClient({ call } as never);
	expect(await client.deleteImage("saved")).toEqual({
		id: "saved",
		deleted: true,
	});
	expect(call).toHaveBeenCalledWith("/api/images/saved", {
		method: "DELETE",
		signal: undefined,
	});
	await expect(client.deleteImage("../saved")).rejects.toThrow();
	expect(call).toHaveBeenCalledOnce();
});
test("image client refuses a deletion receipt for another image", async () => {
	const client = imageClient({
		call: async () => Response.json({ id: "other", deleted: true }),
	} as never);
	await expect(client.deleteImage("saved")).rejects.toThrow(
		"invalid_image_delete_result",
	);
});
