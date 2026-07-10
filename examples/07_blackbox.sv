// 07_blackbox: instantiates an opaque blackbox core between logic and a register
// Demonstrates a blackbox boundary: `mystery_core` is declared with
// (* blackbox *) so yosys keeps it as an opaque cell — paths should break
// at its input/output ports instead of tracing through it.
(* blackbox *)
module mystery_core (
    input  logic [7:0]  a,
    output logic [7:0]  y
);
endmodule

module blackbox_demo (
    input  logic        clk,
    input  logic         rst,
    input  logic [7:0]   in_a,
    input  logic [7:0]   in_b,
    output logic [7:0]   out_q
);

  logic [7:0] pre_mix;
  logic [7:0] core_out;

  assign pre_mix = in_a ^ in_b;

  mystery_core u_core (
      .a(pre_mix),
      .y(core_out)
  );

  always_ff @(posedge clk) begin
    if (rst)
      out_q <= 8'd0;
    else
      out_q <= core_out;
  end

endmodule
