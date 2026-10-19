import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const obsidianDouble = `
	export class PluginSettingTab {}
	export class App {}
	export class Modal {}
	export class ConfirmationModal {}
	export class ItemView {}
	export class Notice {}
	export class FuzzySuggestModal {}
	export class Setting {}
	export function setIcon() {}
	export function requestUrl() { throw new Error("Unexpected network request"); }
`;

async function bundle(entry) {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "host-double",
				setup(builder) {
					builder.onResolve({ filter: /^obsidian$/ }, () => ({
						path: "host",
						namespace: "double",
					}));
					builder.onLoad({ filter: /.*/, namespace: "double" }, () => ({
						contents: obsidianDouble,
					}));
				},
			},
		],
	});
	return import(
		`data:text/javascript;base64,${Buffer.from(
			result.outputFiles[0].text
		).toString("base64")}`
	);
}

const servers = await bundle("src/servers.ts");
const connection = await bundle("src/connection.ts");
const historyModule = await bundle("src/history.ts");
const settingsModule = await bundle("src/settings.ts");

function server(overrides = {}) {
	return {
		id: "s1",
		name: "Home",
		wanUrl: "https://wan.example",
		lanUrl: "http://192.168.1.10:4533",
		shareBaseUrl: "",
		username: "listener",
		password: "secret",
		connectionMode: "auto",
		...overrides,
	};
}

test("activeServer returns the selected server and supports legacy settings", () => {
	const selected = servers.activeServer({
		servers: [server(), server({ id: "s2", name: "Other" })],
		activeServerId: "s2",
	});
	assert.equal(selected.id, "s2");

	const legacy = servers.activeServer({
		serverUrl: "https://legacy.example/navidrome",
		username: "old",
		password: "pass",
		shareBaseUrl: "https://legacy.example/navidrome",
	});
	assert.equal(legacy.wanUrl, "https://legacy.example/navidrome");
	assert.equal(legacy.shareBaseUrl, "https://legacy.example/navidrome");
	assert.equal(legacy.username, "old");
});

test("server URL selection and share fallback follow the mode", () => {
	const auto = server();
	assert.equal(servers.serverApiUrl(auto), "http://192.168.1.10:4533");
	assert.equal(
		servers.serverApiUrl(auto, "wan"),
		"https://wan.example"
	);
	assert.equal(
		servers.serverApiUrl(auto, "lan"),
		"http://192.168.1.10:4533"
	);
	assert.equal(servers.serverShareBase(auto), "https://wan.example");
	assert.equal(
		servers.serverShareBase(server({ shareBaseUrl: "https://share.example" })),
		"https://share.example"
	);
});

test("ConnectionManager prefers LAN, falls back to WAN, and recovers", async () => {
	const settings = {
		servers: [server()],
		activeServerId: "s1",
	};
	const manager = new connection.ConnectionManager(() => settings);
	assert.equal(manager.currentUrl(), "http://192.168.1.10:4533");
	assert.equal(manager.fallbackUrl(), "https://wan.example");

	manager.noteRequest("http://192.168.1.10:4533", false);
	assert.equal(manager.currentUrl(), "https://wan.example");
	assert.equal(manager.fallbackUrl(), "http://192.168.1.10:4533");

	manager.setProbe(async () => true);
	await manager.probeNow();
	assert.equal(manager.currentUrl(), "http://192.168.1.10:4533");
	assert.equal(manager.activeKind(), "lan");
});

test("ConnectionManager honors WAN-only and LAN-only modes", () => {
	const wanSettings = {
		servers: [server({ connectionMode: "wan" })],
		activeServerId: "s1",
	};
	const wanManager = new connection.ConnectionManager(() => wanSettings);
	assert.equal(wanManager.currentUrl(), "https://wan.example");
	assert.equal(wanManager.fallbackUrl(), null);

	const lanSettings = {
		servers: [server({ connectionMode: "lan" })],
		activeServerId: "s1",
	};
	const lanManager = new connection.ConnectionManager(() => lanSettings);
	assert.equal(lanManager.currentUrl(), "http://192.168.1.10:4533");
	assert.equal(lanManager.fallbackUrl(), null);
});

test("legacy flat settings migrate into one server without changing identity", () => {
	const migrated = settingsModule.migrateSettings({
		serverUrl: "https://legacy.example/navidrome",
		username: "old",
		password: "pass",
		shareBaseUrl: "https://legacy.example/navidrome",
		sharingEnabled: false,
	});
	assert.equal(migrated.servers.length, 1);
	assert.equal(migrated.servers[0].wanUrl, "https://legacy.example/navidrome");
	assert.equal(migrated.servers[0].shareBaseUrl, "https://legacy.example/navidrome");
	assert.equal(migrated.servers[0].username, "old");
	assert.equal(migrated.activeServerId, migrated.servers[0].id);
	assert.equal(migrated.sharingEnabled, false);
	assert.equal(migrated.serverUrl, undefined);
});

test("migrateSettings keeps multiple saved servers and a valid active id", () => {
	const first = server({ id: "a" });
	const second = server({ id: "b", name: "Second" });
	const migrated = settingsModule.migrateSettings({
		servers: [first, second],
		activeServerId: "b",
	});
	assert.equal(migrated.servers.length, 2);
	assert.equal(migrated.activeServerId, "b");
});

test("history identity uses host and username, ignoring path and scheme", () => {
	const identity = (wanUrl, username = "listener") =>
		historyModule.historyConnection({
			servers: [server({ wanUrl, lanUrl: "", username })],
			activeServerId: "s1",
		});
	assert.equal(
		identity("http://192.168.0.123/navidrome"),
		identity("http://192.168.0.123/octo")
	);
	assert.equal(
		identity("http://192.168.0.123/navidrome"),
		identity("https://192.168.0.123/octo")
	);
	assert.notEqual(
		identity("http://192.168.0.123/navidrome"),
		identity("http://192.168.0.124/navidrome")
	);
	assert.notEqual(
		identity("http://192.168.0.123/navidrome"),
		identity("http://192.168.0.123/navidrome", "other")
	);
});
