import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@gajae-code/utils";
import { loginKiro, refreshKiroToken } from "../src/utils/oauth/kiro";

const REGISTRATION_KEY = "kirocli:odic:device-registration";
const MISSING_REGISTRATION = "Kiro client registration is missing or expired";

let previousAgentDir: string | undefined;
let previousPiConfigDir: string | undefined;
let previousGjcConfigDir: string | undefined;
let tempConfigRoot: string | undefined;
let previousFetch: typeof fetch | undefined;

async function useTempAgentDir(): Promise<void> {
	previousAgentDir = getAgentDir();
	previousPiConfigDir = process.env.PI_CONFIG_DIR;
	previousGjcConfigDir = process.env.GJC_CONFIG_DIR;
	tempConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-oauth-"));
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempConfigRoot);
	delete process.env.GJC_CONFIG_DIR;
	setAgentDir(path.join(tempConfigRoot, "agent"));
	await fs.mkdir(path.dirname(getAgentDbPath()), { recursive: true });
}

/** Seed a registration row directly so `readRegistration` has something to find. */
function seedRegistration(value: unknown, options?: { createTable?: boolean }): void {
	const db = new Database(getAgentDbPath());
	try {
		if (options?.createTable !== false) {
			db.run("CREATE TABLE IF NOT EXISTS kiro_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		}
		db.prepare("INSERT OR REPLACE INTO kiro_kv (key, value) VALUES (?, ?)").run(
			REGISTRATION_KEY,
			typeof value === "string" ? value : JSON.stringify(value),
		);
	} finally {
		db.close();
	}
}

function validRegistration(): Record<string, unknown> {
	return {
		clientId: "client-abc",
		clientSecret: "secret-xyz",
		clientIdIssuedAt: 1_700_000_000,
		// Epoch SECONDS, far in the future, so `isRegistrationValid` accepts it.
		clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
	};
}

function stubFetch(handler: (request: Request) => Promise<Response>): Request[] {
	const seen: Request[] = [];
	previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		seen.push(request);
		return handler(request);
	}) as typeof fetch;
	return seen;
}

