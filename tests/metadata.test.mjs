import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/metadata.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { albumDateValue, albumLabel, albumLabelFor, songMeta } = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("album labels append the release year", () => {
	assert.equal(albumLabel("Album", 1999), "Album - 1999");
	assert.equal(albumLabel("Album", undefined), "Album");
	assert.equal(albumLabel(undefined, 1999), "");
});

test("album labels and sort keys prefer releaseDate then originalReleaseDate", () => {
	assert.equal(
		albumLabelFor({
			id: "album",
			name: "Album",
			releaseDate: { year: 2001, month: 2, day: 3 },
			originalReleaseDate: { year: 1999 },
			year: 1998,
		}),
		"Album - 2001"
	);
	assert.equal(
		albumLabelFor({
			id: "album",
			name: "Album",
			originalReleaseDate: { year: 1999 },
			year: 1998,
		}),
		"Album - 1999"
	);
	assert.equal(
		albumDateValue({
			id: "album",
			name: "Album",
			releaseDate: { year: 2001, month: 2, day: 3 },
			year: 1998,
		}),
		20010203
	);
});

test("song metadata always includes artist and album-year", () => {
	assert.equal(
		songMeta({
			id: "one",
			title: "Song",
			artist: "Artist",
			album: "Album",
			year: 1999,
		}),
		"Artist · Album - 1999"
	);
	assert.equal(
		songMeta({ id: "two", title: "Song", album: "Album", year: 2001 }),
		"Unknown artist · Album - 2001"
	);
	assert.equal(
		songMeta({ id: "three", title: "Song", artist: "Artist" }),
		"Artist"
	);
});
