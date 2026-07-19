library ieee;
use ieee.std_logic_1164.all;

entity pipe is
  generic (
    WIDTH       : positive := 16;
    STAGES      : natural := 4;
    RESET_VALUE : std_logic_vector(WIDTH - 1 downto 0) := (others => '0')
  );
  port (
    clk      : in  std_logic;
    rst      : in  std_logic;
    en       : in  std_logic;
    data_in  : in  std_logic_vector(WIDTH - 1 downto 0);
    data_out : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of pipe is
begin
  no_stages : if STAGES = 0 generate
    data_out <= data_in;
  end generate;

  with_stages : if STAGES > 0 generate
    type stage_array is array (natural range <>) of
      std_logic_vector(WIDTH - 1 downto 0);
    signal stage : stage_array(0 to STAGES - 1);
  begin
    process (clk)
    begin
      if rising_edge(clk) then
        if rst = '1' then
          for i in 0 to STAGES - 1 loop
            stage(i) <= RESET_VALUE;
          end loop;
        elsif en = '1' then
          stage(0) <= data_in;
          for i in 1 to STAGES - 1 loop
            stage(i) <= stage(i - 1);
          end loop;
        end if;
      end if;
    end process;

    data_out <= stage(STAGES - 1);
  end generate;
end architecture;
