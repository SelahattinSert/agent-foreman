#!/usr/bin/env node

import {pathToFileURL} from 'node:url';

import {runDispatcherEntry} from './dispatcher-entry.js';

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
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
