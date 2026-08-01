import {defineConfig} from 'tsdown';

export default defineConfig({
  cwd: process.cwd(),
  outExtensions: () => ({js: '.js', dts: '.d.ts'}),
});
