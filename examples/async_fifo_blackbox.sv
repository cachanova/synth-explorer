// A vendor-generated dual-clock FIFO is a typical opaque boundary in an RTL
// project. The wrapper keeps the application-side interface and IP parameters
// visible while leaving the clock-domain-crossing implementation blackboxed.
(* blackbox *)
module async_fifo_ip #(
    parameter int unsigned DATA_WIDTH = 16,
    parameter int unsigned ADDR_WIDTH = 4
) (
    input  logic                  write_clk,
    input  logic                  write_rst,
    input  logic                  write_en,
    input  logic [DATA_WIDTH-1:0] write_data,
    output logic                  full,
    input  logic                  read_clk,
    input  logic                  read_rst,
    input  logic                  read_en,
    output logic [DATA_WIDTH-1:0] read_data,
    output logic                  empty
);
endmodule

module async_fifo_wrapper #(
    parameter int unsigned DATA_WIDTH = 16,
    parameter int unsigned DEPTH = 16,
    parameter int unsigned ADDR_WIDTH = (DEPTH <= 1) ? 1 : $clog2(DEPTH)
) (
    input  logic                  write_clk,
    input  logic                  write_rst,
    input  logic                  write_valid,
    output logic                  write_ready,
    input  logic [DATA_WIDTH-1:0] write_data,
    input  logic                  read_clk,
    input  logic                  read_rst,
    output logic                  read_valid,
    input  logic                  read_ready,
    output logic [DATA_WIDTH-1:0] read_data
);

  logic full;
  logic empty;

  async_fifo_ip #(
      .DATA_WIDTH(DATA_WIDTH),
      .ADDR_WIDTH(ADDR_WIDTH)
  ) fifo_ip (
      .write_clk(write_clk),
      .write_rst(write_rst),
      .write_en(write_valid && write_ready),
      .write_data(write_data),
      .full(full),
      .read_clk(read_clk),
      .read_rst(read_rst),
      .read_en(read_valid && read_ready),
      .read_data(read_data),
      .empty(empty)
  );

  assign write_ready = !full;
  assign read_valid = !empty;

endmodule
