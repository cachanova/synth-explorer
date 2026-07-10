// 06_comb_output: purely combinational comparator + mux, no clock
// Demonstrates a design with zero registers: every top-level output is
// driven directly by combinational logic, so all paths terminate at
// top-level output ports rather than FF D inputs.
module comb_output (
    input  logic [15:0]  x,
    input  logic [15:0]  y,
    input  logic [15:0]  on_lt,
    input  logic [15:0]  on_ge,
    output logic [15:0]  result,
    output logic          x_lt_y
);

  assign x_lt_y = (x < y);
  assign result  = x_lt_y ? on_lt : on_ge;

endmodule
