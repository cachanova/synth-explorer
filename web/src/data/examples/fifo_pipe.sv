module fifo_pipe #(
    parameter int unsigned WIDTH = 16,
    parameter int unsigned STAGES = 3
) (
    input  logic             clk,
    input  logic             rst,
    input  logic             input_valid,
    output logic             input_ready,
    input  logic [WIDTH-1:0] input_data,
    output logic             output_valid,
    input  logic             output_ready,
    output logic [WIDTH-1:0] output_data
);

  if (STAGES == 0) begin : no_stages
    assign input_ready = output_ready;
    assign output_valid = input_valid;
    assign output_data = input_data;
  end else begin : with_stages
    logic [STAGES-1:0] valid;
    logic [WIDTH-1:0] data [0:STAGES-1];
    logic [STAGES:0] ready;

    assign ready[STAGES] = output_ready;

    for (genvar i = 0; i < STAGES; i = i + 1) begin : stage_ready
      assign ready[i] = !valid[i] || ready[i + 1];
    end

    always_ff @(posedge clk) begin
      if (rst) begin
        valid <= '0;
      end else begin
        for (integer i = 0; i < STAGES; i = i + 1) begin
          if (ready[i]) begin
            if (i == 0) begin
              valid[i] <= input_valid;
              if (input_valid)
                data[i] <= input_data;
            end else begin
              valid[i] <= valid[i - 1];
              if (valid[i - 1])
                data[i] <= data[i - 1];
            end
          end
        end
      end
    end

    assign input_ready = ready[0];
    assign output_valid = valid[STAGES - 1];
    assign output_data = data[STAGES - 1];
  end

endmodule
