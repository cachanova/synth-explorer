--  wasm32 stub: crash-report box without Ada.Exceptions introspection,
--  which the AdaWebPack runtime does not provide.
with Simple_IO; use Simple_IO;

package body Bug is
   procedure Disp_Bug_Box (Except : Exception_Occurrence)
   is
      pragma Unreferenced (Except);
   begin
      Put_Line_Err ("******************** GHDL Bug occurred ****************");
   end Disp_Bug_Box;

   function Get_Gnat_Version return String is
   begin
      return "unknown (wasm32)";
   end Get_Gnat_Version;
end Bug;
