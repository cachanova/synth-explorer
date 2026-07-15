module pipe #(
    parameter int unsigned WIDTH = 16,
    parameter int unsigned STAGES = 4,
    parameter logic [WIDTH-1:0] RESET_VALUE = '0
) (
    input  logic             clk,
    input  logic             rst,
    input  logic             en,
    input  logic [WIDTH-1:0] data_in,
    output logic [WIDTH-1:0] data_out
);

  logic [WIDTH-1:0] stage [0:STAGES-1];

  always_ff @(posedge clk) begin
    if (rst) begin
      for (integer i = 0; i < STAGES; i = i + 1)
        stage[i] <= RESET_VALUE;
    end else if (en) begin
      stage[0] <= data_in;
      for (integer i = 1; i < STAGES; i = i + 1)
        stage[i] <= stage[i - 1];
    end
  end

  assign data_out = stage[STAGES - 1];

endmodule
