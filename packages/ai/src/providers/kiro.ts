/** Kiro / Amazon Q streaming provider using the Builder ID bearer token. */
import * as nodeCrypto from "node:crypto";
import { $env, extractHttpStatusFromError, fetchWithRetry } from "@gajae-code/utils";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { redactedHttpErrorSummary } from "../utils/http-error-redaction";
import { parseStreamingJson } from "../utils/json-parse";
import { flattenToolRootCombinators, toolWireSchema } from "../utils/schema";
import { decodeEventStream } from "./aws-eventstream";
import { transformMessages } from "./transform-messages";

export const KIRO_REGION = "us-east-1";
export const KIRO_RUNTIME_URL = `https://runtime.${KIRO_REGION}.kiro.dev/`;
export const KIRO_MANAGEMENT_URL = `https://management.${KIRO_REGION}.kiro.dev/`;
// Kiro CLI 2.14.2 uses this shared CodeWhisperer profile ARN for Builder ID.
// Unlike social credentials, Builder ID tokens cannot call ListAvailableProfiles;
// omitting this value therefore makes model discovery and usage fail with HTTP 400.
export const KIRO_BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_ORIGIN = "KIRO_CLI";

/**
 * Header Kiro CLI uses to declare the user's upstream data-collection
 * preference. The value's polarity is undocumented (reverse-engineered from
 * kiro-cli 2.14.2, which hardcodes `"false"`), so GJC never asserts a
 * preference on the user's behalf: the header is omitted unless
 * `GJC_KIRO_CODEWHISPERER_OPTOUT` explicitly supplies a value. Omission cannot
 * misrepresent intent in either polarity; hardcoding a value can.
 */
export const KIRO_OPTOUT_HEADER = "x-amzn-codewhisperer-optout";

/**
 * Resolve the opt-out header pair, or an empty object when unset.
 *
 * Spread into a `headers` literal so an unset setting contributes no header at
 * all rather than an empty-valued one.
 */
export function kiroOptoutHeader(): Record<string, string> {
	const configured = $env.GJC_KIRO_CODEWHISPERER_OPTOUT?.trim();
	return configured ? { [KIRO_OPTOUT_HEADER]: configured } : {};
}

const KIRO_STREAM_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const KIRO_LIST_PROFILES_TARGET = "AmazonCodeWhispererService.ListAvailableProfiles";

function kiroPlatform(): string {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}

/** Exact User-Agent the kiro-cli-chat 2.14.2 binary sends on AWS SDK calls. */
export const KIRO_AWS_UA = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/${kiroPlatform()} lang/rust/1.92.0 md/appVersion-2.14.2 app/AmazonQ-For-CLI`;
export const KIRO_AWS_X_AMZ_UA = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/${kiroPlatform()} lang/rust/1.92.0 m/F,C app/AmazonQ-For-CLI`;
/** Streaming API uses a different api module name. */
export const KIRO_STREAMING_UA = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${kiroPlatform()} lang/rust/1.92.0 md/appVersion-2.14.2 app/AmazonQ-For-CLI`;
export const KIRO_STREAMING_X_AMZ_UA = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${kiroPlatform()} lang/rust/1.92.0 m/F,C app/AmazonQ-For-CLI`;
/** UA for Kiro-native endpoints (social refresh, KAS). */
export const KIRO_KIROCLI_UA = "KiroCLI/2.14.2 md/appVersion-2.14.2 app/AmazonQ-For-CLI";

type KiroFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface KiroProfilesPayload {
	profiles?: unknown;
}

/**
 * Profile ARNs are stable per account and the endpoint is a control-plane
 * round trip, so resolutions are memoized per access token. The credential
 * itself does not persist the ARN: a Kiro access token is the only identity
 * input available, and it can always re-derive the profile.
 *
 * Keyed by a SHA-256 digest of the token rather than the token itself, so the
 * bearer secret never sits in a long-lived map (and therefore never lands in a
 * heap or core dump). Digesting preserves the per-token isolation property — a
 * refreshed or switched credential still never inherits another account's
 * profile — and the map stays bounded so long sessions cannot grow it.
 */
const KIRO_PROFILE_ARN_CACHE = new Map<string, string>();
const KIRO_PROFILE_ARN_CACHE_MAX = 8;

function kiroProfileCacheKey(accessToken: string): string {
	return nodeCrypto.createHash("sha256").update(accessToken).digest("hex");
}

function cacheProfileArn(cacheKey: string, profileArn: string): string {
	if (KIRO_PROFILE_ARN_CACHE.size >= KIRO_PROFILE_ARN_CACHE_MAX) {
		const oldest = KIRO_PROFILE_ARN_CACHE.keys().next();
		if (!oldest.done) KIRO_PROFILE_ARN_CACHE.delete(oldest.value);
	}
	KIRO_PROFILE_ARN_CACHE.set(cacheKey, profileArn);
	return profileArn;
}

