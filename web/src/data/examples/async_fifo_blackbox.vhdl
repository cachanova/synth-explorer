library ieee;
use ieee.std_logic_1164.all;

entity async_fifo_ip is
  generic (
    DATA_WIDTH : positive := 16;
    DEPTH      : positive := 16;
    ADDR_WIDTH : positive := 4
  );
  port (
    write_clk  : in  std_logic;
    write_rst  : in  std_logic;
    write_en   : in  std_logic;
    write_data : in  std_logic_vector(DATA_WIDTH - 1 downto 0);
    full       : out std_logic;
    read_clk   : in  std_logic;
    read_rst   : in  std_logic;
    read_en    : in  std_logic;
    read_data  : out std_logic_vector(DATA_WIDTH - 1 downto 0);
    empty      : out std_logic
  );
end entity;

architecture blackbox of async_fifo_ip is
  attribute syn_black_box : boolean;
  attribute syn_black_box of blackbox : architecture is true;
begin
end architecture;

library ieee;
use ieee.std_logic_1164.all;
use work.example_math_pkg.all;

entity async_fifo_wrapper is
  generic (
    DATA_WIDTH : positive := 16;
    DEPTH      : positive := 16;
    ADDR_WIDTH : positive := index_width(DEPTH)
  );
  port (
    write_clk   : in  std_logic;
    write_rst   : in  std_logic;
    write_valid : in  std_logic;
    write_ready : out std_logic;
    write_data  : in  std_logic_vector(DATA_WIDTH - 1 downto 0);
    read_clk    : in  std_logic;
    read_rst    : in  std_logic;
    read_valid  : out std_logic;
    read_ready  : in  std_logic;
    read_data   : out std_logic_vector(DATA_WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of async_fifo_wrapper is
  signal full  : std_logic;
  signal empty : std_logic;
begin
  fifo_ip : entity work.async_fifo_ip(blackbox)
    generic map (
      DATA_WIDTH => DATA_WIDTH,
      DEPTH      => DEPTH,
      ADDR_WIDTH => ADDR_WIDTH
    )
    port map (
      write_clk  => write_clk,
      write_rst  => write_rst,
      write_en   => write_valid and write_ready,
      write_data => write_data,
      full       => full,
      read_clk   => read_clk,
      read_rst   => read_rst,
      read_en    => read_valid and read_ready,
      read_data  => read_data,
      empty      => empty
    );

  write_ready <= not full;
  read_valid <= not empty;
end architecture;
