pragma Suppress (All_Checks);

with Errorout;
with Errorout.Console;
with Flags;
with Name_Table;
with Vhdl.Canon;
with Vhdl.Nodes; use Vhdl.Nodes;
with Vhdl.Configuration;
with Vhdl.Utils;
with Vhdl.Std_Package;
with Elab.Vhdl_Insts;
with Elab.Vhdl_Context; use Elab.Vhdl_Context;
with Synth.Flags; use Synth.Flags;
with Synth.Context; use Synth.Context;
with Synthesis;
with Netlists; use Netlists;
with Netlists.Rename;
with Netlists.Disp_Verilog;
with Outputs;

package body Synth_Api is
   procedure Synth_Init is
   begin
      --  Route diagnostics to the host's stderr imports instead of the
      --  default null handler (which traps on the first reported error).
      Errorout.Console.Install_Handler;
      Flags.Flag_Elaborate := True;
      Flags.Flag_Elaborate_With_Outdated := False;
      Flags.Flag_Only_Elab_Warnings := False;
      --  Synthesis does its own canonicalization of concurrent statements.
      Vhdl.Canon.Canon_Flag_Concurrent_Stmts := False;
      Vhdl.Canon.Canon_Flag_Add_Suspend_State := False;
   end Synth_Init;

   function Synth_Top (Name : Thin_String_Ptr; Len : Natural) return Integer
   is
      use Errorout;
      Prim_Id : Name_Id;
      Config : Iir;
      Inst : Synth_Instance_Acc;
      Res : Base_Instance_Acc;
   begin
      Nbr_Errors := 0;
      Prim_Id := Name_Table.Get_Identifier (Name (1 .. Len));

      Config := Vhdl.Configuration.Configure
        (Null_Identifier, Prim_Id, Null_Identifier);
      if Config = Null_Iir or else Nbr_Errors > 0 then
         return -1;
      end if;
      Vhdl.Configuration.Add_Verification_Units;

      declare
         Top : Iir;
      begin
         Top := Vhdl.Utils.Get_Entity_From_Configuration (Config);
         Vhdl.Configuration.Apply_Generic_Override (Top);
         Vhdl.Configuration.Check_Entity_Declaration_Top (Top, False);
         if Nbr_Errors > 0 then
            return -2;
         end if;
      end;

      Inst := Elab.Vhdl_Insts.Elab_Top_Unit (Get_Library_Unit (Config));
      if Nbr_Errors > 0 then
         return -3;
      end if;

      Res := Synthesis.Synth_Design (Config, Inst, Name_Asis);
      if Res = null or else Nbr_Errors > 0 then
         return -4;
      end if;

      if not Outputs.Open_File (null) then
         return -5;
      end if;
      Netlists.Rename.Rename_Module
        (Res.Builder, Res.Top_Module, Language_Verilog);
      Netlists.Disp_Verilog.Disp_Verilog (Res.Top_Module);
      Outputs.Close;

      --  De-elaborate all packages so a later run can re-use them.
      for I in Vhdl.Configuration.Design_Units.First
        .. Vhdl.Configuration.Design_Units.Last
      loop
         Set_Elab_Flag (Vhdl.Configuration.Design_Units.Table (I), False);
      end loop;
      Set_Elab_Flag (Vhdl.Std_Package.Std_Standard_Unit, False);
      return 0;
   end Synth_Top;
end Synth_Api;
