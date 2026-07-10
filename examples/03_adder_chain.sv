// 03_adder_chain: sequential chain of four 16-bit adds feeding a register
// Demonstrates the deepest carry-propagation path of the example set:
// ((a+b)+c)+d is one combinational cone with four chained 16-bit adders
// before the register's D input.
module adder_chain (
    input  logic         clk,
    input  logic          rst,
    input  logic [15:0]   a,
    input  logic [15:0]   b,
    input  logic [15:0]   c,
    input  logic [15:0]   d,
    output logic [17:0]   sum
);

  logic [17:0] s_c;

  assign s_c = ((({2'b00, a} + {2'b00, b}) + {2'b00, c}) + {2'b00, d});

  always_ff @(posedge clk) begin
    if (rst)
      sum <= 18'd0;
    else
      sum <= s_c;
  end

endmodule
