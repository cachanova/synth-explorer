// 08_fsm: small 5-state Moore FSM with two outputs
// Demonstrates FSM state-register analysis: a single state register with a
// combinational next-state cone and Moore-style (state-only) output logic.
module fsm (
    input  logic  clk,
    input  logic   rst,
    input  logic   start,
    input  logic   done,
    input  logic   ack,
    output logic   busy,
    output logic   valid
);

  typedef enum logic [2:0] {
    S_IDLE = 3'd0,
    S_LOAD = 3'd1,
    S_RUN  = 3'd2,
    S_WAIT = 3'd3,
    S_DONE = 3'd4
  } state_t;

  state_t state, next_state;

  always_comb begin
    next_state = state;
    case (state)
      S_IDLE: next_state = start ? S_LOAD : S_IDLE;
      S_LOAD: next_state = S_RUN;
      S_RUN:  next_state = done ? S_WAIT : S_RUN;
      S_WAIT: next_state = ack ? S_DONE : S_WAIT;
      S_DONE: next_state = S_IDLE;
      default: next_state = S_IDLE;
    endcase
  end

  always_ff @(posedge clk) begin
    if (rst)
      state <= S_IDLE;
    else
      state <= next_state;
  end

  assign busy  = (state != S_IDLE);
  assign valid = (state == S_DONE);

endmodule
