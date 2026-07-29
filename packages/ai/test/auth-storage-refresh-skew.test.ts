import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { UsageProvider } from "../src/usage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";

describe("AuthStorage OAuth refresh skew", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-refresh-skew-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		unregisterOAuthProviders("auth-storage-refresh-skew-test");
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("refreshes before strict expiry when the credential is inside the 60s skew", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let refreshCalls = 0;
		const refreshedExpires = Date.now() + 60 * 60_000;
		registerOAuthProvider({
			id: "unit-oauth-skew",
			name: "Unit OAuth Skew",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "access-after-skew-refresh",
					refresh: "refresh-after-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew", [
			{
				type: "oauth",
				access: "access-before-skew-refresh",
				refresh: "refresh-before-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-skew", "skew-session");

		expect(apiKey).toBe("access-after-skew-refresh");
		expect(refreshCalls).toBe(1);
		const stored = store.listAuthCredentials("unit-oauth-skew");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("access-after-skew-refresh");
			expect(stored[0].credential.refresh).toBe("refresh-after-skew-refresh");
		}
	});

	test("coalesces concurrent skew refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		registerOAuthProvider({
			id: "unit-oauth-skew-mutex",
			name: "Unit OAuth Skew Mutex",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-after-shared-skew-refresh",
					refresh: "refresh-after-shared-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew-mutex", [
			{
				type: "oauth",
				access: "access-before-shared-skew-refresh",
				refresh: "refresh-before-shared-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const first = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-after-shared-skew-refresh");
		await expect(second).resolves.toBe("access-after-shared-skew-refresh");
		expect(refreshCalls).toBe(1);
	});

	test("does not overwrite another opaque credential after a usage-triggered refresh-token rotation", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const providerId = "unit-opaque-usage-refresh";
		await authStorage.set(providerId, [
			{
				type: "oauth",
				access: "account-a-access",
				refresh: "account-a-refresh",
				expires: Date.now() + 60 * 60_000,
			},
			{
				type: "oauth",
				access: "account-b-access",
				refresh: "account-b-refresh",
				expires: Date.now() + 30_000,
			},
		]);
		const before = store.listAuthCredentials(providerId);
		const accountAId = before[0]!.id;
		const accountBId = before[1]!.id;
		let usageCalls = 0;
		const usageProvider: UsageProvider = {
			id: providerId,
			async fetchUsage(params) {
				usageCalls += 1;
				return {
					provider: providerId,
					fetchedAt: Date.now(),
					limits: [],
					metadata: { account: params.credential.accessToken },
				};
			},
		};
		const usageStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === providerId ? usageProvider : undefined),
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				expect(credentialId).toBe(accountBId);
				return {
					...credential,
					access: "account-b-access-rotated",
					refresh: "account-b-refresh-rotated",
					expires: Date.now() + 60 * 60_000,
				};
			},
		});
		await usageStorage.reload();

		await usageStorage.fetchUsageReports();
		await usageStorage.fetchUsageReports();
		expect(usageCalls).toBe(2);

		const after = store.listAuthCredentials(providerId);
		const accountA = after.find(entry => entry.id === accountAId);
		const accountB = after.find(entry => entry.id === accountBId);
		expect(accountA?.credential.type).toBe("oauth");
		expect(accountB?.credential.type).toBe("oauth");
		if (accountA?.credential.type === "oauth" && accountB?.credential.type === "oauth") {
			expect(accountA.credential.access).toBe("account-a-access");
			expect(accountA.credential.refresh).toBe("account-a-refresh");
			expect(accountB.credential.access).toBe("account-b-access-rotated");
			expect(accountB.credential.refresh).toBe("account-b-refresh-rotated");
		}
	});
});
