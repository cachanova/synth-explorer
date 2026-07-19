library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity adder8 is
  port (
    clk : in std_logic;
    a, b : in unsigned(7 downto 0);
    q : out unsigned(7 downto 0)
  );
end entity;

architecture rtl of adder8 is
begin
  process (clk)
  begin
    if rising_edge(clk) then
      q <= a + b;
    end if;
  end process;
end architecture;
