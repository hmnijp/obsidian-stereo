import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

// Exercise the real plugin data wiring without loading views or generated art.
const result = await build({
	entryPoints: ["src/main.ts"], bundle: true, write: false, format: "esm", platform: "node",
	plugins: [{ name: "host-double", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "double" }));
		builder.onLoad({ filter: /.*/, namespace: "double" }, () => ({ contents: `
			export class Plugin {
				app = {}; initial = null; writes = [];
				async loadData() { return this.initial; }
				async saveData(data) { this.writes.push(structuredClone(data)); }
				registerView() {} addSettingTab() {} addRibbonIcon() {} addCommand() {}
			}
			export class Notice {}
			export class WorkspaceLeaf {
				constructor(app) { this.app = app; this.state = null; this.parent = null; }
				getViewState() { return this.state ?? { type: "empty", state: {} }; }
				async setViewState(state) { this.state = state; }
			}
			export class App {} export class PluginSettingTab {
				containerEl = { addClass() {} };
				constructor() {}
			}
			export class Modal {} export class Setting {} export class FuzzySuggestModal {}
			export class ButtonComponent {} export function setIcon() {}
			export function debounce(fn) { const call = () => { call.pending = true; }; call.cancel = () => { call.pending = false; }; call.run = () => { if (call.pending) fn(); call.pending = false; }; return call; }
			export function requestUrl() { throw new Error("Unexpected network request"); }
		` }));
		builder.onLoad({ filter: /[\\/]src[\\/]view\.ts$/ }, () => ({ contents: 'export const STEREO_VIEW_TYPE = "stereo-player"; export class StereoView {}' }));
	} }],
});
const { default: StereoPlugin } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

class AudioDouble extends EventTarget {
	src = ""; paused = true; readyState = 4; currentTime = 0; duration = 200;
	async play() { this.paused = false; this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); }
	pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
	removeAttribute(name) { if (name === "src") this.src = ""; }
	load() {}
}
globalThis.Audio = AudioDouble;
const settings = { serverUrl: "https://music.invalid", username: "listener", password: "secret" };
const song = { id: "one", title: "One", duration: 200 };

function activeServer(plugin) {
	return plugin.settings.servers.find(
		(server) => server.id === plugin.settings.activeServerId
	);
}

async function setup(t, initial) {
	const plugin = new StereoPlugin();
	plugin.initial = initial;
	await plugin.onload();
	plugin.client.streamUrl = (id) => `https://music.invalid/${id}`;
	t.after(async () => { plugin.onunload(); await plugin.pendingSave; });
	return plugin;
}

test("plugin loads legacy data and saves current queue alongside history before debounce", async (t) => {
	for (const initial of [null, settings, { settings }]) {
		const plugin = await setup(t, initial);
		assert.deepEqual(plugin.player.history.getEntries(), []);
		await plugin.player.playTrack(song);
		await plugin.pendingSave;
		const saved = plugin.writes.at(-1);
		assert.equal(saved.history.entries.length, 1);
		assert.deepEqual(saved.playerState.queue, [song]);
		const restarted = await setup(t, saved);
		assert.equal(restarted.player.history.getEntries().length, 1);
		assert.equal(restarted.player.getState().playing, false);
		assert.equal(restarted.writes.length, 0);
	}
});

test("remembered sidebar views persist and ignore invalid entries", async (t) => {
	const openViews = [
		{ side: "left", path: [1], tab: 0 },
		{ side: "right", path: [0], tab: 2 },
		{ side: "left", path: [0, 1], tab: 1 },
	];
	const plugin = await setup(t, {
		settings,
		openViews: [
			...openViews,
			{ side: "main", path: [0], tab: 0 },
			{ side: "left", path: [-1], tab: 0 },
		],
		lastViewSide: "left",
	});
	await plugin.saveSettings();
	const saved = plugin.writes.at(-1);
	assert.deepEqual(saved.openViews, openViews);
	assert.equal(saved.lastViewSide, "left");

	const restarted = await setup(t, saved);
	await restarted.saveSettings();
	const again = restarted.writes.at(-1);
	assert.deepEqual(again.openViews, openViews);
	assert.equal(again.lastViewSide, "left");
});