/** Test seam: drop memoized profile resolutions. */
export function resetKiroProfileArnCache(): void {
	KIRO_PROFILE_ARN_CACHE.clear();
}

export async function resolveKiroProfileArn(accessToken: string, fetcher: KiroFetcher = fetch): Promise<string> {
	const cacheKey = kiroProfileCacheKey(accessToken);
	const cached = KIRO_PROFILE_ARN_CACHE.get(cacheKey);
	if (cached) return cached;
	const response = await fetcher(KIRO_MANAGEMENT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/x-amz-json-1.0",
			"x-amz-target": KIRO_LIST_PROFILES_TARGET,
			"User-Agent": KIRO_AWS_UA,
			"x-amz-user-agent": KIRO_AWS_X_AMZ_UA,
			...kiroOptoutHeader(),
			"amz-sdk-request": "attempt=1; max=3",
			accept: "*/*",
			"accept-encoding": "gzip",
		},
		body: "{}",
	});
	if (!response.ok) {
		throw Object.assign(new Error(`Kiro profile resolution failed: ${redactedHttpErrorSummary(response)}`), {
			status: response.status,
		});
	}
	const payload = (await response.json()) as KiroProfilesPayload;
	if (Array.isArray(payload.profiles)) {
		for (const value of payload.profiles) {
			const profile = value as { arn?: unknown };
			if (typeof profile.arn === "string" && profile.arn) return cacheProfileArn(cacheKey, profile.arn);
		}
	}
	throw new Error("Kiro profile resolution failed: response contained no profile ARN");
}

export interface KiroOptions extends SimpleStreamOptions {
	profileArn?: string;
}

export interface KiroAccessContext {
	token: string;
	profileArn?: string;
}

export function parseKiroAccessContext(apiKey: string): KiroAccessContext {
	if (!apiKey.startsWith("{")) return { token: apiKey };
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown; kiroProfileArn?: unknown };
		if (typeof parsed.token !== "string" || !parsed.token) return { token: apiKey };
		return {
			token: parsed.token,
			...(typeof parsed.kiroProfileArn === "string" && parsed.kiroProfileArn
				? { profileArn: parsed.kiroProfileArn }
				: {}),
		};
	} catch {
		return { token: apiKey };
	}
}

type KiroContent = { text: string } | { json: Record<string, unknown> };

interface KiroToolResult {
	toolUseId: string;
	content: KiroContent[];
	status: "success" | "error";
}

interface KiroToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
}

interface KiroUserInputMessage {
	content: string;
	userInputMessageContext: {
		envState: { operatingSystem: string; currentWorkingDirectory: string };
		tools?: Array<{
			toolSpecification: {
				name: string;
				description: string;
				inputSchema: { json: unknown };
			};
		}>;
		toolResults?: KiroToolResult[];
	};
	origin: typeof KIRO_ORIGIN;
	modelId: string;
}

interface KiroAssistantResponseMessage {
	content: string;
	toolUses?: KiroToolUse[];
}

type KiroHistoryMessage =
	| { userInputMessage: KiroUserInputMessage }
	| { assistantResponseMessage: KiroAssistantResponseMessage };

export interface KiroRequest {
	conversationState: {
		conversationId: string;
		history: KiroHistoryMessage[];
		currentMessage: { userInputMessage: KiroUserInputMessage };
		chatTriggerType: "MANUAL";
		agentContinuationId: string;
		agentTaskType: "vibe";
	};
	profileArn: string;
	additionalModelRequestFields?: {
		thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
		reasoning?: { mode?: string; effort?: string };
	};
}

type KiroBlock = (TextContent | ToolCall) & { partialJson?: string };

/**
 * Kiro's `userInputMessage` wire format carries text only — there is no image
 * transport. Every Kiro model therefore advertises `input: ["text"]`, so an
 * image block reaching here means capability filtering was bypassed. Throwing
 * beats substituting a `[Image: ...]` placeholder, which silently returned a
 * reply that never saw the attachment.
 */
function rejectImageContent(mimeType: string): never {
	throw new Error(`Kiro transport does not support image input (received ${mimeType})`);
}

function stringifyContent(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? block.text : rejectImageContent(block.mimeType))).join("\n");
}

function envState(): KiroUserInputMessage["userInputMessageContext"]["envState"] {
	return {
		operatingSystem: process.platform === "darwin" ? "macos" : process.platform,
		currentWorkingDirectory: process.cwd(),
	};
}

