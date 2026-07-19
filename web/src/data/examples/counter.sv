module counter #(
    parameter int unsigned WIDTH = 8
) (
    input  logic             clk,
    input  logic             reset,
    input  logic             enable,
    output logic [WIDTH-1:0] count
);
  function automatic logic [WIDTH-1:0] increment(
      input logic [WIDTH-1:0] value
  );
    increment = value + 1'b1;
  endfunction

  always_ff @(posedge clk) begin
    if (reset)
      count <= '0;
    else if (enable)
      count <= increment(count);
  end
endmodule
