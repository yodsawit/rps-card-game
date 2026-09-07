import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type BufferedLogger<T> = ((event: T) => void) & { close(): Promise<void> };

/** Bounded queue, 10 MiB files, five retained rotations. Never blocks play on I/O. */
export function createBufferedLogger<T>(
  path: string,
  reportError: (message: string) => void
): BufferedLogger<T> {
  let queue: string[] = [];
  let queuedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let closed = false;
  let warned = false;
  const report = (message: string): void => {
    if (!warned) reportError(message);
    warned = true;
  };
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    writing = writing.then(async () => {
      if (queue.length === 0) return;
      const content = queue.join("");
      queue = [];
      queuedBytes = 0;
      try {
        await mkdir(dirname(path), { recursive: true });
        const size = await stat(path).then((entry) => entry.size).catch(() => 0);
        if (size + Buffer.byteLength(content) > 10 * 1024 * 1024) {
          await rm(`${path}.5`, { force: true });
          for (let index = 4; index >= 0; index -= 1) {
            await rename(index === 0 ? path : `${path}.${index}`, `${path}.${index + 1}`)
              .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          }
        }
        await appendFile(path, content, "utf8");
        warned = false;
      } catch (error) {
        report(`RPS log batch could not be written: ${error instanceof Error ? error.message : "file error"}`);
      }
    });
  };
  const logger = ((event: T): void => {
    if (closed) return;
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > 4 * 1024 * 1024) {
      report("RPS log queue full; new events were dropped.");
      return;
    }
    queue.push(line);
    queuedBytes += bytes;
    if (!timer) { timer = setTimeout(flush, 100); timer.unref(); }
  }) as BufferedLogger<T>;
  logger.close = async () => { closed = true; flush(); await writing; };
  return logger;
}
