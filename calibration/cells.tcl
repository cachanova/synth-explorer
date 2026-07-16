# Extract *physical* per-cell and per-net delays from Vivado.
#
# `vivado.tcl` measures whole paths; this dumps the detailed path table so each
# delay can be attributed to the primitive that caused it. That is what lets the
# coefficients in `delay_model.rs` mean what they say ("a LUT costs this much")
# rather than being a fudge factor tuned to make totals land.
#
# Emits one CELL:/NET: line per row of the path table. `calibrate cells` turns
# those into per-family coefficients.
#
# A NET row is tagged with the **driver->sink primitive pair and the net's
# state**, not just fanout. That is what the net model keys on, and it is the
# shape AMD documents: UG906 (Vivado Design Analysis) p.132, "Interconnect
# Setting", says that for post-synthesis designs the Estimated net delay
# "corresponds to the delay of the best possible placement, based on the nature
# of the driver and loads as well as the fanout". Fanout alone cannot express
# that a LUT->CARRY hop is 650 ps on Series-7 and 33 ps on UltraScale+.

set cases_dir [lindex $argv 0]
# Optional filters: run only this family, and only this case. The prod host
# redeploys often and a redeploy recreates the container mid-run, killing the
# sweep and wiping /tmp. So the sweep is driven one chunk at a time and retried
# — a kill then costs one chunk, not the whole sweep. Empty means "all".
set only_family [lindex $argv 1]
set only_case [lindex $argv 2]

# A spread wide enough to see every category the model has a coefficient for:
# LUTs and general nets, carry propagate vs carry entry, wide muxes, FF->LUT
# locality, and a bare FF->FF hop for clock-to-Q. The four-probe set this
# replaces missed MUXF entirely and had no FF->LUT sample on series7.
set probes {
    {adder_chain_w16n4 adder_chain.sv           adder_chain}
    {adder_chain_w32n4 adder_chain.sv           adder_chain}
    {barrel_w32        barrel_shifter.sv        barrel_shifter}
    {barrel_w64        barrel_shifter.sv        barrel_shifter}
    {prio_for_w32      priority_encoder_for.sv  priority_encoder_for}
    {prio_case_w32     priority_encoder_case.sv priority_encoder_case}
    {prio_carry_w32    priority_encoder_carry.sv priority_encoder_carry}
    {pipe_w8_s4        pipe.sv                  pipe}
    {reg_mux_w32       reg_mux.sv               reg_mux}
    {arbiter_n16       round_robin_arbiter.sv   round_robin_arbiter}
    {handshake_t16     handshake_controller.sv  handshake_controller}
    {fifo_pipe_w16_s3  fifo_pipe.sv             fifo_pipe}
}
set parts {
    series7         xc7a35tcpg236-1
    ultrascale      xcku035-fbva676-1-c
    ultrascale_plus xcku5p-ffva676-1-e
}

# `Prop_lut3_I0_O` -> `lut3`; `Prop_carry4_DI[1]_CO[3]` -> `carry4`.
proc prim_of {arc} {
    return [lindex [split $arc "_"] 0]
}

# The arc's INPUT pin: `lut3_I0_O` -> `I0`; `carry4_DI[1]_CO[3]` -> `DI[1]`.
# This is what separates a carry-chain entry (DI/S) from a propagate (CI), and
# it is also the sink pin of the net feeding this cell.
proc inpin_of {arc} {
    return [lindex [split $arc "_"] 1]
}

# Last component of a pin path: `q_reg[0]/D` -> `D`.
proc pin_of {path} {
    set idx [string last "/" $path]
    if {$idx < 0} { return "-" }
    return [string range $path [expr {$idx + 1}] end]
}

