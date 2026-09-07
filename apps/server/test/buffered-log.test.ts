import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedLogger } from "../src/buffered-log.js";

it("flushes queued events in order on shutdown and rejects oversized batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rps-log-test-"));
  const path = join(directory, "events.jsonl");
  const errors: string[] = [];
  const logger = createBufferedLogger<unknown>(path, (error) => errors.push(error));
  try {
    logger({ sequence: 1 });
    logger("x".repeat(4 * 1024 * 1024));
    logger({ sequence: 2 });
    await logger.close();
    logger({ sequence: 3 });
    expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(errors).toEqual(["RPS log queue full; new events were dropped."]);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
