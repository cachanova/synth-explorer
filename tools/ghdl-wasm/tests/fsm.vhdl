library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity fsm is
  port (
    clk, rst : in std_logic;
    start, done_in : in std_logic;
    busy : out std_logic;
    ticks : out unsigned(7 downto 0)
  );
end entity;

architecture rtl of fsm is
  type state_t is (idle, run, drain);
  signal state : state_t := idle;
  signal cnt : unsigned(7 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        state <= idle;
        cnt <= (others => '0');
      else
        case state is
          when idle =>
            if start = '1' then
              state <= run;
              cnt <= (others => '0');
            end if;
          when run =>
            cnt <= cnt + 1;
            if done_in = '1' then
              state <= drain;
            end if;
          when drain =>
            state <= idle;
        end case;
      end if;
    end if;
  end process;

  busy <= '1' when state /= idle else '0';
  ticks <= cnt;
end architecture;
