module reg_mux #(
    parameter int unsigned WIDTH = 8,
    parameter logic [WIDTH-1:0] RESET_VALUE = '0
) (
    input  logic                 clk,
    input  logic                 rst,
    input  logic                 sel,
    input  logic [WIDTH-1:0]     a,
    input  logic [WIDTH-1:0]     b,
    output logic [WIDTH-1:0]     q
);

  always_ff @(posedge clk) begin
    if (rst)
      q <= RESET_VALUE;
    else
      q <= sel ? b : a;
  end

endmodule