function convertTools(tools: Tool[] | undefined): KiroUserInputMessage["userInputMessageContext"]["tools"] {
	if (!tools?.length) return undefined;
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description || "",
			inputSchema: { json: flattenToolRootCombinators(toolWireSchema(tool)) },
		},
	}));
}
/**
 * Kiro requires tool-use ids to be at most 64 chars of `[A-Za-z0-9_-]`
 * (asserted by the existing wire tests). Ids Kiro itself issued already satisfy
 * that shape, so they pass through verbatim — re-hashing them produced an id the
 * server never issued and broke multi-turn tool replay. Foreign ids (e.g. the
 * 100-char pipe-separated OpenAI Responses shape) still need normalizing, and
 * SHA-256 yields a conforming, collision-resistant, deterministic id.
 *
 * The transform is a pure function of the id, so both callsites compute the same
 * value independently and no cross-message map is needed.
 */
const KIRO_CONFORMING_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function kiroToolUseId(id: string): string {
	if (KIRO_CONFORMING_TOOL_USE_ID.test(id)) return id;
	return nodeCrypto.createHash("sha256").update(id).digest("hex");
}

function convertToolResult(message: ToolResultMessage): KiroToolResult {
	return {
		toolUseId: kiroToolUseId(message.toolCallId),
		status: message.isError ? "error" : "success",
		content: message.content.map(block =>
			block.type === "text" ? { text: block.text } : rejectImageContent(block.mimeType),
		),
	};
}

function userInput(
	content: string,
	modelId: string,
	tools: KiroUserInputMessage["userInputMessageContext"]["tools"],
	toolResults?: KiroToolResult[],
): KiroUserInputMessage {
	return {
		content,
		userInputMessageContext: {
			envState: envState(),
			...(tools ? { tools } : {}),
			...(toolResults?.length ? { toolResults } : {}),
		},
		origin: KIRO_ORIGIN,
		modelId,
	};
}

function convertAssistant(message: AssistantMessage): KiroAssistantResponseMessage {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
	const toolUses = message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map(block => ({ toolUseId: kiroToolUseId(block.id), name: block.name, input: block.arguments ?? {} }));
	return { content: text, ...(toolUses.length ? { toolUses } : {}) };
}

function convertHistory(
	messages: Message[],
	modelId: string,
	tools: KiroUserInputMessage["userInputMessageContext"]["tools"],
): KiroHistoryMessage[] {
	const history: KiroHistoryMessage[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult") {
			const toolResults: KiroToolResult[] = [convertToolResult(message)];
			while (messages[index + 1]?.role === "toolResult") {
				index += 1;
				toolResults.push(convertToolResult(messages[index] as ToolResultMessage));
			}
			history.push({ userInputMessage: userInput("", modelId, tools, toolResults) });
		} else if (message.role === "assistant") {
			history.push({ assistantResponseMessage: convertAssistant(message) });
		} else {
			history.push({ userInputMessage: userInput(stringifyContent(message.content), modelId, tools) });
		}
	}
	return history;
}

export function buildKiroRequest(
	model: Model<"kiro-streaming">,
	context: Context,
	profileArn: string,
	reasoning?: KiroOptions["reasoning"],
): KiroRequest {
	const tools = convertTools(context.tools);
	const messages = transformMessages(context.messages, model);
	let current: KiroUserInputMessage;
	const trailingToolResults: KiroToolResult[] = [];
	while (messages.at(-1)?.role === "toolResult") {
		trailingToolResults.unshift(convertToolResult(messages.pop() as ToolResultMessage));
	}
	const last = messages.pop();
	if (trailingToolResults.length > 0) {
		if (last) messages.push(last);
		current = userInput("", model.id, tools, trailingToolResults);
	} else if (last?.role === "user" || last?.role === "developer") {
		current = userInput(stringifyContent(last.content), model.id, tools);
	} else {
		if (last) messages.push(last);
		current = userInput("Continue.", model.id, tools);
	}

	const history = convertHistory(messages, model.id, tools);
	const systemPrompt = context.systemPrompt?.filter(Boolean).join("\n\n");
	if (systemPrompt) {
		current.content = `<system>\n${systemPrompt}\n</system>\n\n${current.content}`;
	}
	const request: KiroRequest = {
		conversationState: {
			conversationId: crypto.randomUUID(),
			history,
			currentMessage: { userInputMessage: current },
			chatTriggerType: "MANUAL",
			agentContinuationId: crypto.randomUUID(),
			agentTaskType: "vibe",
		},
		profileArn,
	};
	if (model.reasoning) {
		request.additionalModelRequestFields = reasoning
			? {
					thinking: { type: "adaptive", display: "summarized" },
					reasoning: { effort: reasoning },
				}
			: { thinking: { type: "disabled" } };
	}
	return request;
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "END_TURN":
			return "stop";
		case "TOOL_USE":
			return "toolUse";
		case "MAX_TOKENS":
			return "length";
		default:
			return "stop";
	}
}

