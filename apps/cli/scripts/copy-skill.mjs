import {cp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(scriptDirectory, '../../../skills/agent-foreman');
const destination = path.resolve(scriptDirectory, '../dist/skills/agent-foreman');

await rm(destination, {recursive: true, force: true});
await mkdir(path.dirname(destination), {recursive: true});
await cp(source, destination, {recursive: true, errorOnExist: true, force: false});
