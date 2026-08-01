#!/usr/bin/env node

import {runDispatcherEntry} from './dispatcher-entry.js';
import {isMainModule} from './entrypoint.js';

const entryPoint = process.argv[1];
if (isMainModule(import.meta.url, entryPoint)) {
  runDispatcherEntry(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Agent Foreman dispatcher: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
