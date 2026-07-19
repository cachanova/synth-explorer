package example_math_pkg is
  function ceil_log2(value : positive) return natural;
  function index_width(value : positive) return positive;
end package;

package body example_math_pkg is
  function ceil_log2(value : positive) return natural is
    variable remaining : natural := value - 1;
    variable result    : natural := 0;
  begin
    while remaining > 0 loop
      remaining := remaining / 2;
      result := result + 1;
    end loop;
    return result;
  end function;

  function index_width(value : positive) return positive is
    variable result : natural := ceil_log2(value);
  begin
    if result = 0 then
      return 1;
    end if;
    return result;
  end function;
end package body;
