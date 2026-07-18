module handshake_controller #(
    parameter int unsigned TIMEOUT_CYCLES = 16,
    parameter int unsigned COUNT_WIDTH =
        (TIMEOUT_CYCLES <= 1) ? 1 : $clog2(TIMEOUT_CYCLES)
) (
    input  logic clk,
    input  logic rst,
    input  logic start,
    output logic request_valid,
    input  logic request_ready,
    input  logic response_valid,
    output logic response_ready,
    output logic busy,
    output logic done,
    output logic timed_out
);

  typedef enum logic [1:0] {
    IDLE,
    SEND_REQUEST,
    WAIT_RESPONSE
  } state_t;

  state_t state;
  state_t next_state;
  logic [COUNT_WIDTH-1:0] wait_count;
  logic timeout;

  assign timeout = (wait_count == COUNT_WIDTH'(TIMEOUT_CYCLES - 1));

  always_comb begin
    next_state = state;
    request_valid = 1'b0;
    response_ready = 1'b0;
    busy = 1'b1;
    done = 1'b0;
    timed_out = 1'b0;

    case (state)
      IDLE: begin
        busy = 1'b0;
        if (start)
          next_state = SEND_REQUEST;
      end
      SEND_REQUEST: begin
        request_valid = 1'b1;
        if (request_ready)
          next_state = WAIT_RESPONSE;
      end
      WAIT_RESPONSE: begin
        response_ready = 1'b1;
        if (response_valid) begin
          done = 1'b1;
          next_state = IDLE;
        end else if (timeout) begin
          timed_out = 1'b1;
          next_state = IDLE;
        end
      end
      default: next_state = IDLE;
    endcase
  end

  always_ff @(posedge clk) begin
    if (rst) begin
      state <= IDLE;
      wait_count <= '0;
    end else begin
      state <= next_state;
      if (state != WAIT_RESPONSE || response_valid || timeout)
        wait_count <= '0;
      else
        wait_count <= wait_count + 1'b1;
    end
  end

endmodule
