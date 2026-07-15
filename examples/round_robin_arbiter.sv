module round_robin_arbiter #(
    parameter int unsigned NUM_REQUESTERS = 4,
    parameter int unsigned INDEX_WIDTH =
        (NUM_REQUESTERS <= 1) ? 1 : $clog2(NUM_REQUESTERS)
) (
    input  logic                        clk,
    input  logic                        rst,
    input  logic [NUM_REQUESTERS-1:0]   requests,
    input  logic                        accept,
    output logic [NUM_REQUESTERS-1:0]   grant,
    output logic [INDEX_WIDTH-1:0]      grant_index,
    output logic                        grant_valid
);

  logic [INDEX_WIDTH-1:0] next_index;
  logic [2*NUM_REQUESTERS-1:0] doubled_requests;
  logic [NUM_REQUESTERS-1:0] rotated_requests;
  logic [INDEX_WIDTH:0] candidate;
  integer offset;

  assign doubled_requests = {requests, requests};
  assign rotated_requests = NUM_REQUESTERS'(doubled_requests >> next_index);

  always_comb begin
    grant = '0;
    grant_index = '0;
    grant_valid = 1'b0;
    candidate = '0;

    for (offset = 0; offset < NUM_REQUESTERS; offset = offset + 1) begin
      if (!grant_valid && rotated_requests[offset]) begin
        candidate = {1'b0, next_index} + (INDEX_WIDTH + 1)'(offset);
        if (candidate >= (INDEX_WIDTH + 1)'(NUM_REQUESTERS))
          candidate = candidate - (INDEX_WIDTH + 1)'(NUM_REQUESTERS);
        grant_index = candidate[INDEX_WIDTH-1:0];
        grant_valid = 1'b1;
      end
    end

    if (grant_valid)
      grant = {{(NUM_REQUESTERS - 1){1'b0}}, 1'b1} << grant_index;
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      next_index <= '0;
    end else if (accept && grant_valid) begin
      if (grant_index == INDEX_WIDTH'(NUM_REQUESTERS - 1))
        next_index <= '0;
      else
        next_index <= grant_index + 1'b1;
    end
  end

endmodule
