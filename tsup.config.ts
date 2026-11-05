import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }
const define = { __AR_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs', 'iife'],
    globalName: 'ARTracker',
    target: 'es2020',
    dts: true,
    treeshake: true,
    sourcemap: true,
    minify: true,
    clean: true,
    define,
  },
  {
    entry: { replay: 'src/replay/index.ts' },
    format: ['esm', 'cjs'],
    target: 'es2020',
    dts: true,
    treeshake: true,
    sourcemap: true,
    minify: true,
    external: ['rrweb'],
    define,
  },
])
