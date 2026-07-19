--  Minimal exported entry points to drive GHDL's synthesis kernel from a
--  WebAssembly host, bypassing the native command-line driver.
with Types; use Types;

package Synth_Api is
   --  Initialize VHDL-2008 analysis, load the bundled standard libraries,
   --  and configure diagnostics. 0 = success.
   function Synth_Init return Integer;

   --  Analyze FILE into the work library. The caller must provide files in
   --  dependency order (packages before units that use them).
   --  0 = success; negative values identify an analysis failure.
   function Analyze_File
     (File : Thin_String_Ptr; Len : Natural) return Integer;

   --  Configure, elaborate, and synthesize entity NAME (lowercase), then
   --  write a Verilog netlist through the host's stdio imports.
   --  0 = success; negative values identify the failing stage.
   function Synth_Top (Name : Thin_String_Ptr; Len : Natural) return Integer;
end Synth_Api;
