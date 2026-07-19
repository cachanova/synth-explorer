library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.example_math_pkg.all;

entity handshake_controller is
  generic (
    TIMEOUT_CYCLES : positive := 16;
    COUNT_WIDTH    : positive := index_width(TIMEOUT_CYCLES)
  );
  port (
    clk            : in  std_logic;
    rst            : in  std_logic;
    start          : in  std_logic;
    request_valid  : out std_logic;
    request_ready  : in  std_logic;
    response_valid : in  std_logic;
    response_ready : out std_logic;
    busy           : out std_logic;
    done           : out std_logic;
    timed_out      : out std_logic
  );
end entity;

architecture rtl of handshake_controller is
  type state_type is (idle, send_request, wait_response);
  signal state       : state_type := idle;
  signal next_state  : state_type;
  signal wait_count  : unsigned(COUNT_WIDTH - 1 downto 0) := (others => '0');
  signal timeout     : std_logic;
begin
  timeout <= '1' when wait_count = to_unsigned(TIMEOUT_CYCLES - 1, COUNT_WIDTH)
    else '0';

  process (all)
  begin
    next_state <= state;
    request_valid <= '0';
    response_ready <= '0';
    busy <= '1';
    done <= '0';
    timed_out <= '0';

    case state is
      when idle =>
        busy <= '0';
        if start = '1' then
          next_state <= send_request;
        end if;
      when send_request =>
        request_valid <= '1';
        if request_ready = '1' then
          next_state <= wait_response;
        end if;
      when wait_response =>
        response_ready <= '1';
        if response_valid = '1' then
          done <= '1';
          next_state <= idle;
        elsif timeout = '1' then
          timed_out <= '1';
          next_state <= idle;
        end if;
    end case;
  end process;

  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        state <= idle;
        wait_count <= (others => '0');
      else
        state <= next_state;
        if state /= wait_response or response_valid = '1' or timeout = '1' then
          wait_count <= (others => '0');
        else
          wait_count <= wait_count + 1;
        end if;
      end if;
    end if;
  end process;
end architecture;
