library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity barrel_shifter is
  generic (
    WIDTH       : positive := 32;
    SHIFT_WIDTH : positive := index_width(WIDTH)
  );
  port (
    data_in      : in  std_logic_vector(WIDTH - 1 downto 0);
    shift_amount : in  std_logic_vector(SHIFT_WIDTH - 1 downto 0);
    shift_right  : in  std_logic;
    arithmetic   : in  std_logic;
    data_out     : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of barrel_shifter is
begin
  process (all)
    variable amount : natural;
  begin
    amount := to_integer(unsigned(shift_amount));
    if shift_right = '1' and arithmetic = '1' then
      data_out <= std_logic_vector(ieee.numeric_std.shift_right(signed(data_in), amount));
    elsif shift_right = '1' then
      data_out <= std_logic_vector(ieee.numeric_std.shift_right(unsigned(data_in), amount));
    else
      data_out <= std_logic_vector(shift_left(unsigned(data_in), amount));
    end if;
  end process;
end architecture;
