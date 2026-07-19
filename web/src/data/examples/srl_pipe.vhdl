library ieee;
use ieee.std_logic_1164.all;

entity srl_pipe is
  generic (
    WIDTH  : positive := 8;
    STAGES : natural := 16
  );
  port (
    clk       : in  std_logic;
    rst       : in  std_logic;
    en        : in  std_logic;
    valid_in  : in  std_logic;
    data_in   : in  std_logic_vector(WIDTH - 1 downto 0);
    valid_out : out std_logic;
    data_out  : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of srl_pipe is
begin
  no_stages : if STAGES = 0 generate
    data_out <= data_in;
    valid_out <= valid_in;
  end generate;

  with_stages : if STAGES > 0 generate
    type data_array is array (natural range <>) of
      std_logic_vector(WIDTH - 1 downto 0);
    signal shift_data  : data_array(0 to STAGES - 1);
    signal shift_valid : std_logic_vector(STAGES - 1 downto 0);
  begin
    process (clk)
    begin
      if rising_edge(clk) then
        if en = '1' then
          shift_data(0) <= data_in;
          for i in 1 to STAGES - 1 loop
            shift_data(i) <= shift_data(i - 1);
          end loop;
        end if;
      end if;
    end process;

    process (clk)
    begin
      if rising_edge(clk) then
        if rst = '1' then
          shift_valid <= (others => '0');
        elsif en = '1' then
          shift_valid(0) <= valid_in;
          for i in 1 to STAGES - 1 loop
            shift_valid(i) <= shift_valid(i - 1);
          end loop;
        end if;
      end if;
    end process;

    data_out <= shift_data(STAGES - 1);
    valid_out <= shift_valid(STAGES - 1);
  end generate;
end architecture;
