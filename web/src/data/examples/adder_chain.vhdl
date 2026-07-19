library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity adder_chain is
  generic (
    WIDTH      : positive := 16;
    NUM_INPUTS : positive := 4;
    SUM_WIDTH  : positive := WIDTH + ceil_log2(NUM_INPUTS)
  );
  port (
    values : in  std_logic_vector(NUM_INPUTS * WIDTH - 1 downto 0);
    sum    : out std_logic_vector(SUM_WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of adder_chain is
  type partial_sum_array is array (natural range <>) of
    unsigned(SUM_WIDTH - 1 downto 0);
  signal partial_sum : partial_sum_array(0 to NUM_INPUTS);
begin
  partial_sum(0) <= (others => '0');

  add_input : for i in 0 to NUM_INPUTS - 1 generate
    partial_sum(i + 1) <= partial_sum(i) + resize(
      unsigned(values((i + 1) * WIDTH - 1 downto i * WIDTH)),
      SUM_WIDTH
    );
  end generate;

  sum <= std_logic_vector(partial_sum(NUM_INPUTS));
end architecture;
