#!/usr/bin/env node

import {runCli} from './cli.js';
import {isMainModule} from './entrypoint.js';

const entryPoint = process.argv[1];
if (isMainModule(import.meta.url, entryPoint)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent Foreman: ${message}\n`);
    process.exitCode = 1;
  });
}
