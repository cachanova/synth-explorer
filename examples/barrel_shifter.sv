module barrel_shifter #(
    parameter int unsigned WIDTH = 32,
    parameter int unsigned SHIFT_WIDTH = (WIDTH <= 1) ? 1 : $clog2(WIDTH)
) (
    input  logic [WIDTH-1:0]       data_in,
    input  logic [SHIFT_WIDTH-1:0] shift_amount,
    input  logic                   shift_right,
    input  logic                   arithmetic,
    output logic [WIDTH-1:0]       data_out
);

  always_comb begin
    if (shift_right && arithmetic)
      data_out = $signed(data_in) >>> shift_amount;
    else if (shift_right)
      data_out = data_in >> shift_amount;
    else
      data_out = data_in << shift_amount;
  end

endmodule
