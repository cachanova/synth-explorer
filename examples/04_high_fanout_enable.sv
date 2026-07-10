// 04_high_fanout_enable: one enable gating 16 separate 8-bit registers
// Demonstrates a very high-fanout net: the single `en` input drives the
// clock-enable of 16 independent registers, so the fanout ranking should
// place `en` at (or near) the top.
module high_fanout_enable (
    input  logic        clk,
    input  logic          rst,
    input  logic          en,
    input  logic [127:0]  d_in,
    output logic [127:0]  d_out
);

  localparam int N = 16;

  logic [7:0] regs [N];

  genvar i;
  generate
    for (i = 0; i < N; i++) begin : g_regs
      always_ff @(posedge clk) begin
        if (rst)
          regs[i] <= 8'd0;
        else if (en)
          regs[i] <= d_in[i*8 +: 8];
      end
      assign d_out[i*8 +: 8] = regs[i];
    end
  endgenerate

endmodule
