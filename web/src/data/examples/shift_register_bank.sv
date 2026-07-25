module shift_register_lane #(
    parameter int unsigned DEPTH = 4
) (
    input  logic clk,
    input  logic rst,
    input  logic data_in,
    output logic data_out
);

  logic [DEPTH-1:0] stages;

  always_ff @(posedge clk) begin
    if (rst)
      stages <= '0;
    else
      stages <= {stages[DEPTH-2:0], data_in};
  end

  assign data_out = stages[DEPTH-1];

endmodule

module shift_register_bank #(
    parameter int unsigned WIDTH = 4,
    parameter int unsigned DEPTH = 4
) (
    input  logic             clk,
    input  logic             rst,
    input  logic [WIDTH-1:0] data_in,
    output logic [WIDTH-1:0] data_out
);

  for (genvar lane = 0; lane < WIDTH; lane = lane + 1) begin : lanes
    shift_register_lane #(
        .DEPTH(DEPTH)
    ) lane_shift (
        .clk(clk),
        .rst(rst),
        .data_in(data_in[lane]),
        .data_out(data_out[lane])
    );
  end

endmodule