function parsePayload(payload: Uint8Array): Record<string, unknown> {
	if (payload.length === 0) return {};
	return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
}

export const streamKiro: StreamFunction<"kiro-streaming"> = (
	model: Model<"kiro-streaming">,
	context: Context,
	options: KiroOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "kiro-streaming" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		const startedAt = Date.now();
		let firstTokenAt: number | undefined;
		let started = false;
		let activeTextIndex: number | undefined;
		const toolIndexes = new Map<string, number>();
		try {
			if (!options.apiKey) throw new Error("Kiro access token is required");
			const access = parseKiroAccessContext(options.apiKey);
			const profileArn = options.profileArn ?? access.profileArn ?? (await resolveKiroProfileArn(access.token));
			const request = buildKiroRequest(model, context, profileArn, options.reasoning);
			options.onPayload?.(request);
			const response = await fetchWithRetry(model.baseUrl || KIRO_RUNTIME_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${access.token}`,
					"Content-Type": "application/x-amz-json-1.0",
					"x-amz-target": KIRO_STREAM_TARGET,
					...kiroOptoutHeader(),
					"User-Agent": KIRO_STREAMING_UA,
					"x-amz-user-agent": KIRO_STREAMING_X_AMZ_UA,
					"amz-sdk-invocation-id": crypto.randomUUID(),
					"amz-sdk-request": "attempt=1; max=3",
					"x-amzn-kiro-agent-mode": "vibe",
					accept: "*/*",
					"accept-encoding": "gzip",
				},
				body: JSON.stringify(request),
				signal: options.signal,
			});
			if (!response.ok) {
				throw Object.assign(new Error(`Kiro ${redactedHttpErrorSummary(response)}`), {
					status: response.status,
				});
			}
			if (!response.body) throw new Error("Kiro response has no body");

			for await (const message of decodeEventStream(response.body)) {
				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];
				if (messageType === "exception" || messageType === "error") {
					const payload = parsePayload(message.payload);
					throw new Error(String(payload.message ?? eventType ?? "Kiro stream error"));
				}
				if (messageType !== "event") continue;
				const payload = parsePayload(message.payload);
				if (!started) {
					started = true;
					stream.push({ type: "start", partial: output });
				}
				switch (eventType) {
					case "assistantResponseEvent": {
						const delta = typeof payload.content === "string" ? payload.content : "";
						if (!delta) break;
						if (!firstTokenAt) firstTokenAt = Date.now();
						if (activeTextIndex === undefined) {
							activeTextIndex = output.content.length;
							output.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
						}
						const block = output.content[activeTextIndex];
						if (block?.type === "text") block.text += delta;
						stream.push({ type: "text_delta", contentIndex: activeTextIndex, delta, partial: output });
						break;
					}
					case "toolUseEvent": {
						const id = typeof payload.toolUseId === "string" ? payload.toolUseId : "";
						if (!id) break;
						let index = toolIndexes.get(id);
						if (index === undefined) {
							index = output.content.length;
							const name = typeof payload.name === "string" ? payload.name : "";
							const initialInput =
								typeof payload.input === "object" && payload.input !== null
									? (payload.input as Record<string, unknown>)
									: {};
							output.content.push({
								type: "toolCall",
								id,
								name,
								arguments: initialInput,
								partialJson: "",
							} as KiroBlock);
							toolIndexes.set(id, index);
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						}
						const block = output.content[index] as KiroBlock | undefined;
						const delta = typeof payload.input === "string" ? payload.input : "";
						if (block?.type === "toolCall" && delta) {
							block.partialJson = (block.partialJson ?? "") + delta;
							block.arguments = parseStreamingJson(block.partialJson) ?? {};
							stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: output });
						}
						if (payload.stop === true && block?.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson ?? "") ?? {};
							delete block.partialJson;
							stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
						}
						break;
					}
					case "metadataEvent":
						output.stopReason = mapStopReason(
							typeof payload.stopReason === "string" ? payload.stopReason : undefined,
						);
						break;
				}
			}

			if (activeTextIndex !== undefined) {
				const block = output.content[activeTextIndex];
				if (block?.type === "text")
					stream.push({ type: "text_end", contentIndex: activeTextIndex, content: block.text, partial: output });
			}
			output.duration = Date.now() - startedAt;
			if (firstTokenAt) output.ttft = firstTokenAt - startedAt;
			output.usage.cost = calculateCost(model, output.usage);
			const doneReason =
				output.stopReason === "length" || output.stopReason === "toolUse" ? output.stopReason : "stop";
			output.stopReason = doneReason;
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			output.errorStatus = extractHttpStatusFromError(error);
			output.transportFailure = transportFailureFacts(error);
			output.duration = Date.now() - startedAt;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
