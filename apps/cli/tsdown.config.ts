import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'dispatcher-main': 'src/dispatcher-main.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  outExtensions: () => ({js: '.js', dts: '.d.ts'}),
  deps: {
    alwaysBundle: [/^@agent-foreman\//u, 'smol-toml'],
    neverBundle: ['better-sqlite3'],
  },
});
