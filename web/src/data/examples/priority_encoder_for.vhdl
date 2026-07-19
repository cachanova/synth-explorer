library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity priority_encoder_for is
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

architecture rtl of priority_encoder_for is
begin
  process (all)
    variable one_hot_value : std_logic_vector(WIDTH - 1 downto 0);
    variable index_value   : unsigned(INDEX_WIDTH - 1 downto 0);
    variable found         : boolean;
  begin
    one_hot_value := (others => '0');
    index_value := (others => '0');
    found := false;

    for i in 0 to WIDTH - 1 loop
      if not found and requests(i) = '1' then
        one_hot_value(i) := '1';
        index_value := to_unsigned(i, INDEX_WIDTH);
        found := true;
      end if;
    end loop;

    one_hot <= one_hot_value;
    index <= std_logic_vector(index_value);
    if found then
      valid <= '1';
    else
      valid <= '0';
    end if;
  end process;
end architecture;
