module leaf(input wire a, output wire y);
  wire alias = a;
  assign y = alias;
endmodule
module other(input wire a, output wire y);
  wire alias = ~a;
  assign y = alias;
endmodule
module unused(input wire a, output wire y);
  wire alias = a;
  assign y = alias;
endmodule
module scoped_children(input wire a, input wire b, output wire y0, output wire y1);
  leaf u_leaf(.a(a), .y(y0));
  other u_other(.a(b), .y(y1));
endmodule
