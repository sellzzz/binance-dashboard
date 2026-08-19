import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createJsonStore({ file, fallback, limit = null }) {
  let value;
  let writeQueue = Promise.resolve();

  async function load() {
    if (value !== undefined) return value;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      value = structuredClone(fallback);
    }
    if (limit && Array.isArray(value)) value = value.slice(0, limit);
    return value;
  }

  async function save(next) {
    value = next;
    const snapshot = JSON.stringify(value, null, 2);
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, snapshot, "utf8");
    });
    await writeQueue;
    return value;
  }

  return { load, save };
}