test("sidebar side detection walks the workspace parent chain", async (t) => {
	const plugin = await setup(t, { settings });
	const leftSplit = {};
	const rightSplit = {};
	plugin.app.workspace = { leftSplit, rightSplit };
	assert.equal(
		plugin.sideOfLeaf({ parent: { parent: leftSplit } }),
		"left"
	);
	assert.equal(plugin.sideOfLeaf({ parent: rightSplit }), "right");
	assert.equal(plugin.sideOfLeaf({ parent: {} }), null);
});

test("saved sidebar view keeps its split and tab indexes", async (t) => {
	const plugin = await setup(t, { settings });
	const leftSplit = { children: [] };
	const split = { parent: leftSplit, children: [] };
	const tabs = { parent: split, children: [] };
	const leaf = { parent: tabs, children: [] };
	leftSplit.children.push(split);
	split.children.push(tabs);
	tabs.children.push(leaf);
	plugin.app.workspace = {
		leftSplit,
		rightSplit: { children: [] },
	};

	assert.deepEqual(plugin.savedViewForLeaf(leaf), {
		side: "left",
		path: [0, 0],
		tab: 0,
	});
});

test("restores a saved view as a tab in its original group", async (t) => {
	const plugin = await setup(t, { settings });
	const leftSplit = { children: [] };
	const makeGroup = () => {
		const group = { parent: leftSplit, children: [] };
		group.insertChild = (index, leaf) => {
			group.children.splice(index, 0, leaf);
			leaf.parent = group;
		};
		group.selectTabIndex = (index) => {
			group.currentTab = index;
		};
		return group;
	};
	const first = makeGroup();
	const second = makeGroup();
	leftSplit.children.push(first, second);
	const rightSplit = { children: [] };
	const iterate = (root, callback) => {
		for (const group of root.children) {
			for (const leaf of group.children) callback(leaf);
		}
	};
	plugin.app.workspace = {
		leftSplit,
		rightSplit,
		iterateAllLeaves(callback) {
			iterate(leftSplit, callback);
			iterate(rightSplit, callback);
		},
	};
	plugin.openViews = [{ side: "left", path: [1], tab: 0 }];

	await plugin.restoreSavedViews();

	assert.equal(second.children.length, 1);
	assert.deepEqual(second.children[0].state, {
		type: "stereo-player",
		active: false,
	});
	assert.equal(second.currentTab, 0);
	assert.equal(first.children.length, 0);
});

test("last sidebar side falls back to a remembered side", async (t) => {
	const plugin = await setup(t, {
		settings,
		openViews: [{ side: "right", path: [0], tab: 0 }],
		lastViewSide: "left",
	});
	await plugin.saveSettings();
	const saved = plugin.writes.at(-1);
	assert.deepEqual(saved.openViews, [{ side: "right", path: [0], tab: 0 }]);
	assert.equal(saved.lastViewSide, "right");
});

test("legacy full-URL history identity migrates to the host identity", async (t) => {
	const legacyConnection = createHash("md5")
		.update(JSON.stringify(["https://music.invalid", "listener"]))
		.digest("hex");
	const plugin = await setup(t, {
		settings,
		playerState: { queue: [song], index: 0, position: 12, volume: 0.4 },
		history: {
			connection: legacyConnection,
			entries: [{ song, playedAt: Date.now() }],
		},
	});
	assert.deepEqual(plugin.player.getState().queue, [song]);
	assert.equal(plugin.player.history.getEntries().length, 1);
	assert.notEqual(plugin.player.history.getConnection(), legacyConnection);
});

test("queue origin is cleared by edits and survives restart", async (t) => {
	const plugin = await setup(t, { settings });
	await plugin.player.setQueue(
		[song, { id: "two", title: "Two" }],
		0,
		{ kind: "album", id: "album-1", name: "Album" }
	);
	assert.deepEqual(plugin.player.getState().queueOrigin, {
		kind: "album",
		id: "album-1",
		name: "Album",
	});

	plugin.player.addToQueue([{ id: "three", title: "Three" }]);
	assert.equal(plugin.player.getState().queueOrigin, null);

	await plugin.player.setQueue(
		[song],
		0,
		{ kind: "playlist", id: "playlist-1", name: "Playlist", songCount: 1 }
	);
	plugin.savePlayerState.run();
	await plugin.pendingSave;
	const restarted = await setup(t, plugin.writes.at(-1));
	assert.deepEqual(restarted.player.getState().queueOrigin, {
		kind: "playlist",
		id: "playlist-1",
		name: "Playlist",
		songCount: 1,
	});
});

