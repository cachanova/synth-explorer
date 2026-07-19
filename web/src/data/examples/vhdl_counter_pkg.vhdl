library ieee;
use ieee.numeric_std.all;

package vhdl_counter_pkg is
  function increment(value : unsigned) return unsigned;
end package;

package body vhdl_counter_pkg is
  function increment(value : unsigned) return unsigned is
  begin
    return value + 1;
  end function;
end package body;
