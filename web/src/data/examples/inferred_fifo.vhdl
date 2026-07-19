library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity inferred_fifo is
  generic (
    DATA_WIDTH  : positive := 16;
    DEPTH       : positive := 16;
    ADDR_WIDTH  : positive := index_width(DEPTH);
    COUNT_WIDTH : positive := index_width(DEPTH + 1)
  );
  port (
    clk        : in  std_logic;
    rst        : in  std_logic;
    push_valid : in  std_logic;
    push_ready : out std_logic;
    push_data  : in  std_logic_vector(DATA_WIDTH - 1 downto 0);
    pop_valid  : out std_logic;
    pop_ready  : in  std_logic;
    pop_data   : out std_logic_vector(DATA_WIDTH - 1 downto 0);
    count      : out std_logic_vector(COUNT_WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of inferred_fifo is
  type memory_array is array (0 to DEPTH - 1) of
    std_logic_vector(DATA_WIDTH - 1 downto 0);
  signal memory        : memory_array;
  signal write_pointer : unsigned(ADDR_WIDTH - 1 downto 0) := (others => '0');
  signal read_pointer  : unsigned(ADDR_WIDTH - 1 downto 0) := (others => '0');
  signal count_value   : natural range 0 to DEPTH := 0;
  signal push          : std_logic;
  signal pop           : std_logic;
begin
  push_ready <= '1' when count_value < DEPTH else '0';
  pop_valid <= '1' when count_value > 0 else '0';
  push <= push_valid and push_ready;
  pop <= pop_valid and pop_ready;
  pop_data <= memory(to_integer(read_pointer));
  count <= std_logic_vector(to_unsigned(count_value, COUNT_WIDTH));

  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        write_pointer <= (others => '0');
        read_pointer <= (others => '0');
        count_value <= 0;
      else
        if push = '1' then
          memory(to_integer(write_pointer)) <= push_data;
          if write_pointer = to_unsigned(DEPTH - 1, ADDR_WIDTH) then
            write_pointer <= (others => '0');
          else
            write_pointer <= write_pointer + 1;
          end if;
        end if;

        if pop = '1' then
          if read_pointer = to_unsigned(DEPTH - 1, ADDR_WIDTH) then
            read_pointer <= (others => '0');
          else
            read_pointer <= read_pointer + 1;
          end if;
        end if;

        if push = '1' and pop = '0' then
          count_value <= count_value + 1;
        elsif push = '0' and pop = '1' then
          count_value <= count_value - 1;
        end if;
      end if;
    end if;
  end process;
end architecture;
