// Lowest numbered request has priority.
module priority_encoder_for #(
    parameter int unsigned WIDTH = 32,
    parameter int unsigned INDEX_WIDTH = (WIDTH <= 1) ? 1 : $clog2(WIDTH)
) (
    input  logic [WIDTH-1:0]       requests,
    output logic [WIDTH-1:0]       one_hot,
    output logic [INDEX_WIDTH-1:0] index,
    output logic                   valid
);

  integer i;
  always_comb begin
    one_hot = '0;
    index = '0;
    valid = 1'b0;

    for (i = 0; i < WIDTH; i = i + 1) begin
      if (!valid && requests[i]) begin
        one_hot[i] = 1'b1;
        index = INDEX_WIDTH'(i);
        valid = 1'b1;
      end
    end
  end

endmodule
