library ieee;
use ieee.std_logic_1164.all;

entity reg_mux is
  generic (
    WIDTH       : positive := 8;
    RESET_VALUE : std_logic_vector(WIDTH - 1 downto 0) := (others => '0')
  );
  port (
    clk : in  std_logic;
    rst : in  std_logic;
    sel : in  std_logic;
    a   : in  std_logic_vector(WIDTH - 1 downto 0);
    b   : in  std_logic_vector(WIDTH - 1 downto 0);
    q   : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of reg_mux is
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        q <= RESET_VALUE;
      elsif sel = '1' then
        q <= b;
      else
        q <= a;
      end if;
    end if;
  end process;
end architecture;
