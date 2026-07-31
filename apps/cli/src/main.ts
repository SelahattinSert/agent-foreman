#!/usr/bin/env node

import {pathToFileURL} from 'node:url';

import {runCli} from './cli.js';

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent Foreman: ${message}\n`);
    process.exitCode = 1;
  });
}