# Parse one `report_timing -return_string` path table.
#
# The grammar, verified against a raw report rather than assumed — getting this
# wrong drops rows silently, which is how a whole sweep gets wasted:
#
#     net (fo=2, unplaced)         0.676     1.773    sum[4]_INST_0_i_11_n_0
#     LUT5 (Prop_lut5_I1_O)        0.124     1.897 r  sum[4]_INST_0_i_3/O
#
# There is NO bare "sink" row for an internal net. A net's sink is the cell
# whose `Prop_` arc comes NEXT, and that arc names the sink pin (`I1`) as well.
# A bare row appears only at a path ENDPOINT, where the sink has no outgoing
# arc in this path (a top-level port, or a register's D pin).
proc emit_rows {fam name rpt} {
    # `in_data` gates out the *source clock path*, whose rows look exactly like
    # data rows: `net (fo=31, unset) 0.973  clk` feeding `FDRE ... r
    # q_reg[0]/C`. Timing that as a data net is the clock-path bug all over
    # again. The clock path carries no `Prop_` arc in an out-of-context run (no
    # BUFG), so the first `Prop_` row is exactly where the data path starts.
    set in_data 0
    set driver ""
    set pending_arc ""
    set pend_fo ""
    set pend_state ""
    set pend_incr ""
    set pend_net ""

    foreach line [split $rpt "\n"] {
        # A new path report resets everything.
        if {[regexp {^Slack } $line]} {
            set in_data 0
            set driver ""
            set pending_arc ""
            set pend_fo ""
            continue
        }
        # A `(clock ... edge)` row opens a CLOCK path section — the source clock
        # path before the data path, and the DESTINATION clock path after it.
        # Closing `in_data` here is what keeps the clock tree out of the data
        # numbers. Without it the destination clock path's
        #     net (fo=3, unset)  0.924   clk
        #     FDRE               r  some_reg/C
        # is attributed to whatever data cell was last seen, inventing a
        # `LUT->FF 924 ps` route out of the clock net. That is this project's
        # recurring clock-path bug (see #53); it leaked 97 rows before this
        # guard existed.
        if {[regexp {\(clock .* edge\)} $line]} {
            set in_data 0
            set driver ""
            set pending_arc ""
            set pend_fo ""
            continue
        }
        # Emit a completed cell arc and, if a net was waiting on this cell,
        # complete that net: this cell is its sink.
        set arc ""
        set incr ""
        # Cell rows:  "  LUT3 (Prop_lut3_I2_O)   0.124   1.097 r  ..."
        # Key off the timing arc, not the cell column: the arc names the
        # primitive *and* the pin-to-pin path, which is what distinguishes a
        # carry propagate (carry4_CI_CO) from a chain entry (carry4_DI_CO).
        # The arc contains brackets, so match up to the closing paren.
        if {[regexp {\(Prop_([^)]+)\)\s+([0-9.]+)} $line -> a i]} {
            set arc $a
            set incr $i
        } elseif {[regexp {\(Prop_([^)]+)\)\s*$} $line -> a]} {
            # Vivado wraps a long arc name onto its own line, putting the delay
            # on the NEXT line:
            #     CARRY4 (Prop_carry4_DI[1]_CO[3])
            #                              0.520     3.067 r  sum[4]_INST_0/CO[3]
            # A single-line regex silently drops every one of those — which is
            # every carry arc, i.e. exactly the ones worth measuring. So carry
            # the arc forward until its delay shows up.
            set pending_arc $a
            continue
        } elseif {$pending_arc ne "" \
                      && [regexp {^\s+([0-9.]+)\s+[0-9.]+} $line -> i]} {
            set arc $pending_arc
            set incr $i
            set pending_arc ""
        }
        if {$arc ne ""} {
            set prim [prim_of $arc]
            if {$pend_fo ne "" && $in_data} {
                puts "NET: $fam $name $pend_fo $pend_state $pend_incr $driver\
                      $prim [inpin_of $arc] $pend_net"
            }
            puts "CELL: $fam $name $arc $incr"
            set driver $prim
            set in_data 1
            set pend_fo ""
            continue
        }
        # Path starts at a top-level input port rather than a register. The
        # marker is the `input delay` row that `set_input_delay` produces; the
        # port itself is then a bare row carrying no cell name:
        #     input delay                  0.000     0.000    <hidden>
        #                                  0.000     0.000 r  values[36]
        #     net (fo=2, unset)            0.973     0.973    values[36]
        # Without this the first net of every combinational path has no driver
        # and is dropped — and those are exactly the `unset` samples.
        if {[regexp {^\s+input delay\s} $line] || [regexp {\(input port\)} $line]} {
            set driver "port"
            set in_data 1
            set pend_fo ""
            continue
        }
        # Net rows. Two shapes, and the state word is OPTIONAL:
        #   "  net (fo=2, unplaced)   0.676   1.773  name"   <- real estimate
        #   "  net (fo=0)             0.973   2.402  q[0]"   <- port net
        # Requiring the state silently dropped every fo=0 port net.
        # The state matters: `unplaced` is UG906's documented estimate, but
        # `unset` (which appears on port-driven nets in an OOC run and is in no
        # AMD doc) is a different animal and is kept separate here rather than
        # averaged into general routing.
        if {[regexp {^\s+net \(fo=(\d+)(?:,\s*(\w+))?\)\s+([0-9.]+)\s+[0-9.]+\s*(\S*)} \
                 $line -> fo state incr netname]} {
            if {$state eq ""} { set state "none" }
            if {$netname eq ""} { set netname "-" }
            set pend_fo $fo
            set pend_state $state
            set pend_incr $incr
            set pend_net $netname
            continue
        }
        # A bare row closes a net at a path ENDPOINT:
        #   "   FDRE       r  q_reg[0]/D"   <- sink cell + pin
        #   "              r  q[0]"         <- sink is a top-level port
        # Check the port shape first: it is the more specific pattern.
        if {$pend_fo ne "" && $in_data} {
            if {[regexp {^\s+[rf]\s+(\S+)\s*$} $line -> pin]} {
                puts "NET: $fam $name $pend_fo $pend_state $pend_incr $driver\
                      port - $pend_net"
                set pend_fo ""
                continue
            }
            if {[regexp {^\s+(\S+)\s+[rf]\s+(\S+)\s*$} $line -> sink path]} {
                puts "NET: $fam $name $pend_fo $pend_state $pend_incr $driver\
                      [string tolower $sink] [pin_of $path] $pend_net"
                set pend_fo ""
                continue
            }
        }
    }
}