test("pending writes cannot overwrite a later clear; clearing is saved without waiting for queue debounce", async (t) => {
	const plugin = await setup(t, { settings });
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const completed = [];
	plugin.saveData = async (data) => { await blocked; completed.push(structuredClone(data)); };
	await plugin.player.playTrack(song);
	plugin.player.history.clear();
	assert.equal(plugin.player.history.getEntries().length, 0);
	assert.equal(plugin.player.getState().playing, true);
	release();
	await plugin.pendingSave;
	assert.equal(completed[0].history.entries.length, 1);
	assert.deepEqual(completed.at(-1).history.entries, []);
	assert.deepEqual(completed.at(-1).playerState.queue, [song]);
	plugin.savePlayerState.run();
	await plugin.pendingSave;
	assert.deepEqual(completed.at(-1).history.entries, []);
});

test("connection edits keep history and queue until committed; other settings never clear them", async (t) => {
	const plugin = await setup(t, { settings });
	await plugin.player.playTrack(song);
	await plugin.player.playTrack(song);
	assert.equal(plugin.player.getState().canUndo, true);
	activeServer(plugin).password = "replacement";
	await plugin.saveSettings();
	assert.equal(plugin.writes.at(-1).history.entries.length, 2);
	// Typing through a wrong value and correcting it before leaving the field.
	activeServer(plugin).username = "listene";
	await plugin.saveSettings();
	activeServer(plugin).username = "listener";
	await plugin.saveSettings();
	await plugin.commitConnection();
	assert.equal(plugin.player.history.getEntries().length, 2);
	assert.deepEqual(plugin.player.getState().queue, [song]);
	assert.equal(plugin.player.getState().canUndo, true);
	activeServer(plugin).username = "someone-else";
	await plugin.saveSettings();
	assert.equal(plugin.writes.at(-1).history.entries.length, 2);
	assert.deepEqual(plugin.writes.at(-1).playerState.queue, [song]);
	await plugin.commitConnection();
	const saved = plugin.writes.at(-1);
	assert.deepEqual(saved.history.entries, []);
	assert.deepEqual(saved.playerState.queue, []);
	assert.equal(plugin.player.getState().canUndo, false);
	assert.equal(saved.settings.servers[0].username, "someone-else");
});

test("reloading an uncommitted account edit drops the old queue; legacy and same-account data keep it", async (t) => {
	const plugin = await setup(t, { settings });
	await plugin.player.playTrack(song);
	activeServer(plugin).username = "someone-else";
	await plugin.saveSettings();
	const midEdit = plugin.writes.at(-1);
	assert.deepEqual(midEdit.playerState.queue, [song]);
	const restarted = await setup(t, midEdit);
	assert.deepEqual(restarted.player.getState().queue, []);
	assert.equal(restarted.player.getState().track, null);
	assert.deepEqual(restarted.player.history.getEntries(), []);
	assert.equal(activeServer(restarted).username, "someone-else");
	const playerState = { queue: [song], index: 0, position: 12, volume: 0.4 };
	const legacy = await setup(t, { settings, playerState });
	assert.deepEqual(legacy.player.getState().queue, [song]);
	assert.equal(legacy.player.getState().position, 12);
	const same = await setup(t, { settings, playerState, history: { connection: legacy.player.history.getConnection(), entries: [] } });
	assert.deepEqual(same.player.getState().queue, [song]);
});

test("unload flushes the latest paused position and cancels delayed saves", async (t) => {
	const plugin = await setup(t, { settings });
	await plugin.player.playTrack(song);
	plugin.player.seek(31);
	plugin.onunload();
	await plugin.pendingSave;
	assert.equal(plugin.writes.at(-1).playerState.position, 31);
	assert.equal(plugin.writes.at(-1).history.entries.length, 1);
	assert.equal(plugin.savePlayerState.pending, false);
});
