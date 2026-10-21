/** Scripted model plans for integration fixtures; production must obtain these from the model. */
export const taskPlan = (...requests: string[]) => ({
	name: "set_plan",
	arguments: {
		goal: requests.join(" / "),
		items: requests.map((request, index) => ({
			request,
			check: "",
			dependsOn: index ? [index - 1] : [],
		})),
		report: "summarize the results",
	},
});
export const taskItem = (
	packet: { plan: { steps: Array<{ stepRef: string }> } },
	index = 0,
) => packet.plan.steps[index]!.stepRef;