foreach {fam part} $parts {
    if {$only_family ne "" && $fam ne $only_family} { continue }
    foreach p $probes {
        lassign $p name file top
        if {$only_case ne "" && $name ne $only_case} { continue }
        close_project -quiet
        create_project -in_memory -part $part
        if {[catch {
            read_verilog -sv [file join $cases_dir $name $file]
            synth_design -top $top -part $part -mode out_of_context
        } err]} {
            puts "SKIP: $fam $name synth failed: $err"
            continue
        }
        set clk_ports [get_ports -quiet clk]
        if {[llength $clk_ports] > 0} {
            create_clock -name cal_clk -period 10.000 $clk_ports
        } else {
            create_clock -name cal_clk -period 10.000
        }
        set in_ports [get_ports -quiet -filter {DIRECTION == IN && NAME !~ "*clk*"}]
        set out_ports [get_ports -quiet -filter {DIRECTION == OUT}]
        if {[llength $in_ports] > 0} { set_input_delay -clock cal_clk 0.000 $in_ports }
        if {[llength $out_ports] > 0} { set_output_delay -clock cal_clk 0.000 $out_ports }

        # Several paths per case: one path alone gives too few net samples to
        # separate a fanout term from a driver->sink pair term.
        #
        # Two reports, because `-max_paths N` returns the worst path per
        # ENDPOINT. In an out-of-context run every output-port net costs a flat
        # 0.973 ns, so for a registered design the worst path to every endpoint
        # is the same trivial FF->port hop and the report contains not one
        # fabric net. `reg_mux_w32` yielded 24 paths and 0 usable samples that
        # way. Asking separately for register-to-register paths is what exposes
        # the FF->LUT->FF fabric routing the model actually estimates.
        emit_rows $fam $name [report_timing -delay_type max -max_paths 24 \
                                  -return_string]
        set regs [get_cells -quiet -hier -filter {IS_SEQUENTIAL}]
        if {[llength $regs] > 0} {
            if {[catch {
                emit_rows $fam $name [report_timing -delay_type max \
                                          -from $regs -to $regs -max_paths 24 \
                                          -return_string]
            } err]} {
                puts "SKIP: $fam $name reg2reg report failed: $err"
            }
        }
    }
}
close_project -quiet
puts "DONE"
