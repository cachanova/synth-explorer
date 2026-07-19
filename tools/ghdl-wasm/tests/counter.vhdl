library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
  generic (WIDTH : natural := 12);
  port (
    clk, rst, en : in std_logic;
    count : out unsigned(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of counter is
  signal r : unsigned(WIDTH - 1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        r <= (others => '0');
      elsif en = '1' then
        r <= r + 1;
      end if;
    end if;
  end process;
  count <= r;
end architecture;
