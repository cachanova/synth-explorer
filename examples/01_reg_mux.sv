// 01_reg_mux: register behind a 2:1 mux
// Demonstrates the simplest case: a single FF endpoint whose D input is fed
// by a shallow (1-level) combinational mux cone.
module reg_mux (
    input  logic       clk,
    input  logic        rst,
    input  logic        sel,
    input  logic [7:0]  a,
    input  logic [7:0]  b,
    output logic [7:0]  q
);

  always_ff @(posedge clk) begin
    if (rst)
      q <= 8'd0;
    else
      q <= sel ? b : a;
  end

endmodule
