import { describe, expect, test } from "bun:test";

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
    const fixture = await Bun.file("test/fixtures/sse-basic.txt").text();
    const events = await collectEvents(streamFromString(fixture, 5));

    expect(events).toHaveLength(2);
    expect(events[0].status).toBe("IN_PROGRESS");
    expect(events[0].text).toBe("partial");
    expect(events[1].status).toBe("COMPLETED");
    expect(events[1].final).toBe(true);
  });

  test("skips invalid JSON payloads and continues parsing", async () => {
    const payload = [
      "data: {invalid-json}",
      "",
      'data: {"status":"COMPLETED","text":"ok"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const events = await collectEvents(streamFromString(payload));
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("ok");
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

    expect(merged.chunks).toEqual(["Hello ", "world"]);
    expect(merged.answer).toBe("Hello world");
  });

  test("mergeEvent preserves and accumulates sources_list", () => {
    const first = mergeEvent(
      { sources_list: [{ title: "A", url: "https://a.example" }] },
      { text: "step 1" },
    );

    expect(first.sources_list).toEqual([{ title: "A", url: "https://a.example" }]);

    const second = mergeEvent(first, {
      sources_list: [{ title: "B", url: "https://b.example" }],
      status: "COMPLETED",
    });

    expect(second.sources_list).toEqual([
      { title: "A", url: "https://a.example" },
      { title: "B", url: "https://b.example" },
    ]);
  });

  test("incremental fixture merges markdown and metadata", async () => {
    const fixture = await Bun.file("test/fixtures/sse-incremental.txt").text();
    let snapshot: StreamEvent = {};

    for await (const event of readSseEvents(streamFromString(fixture, 11))) {
      snapshot = mergeEvent(snapshot, event);
    }

    const markdown = snapshot.blocks?.find((block) => block.intended_usage === "markdown_block")
      ?.markdown_block;

    expect(markdown?.chunks).toEqual(["Hello ", "world"]);
    expect(markdown?.answer).toBe("Hello world");
    expect(snapshot.display_model).toBe("pplx_pro_upgraded");
    expect(snapshot.uuid).toBe("req-incremental");
  });
});
