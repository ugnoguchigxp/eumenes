import { z } from "zod";

const fields = {
	id: z.string(),
	title: z.string(),
	kind: z.string(),
	interval: z.string(),
	intervalMs: z
		.number()
		.int()
		.positive()
		.max(365 * 86_400_000)
		.nullable(),
};
const item = z.discriminatedUnion("state", [
	z.object({
		...fields,
		state: z.literal("active"),
		nextDueAt: z.iso.datetime({ offset: true }),
	}),
	z.object({ ...fields, state: z.literal("paused"), nextDueAt: z.null() }),
]);

export const scheduleAgendaData = z.object({ items: z.array(item) });
export type ScheduleAgendaItem = z.infer<typeof item>;
export type ScheduleAgendaResource = z.infer<typeof scheduleAgendaData> & {
	kind: "schedule-agenda";
	revision: number;
};
