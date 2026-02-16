import type { StreamBlock, StreamEvent } from "./types.js";

function parseEventPayload(payload: string): StreamEvent | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as StreamEvent;
  } catch {
    return null;
  }
}

/** Parse SSE `data:` lines from a ReadableStream, yielding parsed StreamEvent objects. Handles multi-line payloads, `[DONE]` marker, and abort signal. */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let bufferedText = "";
  let dataLines: string[] = [];

  const flushEvent = (): StreamEvent | null | "done" => {
    if (dataLines.length === 0) {
      return null;
    }

    const payload = dataLines.join("\n");
    dataLines = [];

    if (payload.trim() === "[DONE]") {
      return "done";
    }

    return parseEventPayload(payload);
  };

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      bufferedText += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = bufferedText.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const rawLine = bufferedText.slice(0, newlineIndex);
        bufferedText = bufferedText.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const parsed = flushEvent();
          if (parsed === "done") {
            return;
          }
          if (parsed) {
            yield parsed;
          }
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    bufferedText += decoder.decode();
    const tail = bufferedText.trim();
    if (tail.startsWith("data:")) {
      dataLines.push(tail.slice(5).trimStart());
    }

    const parsed = flushEvent();
    if (parsed && parsed !== "done") {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Merge a markdown block's chunks, respecting chunk_starting_offset for splice. */
export function mergeMarkdownBlock(
  existing: { answer?: string; chunks?: string[]; chunk_starting_offset?: number },
  incoming: { answer?: string; chunks?: string[]; chunk_starting_offset?: number },
): { answer?: string; chunks?: string[]; chunk_starting_offset?: number } {
  const currentChunks = existing.chunks ?? [];
  let mergedChunks = currentChunks;

  if (incoming.chunks) {
    if (typeof incoming.chunk_starting_offset === "number") {
      if (incoming.chunk_starting_offset <= 0) {
        mergedChunks = [...incoming.chunks];
      } else {
        mergedChunks = [
          ...currentChunks.slice(0, incoming.chunk_starting_offset),
          ...incoming.chunks,
        ];
      }
    } else {
      mergedChunks = [...incoming.chunks];
    }
  }

  const mergedAnswer =
    incoming.answer ??
    (mergedChunks.length > 0 ? mergedChunks.join("") : undefined) ??
    existing.answer;

  return {
    ...existing,
    ...incoming,
    answer: mergedAnswer,
    chunks: mergedChunks,
  };
}

function mergeSingleBlock(existing: StreamBlock, incoming: StreamBlock): StreamBlock {
  const merged: StreamBlock = {
    ...existing,
    ...incoming,
  };

  if (existing.markdown_block || incoming.markdown_block) {
    merged.markdown_block = mergeMarkdownBlock(
      existing.markdown_block ?? {},
      incoming.markdown_block ?? {},
    );
  }

  if (existing.web_result_block || incoming.web_result_block) {
    merged.web_result_block = {
      web_results:
        incoming.web_result_block?.web_results ?? existing.web_result_block?.web_results ?? [],
    };
  }

  return merged;
}

/** Merge block arrays keyed by intended_usage. */
export function mergeBlocks(
  existing: StreamBlock[],
  incoming: StreamBlock[],
): StreamBlock[] {
  const result = existing.map((block) => ({ ...block }));

  for (const incomingBlock of incoming) {
    if (!incomingBlock.intended_usage) {
      result.push({ ...incomingBlock });
      continue;
    }

    const index = result.findIndex(
      (existingBlock) => existingBlock.intended_usage === incomingBlock.intended_usage,
    );

    if (index < 0) {
      result.push({ ...incomingBlock });
      continue;
    }

    result[index] = mergeSingleBlock(result[index], incomingBlock);
  }

  return result;
}

/** Merge two StreamEvents into a single accumulated snapshot. Sources are accumulated, never replaced. */
export function mergeEvent(
  existing: StreamEvent,
  incoming: StreamEvent,
): StreamEvent {
  const merged: StreamEvent = {
    ...existing,
    ...incoming,
  };

  if (existing.blocks || incoming.blocks) {
    merged.blocks = mergeBlocks(existing.blocks ?? [], incoming.blocks ?? []);
  }

  const existingSources = existing.sources_list ?? [];
  const incomingSources = incoming.sources_list ?? [];

  if (existingSources.length > 0 || incomingSources.length > 0) {
    merged.sources_list = [...existingSources, ...incomingSources];
  }

  return merged;
}
