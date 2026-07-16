# Extract *physical* per-cell and per-net delays from Vivado.
#
# `vivado.tcl` measures whole paths; this dumps the detailed path table so each
# delay can be attributed to the primitive that caused it. That is what lets the
# coefficients in `delay_model.rs` mean what they say ("a LUT costs this much")
# rather than being a fudge factor tuned to make totals land.
#
# Emits one CELL:/NET: line per row of the path table. `calibrate cells` turns
# those into per-family coefficients.

set cases_dir [lindex $argv 0]

# The whole corpus, not a hand-picked subset: net delay keys on the driver->sink
# cell pair, and pair coverage needs breadth. Four probe designs left Series-7
# CARRY->CARRY, UltraScale LUT->CARRY, and every ->FF pair unmeasured.
set spec_fh [open [file join $cases_dir cases.json] r]
set spec [read $spec_fh]
close $spec_fh
set probes {}
foreach {_ name file top} [regexp -all -inline \
        {"name"\s*:\s*"([^"]+)"\s*,\s*"file"\s*:\s*"([^"]+)"\s*,\s*"top"\s*:\s*"([^"]+)"} $spec] {
    lappend probes [list $name $file $top]
}
set declared [regexp -all {"name"\s*:\s*"} $spec]
if {[llength $probes] != $declared} {
    error "parsed [llength $probes] cases but the spec declares $declared"
}
puts "PARSED: [llength $probes] cases"
set parts {
    series7         xc7a35tcpg236-1
    ultrascale      xcku035-fbva676-1-c
    ultrascale_plus xcku5p-ffva676-1-e
}

foreach {fam part} $parts {
    foreach p $probes {
        lassign $p name file top
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

        # Several paths per case: one path alone gives too few net samples to fit
        # a fanout term.
        set rpt [report_timing -delay_type max -max_paths 12 -return_string]
        # Vivado wraps a long arc name onto its own line, putting the delay on
        # the NEXT line:
        #     CARRY4 (Prop_carry4_DI[1]_CO[3])
        #                              0.520     3.067 r  sum[4]_INST_0/CO[3]
        # A single-line regex silently drops every one of those — which is every
        # carry arc, i.e. exactly the ones worth measuring. So carry the arc
        # forward until its delay shows up.
        set pending ""
        foreach line [split $rpt "\n"] {
            # Cell rows:  "  LUT3 (Prop_lut3_I2_O)   0.124   1.097 r  ..."
            # Key off the timing arc, not the cell column: the arc names the
            # primitive *and* the pin-to-pin path, which is what distinguishes a
            # carry propagate (carry4_CI_CO) from a chain entry (carry4_DI_CO).
            # The arc contains brackets, so match up to the closing paren.
            if {[regexp {\(Prop_([^)]+)\)\s+([0-9.]+)} $line -> arc incr]} {
                puts "CELL: $fam $name $arc $incr"
                set pending ""
                continue
            }
            if {[regexp {\(Prop_([^)]+)\)\s*$} $line -> arc]} {
                set pending $arc
                continue
            }
            if {$pending ne "" && [regexp {^\s+([0-9.]+)\s+[0-9.]+} $line -> incr]} {
                puts "CELL: $fam $name $pending $incr"
                set pending ""
                continue
            }
            # Net rows:   "  net (fo=2, unplaced)    0.676   1.773  name"
            if {[regexp {^\s+net \(fo=(\d+),\s*(\w+)\)\s+([0-9.]+)} $line -> fo state incr]} {
                puts "NET: $fam $name $fo $state $incr"
            }
        }
    }
}
close_project -quiet
puts "DONE"
