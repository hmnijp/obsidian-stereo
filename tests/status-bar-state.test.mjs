import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/status-bar-state.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { statusBarPresentation } = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const song = {
	id: "one",
	title: "Song",
	artist: "Artist",
};

test("empty queue uses the idle ribbon icon and opens the player", () => {
	assert.deepEqual(statusBarPresentation({ track: null, playing: false }), {
		icon: "boom-box",
		idle: true,
		playing: false,
		label: "Open Stereo",
	});
});

test("paused and playing tracks mirror the player play/pause states", () => {
	assert.deepEqual(statusBarPresentation({ track: song, playing: false }), {
		icon: "play",
		idle: false,
		playing: false,
		label: "Play: Artist - Song",
	});
	assert.deepEqual(statusBarPresentation({ track: song, playing: true }), {
		icon: "pause",
		idle: false,
		playing: true,
		label: "Pause: Artist - Song",
	});
});

test("tracks without an artist fall back to the title", () => {
	assert.equal(
		statusBarPresentation({
			track: { ...song, artist: "" },
			playing: false,
		}).label,
		"Play: Song"
	);
});
