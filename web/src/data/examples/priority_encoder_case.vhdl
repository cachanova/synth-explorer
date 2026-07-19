library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity priority_encoder_case is
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

architecture rtl of priority_encoder_case is
begin
  process (all)
    variable padded   : unsigned(31 downto 0);
    variable isolated : unsigned(31 downto 0);
  begin
    padded := (others => '0');
    padded(WIDTH - 1 downto 0) := unsigned(requests);
    isolated := padded and ((not padded) + to_unsigned(1, 32));
    one_hot <= std_logic_vector(isolated(WIDTH - 1 downto 0));
    index <= (others => '0');
    valid <= '1';

    case isolated is
      when x"00000001" => index <= std_logic_vector(to_unsigned(0, INDEX_WIDTH));
      when x"00000002" => index <= std_logic_vector(to_unsigned(1, INDEX_WIDTH));
      when x"00000004" => index <= std_logic_vector(to_unsigned(2, INDEX_WIDTH));
      when x"00000008" => index <= std_logic_vector(to_unsigned(3, INDEX_WIDTH));
      when x"00000010" => index <= std_logic_vector(to_unsigned(4, INDEX_WIDTH));
      when x"00000020" => index <= std_logic_vector(to_unsigned(5, INDEX_WIDTH));
      when x"00000040" => index <= std_logic_vector(to_unsigned(6, INDEX_WIDTH));
      when x"00000080" => index <= std_logic_vector(to_unsigned(7, INDEX_WIDTH));
      when x"00000100" => index <= std_logic_vector(to_unsigned(8, INDEX_WIDTH));
      when x"00000200" => index <= std_logic_vector(to_unsigned(9, INDEX_WIDTH));
      when x"00000400" => index <= std_logic_vector(to_unsigned(10, INDEX_WIDTH));
      when x"00000800" => index <= std_logic_vector(to_unsigned(11, INDEX_WIDTH));
      when x"00001000" => index <= std_logic_vector(to_unsigned(12, INDEX_WIDTH));
      when x"00002000" => index <= std_logic_vector(to_unsigned(13, INDEX_WIDTH));
      when x"00004000" => index <= std_logic_vector(to_unsigned(14, INDEX_WIDTH));
      when x"00008000" => index <= std_logic_vector(to_unsigned(15, INDEX_WIDTH));
      when x"00010000" => index <= std_logic_vector(to_unsigned(16, INDEX_WIDTH));
      when x"00020000" => index <= std_logic_vector(to_unsigned(17, INDEX_WIDTH));
      when x"00040000" => index <= std_logic_vector(to_unsigned(18, INDEX_WIDTH));
      when x"00080000" => index <= std_logic_vector(to_unsigned(19, INDEX_WIDTH));
      when x"00100000" => index <= std_logic_vector(to_unsigned(20, INDEX_WIDTH));
      when x"00200000" => index <= std_logic_vector(to_unsigned(21, INDEX_WIDTH));
      when x"00400000" => index <= std_logic_vector(to_unsigned(22, INDEX_WIDTH));
      when x"00800000" => index <= std_logic_vector(to_unsigned(23, INDEX_WIDTH));
      when x"01000000" => index <= std_logic_vector(to_unsigned(24, INDEX_WIDTH));
      when x"02000000" => index <= std_logic_vector(to_unsigned(25, INDEX_WIDTH));
      when x"04000000" => index <= std_logic_vector(to_unsigned(26, INDEX_WIDTH));
      when x"08000000" => index <= std_logic_vector(to_unsigned(27, INDEX_WIDTH));
      when x"10000000" => index <= std_logic_vector(to_unsigned(28, INDEX_WIDTH));
      when x"20000000" => index <= std_logic_vector(to_unsigned(29, INDEX_WIDTH));
      when x"40000000" => index <= std_logic_vector(to_unsigned(30, INDEX_WIDTH));
      when x"80000000" => index <= std_logic_vector(to_unsigned(31, INDEX_WIDTH));
      when others => valid <= '0';
    end case;
  end process;
end architecture;
