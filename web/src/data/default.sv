module top (
  input  wire       clk,
  input  wire       rst,
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       sel,
  output reg  [7:0] q
);
  wire [7:0] sum = a + b;
  always @(posedge clk) begin
    if (rst) q <= 8'd0;
    else     q <= sel ? sum : a;
  end
endmodule
