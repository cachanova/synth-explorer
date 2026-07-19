pragma Suppress (All_Checks);

with Errorout;
with Errorout.Console;
with Flags;
with Libraries;
with Name_Table;
with Options;
with Vhdl.Canon;
with Vhdl.Nodes; use Vhdl.Nodes;
with Vhdl.Configuration;
with Vhdl.Sem_Lib;
with Vhdl.Utils;
with Vhdl.Std_Package;
with Elab.Vhdl_Insts;
with Elab.Vhdl_Context; use Elab.Vhdl_Context;
with Synth.Flags; use Synth.Flags;
with Synth.Context; use Synth.Context;
with Synthesis;
with Netlists; use Netlists;
with Netlists.Errors;
with Netlists.Rename;
with Netlists.Disp_Verilog;
with Outputs;
with Synth.Vhdl_Foreign;

package body Synth_Api is
   function Synth_Init return Integer is
      Ok : Boolean;
   begin
      --  Route diagnostics to the host's stderr imports instead of the
      --  default null handler (which traps on the first reported error).
      Errorout.Console.Install_Handler;
      Options.Initialize;
      Flags.Vhdl_Std := Flags.Vhdl_08;
      Flags.Flag_Elaborate := True;
      Flags.Flag_Elaborate_With_Outdated := False;
      Flags.Flag_Only_Elab_Warnings := False;
      --  Synthesis does its own canonicalization of concurrent statements.
      Vhdl.Canon.Canon_Flag_Concurrent_Stmts := False;
      Vhdl.Canon.Canon_Flag_Add_Suspend_State := False;
      Netlists.Errors.Initialize;
      Synth.Vhdl_Foreign.Initialize;

      Libraries.Add_Library_Path ("/ghdl/lib/ghdl/");
      Ok := Libraries.Load_Std_Library;
      if not Ok then
         return -1;
      end if;
      Libraries.Load_Work_Library (True);
      return 0;
   end Synth_Init;

   function Analyze_File
     (File : Thin_String_Ptr; Len : Natural) return Integer
   is
      Id : Name_Id;
      Design_File : Iir;
      Unit : Iir;
      Next_Unit : Iir;
   begin
      Errorout.Nbr_Errors := 0;
      Id := Name_Table.Get_Identifier (File (1 .. Len));
      Design_File := Vhdl.Sem_Lib.Load_File_Name (Id);
      if Design_File = Null_Iir then
         return -1;
      end if;

      Unit := Get_First_Design_Unit (Design_File);
      while Unit /= Null_Iir loop
         Next_Unit := Get_Chain (Unit);
         Vhdl.Sem_Lib.Finish_Compilation (Unit, False);
         if Errorout.Nbr_Errors = 0 then
            Set_Chain (Unit, Null_Iir);
            Libraries.Add_Design_Unit_Into_Library (Unit);
         end if;
         Unit := Next_Unit;
      end loop;
      if Errorout.Nbr_Errors > 0 then
         return -2;
      end if;
      return 0;
   end Analyze_File;

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
