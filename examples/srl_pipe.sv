// The shift storage intentionally has no reset so FPGA synthesis can map it to
// SRL primitives. Reset only clears the separate valid pipeline.
module srl_pipe #(
    parameter int unsigned WIDTH = 8,
    parameter int unsigned STAGES = 16
) (
    input  logic             clk,
    input  logic             rst,
    input  logic             en,
    input  logic             valid_in,
    input  logic [WIDTH-1:0] data_in,
    output logic             valid_out,
    output logic [WIDTH-1:0] data_out
);

  if (STAGES == 0) begin : no_stages
    assign data_out = data_in;
    assign valid_out = valid_in;
  end else begin : with_stages
    logic [WIDTH-1:0] shift_data [0:STAGES-1];
    logic [STAGES-1:0] shift_valid;

    always_ff @(posedge clk) begin
      if (en) begin
        shift_data[0] <= data_in;
        for (integer i = 1; i < STAGES; i = i + 1)
          shift_data[i] <= shift_data[i - 1];
      end
    end

    always_ff @(posedge clk) begin
      if (rst) begin
        shift_valid <= '0;
      end else if (en) begin
        shift_valid[0] <= valid_in;
        for (integer i = 1; i < STAGES; i = i + 1)
          shift_valid[i] <= shift_valid[i - 1];
      end
    end

    assign data_out = shift_data[STAGES - 1];
    assign valid_out = shift_valid[STAGES - 1];
  end

endmodule
