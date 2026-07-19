library ieee;
use ieee.std_logic_1164.all;
entity sembad is
  port (a : in std_logic; y : out std_logic);
end entity;
architecture rtl of sembad is
begin
  y <= a and undefined_signal;
end architecture;
