module inferred_fifo #(
    parameter int unsigned DATA_WIDTH = 16,
    parameter int unsigned DEPTH = 16,
    parameter int unsigned ADDR_WIDTH = (DEPTH <= 1) ? 1 : $clog2(DEPTH),
    parameter int unsigned COUNT_WIDTH = $clog2(DEPTH + 1)
) (
    input  logic                  clk,
    input  logic                  rst,
    input  logic                  push_valid,
    output logic                  push_ready,
    input  logic [DATA_WIDTH-1:0] push_data,
    output logic                  pop_valid,
    input  logic                  pop_ready,
    output logic [DATA_WIDTH-1:0] pop_data,
    output logic [COUNT_WIDTH-1:0] count
);

  logic [DATA_WIDTH-1:0] memory [0:DEPTH-1];
  logic [ADDR_WIDTH-1:0] write_pointer;
  logic [ADDR_WIDTH-1:0] read_pointer;
  logic push;
  logic pop;

  assign push_ready = count < COUNT_WIDTH'(DEPTH);
  assign pop_valid = count != 0;
  assign push = push_valid && push_ready;
  assign pop = pop_valid && pop_ready;
  assign pop_data = memory[read_pointer];

  always_ff @(posedge clk) begin
    if (rst) begin
      write_pointer <= '0;
      read_pointer <= '0;
      count <= '0;
    end else begin
      if (push) begin
        memory[write_pointer] <= push_data;
        if (write_pointer == ADDR_WIDTH'(DEPTH - 1))
          write_pointer <= '0;
        else
          write_pointer <= write_pointer + 1'b1;
      end

      if (pop) begin
        if (read_pointer == ADDR_WIDTH'(DEPTH - 1))
          read_pointer <= '0;
        else
          read_pointer <= read_pointer + 1'b1;
      end

      case ({push, pop})
        2'b10: count <= count + 1'b1;
        2'b01: count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end

endmodule
