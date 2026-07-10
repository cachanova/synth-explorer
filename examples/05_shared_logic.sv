// 05_shared_logic: one shared combinational cone feeding three registers
// Demonstrates a shared fanin cone: `a*3` (via shift+add) is computed once
// and then combined with different extra logic for three different
// registers, so all three endpoints share a common upstream sub-cone.
module shared_logic (
    input  logic        clk,
    input  logic          rst,
    input  logic [7:0]    a,
    input  logic [7:0]    b,
    input  logic [7:0]    c,
    output logic [8:0]    q1,
    output logic [8:0]    q2,
    output logic [8:0]    q3
);

  logic [8:0] a_times3;

  assign a_times3 = ({a, 1'b0} + a); // a*2 + a = a*3

  always_ff @(posedge clk) begin
    if (rst) begin
      q1 <= 9'd0;
      q2 <= 9'd0;
      q3 <= 9'd0;
    end else begin
      q1 <= a_times3 + {1'b0, b};
      q2 <= a_times3 - {1'b0, c};
      q3 <= a_times3 ^ {1'b0, (b & c)};
    end
  end

endmodule
