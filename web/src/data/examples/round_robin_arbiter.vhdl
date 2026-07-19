library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity round_robin_arbiter is
  generic (
    NUM_REQUESTERS : positive := 4;
    INDEX_WIDTH    : positive := index_width(NUM_REQUESTERS)
  );
  port (
    clk         : in  std_logic;
    rst         : in  std_logic;
    requests    : in  std_logic_vector(NUM_REQUESTERS - 1 downto 0);
    accept      : in  std_logic;
    grant       : out std_logic_vector(NUM_REQUESTERS - 1 downto 0);
    grant_index : out std_logic_vector(INDEX_WIDTH - 1 downto 0);
    grant_valid : out std_logic
  );
end entity;

architecture rtl of round_robin_arbiter is
  signal next_index : unsigned(INDEX_WIDTH - 1 downto 0) := (others => '0');
begin
  process (all)
    variable grant_value : std_logic_vector(NUM_REQUESTERS - 1 downto 0);
    variable index_value : unsigned(INDEX_WIDTH - 1 downto 0);
    variable candidate   : natural range 0 to 2 * NUM_REQUESTERS;
    variable found       : boolean;
  begin
    grant_value := (others => '0');
    index_value := (others => '0');
    found := false;

    for offset in 0 to NUM_REQUESTERS - 1 loop
      candidate := to_integer(next_index) + offset;
      if candidate >= NUM_REQUESTERS then
        candidate := candidate - NUM_REQUESTERS;
      end if;
      if not found and requests(candidate) = '1' then
        grant_value(candidate) := '1';
        index_value := to_unsigned(candidate, INDEX_WIDTH);
        found := true;
      end if;
    end loop;

    grant <= grant_value;
    grant_index <= std_logic_vector(index_value);
    if found then
      grant_valid <= '1';
    else
      grant_valid <= '0';
    end if;
  end process;

  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        next_index <= (others => '0');
      elsif accept = '1' and grant_valid = '1' then
        if unsigned(grant_index) = to_unsigned(NUM_REQUESTERS - 1, INDEX_WIDTH) then
          next_index <= (others => '0');
        else
          next_index <= unsigned(grant_index) + 1;
        end if;
      end if;
    end if;
  end process;
end architecture;
