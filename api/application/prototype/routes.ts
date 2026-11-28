import type { Context, Hono } from "hono";
import { z } from "zod";
import {
	prototypeStatus,
	registration,
	trialInventoryView,
	trialRequest,
} from "../../domains/prototype/contracts";
import type { PrototypeService } from "../../domains/prototype";

const pathBody = z.object({ path: z.string().min(1).max(2048) });
const nameBody = z.object({ name: z.string().min(1).max(64) });
const resolution = z.object({ version: z.string().regex(/^[a-f0-9]{64}$/) });
const onlyId = z.uuid();

async function action(c: Context, handle: () => unknown) {
	try {
		return c.json(await handle());
	} catch (e) {
		const reason = (e as Error).message;
		if (reason === "prototype_not_found") return c.json({ error: reason }, 404);
		if (reason === "prototype_workspace_busy")
			return c.json({ error: reason }, 409);
		if (reason.startsWith("prototype_") || reason === "runner_git_failed")
			return c.json({ error: reason }, 400);
		if (e instanceof z.ZodError || e instanceof SyntaxError)
			return c.json({ error: "prototype_request_invalid" }, 400);
		if (
			["ENOENT", "ENOTDIR", "EACCES", "EEXIST", "ELOOP"].includes(
				(e as NodeJS.ErrnoException).code ?? "",
			)
		)
			return c.json({ error: "prototype_path_invalid" }, 400);
		throw e;
	}
}

export function registerPrototypeRoutes(
	app: Hono,
	service: PrototypeService,
	hooks?: { removed(id: string, remove: () => void): Promise<void> },
) {
	const path = "/api/prototypes";
	app.get(path, (c) => c.json(prototypeStatus.parse(service.list())));
	app.post(path + "/register", (c) =>
		action(c, async () =>
			registration.parse(
				service.register(pathBody.parse(await c.req.json()).path),
			),
		),
	);
	app.post(path + "/create", (c) =>
		action(c, async () =>
			registration.parse(
				service.create(nameBody.parse(await c.req.json()).name),
			),
		),
	);
	const id = (c: Context) => onlyId.parse(c.req.param("id"));
	app.post(path + "/trial", (c) =>
		action(c, async () =>
			registration.parse(
				service.registerTrial(trialRequest.parse(await c.req.json())),
			),
		),
	);
	app.get(path + "/:id/trial", (c) =>
		action(c, () => trialInventoryView.parse(service.trialInventory(id(c)))),
	);
	app.get(path + "/:id/preview", (c) =>
		action(c, () => service.preview(id(c))),
	);
	app.post(path + "/:id/open", (c) => action(c, () => service.open(id(c))));
	app.post(path + "/:id/retry", (c) => action(c, () => service.retry(id(c))));
	app.post(path + "/:id/hide", (c) =>
		action(c, () => {
			service.hide(id(c));
			return { ok: true };
		}),
	);
	app.post(path + "/:id/stalled", (c) =>
		action(c, async () =>
			service.stalled(id(c), resolution.parse(await c.req.json()).version),
		),
	);
	app.post(path + "/:id/move", (c) =>
		action(c, async () =>
			registration.parse(
				service.move(id(c), pathBody.parse(await c.req.json()).path),
			),
		),
	);
	app.delete(path + "/:id", (c) =>
		action(c, async () => {
			const target = id(c);
			if (hooks) await hooks.removed(target, () => service.remove(target));
			else service.remove(target);
			return { ok: true };
		}),
	);
}
