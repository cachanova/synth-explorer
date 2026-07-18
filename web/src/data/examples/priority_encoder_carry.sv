// Lowest numbered request has priority. The isolation expression maps naturally
// onto an FPGA carry chain before the selected bit is encoded.
module priority_encoder_carry #(
    parameter int unsigned WIDTH = 32,
    parameter int unsigned INDEX_WIDTH = (WIDTH <= 1) ? 1 : $clog2(WIDTH)
) (
    input  logic [WIDTH-1:0]       requests,
    output logic [WIDTH-1:0]       one_hot,
    output logic [INDEX_WIDTH-1:0] index,
    output logic                   valid
);

  integer i;

  assign one_hot = requests & (~requests + 'd1);
  assign valid = |requests;

  always_comb begin
    index = '0;
    for (i = 0; i < WIDTH; i = i + 1) begin
      if (one_hot[i])
        index = INDEX_WIDTH'(i);
    end
  end

endmodule
