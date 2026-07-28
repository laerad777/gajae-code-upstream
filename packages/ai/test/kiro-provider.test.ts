import { describe, expect, test } from "bun:test";
import { Effort } from "../src/model-thinking";
import {
	buildKiroRequest,
	KIRO_ORIGIN,
	parseKiroAccessContext,
	resetKiroProfileArnCache,
	resolveKiroProfileArn,
} from "../src/providers/kiro";
import { resolveLazyStreamFirstEventFallbackMs } from "../src/providers/register-builtins";
import type { AssistantMessage, Model } from "../src/types";
import { fetchKiroModels } from "../src/utils/discovery/kiro";

const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

const model: Model<"kiro-streaming"> = {
	id: "claude-haiku-4.5",
	name: "claude-haiku-4.5",
	api: "kiro-streaming",
	provider: "kiro",
	baseUrl: "https://runtime.us-east-1.kiro.dev/",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

describe("Kiro provider", () => {
	test("extracts the token and profile ARN from the structured Kiro credential payload", () => {
		const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/GOOGLE";
		expect(
			parseKiroAccessContext(
				JSON.stringify({
					token: "social-token",
					kiroMethod: "google",
					kiroProfileArn: profileArn,
				}),
			),
		).toEqual({ token: "social-token", profileArn });
	});

	test("treats a bare access token as the credential payload", () => {
		expect(parseKiroAccessContext("plain-token")).toEqual({ token: "plain-token" });
	});

	test("omits the upstream message, account id, and ARN from resolution failures", async () => {
		resetKiroProfileArnCache();
		const fetcher = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					__type: "com.amazon.codewhisperer#ValidationException",
					message: "profile arn:aws:codewhisperer:us-east-1:123456789012:profile/SECRET is invalid",
				}),
				{ status: 400 },
			);
		const error = await resolveKiroProfileArn("token", fetcher).catch((cause: unknown) => cause);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Kiro profile resolution failed: HTTP 400");
		expect(message).not.toContain("123456789012");
		expect(message).not.toContain("arn:aws:codewhisperer");
	});
	test("builds native history, tool call, and tool result payloads", () => {
		const request = buildKiroRequest(
			model,
			{
				systemPrompt: ["Be concise."],
				tools: [
					{
						name: "echo_value",
						description: "Echo a value",
						parameters: {
							type: "object",
							properties: { value: { type: "string" } },
							required: ["value"],
						},
					},
				],
				messages: [
					{ role: "user", content: "Use the tool", timestamp: 1 },
					{
						role: "assistant",
						api: "kiro-streaming",
						provider: "kiro",
						model: model.id,
						content: [
							{
								type: "toolCall",
								id: "call_QKsJSt3a0VVwVELmiM3GxIWK|fc_018d34fca8cceb25016a662d98ed6081918f20fcf4dfda78c9",
								name: "echo_value",
								arguments: { value: "x" },
							},
						],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call_QKsJSt3a0VVwVELmiM3GxIWK|fc_018d34fca8cceb25016a662d98ed6081918f20fcf4dfda78c9",
						toolName: "echo_value",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			BUILDER_ID_PROFILE_ARN,
		);

		expect(request.profileArn).toBe(BUILDER_ID_PROFILE_ARN);
		expect(request.conversationState.history[1]).toEqual({
			assistantResponseMessage: {
				content: "",
				toolUses: [
					{
						toolUseId: "df38b111802bf381130da07069c1b3a38a503eeb01a129129877ba2cf8eb3b8e",
						name: "echo_value",
						input: { value: "x" },
					},
				],
			},
		});
		const current = request.conversationState.currentMessage.userInputMessage;
		expect(current.content).toContain("Be concise.");
		expect(current.userInputMessageContext.toolResults).toEqual([
			{
				toolUseId: "df38b111802bf381130da07069c1b3a38a503eeb01a129129877ba2cf8eb3b8e",
				status: "success",
				content: [{ text: "done" }],
			},
		]);
		expect(current.userInputMessageContext.tools?.[0].toolSpecification.name).toBe("echo_value");
		const assistantHistory = request.conversationState.history[1];
		if (!assistantHistory || !("assistantResponseMessage" in assistantHistory)) {
			throw new Error("Expected assistant history");
		}
		const ids = assistantHistory.assistantResponseMessage.toolUses?.map(tool => tool.toolUseId) ?? [];
		expect(ids.every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("maps profile effort to Kiro adaptive reasoning fields", () => {
		const context = {
			messages: [{ role: "user" as const, content: "Think", timestamp: 1 }],
		};
		const reasoningModel = { ...model, reasoning: true };
		expect(
			buildKiroRequest(reasoningModel, context, BUILDER_ID_PROFILE_ARN, Effort.XHigh).additionalModelRequestFields,
		).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			reasoning: { effort: "xhigh" },
		});
		expect(buildKiroRequest(reasoningModel, context, BUILDER_ID_PROFILE_ARN).additionalModelRequestFields).toEqual({
			thinking: { type: "disabled" },
		});
	});

	test("repairs orphan tool calls before Kiro serialization", () => {
		const orphan: AssistantMessage = {
			role: "assistant",
			api: "kiro-streaming",
			provider: "kiro",
			model: model.id,
			content: [{ type: "toolCall", id: "orphan|call", name: "echo_value", arguments: {} }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const request = buildKiroRequest(
			model,
			{
				messages: [
					{ role: "user", content: "Use the tool", timestamp: 1 },
					orphan,
					{ role: "user", content: "Continue", timestamp: 3 },
				],
			},
			BUILDER_ID_PROFILE_ARN,
		);
		const repaired = request.conversationState.history[2];
		expect(repaired).toEqual({
			userInputMessage: {
				content: "",
				userInputMessageContext: {
					envState: {
						operatingSystem: process.platform === "darwin" ? "macos" : process.platform,
						currentWorkingDirectory: process.cwd(),
					},
					toolResults: [
						{
							toolUseId: "17efecc8baf02b3ee24c0ed48de4a5b6a4e9b03fcfdc0f028df5a668008a83c4",
							status: "error",
							content: [{ text: "No result provided" }],
						},
					],
				},
				origin: KIRO_ORIGIN,
				modelId: model.id,
			},
		});
	});

	test("discovers and normalizes the authenticated model catalog", async () => {
		const requests: Request[] = [];
		const resolvedProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROPLUS";
		const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			requests.push(request);
			if (request.headers.get("x-amz-target") === "AmazonCodeWhispererService.ListAvailableProfiles") {
				return Response.json({ profiles: [{ arn: resolvedProfileArn, profileName: "QDefaultProfile" }] });
			}
			return Response.json({
				defaultModel: { modelId: "auto" },
				models: [
					{
						modelId: "claude-haiku-4.5",
						modelName: "Claude Haiku 4.5",
						tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
					},
				],
			});
		};
		const models = await fetchKiroModels({ accessToken: "token", fetcher });
		expect(requests[0]?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
		expect(requests[1]?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
		expect(requests[1]?.headers.get("authorization")).toBe("Bearer token");
		expect(models).toEqual([
			expect.objectContaining({
				id: "claude-haiku-4.5",
				api: "kiro-streaming",
				provider: "kiro",
				contextWindow: 200_000,
				maxTokens: 64_000,
			}),
		]);
		const body = JSON.parse(await requests[1]!.text()) as Record<string, unknown>;
		expect(body).toEqual({ origin: KIRO_ORIGIN, profileArn: resolvedProfileArn });
	});
	test("rejects image content instead of substituting a placeholder", () => {
		const context = {
			messages: [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "look" },
						{ type: "image" as const, data: "AAAA", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};
		expect(() => buildKiroRequest(model, context, BUILDER_ID_PROFILE_ARN)).toThrow(
			"Kiro transport does not support image input (received image/png)",
		);
	});

	test("isolates memoized profile ARNs per access token and clears on reset", async () => {
		resetKiroProfileArnCache();
		const targets: string[] = [];
		const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const token = String(new Headers(init?.headers).get("authorization"));
			targets.push(token);
			return Response.json({ profiles: [{ arn: `arn:aws:codewhisperer:us-east-1:1:profile/${token}` }] });
		};

		// Distinct tokens resolve independently: neither inherits the other's ARN.
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(await resolveKiroProfileArn("token-b", fetcher)).toContain("Bearer token-b");
		expect(targets).toEqual(["Bearer token-a", "Bearer token-b"]);

		// A repeat lookup for an already-resolved token performs no round trip.
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(targets).toHaveLength(2);

		// Reset drops the memoized entries, so the next lookup resolves again.
		resetKiroProfileArnCache();
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(targets).toEqual(["Bearer token-a", "Bearer token-b", "Bearer token-a"]);
	});

	test("exempts Kiro from the shared lazy-stream first-event floor", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("kiro")).toBe(300_000);
		expect(resolveLazyStreamFirstEventFallbackMs("anthropic")).toBeUndefined();
	});
});
