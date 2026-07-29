import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage OAuth refresh race", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-race-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders("auth-storage-oauth-refresh-race-test");
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("does not disable a credential another process already rotated", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Seed the shared DB with one expired OAuth credential; this simulates the
		// state two cooperating gjc processes both load from the persisted row.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Simulate the peer's successful refresh: another process called the real
		// `#replaceCredentialAt` path, which rotates the row in place via
		// updateAuthCredential. The in-memory snapshot we hold is now stale.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		// Mock mirrors Anthropic: only the stale refresh token is rejected, because
		// real rotation invalidates the previous refresh token on use.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-race");

			// We should have picked up the rotated credential instead of disabling
			// the row that the peer just updated.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(authStorage!.list()).toContain("anthropic");

			// The row must still be active in storage; before the fix it would be
			// soft-deleted with disabled_cause set to the invalid_grant error.
			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("does not disable when peer rotates between pre-check and CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Refresh genuinely fails — the pre-check that compares the persisted
		// refresh token to our snapshot will therefore see the SAME stale token
		// and fall through to the disable. We then race a peer rotation into the
		// window between the pre-check and the CAS, which the CAS must detect.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		const sharedStore = store;
		const originalTryDisable = sharedStore.tryDisableAuthCredentialIfMatches.bind(sharedStore);
		const tryDisableSpy = vi
			.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches")
			.mockImplementation((id, expectedData, disabledCause) => {
				// Simulate the peer's successful rotation landing in the window
				// between the pre-check (which saw the stale token) and the CAS
				// disable. The CAS predicate `data = expectedData` must now miss.
				sharedStore.updateAuthCredential(id, {
					type: "oauth",
					access: "fresh-access-from-peer",
					refresh: "fresh-refresh-from-peer",
					expires: Date.now() + 60 * 60_000,
				});
				return originalTryDisable(id, expectedData, disabledCause);
			});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-race");

			// CAS lost → reload → pick up the peer-rotated credential.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(tryDisableSpy).toHaveBeenCalled();

			// Row must still be active, with the peer's rotated tokens.
			const stored = sharedStore.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
				expect(stored[0].credential.access).toBe("fresh-access-from-peer");
			}
		});
	});

	test("still disables when the failure is real (no concurrent rotation)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Single-process scenario: refresh genuinely fails and no peer updated the
		// row. The credential should still be soft-deleted.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-real-failure");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});
	});
	test("persists every credential refreshed during candidate preflight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-preflight",
			name: "Unit OAuth Preflight",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-preflight", [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires },
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-preflight");
		expect(apiKey).toBe("access-a-rotated");

		const stored = store.listAuthCredentials("unit-oauth-preflight");
		expect(stored).toHaveLength(2);
		const oauth = stored.map(entry => entry.credential).filter(credential => credential.type === "oauth");
		expect(oauth.map(credential => credential.refresh).sort()).toEqual(["refresh-a-rotated", "refresh-b-rotated"]);
	});

	test("coalesces concurrent refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-mutex",
			name: "Unit OAuth Mutex",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-mutex", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const first = authStorage.getApiKey("unit-oauth-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-rotated");
		await expect(second).resolves.toBe("access-rotated");
		expect(refreshCalls).toBe(1);
	});

	test("keeps a shared refresh alive when one waiter cancels", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		const controller = new AbortController();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-cancelled-waiter",
			name: "Unit OAuth Cancelled Waiter",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-cancelled-waiter", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);

		const cancelled = authStorage.getApiKey("unit-oauth-cancelled-waiter", "cancelled", {
			signal: controller.signal,
		});
		const waiting = authStorage.getApiKey("unit-oauth-cancelled-waiter", "waiting");
		await refreshStarted.promise;
		controller.abort();
		await expect(cancelled).resolves.toBeUndefined();
		allowRefresh.resolve();

		await expect(waiting).resolves.toBe("access-rotated");
		expect(refreshCalls).toBe(1);
		const persisted = store.listAuthCredentials("unit-oauth-cancelled-waiter")[0]?.credential;
		expect(persisted?.type).toBe("oauth");
		if (persisted?.type === "oauth") expect(persisted.refresh).toBe("refresh-rotated");
	});

	test("persists a shared rotation after every waiter cancels", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		const firstController = new AbortController();
		const secondController = new AbortController();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-all-waiters-cancelled",
			name: "Unit OAuth All Waiters Cancelled",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-after-all-cancelled",
					refresh: "refresh-after-all-cancelled",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-all-waiters-cancelled", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		const first = authStorage.getApiKey("unit-oauth-all-waiters-cancelled", "cancelled-first", {
			signal: firstController.signal,
		});
		const second = authStorage.getApiKey("unit-oauth-all-waiters-cancelled", "cancelled-second", {
			signal: secondController.signal,
		});
		await refreshStarted.promise;
		firstController.abort();
		secondController.abort();
		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();

		allowRefresh.resolve();
		let persistedRefresh: string | undefined;
		for (let attempt = 0; attempt < 50; attempt++) {
			const persisted = store.listAuthCredentials("unit-oauth-all-waiters-cancelled")[0]?.credential;
			if (persisted?.type === "oauth") persistedRefresh = persisted.refresh;
			if (persistedRefresh === "refresh-after-all-cancelled") break;
			await Bun.sleep(5);
		}

		expect(refreshCalls).toBe(1);
		expect(persistedRefresh).toBe("refresh-after-all-cancelled");
	});

	test("persists one successful shared refresh exactly once", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const compareAndSwap = vi.spyOn(store, "tryUpdateAuthCredentialIfMatches");
		const refreshedExpires = Date.now() + 60 * 60_000;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-single-persist",
			name: "Unit OAuth Single Persist",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-single-persist", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		await expect(authStorage.getApiKey("unit-oauth-single-persist", "single-persist")).resolves.toBe(
			"access-rotated",
		);

		expect(compareAndSwap).toHaveBeenCalledTimes(1);
		const persisted = store.listAuthCredentials("unit-oauth-single-persist")[0]?.credential;
		expect(persisted).toMatchObject({ access: "access-rotated", refresh: "refresh-rotated" });
	});

	test("does not overwrite a row changed while refresh is in flight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const refreshStarted = Promise.withResolvers<void>();
		const releaseRefresh = Promise.withResolvers<void>();
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-refresh-cas",
			name: "Unit OAuth Refresh CAS",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60_000 };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await releaseRefresh.promise;
				return { ...credentials, access: "late-refresh-access", refresh: "late-refresh-token" };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set("unit-oauth-refresh-cas", [
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 60_000 },
		]);
		const id = store.listAuthCredentials("unit-oauth-refresh-cas")[0]!.id;
		const pending = authStorage.getApiKey("unit-oauth-refresh-cas", "refresh-cas");
		await refreshStarted.promise;
		store.updateAuthCredential(id, {
			type: "oauth",
			access: "new-login-access",
			refresh: "new-login-token",
			expires: Date.now() + 60 * 60_000,
		});
		releaseRefresh.resolve();

		await expect(pending).resolves.toBe("new-login-access");
		const persistedAfter = store.listAuthCredentials("unit-oauth-refresh-cas")[0]?.credential;
		expect(persistedAfter).toMatchObject({ access: "new-login-access", refresh: "new-login-token" });
	});

	test("invalidating a session-sticky OAuth credential rotates the retry to another active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		let sessionId = "";
		for (let index = 0; index < 32; index++) {
			const candidate = `session-auth-retry-${index}`;
			if (Bun.hash.xxHash32(candidate) % 2 === 0) {
				sessionId = candidate;
				break;
			}
		}
		if (!sessionId) throw new Error("could not find test session id");

		await authStorage.set("unit-oauth-rotation", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(firstKey).toBe("access-a");

		const invalidated = await authStorage.invalidateCredentialMatching("unit-oauth-rotation", "access-a", {
			sessionId,
		});
		expect(invalidated).toBe(true);

		const retryKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(retryKey).toBe("access-b");
	});

	test("recovers from a non-definitive invalid-grant failure when a peer rotated the token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Kimi-style failure: refresh-token rotation by a peer leaves our snapshot
		// token rejected with a message that does NOT match the definitive-failure
		// regex (HTTP 400 "The provided authorization grant is invalid", not the
		// literal "invalid_grant"). Before the fix this was misclassified as
		// transient and the healthy credential was temp-blocked for 5 minutes on
		// every rotation race — with Kimi's ~12-minute access tokens and several
		// gjc processes sharing the store, users saw repeated "logged out" states.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Peer process rotated the row first.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			if (credentials.refresh === "stale-refresh") {
				throw new Error("Kimi token refresh failed: 400: The provided authorization grant is invalid");
			}
			return credentials;
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-kimi-race");

			// The peer-rotated credential must be picked up — not temp-blocked.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);

			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("disables on a genuine Kimi-style invalid-grant failure with no peer rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Same Kimi message shape, but no peer updated the row: the refresh token
		// is genuinely revoked, so the credential must be disabled (and the
		// onCredentialDisabled listener fired) instead of looping 5-minute
		// temp-blocks forever.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("Kimi token refresh failed: 400: The provided authorization grant is invalid");
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-kimi-revoked");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("authorization grant is invalid");
		});
	});
});
