// Rewrite GHDL --out=verilog source-location comments into Verilog `line
// preprocessor directives:
//
//   /* counter.vhdl:22:16  */     ->   `line 22 "counter.vhdl" 0
//
// Yosys' read_verilog honors `line, so every cell and wire created from the
// following statement gets a native src attribute pointing at the VHDL file
// and line ("counter.vhdl:22.14-22.19"). That is strictly better than
// injecting (* src *) attributes: the Verilog-2005 grammar rejects
// attributes on continuous assigns, while `line covers every construct and
// also names generated cells after the VHDL location.
//
// Columns in the resulting src attribute come from the generated Verilog's
// layout, so the line is exact but the column span is not meaningful.

const LOC_COMMENT = /^(\s*)\/\*\s*([^\s:*][^:*]*):(\d+):(\d+)\s*\*\/\s*$/;

export function rewriteSrcComments(verilog) {
  let rewritten = 0;
  const out = verilog.split('\n').map((line) => {
    const m = LOC_COMMENT.exec(line);
    if (!m) return line;
    rewritten += 1;
    const [, , file, lineNo] = m;
    return `\`line ${lineNo} "${file}" 0`;
  });
  return { verilog: out.join('\n'), rewritten };
}
