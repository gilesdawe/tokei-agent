#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { main } from "../dist/index.js";

main(process.argv.slice(2), {
  env: process.env,
  fetchImpl: fetch,
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  readFile: (path) => readFileSync(path, "utf8"),
  // Lazy: readline only attaches to stdin if the command iterates (mcp).
  stdin: {
    [Symbol.asyncIterator]: () =>
      createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator](),
  },
})
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: { type: "internal_error", message: String(err) } }) + "\n",
    );
    process.exit(1);
  });
