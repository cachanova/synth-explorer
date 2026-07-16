# Time YOSYS's netlist with VIVADO's delay model.
#
# `vivado.tcl` answers "what does Vivado get on its own netlist"; this script
# answers "what does Vivado's delay model say about *our* (Yosys) netlist". With
# the netlist held constant, the difference between our estimate and this
# number is purely delay-model error, and the difference between this number
# and `vivado.tcl`'s is purely mapping (netlist-shape) error. That decomposition
# is the point: fitting our per-stage coefficients against Vivado-on-Vivado's-
# netlist forces them to absorb the ~2x depth ratio between the two synthesists.
#
# Input layout, next to `cases.json` (see `calibrate gen` for the cases):
#
#   <cases_dir>/cases.json
#   <cases_dir>/edif/<case>.<family>.edif
#
# Each EDIF is exported by Yosys with the app's exact baseline synthesis line:
#
#   read_verilog -sv <case>.sv
#   synth_xilinx -top <top> -flatten -family <xc7|xcu|xcup> -noiopad -noclkbuf
#   write_edif -pvector bra <case>.<family>.edif
#
# Usage: vivado -mode batch -source vivado_edif.tcl -tclargs <cases_dir> [case ...]
#
# Trailing case names restrict the run (the Vivado host is redeployed often, so
# the corpus is run in small idempotent chunks). No names = the whole corpus.
#
# Hard-won incantation notes:
#   * Do NOT pass `-top` to `link_design`. For an EDIF netlist the top comes
#     from the EDIF's own `(design ...)` statement; with `-top`, Vivado instead
#     searches for RTL sources to elaborate and dies with
#     "[Project 1-68] No files found to match top module". The top is verified
#     after linking instead — a wrong EDIF must fail loudly, not time silently.
#   * Never define a Tcl proc named `try`: it shadows the 8.6 builtin that
#     Vivado's tclapp loader uses, and every later `create_project` then fails
#     with the wonderfully misleading "Unable to load Tcl app xilinx::xsim".
#   * Runs only at the -1 baseline grade: the estimate presets are characterized
#     at -1, and speed-grade factors are `vivado.tcl` + `calibrate fit`'s job.
#
# Emits one `RESULT:` JSON record per case/family, same shape as `vivado.tcl`
# (so `calibrate report` reads either), and a `SKIP:` line with the reason for
# anything it cannot time. Constraints match `vivado.tcl` exactly: one 10ns
# clock (real `clk` port or virtual), zero input/output delay elsewhere.
# `Data Path Delay` excludes setup, pairing with our launch+logic+net.

set cases_dir [lindex $argv 0]
set only_cases [lrange $argv 1 end]

set spec_fh [open [file join $cases_dir cases.json] r]
set spec [read $spec_fh]
close $spec_fh

# Field extraction and its loud-failure discipline are copied from `vivado.tcl`:
# every `regexp -all -inline` MUST have capture groups matching the `foreach`
# variable list, and a parsed-count mismatch refuses to run rather than quietly
# narrowing the corpus.

set parts_blob ""
if {![regexp {"parts"\s*:\s*\{(.*?)\n\s*\},} $spec -> parts_blob]} {
    error "could not parse the parts table from cases.json"
}
set families {}
foreach {_ fam body} [regexp -all -inline {"(\w+)"\s*:\s*\{([^\}]*)\}} $parts_blob] {
    if {![regexp {"-1"\s*:\s*"([^"]+)"} $body -> part]} {
        error "family $fam has no -1 baseline part"
    }
    lappend families $fam $part
}
if {[llength $families] == 0} {
    error "parsed no families from cases.json"
}

set cases {}
foreach {_ name top} [regexp -all -inline \
        {"name"\s*:\s*"([^"]+)"\s*,\s*"file"\s*:\s*"[^"]+"\s*,\s*"top"\s*:\s*"([^"]+)"} $spec] {
    lappend cases [list $name $top]
}
set declared [regexp -all {"name"\s*:\s*"} $spec]
if {[llength $cases] != $declared} {
    error "parsed [llength $cases] cases but the spec declares $declared"
}
puts "PARSED: [llength $cases] cases, [expr {[llength $families] / 2}] families"

proc run_case {name top family part} {
    set edif [file join $::cases_dir edif "$name.$family.edif"]
    if {![file exists $edif]} {
        puts "SKIP: $name $family no EDIF at $edif (Yosys export failed or was not shipped)"
        return
    }
    close_project -quiet
    create_project -in_memory -part $part
    if {[catch {
        read_edif $edif
        # No -top here — see the header. The design statement in the EDIF is
        # authoritative, and the check below makes a mismatch loud.
        link_design -part $part -mode out_of_context
    } err]} {
        puts "SKIP: $name $family link failed: $err"
        return
    }
    set linked_top [get_property TOP [current_design]]
    if {$linked_top ne $top} {
        puts "SKIP: $name $family linked top '$linked_top' is not the expected '$top'"
        return
    }

    # Constraint recipe identical to `vivado.tcl`: one clock, real or virtual,
    # zero I/O delay on every non-clock port (input arrival 0 matches our model).
    set clk_ports [get_ports -quiet clk]
    if {[llength $clk_ports] > 0} {
        create_clock -name cal_clk -period 10.000 $clk_ports
    } else {
        create_clock -name cal_clk -period 10.000
    }
    set in_ports [get_ports -quiet -filter {DIRECTION == IN && NAME !~ "*clk*"}]
    set out_ports [get_ports -quiet -filter {DIRECTION == OUT}]
    if {[llength $in_ports] > 0} {
        set_input_delay -clock cal_clk 0.000 $in_ports
    }
    if {[llength $out_ports] > 0} {
        set_output_delay -clock cal_clk 0.000 $out_ports
    }

    set rpt [report_timing -delay_type max -max_paths 1 -return_string]

    if {![regexp {Data Path Delay:\s+([0-9.]+)ns\s+\(logic\s+([0-9.]+)ns[^)]*\)\s+route\s+([0-9.]+)ns} \
            $rpt -> total logic route]} {
        puts "SKIP: $name $family no data path delay (design may have no timing path)"
        return
    }
    # As in `vivado.tcl`: an unchecked regexp would make a parse miss look like
    # a genuine 0, and 0-level cases are held out of the error statistic.
    if {![regexp {Logic Levels:\s+(\d+)} $rpt -> levels]} {
        puts "SKIP: $name $family could not parse Logic Levels"
        return
    }

    puts "RESULT: {\"case\":\"$name\",\"family\":\"$family\",\"speed_grade\":\"-1\",\"data_path_ns\":$total,\"logic_ns\":$logic,\"route_ns\":$route,\"logic_levels\":$levels}"
}

foreach c $cases {
    lassign $c name top
    if {[llength $only_cases] > 0 && [lsearch -exact $only_cases $name] < 0} {
        continue
    }
    foreach {fam part} $families {
        run_case $name $top $fam $part
    }
}
close_project -quiet
puts "DONE"
