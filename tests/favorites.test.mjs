import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/favorites.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { FavoritesIndex } = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const song = (id, starred) =>
	starred ? { id, title: id, starred } : { id, title: id };

function setup(t, connection = "one") {
	const calls = [];
	let current = connection;
	const client = {
		star: async ({ id }) => {
			calls.push(`star:${id}`);
		},
		unstar: async ({ id }) => {
			calls.push(`unstar:${id}`);
		},
	};
	const index = new FavoritesIndex(client, () => current);
	t.after(() => index.destroy());
	return {
		index,
		calls,
		client,
		setConnection: (next) => {
			current = next;
		},
	};
}

test("learns starred fields and toggles favorites without refetching", async (t) => {
	const { index, calls } = setup(t);
	const a = song("a", "2026-10-18T00:00:00Z");
	const b = song("b");
	assert.equal(index.isStarred(a), true);
	assert.equal(index.isStarred(b), false);
	index.learnSongs([a, b]);
	assert.equal(index.isStarredById("a"), true);
	assert.equal(index.isStarredById("b"), false);

	const listenerCalls = [];
	index.subscribe(() => listenerCalls.push("changed"));
	const starred = await index.toggle(b);
	assert.equal(typeof starred, "string");
	assert.deepEqual(calls, ["star:b"]);
	assert.equal(index.isStarredById("b"), true);
	assert.equal(b.starred, starred);
	assert.equal(listenerCalls.length, 1);

	assert.equal(await index.toggle(b), undefined);
	assert.deepEqual(calls, ["star:b", "unstar:b"]);
	assert.equal(index.isStarredById("b"), false);
	assert.equal(b.starred, undefined);
	assert.equal(listenerCalls.length, 2);
});

test("explicit state wins over stale starred fields on other copies", async (t) => {
	const { index } = setup(t);
	const a = song("a");
	await index.toggle(a);
	assert.equal(index.isStarred({ ...a, starred: "old" }), true);
	await index.toggle(a);
	assert.equal(index.isStarred({ ...a, starred: "old" }), false);
});

test("failed toggles keep the previous state and do not notify", async (t) => {
	const { index, client } = setup(t);
	const a = song("a");
	const listenerCalls = [];
	index.subscribe(() => listenerCalls.push("changed"));
	client.star = async () => {
		throw new Error("offline");
	};
	await assert.rejects(index.toggle(a), /offline/);
	assert.equal(index.isStarredById("a"), false);
	assert.equal(a.starred, undefined);
	assert.equal(listenerCalls.length, 0);
});

test("connection changes clear the session index", (t) => {
	const { index, setConnection } = setup(t);
	index.learn(song("a", "2026-10-18T00:00:00Z"));
	assert.equal(index.isStarredById("a"), true);
	const listenerCalls = [];
	index.subscribe(() => listenerCalls.push("changed"));
	setConnection("two");
	index.syncConnection();
	assert.equal(index.isStarredById("a"), false);
	assert.equal(listenerCalls.length, 1);
	index.syncConnection();
	assert.equal(listenerCalls.length, 1);
});

test("radio entries are not sent to the server", async (t) => {
	const { index, calls } = setup(t);
	const radio = { id: "radio", title: "Radio", streamUrl: "https://radio.invalid" };
	assert.equal(await index.toggle(radio), undefined);
	assert.deepEqual(calls, []);
	assert.equal(index.isStarred(radio), false);
});

test("unsubscribing stops notifications", async (t) => {
	const { index } = setup(t);
	let count = 0;
	const unsubscribe = index.subscribe(() => count++);
	await index.toggle(song("a"));
	assert.equal(count, 1);
	unsubscribe();
	await index.toggle(song("b"));
	assert.equal(count, 1);
});
