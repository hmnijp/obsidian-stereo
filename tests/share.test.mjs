import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const obsidianDouble = `
	export class App {}
	export class Modal {}
	export class Setting {}
	export class FuzzySuggestModal {}
	export class ButtonComponent {}
	export class Notice {}
	export function setIcon() {}
	export function requestUrl(options) {
		if (!globalThis.__stereoRequest) throw new Error("Unexpected network request");
		return globalThis.__stereoRequest(options);
	}
`;

async function bundle(entry, extraPlugins = []) {
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
					for (const plugin of extraPlugins) plugin(builder);
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

const share = await bundle("src/share.ts", [
	(builder) => {
		builder.onLoad({ filter: /[\\/]src[\\/]settings\.ts$/ }, () => ({
			contents: `
				export const SHARE_TTL_PRESETS = [
					{ value: "1h", label: "1 hour", ms: 3600000 },
					{ value: "24h", label: "24 hours", ms: 86400000 },
					{ value: "7d", label: "7 days", ms: 604800000 },
				];
			`,
		}));
	},
]);

test("normalizeShareUrl keeps a server-returned path outside the proxy prefix", () => {
	assert.equal(
		share.normalizeShareUrl(
			"https://hmnijpreg.ddns.net/navidrome/share/6QEFU9d1dr",
			"6QEFU9d1dr",
			"",
			"https://hmnijpreg.ddns.net/octo/",
		),
		"https://hmnijpreg.ddns.net/navidrome/share/6QEFU9d1dr",
	);
	assert.equal(
		share.normalizeShareUrl(
			"https://hmnijpreg.ddns.net/octo/navidrome/share/6QEFU9d1dr",
			"6QEFU9d1dr",
			"https://hmnijpreg.ddns.net/navidrome",
			"https://hmnijpreg.ddns.net/octo/",
		),
		"https://hmnijpreg.ddns.net/navidrome/share/6QEFU9d1dr",
	);
	assert.equal(
		share.normalizeShareUrl(
			"http://192.168.0.123/navidrome/share/id",
			"id",
			"",
			"https://wan.example/octo",
		),
		"https://wan.example/navidrome/share/id",
	);
});

test("normalizeShareUrl rewrites LAN and relative links to the WAN base", () => {
	assert.equal(
		share.normalizeShareUrl(
			"http://192.168.1.5:4533/share/abc",
			"abc",
			"https://music.example.com/music",
			"http://192.168.1.5:4533"
		),
		"https://music.example.com/music/share/abc"
	);
	assert.equal(
		share.normalizeShareUrl(
			"/music/share/abc",
			"abc",
			"https://music.example.com/music",
			"http://192.168.1.5:4533"
		),
		"https://music.example.com/music/share/abc"
	);
	assert.equal(
		share.normalizeShareUrl(
			"",
			"abc",
			"https://music.example.com",
			"http://192.168.1.5:4533"
		),
		"https://music.example.com/share/abc"
	);
	assert.equal(
		share.normalizeShareUrl(
			"http://localhost:4533/share/abc",
			"abc",
			"",
			"https://music.example.com"
		),
		"https://music.example.com/share/abc"
	);
	assert.equal(
		share.normalizeShareUrl(
			"/share/abc",
			"abc",
			"music.example.com",
			"http://192.168.1.5:4533"
		),
		"https://music.example.com/share/abc"
	);
});

function song(id, albumId, extra = {}) {
	return { id, title: id, albumId, ...extra };
}

function fakeClient({ albums = [], playlists = [] } = {}) {
	const albumMap = new Map(albums.map((entry) => [entry.album.id, entry]));
	const playlistMap = new Map(
		playlists.map((entry) => [entry.playlist.id, entry])
	);
	return {
		async getAlbum(id) {
			const entry = albumMap.get(id);
			if (!entry) throw new Error("not found");
			return entry;
		},
		async getPlaylist(id) {
			const entry = playlistMap.get(id);
			if (!entry) throw new Error("not found");
			return entry;
		},
		async getPlaylists() {
			return [...playlistMap.values()].map((entry) => entry.playlist);
		},
	};
}

test("a queue with a tracked album origin shares the album when it matches", async () => {
	const songs = [song("s1", "a1"), song("s2", "a1")];
	const target = await share.resolveQueueShareTarget(
		songs,
		{ kind: "album", id: "a1", name: "Album" },
		fakeClient({
			albums: [{ album: { id: "a1", name: "Album" }, songs }],
		})
	);
	assert.equal(target.kind, "album");
	assert.deepEqual(target.resourceIds, ["a1"]);
});

test("a changed queue falls back to a snapshot instead of a stale origin", async () => {
	const songs = [song("s1", "a1"), song("s2", "a1")];
	const target = await share.resolveQueueShareTarget(
		[songs[0]],
		{ kind: "album", id: "a1", name: "Album" },
		fakeClient({
			albums: [{ album: { id: "a1", name: "Album" }, songs }],
		})
	);
	assert.equal(target.kind, "queue");
	assert.deepEqual(target.resourceIds, ["s1"]);
});

test("queues without an origin still detect a complete album", async () => {
	const songs = [song("s1", "a1"), song("s2", "a1")];
	const target = await share.resolveQueueShareTarget(
		songs,
		null,
		fakeClient({
			albums: [{ album: { id: "a1", name: "Album" }, songs }],
		})
	);
	assert.equal(target.kind, "album");
	assert.equal(target.title, "Album");
});

test("queues without an origin detect an unambiguous playlist", async () => {
	const songs = [song("s1", "a1"), song("s2", "a2")];
	const target = await share.resolveQueueShareTarget(
		songs,
		null,
		fakeClient({
			playlists: [
				{
					playlist: { id: "p1", name: "Playlist", songCount: 2 },
					songs,
				},
			],
		})
	);
	assert.equal(target.kind, "playlist");
	assert.deepEqual(target.resourceIds, ["p1"]);
});

test("ambiguous playlists and radio entries never leak into the snapshot", async () => {
	const songs = [
		song("s1", "a1"),
		song("s2", "a2"),
		song("radio", undefined, { streamUrl: "https://radio.example/live" }),
	];
	const target = await share.resolveQueueShareTarget(
		songs,
		null,
		fakeClient({
			playlists: [
				{
					playlist: { id: "p1", name: "One", songCount: 2 },
					songs: songs.slice(0, 2),
				},
				{
					playlist: { id: "p2", name: "Two", songCount: 2 },
					songs: songs.slice(0, 2),
				},
			],
		})
	);
	assert.equal(target.kind, "queue");
	assert.deepEqual(target.resourceIds, ["s1", "s2"]);
});

const subsonic = await bundle("src/subsonic.ts");
const connectionModule = await bundle("src/connection.ts");
globalThis.window = globalThis;
const settings = {
	serverUrl: "https://music.example.com",
	username: "listener",
	password: "secret",
};
const client = new subsonic.SubsonicClient(() => settings);

function respondWith(sharePayload, status = 200) {
	globalThis.__stereoRequest = async (options) => {
		globalThis.__lastRequest = options;
		return {
			status,
			headers: {},
			json: {
				"subsonic-response": {
					status: "ok",
					version: "1.16.1",
					...(sharePayload ? { shares: { share: sharePayload } } : {}),
				},
			},
		};
	};
}

test("createShare sends one id with GET and includes expiry and downloads", async () => {
	const expiresAt = new Date("2030-01-02T03:04:05.000Z");
	respondWith([
		{
			id: "abc",
			url: "http://localhost/share/abc",
			username: "listener",
			created: "2026-01-01T00:00:00Z",
		},
	]);
	const result = await client.createShare({
		ids: ["track-1"],
		description: "Listen",
		expiresAt,
		downloadable: true,
	});
	const request = globalThis.__lastRequest;
	const url = new URL(request.url);
	assert.equal(request.method, "GET");
	assert.equal(url.pathname, "/rest/createShare.view");
	assert.equal(url.searchParams.get("id"), "track-1");
	assert.equal(url.searchParams.get("expires"), String(expiresAt.getTime()));
	assert.equal(url.searchParams.get("downloadable"), "true");
	assert.equal(url.searchParams.get("description"), "Listen");
	assert.equal(result.id, "abc");
});

test("createShare sends large queues as a POST form", async () => {
	respondWith([
		{
			id: "queue",
			url: "http://localhost/share/queue",
			username: "listener",
			created: "2026-01-01T00:00:00Z",
		},
	]);
	const ids = Array.from({ length: 30 }, (_, index) => `track-${index}`);
	await client.createShare({ ids, downloadable: false });
	const request = globalThis.__lastRequest;
	const body = new URLSearchParams(request.body);
	assert.equal(request.method, "POST");
	assert.deepEqual(body.getAll("id"), ids);
	assert.equal(body.get("downloadable"), "false");
});

test("getShares accepts both single objects and arrays, and deleteShare targets the id", async () => {
	respondWith({
		id: "abc",
		url: "https://music.example.com/share/abc",
		username: "listener",
		created: "2026-01-01T00:00:00Z",
	});
	assert.equal((await client.getShares()).length, 1);

	respondWith(null);
	await client.deleteShare("abc");
	const url = new URL(globalThis.__lastRequest.url);
	assert.equal(url.pathname, "/rest/deleteShare.view");
	assert.equal(url.searchParams.get("id"), "abc");
});

test("updateShare sends only the requested fields", async () => {
	respondWith(null);
	await client.updateShare("abc", {
		description: "New description",
		downloadable: true,
	});
	let url = new URL(globalThis.__lastRequest.url);
	assert.equal(url.pathname, "/rest/updateShare.view");
	assert.equal(url.searchParams.get("id"), "abc");
	assert.equal(url.searchParams.get("description"), "New description");
	assert.equal(url.searchParams.get("downloadable"), "true");
	assert.equal(url.searchParams.has("expires"), false);

	const expiresAt = new Date("2030-01-02T03:04:05.000Z");
	await client.updateShare("abc", {
		description: "",
		expiresAt,
	});
	url = new URL(globalThis.__lastRequest.url);
	assert.equal(url.searchParams.get("description"), "");
	assert.equal(url.searchParams.get("expires"), String(expiresAt.getTime()));
	assert.equal(url.searchParams.has("downloadable"), false);
});

test("HTTP 501 reports sharing as unavailable", async () => {
	globalThis.__stereoRequest = async () => ({
		status: 501,
		headers: {},
		json: null,
	});
	await assert.rejects(
		() => client.createShare({ ids: ["one"] }),
		(error) => error.kind === "unreachable" && error.code === 501
	);
});

test("SubsonicClient falls back from LAN to WAN and remembers the failure", async () => {
	const lan = "https://lan.invalid/octo";
	const wan = "https://wan.invalid";
	const serverSettings = {
		servers: [
			{
				id: "s1",
				name: "Test",
				wanUrl: wan,
				lanUrl: lan,
				shareBaseUrl: "",
				username: "listener",
				password: "secret",
				connectionMode: "auto",
			},
		],
		activeServerId: "s1",
	};
	const manager = new connectionModule.ConnectionManager(
		() => serverSettings
	);
	const fallbackClient = new subsonic.SubsonicClient(
		() => serverSettings,
		manager
	);
	const urls = [];
	globalThis.__stereoRequest = async (options) => {
		urls.push(options.url);
		if (options.url.startsWith(lan)) throw new Error("LAN is down");
		return {
			status: 200,
			headers: {},
			json: {
				"subsonic-response": {
					status: "ok",
					version: "1.16.1",
					type: "navidrome",
				},
			},
		};
	};
	const info = await fallbackClient.ping();
	assert.equal(info.type, "navidrome");
	assert.ok(urls[0].startsWith(lan));
	assert.ok(urls[1].startsWith(wan));
	assert.equal(manager.currentUrl(), wan);
});
