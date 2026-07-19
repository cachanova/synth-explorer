library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.counter_pkg.all;

entity counter is
  generic (
    WIDTH : positive := 8
  );
  port (
    clk    : in  std_logic;
    reset  : in  std_logic;
    enable : in  std_logic;
    count  : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of counter is
  signal value : unsigned(WIDTH - 1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if reset = '1' then
        value <= (others => '0');
      elsif enable = '1' then
        value <= increment(value);
      end if;
    end if;
  end process;

  count <= std_logic_vector(value);
end architecture;
