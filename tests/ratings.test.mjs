import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/ratings.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { RatingsIndex } = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const song = (id, userRating) =>
	userRating ? { id, title: id, userRating } : { id, title: id };

function setup(t, connection = "one") {
	const calls = [];
	let current = connection;
	const client = {
		setRating: async (id, rating) => {
			calls.push([id, rating]);
		},
	};
	const index = new RatingsIndex(client, () => current);
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

test("learns userRating and sets or clears stars", async (t) => {
	const { index, calls } = setup(t);
	const a = song("a", 3);
	const b = song("b");
	assert.equal(index.rating(a), 3);
	assert.equal(index.rating(b), 0);
	index.learnSongs([a, b]);
	assert.equal(index.ratingById("a"), 3);
	assert.equal(index.ratingById("b"), 0);

	const listenerCalls = [];
	index.subscribe(() => listenerCalls.push("changed"));
	assert.equal(await index.toggleRating(b, 4), 4);
	assert.deepEqual(calls, [["b", 4]]);
	assert.equal(index.ratingById("b"), 4);
	assert.equal(b.userRating, 4);
	assert.equal(listenerCalls.length, 1);

	assert.equal(await index.toggleRating(b, 4), 0);
	assert.deepEqual(calls, [["b", 4], ["b", 0]]);
	assert.equal(index.ratingById("b"), 0);
	assert.equal(b.userRating, undefined);
	assert.equal(listenerCalls.length, 2);
});

test("explicit ratings win over stale userRating fields", async (t) => {
	const { index, calls } = setup(t);
	const a = song("a");
	await index.toggleRating(a, 2);
	assert.equal(index.rating({ ...a, userRating: 5 }), 2);
	await index.toggleRating(a, 2);
	assert.equal(index.rating({ ...a, userRating: 5 }), 0);
	assert.deepEqual(calls, [["a", 2], ["a", 0]]);
});

test("failed rating writes keep the previous state and do not notify", async (t) => {
	const { index, client } = setup(t);
	const a = song("a");
	const listenerCalls = [];
	index.subscribe(() => listenerCalls.push("changed"));
	client.setRating = async () => {
		throw new Error("offline");
	};
	await assert.rejects(index.toggleRating(a, 5), /offline/);
	assert.equal(index.ratingById("a"), 0);
	assert.equal(a.userRating, undefined);
	assert.equal(listenerCalls.length, 0);
});

test("connection changes clear the session ratings", (t) => {
	const { index, setConnection } = setup(t);
	index.learn(song("a", 5));
	assert.equal(index.ratingById("a"), 5);
	setConnection("two");
	index.syncConnection();
	assert.equal(index.ratingById("a"), 0);
});

test("radio entries are not sent to the server", async (t) => {
	const { index, calls } = setup(t);
	const radio = { id: "radio", title: "Radio", streamUrl: "https://radio.invalid" };
	assert.equal(await index.toggleRating(radio, 4), 0);
	assert.deepEqual(calls, []);
});

test("unsubscribing stops notifications", async (t) => {
	const { index } = setup(t);
	let count = 0;
	const unsubscribe = index.subscribe(() => count++);
	await index.toggleRating(song("a"), 3);
	assert.equal(count, 1);
	unsubscribe();
	await index.toggleRating(song("b"), 3);
	assert.equal(count, 1);
});
