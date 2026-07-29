import { expect, test } from "bun:test";
import type { UsageReport } from "@gajae-code/ai";
import { buildUsageReportText } from "../src/slash-commands/helpers/usage-report";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const NOW = 1_700_000_000_000;

function runtimeWithReports(reports: UsageReport[]): SlashCommandRuntime {
	return {
		session: {
			fetchUsageReports: async () => reports,
		},
	} as unknown as SlashCommandRuntime;
}

test("ACP usage prefers a provider account label over an internal credential id", async () => {
	const report: UsageReport = {
		provider: "kiro",
		fetchedAt: NOW,
		metadata: {
			account: "kiro github (PROFILE123)",
			accountId: "credential:26",
			subscriptionTitle: "KIRO PRO MAX",
		},
		limits: [
			{
				id: "kiro:credit",
				label: "Credits",
				status: "ok",
				amount: { used: 10, limit: 100, usedFraction: 0.1, remainingFraction: 0.9, unit: "requests" },
				scope: {
					provider: "kiro",
					accountId: "credential:26",
					tier: "KIRO PRO MAX",
					windowId: "billing-cycle",
				},
			},
		],
	};

	const output = await buildUsageReportText(runtimeWithReports([report]));

	expect(output).toContain("kiro github (PROFILE123)");
	expect(output).not.toContain("credential:26");
});

test("ACP usage renders a Kiro unavailable account and reason", async () => {
	const report: UsageReport = {
		provider: "kiro",
		fetchedAt: NOW,
		metadata: {
			account: "kiro google (PROFILE456)",
			accountId: "credential:44",
			unavailableReason: "GetUsageLimits returned HTTP 400",
		},
		limits: [],
	};

	const output = await buildUsageReportText(runtimeWithReports([report]));

	expect(output).toContain("kiro google (PROFILE456)");
	expect(output).toContain("GetUsageLimits returned HTTP 400");
	expect(output).not.toContain("credential:44");
	expect(output).not.toContain("no limits reported");
});