afterEach(async () => {
	if (previousFetch) {
		globalThis.fetch = previousFetch;
		previousFetch = undefined;
	}
	if (previousPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousPiConfigDir;
	previousPiConfigDir = undefined;

	if (previousGjcConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = previousGjcConfigDir;
	previousGjcConfigDir = undefined;

	if (previousAgentDir) {
		setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
	}
	if (tempConfigRoot) {
		await fs.rm(tempConfigRoot, { recursive: true, force: true });
		tempConfigRoot = undefined;
	}
});

/**
 * `readRegistration` is module-private, so it is exercised through
 * `refreshKiroToken`, the public entry that consults it. Whether the persisted
 * row was found is observable: a usable registration reaches the token endpoint,
 * an absent or unusable one throws the documented re-login error before any
 * network call. That distinction is what makes these assertions real coverage of
 * the `sqlite_master` probe and the field validation rather than of a
 * re-implementation.
 */
describe("Kiro device registration store", () => {
	test("an absent kiro_kv table reads as no registration without throwing a read error", async () => {
		await useTempAgentDir();
		const requests = stubFetch(async () => Response.json({}));

		// Cold start: no credential store has been opened, so the table does not
		// exist. The probe must treat that as "no registration", not as a failure.
		await expect(refreshKiroToken({ access: "a", refresh: "r", expires: 0 })).rejects.toThrow(MISSING_REGISTRATION);
		// Proof the read short-circuited: no token request was ever issued.
		expect(requests).toHaveLength(0);
	});
	test("a missing registration row is an absent state and registers", async () => {
		await useTempAgentDir();
		const db = new Database(getAgentDbPath());
		try {
			db.run("CREATE TABLE kiro_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		} finally {
			db.close();
		}
		const requests = stubFetch(async () => new Response("", { status: 400 }));

		await expect(loginKiro({ onAuth: () => {}, onPrompt: async () => "", method: "builder-id" })).rejects.toThrow(
			"Kiro RegisterClient failed",
		);
		expect(requests).toHaveLength(1);
	});

	test("a valid persisted registration is found and drives the token request", async () => {
		await useTempAgentDir();
		const registration = validRegistration();
		seedRegistration(registration);

		const requests = stubFetch(async () =>
			Response.json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 28_800 }),
		);

		const refreshed = await refreshKiroToken({
			access: "old-access",
			refresh: "old-refresh",
			expires: 1,
			kiroMethod: "builder-id",
			kiroProfileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
		});

		// The registration round-tripped: its clientId/clientSecret reached the wire.
		expect(requests).toHaveLength(1);
		const body = JSON.parse(await requests[0]!.text()) as Record<string, unknown>;
		expect(body.clientId).toBe(registration.clientId);
		expect(body.clientSecret).toBe(registration.clientSecret);
		expect(body.refreshToken).toBe("old-refresh");

		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe("new-refresh");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
		expect(refreshed.kiroMethod).toBe("builder-id");
		expect(refreshed.kiroProfileArn).toBe("arn:aws:codewhisperer:us-east-1:1:profile/P");
	});

	test("defaults kiroMethod to builder-id when the credential omits it", async () => {
		await useTempAgentDir();
		seedRegistration(validRegistration());
		stubFetch(async () => Response.json({ accessToken: "new-access", refreshToken: "new-refresh" }));

		const refreshed = await refreshKiroToken({ access: "a", refresh: "r", expires: 1 });
		expect(refreshed.kiroMethod).toBe("builder-id");
	});

	test("an unparseable stored payload fails closed without registering", async () => {
		await useTempAgentDir();
		seedRegistration("{not json");
		const requests = stubFetch(async () => Response.json({}));

		await expect(loginKiro({ onAuth: () => {}, onPrompt: async () => "", method: "builder-id" })).rejects.toThrow(
			"Kiro device registration is invalid",
		);
		expect(requests).toHaveLength(0);
	});

	test("a registration row missing required fields fails closed without registering", async () => {
		await useTempAgentDir();
		seedRegistration({ clientId: "only-id" });
		const requests = stubFetch(async () => Response.json({}));

		await expect(loginKiro({ onAuth: () => {}, onPrompt: async () => "", method: "builder-id" })).rejects.toThrow(
			"Kiro device registration is invalid",
		);
		expect(requests).toHaveLength(0);
	});

	test("an expired client secret reads as unusable rather than being reused", async () => {
		await useTempAgentDir();
		seedRegistration({ ...validRegistration(), clientSecretExpiresAt: Math.floor(Date.now() / 1000) - 60 });
		const requests = stubFetch(async () => Response.json({}));

		await expect(refreshKiroToken({ access: "a", refresh: "r", expires: 0 })).rejects.toThrow(MISSING_REGISTRATION);
		expect(requests).toHaveLength(0);
	});
});

describe("Kiro OAuth error redaction adoption", () => {
	const leakyBody = JSON.stringify({
		__type: "InvalidClientException",
		error: "invalid_client",
		error_description:
			"Client 0oa1b2c3d4e5 for account 123456789012 is not authorized; requestId 8f2c1d90-1111-2222-3333-444455556666",
	});

	function expectStatusOnly(message: string, expectedPrefix: string): void {
		expect(message).toBe(`${expectedPrefix}: HTTP 400`);
	}

	test("registerClient returns a status-only error without consuming the body", async () => {
		await useTempAgentDir();
		const response = new Response(leakyBody, { status: 400 });
		const requests = stubFetch(async () => response);

		const error = await loginKiro({
			onAuth: () => {},
			onPrompt: async () => "",
			method: "builder-id",
		}).catch((cause: unknown) => cause);

		expectStatusOnly(error instanceof Error ? error.message : String(error), "Kiro RegisterClient failed");
		expect(response.bodyUsed).toBe(false);
		expect(requests).toHaveLength(1);
	});

	test("startDeviceAuthorization returns a status-only error without consuming the body", async () => {
		await useTempAgentDir();
		seedRegistration(validRegistration());
		const response = new Response(leakyBody, { status: 400 });
		stubFetch(async () => response);

		const error = await loginKiro({
			onAuth: () => {},
			onPrompt: async () => "",
			method: "builder-id",
		}).catch((cause: unknown) => cause);

		expectStatusOnly(error instanceof Error ? error.message : String(error), "Kiro StartDeviceAuthorization failed");
		expect(response.bodyUsed).toBe(false);
	});

	test("social device authorization returns a status-only error without consuming the body", async () => {
		await useTempAgentDir();
		const response = new Response(leakyBody, { status: 400 });
		stubFetch(async () => response);

		const error = await loginKiro({
			onAuth: () => {},
			onPrompt: async () => "",
			method: "google",
		}).catch((cause: unknown) => cause);

		expectStatusOnly(
			error instanceof Error ? error.message : String(error),
			"Kiro social device authorization failed",
		);
		expect(response.bodyUsed).toBe(false);
	});

	test("social device polling returns a status-only error without consuming the body", async () => {
		await useTempAgentDir();
		let call = 0;
		const response = new Response(leakyBody, { status: 400 });
		stubFetch(async () => {
			call += 1;
			if (call === 1) {
				return Response.json({
					deviceCode: "device-code",
					userCode: "USER-CODE",
					verificationUriComplete: "https://example.invalid/verify",
					intervalInMilliseconds: 1000,
					expiresInMilliseconds: 5000,
				});
			}
			return response;
		});

		const error = await loginKiro({
			onAuth: () => {},
			onPrompt: async () => "",
			method: "github",
		}).catch((cause: unknown) => cause);

		expectStatusOnly(error instanceof Error ? error.message : String(error), "Kiro social device poll failed");
		expect(response.bodyUsed).toBe(false);
	});
});
