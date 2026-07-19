--  Minimal exported entry points to drive GHDL's synthesis kernel from a
--  WebAssembly host, bypassing the native command-line driver.
with Types; use Types;

package Synth_Api is
   --  Set analysis/elaboration flags required by synthesis. Must be called
   --  after options__initialize and before the first analyze_file.
   procedure Synth_Init;

   --  Configure, elaborate, and synthesize entity NAME (lowercase), then
   --  write a Verilog netlist through the host's stdio imports.
   --  0 = success; negative values identify the failing stage.
   function Synth_Top (Name : Thin_String_Ptr; Len : Natural) return Integer;
end Synth_Api;
