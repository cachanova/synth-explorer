// B1 two-module pipeline prototype:
//   VHDL --(ghdl-synth.wasm)--> Verilog netlist with location comments
//        --(line_directives rewrite)--> Verilog with `line directives
//        --(project yosys.wasm, WASI)--> source-netlist.json + netlist.json
// then reports how much VHDL provenance survives on cells.
//
// Usage: node b1_pipeline.mjs <ghdl-synth.wasm> <ghdl libdir> <top> <file.vhdl>
// Produces the app's two netlists: the proc-only source netlist and a
// `synth -flatten` gates netlist, mirroring yosysScript.ts's gates mode.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { rewriteSrcComments } from './line_directives.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const YOSYS_WASM = join(REPO, 'web', 'public', 'yosys', 'yosys.wasm');
const SHARE_TGZ = join(REPO, 'web', 'public', 'yosys', 'share.tar.gz');

const [,, ghdlWasm, ghdlLib, topName, vhdlFile] = process.argv;
if (!vhdlFile) {
  console.error('usage: b1_pipeline.mjs <ghdl-synth.wasm> <libdir> <top> <file.vhdl>');
  process.exit(2);
}

// --- Stage 1: GHDL wasm synthesis (fresh subprocess, like a worker run) ---
const rawVerilog = execFileSync(process.execPath, [
  join(HERE, 'ghdl_synth_test.mjs'), ghdlWasm, ghdlLib, topName, vhdlFile,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// --- Stage 2: rewrite location comments into `line directives ---
const { verilog, rewritten } = rewriteSrcComments(rawVerilog);
console.error(`stage2: rewrote ${rewritten} location comments into \`line directives`);

// --- Stage 3: project yosys.wasm under WASI ---
const work = mkdtempSync(join(tmpdir(), 'b1-yosys-'));
try {
  mkdirSync(join(work, 'share'), { recursive: true });
  mkdirSync(join(work, 'tmp', 'yosys-abc-000000'), { recursive: true });
  execFileSync('tar', ['-xzf', SHARE_TGZ, '-C', join(work, 'share')]);
  const vName = `${topName}_from_vhdl.v`;
  writeFileSync(join(work, vName), verilog);
  // Mirror web/src/lib/yosysScript.ts's gates-mode script shape.
  writeFileSync(join(work, 'script.ys'),
    `read_verilog ${vName}\n` +
    'hierarchy -auto-top\nproc\nwrite_json source-netlist.json\ndesign -reset\n' +
    `read_verilog ${vName}\n` +
    'synth -flatten\n' +
    'write_json netlist.json\n');

  // Child process: the wasm module closes stdio on exit, which would
  // otherwise eat this process' own report output.
  execFileSync(process.execPath, ['--no-warnings', join(HERE, 'yosys_wasi_run.mjs'), YOSYS_WASM, work]);
  const exit = Number(readFileSync(join(work, 'exit-code'), 'utf8'));
  if (exit !== 0) {
    console.error(`yosys exited ${exit}`);
    console.error(readFileSync(join(work, 'log.txt'), 'utf8').slice(-4000));
    process.exit(1);
  }

  // --- Stage 4: provenance report ---
  for (const which of ['source-netlist.json', 'netlist.json']) {
    const nl = JSON.parse(readFileSync(join(work, which), 'utf8'));
    const mods = Object.entries(nl.modules ?? {});
    let cells = 0, withSrc = 0, vhdlSrc = 0;
    const byLine = new Map();
    const samples = [];
    for (const [, mod] of mods) {
      for (const [cname, cell] of Object.entries(mod.cells ?? {})) {
        cells += 1;
        const src = cell.attributes?.src;
        if (!src) continue;
        withSrc += 1;
        const frags = String(src).split('|').filter((f) => f.includes('.vhdl:'));
        if (frags.length) {
          vhdlSrc += 1;
          for (const f of frags) {
            const key = f.split('.')[0] === '' ? f : f.replace(/(:\d+)\.\d+.*$/, '$1');
            byLine.set(key, (byLine.get(key) ?? 0) + 1);
          }
          if (samples.length < 8) samples.push(`${cell.type} ${cname.slice(0, 40)} <- ${src}`);
        }
      }
    }
    console.log(`\n== ${which}: ${cells} cells, ${withSrc} with src, ${vhdlSrc} with VHDL src (${cells ? Math.round((100 * vhdlSrc) / cells) : 0}%)`);
    const lines = [...byLine.entries()].sort();
    console.log(`   VHDL lines referenced: ${lines.map(([k, n]) => `${k}(x${n})`).join(' ')}`);
    for (const s of samples) console.log(`   ${s}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
