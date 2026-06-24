import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { describe, test } from "../test-helpers.js";
import { mergeEvent, mergeMarkdownBlock, readSseEvents } from "../../src/search/stream.js";
import type { StreamEvent } from "../../src/search/types.js";

function streamFromString(input: string, chunkSize = 8): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(input);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index += chunkSize) {
        controller.enqueue(encoded.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of readSseEvents(stream)) {
    events.push(event);
  }
  return events;
}

describe("SSE stream parsing", () => {
  test("parses multiline data payloads and stops at [DONE]", async () => {
    const fixture = await readFile("test/fixtures/sse-basic.txt", "utf8");
    const events = await collectEvents(streamFromString(fixture, 5));

    assert.equal(events.length, 2);
    assert.equal(events[0]?.status, "IN_PROGRESS");
    assert.equal(events[0]?.text, "partial");
    assert.equal(events[1]?.status, "COMPLETED");
    assert.equal(events[1]?.final, true);
  });

  test("throws on invalid JSON payloads", async () => {
    const payload = [
      "data: {invalid-json}",
      "",
      'data: {"status":"COMPLETED","text":"ok"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    await assert.rejects(collectEvents(streamFromString(payload)), SyntaxError);
  });
});

describe("event merging", () => {
  test("mergeMarkdownBlock splices chunks at chunk_starting_offset", () => {
    const merged = mergeMarkdownBlock(
      {
        chunks: ["Hello ", "wor"],
        chunk_starting_offset: 0,
      },
      {
        chunks: ["world"],
        chunk_starting_offset: 1,
      },
    );

    assert.deepEqual(merged.chunks, ["Hello ", "world"]);
    assert.equal(merged.answer, "Hello world");
  });

  test("mergeEvent preserves and accumulates sources_list", () => {
    const first = mergeEvent(
      { sources_list: [{ title: "A", url: "https://a.example" }] },
      { text: "step 1" },
    );

    assert.deepEqual(first.sources_list, [{ title: "A", url: "https://a.example" }]);

    const second = mergeEvent(first, {
      sources_list: [{ title: "B", url: "https://b.example" }],
      status: "COMPLETED",
    });

    assert.deepEqual(second.sources_list, [
      { title: "A", url: "https://a.example" },
      { title: "B", url: "https://b.example" },
    ]);
  });

  test("incremental fixture merges markdown and metadata", async () => {
    const fixture = await readFile("test/fixtures/sse-incremental.txt", "utf8");
    let snapshot: StreamEvent = {};

    for await (const event of readSseEvents(streamFromString(fixture, 11))) {
      snapshot = mergeEvent(snapshot, event);
    }

    const markdown = snapshot.blocks?.find((block) => block.intended_usage === "markdown_block")
      ?.markdown_block;

    assert.deepEqual(markdown?.chunks, ["Hello ", "world"]);
    assert.equal(markdown?.answer, "Hello world");
    assert.equal(snapshot.display_model, "pplx_pro_upgraded");
    assert.equal(snapshot.uuid, "req-incremental");
  });
});
