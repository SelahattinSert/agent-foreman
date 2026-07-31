import {mkdir, open, readFile} from 'node:fs/promises';
import path from 'node:path';

import {WorkflowEventRecordSchema, type WorkflowEventRecord} from '@agent-foreman/contracts';
import {PersistenceError} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';

export class JsonlAuditLog {
  public constructor(private readonly filePath: string) {}

  public async append(rawEvent: WorkflowEventRecord): Promise<void> {
    const event = WorkflowEventRecordSchema.parse(redactValue(rawEvent));
    await mkdir(path.dirname(this.filePath), {recursive: true, mode: 0o700});
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async eventIds(): Promise<ReadonlySet<string>> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
    const lines = contents.split('\n');
    const ids = new Set<string>();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      try {
        ids.add(WorkflowEventRecordSchema.parse(JSON.parse(line) as unknown).id);
      } catch (cause: unknown) {
        const incompleteFinalLine = index === lines.length - 1 && !contents.endsWith('\n');
        if (incompleteFinalLine) continue;
        throw new PersistenceError('Audit JSONL contains a malformed record.', {
          cause,
          diagnostics: {filePath: this.filePath, line: index + 1},
        });
      }
    }
    return ids;
  }
}
