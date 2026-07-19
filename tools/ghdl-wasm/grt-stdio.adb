package body Grt.Stdio is
   function fputc (C : int; Stream : FILEs) return int is
   begin
      return C_Fputc (C, Stream);
   end fputc;

   procedure fputc (C : int; Stream : FILEs) is
      Result : int;
      pragma Unreferenced (Result);
   begin
      Result := C_Fputc (C, Stream);
   end fputc;

   function fflush (Stream : FILEs) return int is
   begin
      return C_Fflush (Stream);
   end fflush;

   procedure fflush (Stream : FILEs) is
      Result : int;
      pragma Unreferenced (Result);
   begin
      Result := C_Fflush (Stream);
   end fflush;

   function fclose (Stream : FILEs) return int is
   begin
      return C_Fclose (Stream);
   end fclose;

   procedure fclose (Stream : FILEs) is
      Result : int;
      pragma Unreferenced (Result);
   begin
      Result := C_Fclose (Stream);
   end fclose;
end Grt.Stdio;
