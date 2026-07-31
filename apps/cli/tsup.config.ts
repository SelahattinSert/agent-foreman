import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/dispatcher-main.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  noExternal: [/^@agent-foreman\//u],
  external: ['better-sqlite3'],
});
