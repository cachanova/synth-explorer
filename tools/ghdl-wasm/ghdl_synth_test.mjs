// Synthesis spike driver: node ghdl_synth_test.mjs <ghdl.wasm> <libdir> <top> <vhdl files...>
// Drives libghdl analysis then synth_api__synth_top, capturing the Verilog
// netlist emitted through the stdio imports. Derived from ghdl_compile_test.mjs.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const [,, wasmPath, libDir, topName, ...vhdFiles] = process.argv;
if (!vhdFiles.length) { console.error('usage: ghdl_synth_test.mjs <ghdl.wasm> <libdir> <top> <files...>'); process.exit(2); }

const VLIB = '/ghdl/lib/ghdl';
const VPREFIX = '/ghdl';
const WORKDIR = '/work';

function normalizePath(p) {
  const isAbs = p.startsWith('/');
  const parts = p.split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

class VFS {
  constructor() { this.files=new Map(); this.fds=new Map(); this.nfd=100; }
  addReal(p,r) { this.files.set(normalizePath(p), readFileSync(r)); }
  add(p,c)     { this.files.set(normalizePath(p), Buffer.isBuffer(c)?c:Buffer.from(c,'utf8')); }
  has(p)       { return this.files.has(normalizePath(p)); }
  open(p)      { const np=normalizePath(p); const d=this.files.get(np); if(!d) return -1; const fd=this.nfd++; this.fds.set(fd,{p:np,pos:0,d}); return fd; }
  close(fd)    { this.fds.delete(fd); }
  get(fd)      { return this.fds.get(fd); }
  len(fd)      { const f=this.fds.get(fd); return f?f.d.length:-1; }
  eof(fd)      { const f=this.fds.get(fd); return !f||f.pos>=f.d.length; }
  read(fd,buf,n) { const f=this.fds.get(fd); if(!f) return -1; const av=Math.min(n,f.d.length-f.pos); if(av<=0)return 0; buf.set(f.d.subarray(f.pos,f.pos+av)); f.pos+=av; return av; }
}

const vfs = new VFS();
function loadDir(rd,vd) {
  for (const e of readdirSync(rd)) {
    const rp=join(rd,e), vp=`${vd}/${e}`;
    if (statSync(rp).isDirectory()) loadDir(rp,vp);
    else vfs.addReal(vp,rp);
  }
}
loadDir(libDir, VLIB);

let mem, inst;
const DEC = new TextDecoder('latin1');
const u8 = () => new Uint8Array(mem.buffer);
const dv = () => new DataView(mem.buffer);
function cstr(p) { if (!p) return ''; const m=u8(); let e=p; while(m[e]) e++; return DEC.decode(m.subarray(p,e)); }
function astr_fat(p,bp) { const v=dv(); const first=v.getInt32(bp,true), last=v.getInt32(bp+4,true); return last<first?'':DEC.decode(u8().subarray(p, p+(last-first+1))); }
function wads(dp,bp,s) { const m=u8(); const v=dv(); for(let i=0;i<s.length;i++) m[dp+i]=s.charCodeAt(i); v.setInt32(bp,1,true); v.setInt32(bp+4,s.length,true); }
function bsz(p) { if (!p) return 0; const v=dv(); const base=p-16; const nr=v.getUint32(base+4,true); return (nr&~1)-base-16; }

const outChunks = [];
function emit(buf) { outChunks.push(Buffer.isBuffer(buf)?buf:Buffer.from(buf,'latin1')); }

const env = {
  gnat__directory_operations__get_current_dir: (d,b) => wads(d,b,WORKDIR),
  ada__command_line__command_name: (d,b)=>wads(d,b,'ghdl'),
  ada__command_line__argument_count: ()=>0,
  ada__command_line__argument: (d,b,_)=>wads(d,b,''),
  ada__exceptions__exception_identity:()=>0, ada__exceptions__exception_name:()=>{}, ada__exceptions__exception_information:()=>{},
  strlen: (p)=>{const m=u8();let n=0;while(m[p+n])n++;return n;},
  strcmp: (a,b)=>{const m=u8();for(let i=0;;i++){const d=m[a+i]-m[b+i];if(d)return d;if(!m[a+i])return 0;}},
  realloc: (p,n)=>{if(!p)return inst.exports.malloc(n);if(!n){inst.exports.free(p);return 0;}const o=bsz(p);const np=inst.exports.malloc(n);if(!np)return 0;const m=u8();for(let i=0;i<Math.min(o,n);i++)m[np+i]=m[p+i];inst.exports.free(p);return np;},
  fopen: (pp,_)=>{const fd=vfs.open(cstr(pp));return fd<=0?0:fd;},
  fclose:(fd)=>{vfs.close(fd);return 0;},
  fread: (buf,sz,cnt,fd)=>{const n=vfs.read(fd,u8().subarray(buf,buf+sz*cnt),sz*cnt);return n<0?0:Math.floor(n/sz);},
  fwrite:(buf,sz,cnt,fd)=>{emit(Buffer.from(u8().subarray(buf,buf+sz*cnt)));return cnt;},
  fputs: (sp)=>{const s=cstr(sp)||'';emit(s);return s.length;},
  fgets: (buf,size,fd)=>{const m=u8();let i=0;while(i<size-1){const t=new Uint8Array(1);if(vfs.read(fd,t,1)<=0)break;m[buf+i++]=t[0];if(t[0]===0x0a)break;}if(!i)return 0;m[buf+i]=0;return buf;},
  fflush:()=>0, feof:(fd)=>vfs.eof(fd)?1:0, ftell:(fd)=>{const f=vfs.get(fd);return f?f.pos:-1;},
  getc:(fd)=>{const t=new Uint8Array(1);return vfs.read(fd,t,1)<=0?-1:t[0];},
  putc:(c)=>{emit(Buffer.from([c&0xff]));return c;},
  ungetc:(c,fd)=>{const f=vfs.get(fd);if(f&&f.pos>0)f.pos--;return c;},
  setbuf:()=>{}, isatty:()=>0, fprintf:()=>0, snprintf:()=>0,
  __ghdl_get_stdout:()=>1, __ghdl_get_stderr:()=>2, __ghdl_get_stdin:()=>0,
  putc_unlocked:(c,_fd)=>{emit(Buffer.from([c&0xff]));return c;},
  getc_unlocked:(fd)=>{const t=new Uint8Array(1);return vfs.read(fd,t,1)<=0?-1:t[0];},
  feof_unlocked:(fd)=>vfs.eof(fd)?1:0,
  __ghdl_fprintf_g:(_fd,x)=>{emit(String(x));},
  __ghdl_snprintf_fmtf:(sp,len,_fmt,v)=>{const s=String(v).slice(0,len-1);const m=u8();for(let i=0;i<s.length;i++)m[sp+i]=s.charCodeAt(i);m[sp+s.length]=0;},
  gnat__os_lib__is_regular_file: (p,f)=>vfs.has(astr_fat(p,f))?1:0,
  gnat__os_lib__is_absolute_path:(p,f)=>astr_fat(p,f).startsWith('/')?1:0,
  gnat__os_lib__is_directory:()=>0, gnat__os_lib__is_executable_file:()=>0,
  gnat__os_lib__delete_file:(_a,_b,_c,ok)=>{if(ok)dv().setInt32(ok,0,true);},
  gnat__os_lib__rename_file:(...a)=>{const ok=a[a.length-1];if(ok)dv().setInt32(ok,0,true);},
  gnat__os_lib__file_time_stamp:()=>BigInt(0),
  gnat__os_lib__open_read__2:(path_ptr)=>vfs.open(cstr(path_ptr)),
  gnat__os_lib__close:(fd)=>{vfs.close(fd);},
  gnat__os_lib__create_file__2:()=>-1,
  gnat__os_lib__file_length:(fd)=>vfs.len(fd),
  gnat__os_lib__read:(fd,buf,n)=>{const r=vfs.read(fd,u8().subarray(buf,buf+n),n);return r<0?0:r;},
  gnat__os_lib__write:(fd,buf,n)=>{emit(Buffer.from(u8().subarray(buf,buf+n)));return n;},
  gnat__os_lib__spawn:()=>-1,
  gnat__os_lib__locate_exec_on_path:(d,b)=>wads(d,b,''),
  ada__calendar__clock:()=>0, ada__calendar__time_zones__utc_time_offset:()=>0,
  ada__calendar__Osubtract:()=>0, ada__calendar__split:()=>{},
  ada__characters__handling__to_lower:(c)=>c,
  gnat__sha1__update:()=>{}, gnat__sha1__digest__4:()=>{}, gnat__sha1__digest__5:()=>{},
  gnat__heap_sort_a__sort:()=>{},
  system__img_lli__impl__image_integer:()=>0,
  system__val_lli__impl__value_integer:()=>BigInt(0),
  __gnat_put_exception:()=>{},
  __gnat_put_int:(n)=>{emit(`${n}`);},
  __gnat_put_char:(c)=>{emit(Buffer.from([c&0xff]));},
  __gnat_put_string:(p,l)=>{emit(Buffer.from(u8().subarray(p,p+l)));},
  __gnat_grow:(n)=>n,
  ceil:Math.ceil, floor:Math.floor, round:Math.round, trunc:Math.trunc,
  fmod:(x,y)=>x%y, fmin:Math.min, fmax:Math.max, log10:Math.log10, cbrt:Math.cbrt,
  getenv:()=>0,
  exit:(c)=>{throw Object.assign(new Error(`exit(${c})`),{exitCode:c,isExit:true});},
  time:(p)=>{const t=BigInt(0);if(p)dv().setBigInt64(p,t,true);return t;},
  ctime:()=>0,
  __ghdl_maybe_return_via_longjump:()=>{},
  __ghdl_run_through_longjump:(fn,a)=>{if(fn)try{inst.exports.__indirect_function_table.get(fn)(a);}catch(_){}return 0;},
  __ghdl_ELABORATE:()=>{},
  grt_dynload_open:()=>0, grt_dynload_symbol:()=>0,
  grt_save_backtrace:()=>{}, grt_get_clk_tck:()=>100, grt_get_times:()=>{},
  backtrace_create_state:()=>0, backtrace_pcinfo:()=>0,
  loadVhpiModule:()=>0, loadVpiModule:()=>0,
  Increment_p_vpi_vecval:()=>{}, vpi_get_value_vec_helper:()=>{},
  fstWriterCreate:()=>0, fstWriterClose:()=>{}, fstWriterSetFileType:()=>{},
  fstWriterSetPackType:()=>{}, fstWriterSetTimescale:()=>{}, fstWriterSetVersion:()=>{},
  fstWriterSetRepackOnClose:()=>{}, fstWriterSetParallelMode:()=>{},
  fstWriterCreateVar2:()=>0,
  fstWriterSetSourceStem:()=>{}, fstWriterSetSourceInstantiationStem:()=>{},
  fstWriterSetScope:()=>{}, fstWriterSetUpscope:()=>{},
  fstWriterEmitValueChange:()=>{}, fstWriterEmitVariableLengthValueChange:()=>{}, fstWriterEmitTimeChange:()=>{},
  gzopen:()=>0, gzwrite:()=>0, gzputc:()=>0, gzclose:()=>{},
  __multi3:(rp,al,ah,bl,bh)=>{
    const a = (BigInt.asUintN(64, ah) << 64n) | BigInt.asUintN(64, al);
    const b = (BigInt.asUintN(64, bh) << 64n) | BigInt.asUintN(64, bl);
    const r = BigInt.asUintN(128, a * b);
    const v = dv();
    v.setBigUint64(rp,   r & ((1n << 64n) - 1n), true);
    v.setBigUint64(rp+8, r >> 64n, true);
  },
};

const bytes = readFileSync(wasmPath);
const missing = [];
const { instance } = await WebAssembly.instantiate(bytes, {
  env: new Proxy(env, {
    get(t, k) {
      if (k in t) return t[k];
      missing.push(k);
      return () => 0;
    },
  }),
});
inst = instance; mem = inst.exports.memory;
if (missing.length) console.error('note: auto-stubbed imports:', missing.join(' '));
mem.grow(1024 - Math.ceil(mem.buffer.byteLength/65536));
try { inst.exports.__wasm_call_ctors(); } catch(_) {}
const E = inst.exports;

function pushAstr(s) {
  const b = Buffer.from(s, 'latin1');
  const dp = E.malloc(b.length + 1);
  u8().set(b, dp); u8()[dp + b.length] = 0;
  return [dp, b.length];
}

if (E.ghdlwasm_init) E.ghdlwasm_init(); else console.error("warn: no ghdlwasm_init export");
const initRc = E.synth_api__synth_init();
if (initRc !== 0) {
  console.error(`FAIL: synth_init rc=${initRc}`);
  process.exit(1);
}

for (const f of vhdFiles) {
  vfs.add(basename(f), readFileSync(f));
  const [fp, len] = pushAstr(basename(f));
  let rc = 0, err = null;
  try { rc = E.synth_api__analyze_file(fp, len); }
  catch(e) { err = e.isExit?`EXIT(${e.exitCode})`:e.message; }
  E.free(fp);
  const diag = Buffer.concat(outChunks).toString('latin1');
  if (err || rc !== 0) {
    console.error(`FAIL: analyze ${f}: ${err || `rc=${rc}`}\n${diag}`);
    process.exit(1);
  }
}
outChunks.length = 0;

const [tp, tlen] = pushAstr(topName.toLowerCase());
let rc, cerr;
try { rc = E.synth_api__synth_top(tp, tlen); }
catch(e) { cerr = e.isExit?`EXIT(${e.exitCode})`:(e.stack||e.message); }
E.free(tp);
const output = Buffer.concat(outChunks).toString('latin1');
if (cerr !== undefined || rc !== 0) {
  console.error(`FAIL: synth_top rc=${rc} err=${cerr ?? 'none'}`);
  console.error(output);
  process.exit(1);
}
console.log(output);
console.error(`OK: synth ${topName} -> ${output.length} bytes of Verilog`);
