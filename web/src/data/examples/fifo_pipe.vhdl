library ieee;
use ieee.std_logic_1164.all;

entity fifo_pipe is
  generic (
    WIDTH  : positive := 16;
    STAGES : natural := 3
  );
  port (
    clk          : in  std_logic;
    rst          : in  std_logic;
    input_valid  : in  std_logic;
    input_ready  : out std_logic;
    input_data   : in  std_logic_vector(WIDTH - 1 downto 0);
    output_valid : out std_logic;
    output_ready : in  std_logic;
    output_data  : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of fifo_pipe is
begin
  no_stages : if STAGES = 0 generate
    input_ready <= output_ready;
    output_valid <= input_valid;
    output_data <= input_data;
  end generate;

  with_stages : if STAGES > 0 generate
    type data_array is array (natural range <>) of
      std_logic_vector(WIDTH - 1 downto 0);
    signal valid : std_logic_vector(STAGES - 1 downto 0);
    signal data  : data_array(0 to STAGES - 1);
    signal ready : std_logic_vector(STAGES downto 0);
  begin
    ready(STAGES) <= output_ready;

    stage_ready : for i in 0 to STAGES - 1 generate
      ready(i) <= (not valid(i)) or ready(i + 1);
    end generate;

    process (clk)
    begin
      if rising_edge(clk) then
        if rst = '1' then
          valid <= (others => '0');
        else
          for i in 0 to STAGES - 1 loop
            if ready(i) = '1' then
              if i = 0 then
                valid(i) <= input_valid;
                if input_valid = '1' then
                  data(i) <= input_data;
                end if;
              else
                valid(i) <= valid(i - 1);
                if valid(i - 1) = '1' then
                  data(i) <= data(i - 1);
                end if;
              end if;
            end if;
          end loop;
        end if;
      end if;
    end process;

    input_ready <= ready(0);
    output_valid <= valid(STAGES - 1);
    output_data <= data(STAGES - 1);
  end generate;
end architecture;
