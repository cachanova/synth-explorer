// Run the project's yosys.wasm under Node's WASI against a prepared work
// directory (script.ys + sources + share/). Runs as a child process because
// the module closes stdio fds on exit, which would eat the parent's output.
// Usage: node yosys_wasi_run.mjs <yosys.wasm> <workdir>
import { WASI } from 'node:wasi';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const [,, yosysWasm, workdir] = process.argv;
const wasi = new WASI({
  version: 'preview1',
  args: ['yosys', '-q', '-T', '-l', '/log.txt', '-s', '/script.ys'],
  env: {},
  preopens: { '/': workdir },
  returnOnExit: true,
});
const module = await WebAssembly.compile(readFileSync(yosysWasm));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const code = wasi.start(instance);
writeFileSync(join(workdir, 'exit-code'), String(code));
