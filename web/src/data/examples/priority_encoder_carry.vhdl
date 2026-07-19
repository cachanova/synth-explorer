library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity priority_encoder_carry is
  generic (
    WIDTH       : positive := 32;
    INDEX_WIDTH : positive := index_width(WIDTH)
  );
  port (
    requests : in  std_logic_vector(WIDTH - 1 downto 0);
    one_hot  : out std_logic_vector(WIDTH - 1 downto 0);
    index    : out std_logic_vector(INDEX_WIDTH - 1 downto 0);
    valid    : out std_logic
  );
end entity;

architecture rtl of priority_encoder_carry is
begin
  process (all)
    variable request_value : unsigned(WIDTH - 1 downto 0);
    variable isolated      : unsigned(WIDTH - 1 downto 0);
    variable index_value   : unsigned(INDEX_WIDTH - 1 downto 0);
  begin
    request_value := unsigned(requests);
    isolated := request_value and
      ((not request_value) + to_unsigned(1, WIDTH));
    index_value := (others => '0');

    for i in 0 to WIDTH - 1 loop
      if isolated(i) = '1' then
        index_value := to_unsigned(i, INDEX_WIDTH);
      end if;
    end loop;

    one_hot <= std_logic_vector(isolated);
    index <= std_logic_vector(index_value);
    if request_value = 0 then
      valid <= '0';
    else
      valid <= '1';
    end if;
  end process;
end architecture;
