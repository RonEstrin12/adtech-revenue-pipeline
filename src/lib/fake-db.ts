/** Test helper (not used by production code). A fake pg connection: records every statement, can fail on cue. */
import type { Queryable } from "./db.js";

export interface FakeClient extends Queryable {
  log: { text: string; values?: unknown[] }[];
}

export function fakeClient(opts: { failOn?: RegExp; respond?: (text: string, values?: unknown[]) => any[] } = {}): FakeClient {
  const log: FakeClient["log"] = [];
  return {
    log,
    async query(text, values) {
      log.push({ text, values });
      if (opts.failOn?.test(text)) throw new Error(`boom: ${text.slice(0, 30)}`);
      return { rows: opts.respond?.(text, values) ?? [], rowCount: 0 };
    },
  };
}
