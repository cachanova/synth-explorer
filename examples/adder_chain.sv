// Sum N packed input values through an explicit chain of additions.
module adder_chain #(
    parameter int unsigned WIDTH = 16,
    parameter int unsigned NUM_INPUTS = 4,
    parameter int unsigned SUM_WIDTH = WIDTH + $clog2(NUM_INPUTS)
) (
    input  logic [NUM_INPUTS*WIDTH-1:0] values,
    output logic [SUM_WIDTH-1:0]        sum
);

  logic [SUM_WIDTH-1:0] partial_sum [0:NUM_INPUTS];

  assign partial_sum[0] = '0;

  for (genvar i = 0; i < NUM_INPUTS; i = i + 1) begin : add_input
    assign partial_sum[i + 1] = partial_sum[i] + SUM_WIDTH'(values[i*WIDTH +: WIDTH]);
  end

  assign sum = partial_sum[NUM_INPUTS];

endmodule
