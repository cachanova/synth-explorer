# Vivado ground truth for delay-model calibration.
#
# Reads the generated cases (see `calibrate gen`), synthesizes each one for each
# family/speed-grade part, and emits one JSON record per run on stdout, tagged
# with RESULT: so the caller can sieve it out of Vivado's chatter.
#
# Constraining choices, which decide what we are comparing against:
#   * -mode out_of_context — no IBUF/OBUF. Our graph has no I/O buffers, so
#     letting Vivado insert them would compare different circuits.
#   * A single clock, real (`clk` port) or virtual, with zero input/output delay
#     on every other port. That makes input->FF, FF->FF, FF->output and pure
#     input->output paths all reportable, and sets input arrival to 0 — which is
#     exactly what our model does (`launch_ps` is 0 for a top-level input).
#   * A deliberately slack period: we read Data Path Delay, not slack, so the
#     period only has to be loose enough not to hide paths.
#
# `Data Path Delay` = clock-to-Q + logic + route. Setup is NOT in it (Vivado
# reports setup inside slack), so it pairs with our launch+logic+net.

set cases_dir [lindex $argv 0]

set spec_fh [open [file join $cases_dir cases.json] r]
set spec [read $spec_fh]
close $spec_fh

# Minimal field extraction — Vivado's tcl has no JSON parser, and the spec is
# machine-generated so the shapes are stable.
proc json_field {obj key} {
    if {[regexp "\"$key\"\\s*:\\s*\"(\[^\"\]*)\"" $obj -> value]} { return $value }
    return ""
}

# Pull the parts table: "family": { "-1": "part", ... }
set parts_blob ""
regexp {"parts"\s*:\s*\{(.*?)\n\s*\},} $spec -> parts_blob
set families {}
foreach {_ fam body} [regexp -all -inline {"(\w+)"\s*:\s*\{([^\}]*)\}} $parts_blob] {
    set grades {}
    foreach {_ g p} [regexp -all -inline {"(-\d)"\s*:\s*"([^"]+)"} $body] {
        lappend grades $g $p
    }
    lappend families $fam $grades
}

# Cases that also run at the non-baseline speed grades.
set sg_cases {}
if {[regexp {"speed_grade_cases"\s*:\s*\[([^\]]*)\]} $spec -> sg_blob]} {
    foreach {_ n} [regexp -all -inline {"([^"]+)"} $sg_blob] { lappend sg_cases $n }
}

# Pull the case list.
set cases {}
foreach {_ obj} [regexp -all -inline {\{\s*"name"[^\}]*\}[^\}]*\}} $spec] {
    set name [json_field $obj name]
    set file [json_field $obj file]
    set top  [json_field $obj top]
    if {$name ne "" && $top ne ""} { lappend cases [list $name $file $top] }
}

proc run_case {name file top part} {
    set dir [file join $::cases_dir $name]
    close_project -quiet
    create_project -in_memory -part $part
    if {[catch {
        read_verilog -sv [file join $dir $file]
        synth_design -top $top -part $part -mode out_of_context
    } err]} {
        puts "SKIP: $name $part synth failed: $err"
        return
    }

    # One clock for the whole design: the real `clk` if the module has one, else
    # a virtual clock so the pure-combinational cases still get analyzed.
    set clk_ports [get_ports -quiet clk]
    if {[llength $clk_ports] > 0} {
        create_clock -name cal_clk -period 10.000 $clk_ports
    } else {
        create_clock -name cal_clk -period 10.000
    }
    # Zero I/O delay on every non-clock port: input arrival 0 matches our model.
    # Filter by name rather than subtracting collections — this Vivado build has
    # no `remove_from_collection`.
    set in_ports [get_ports -quiet -filter {DIRECTION == IN && NAME !~ "*clk*"}]
    set out_ports [get_ports -quiet -filter {DIRECTION == OUT}]
    if {[llength $in_ports] > 0} {
        set_input_delay -clock cal_clk 0.000 $in_ports
    }
    if {[llength $out_ports] > 0} {
        set_output_delay -clock cal_clk 0.000 $out_ports
    }

    set rpt [report_timing -delay_type max -max_paths 1 -return_string]

    # Data Path Delay: 3.749ns  (logic 3.259ns (86.9%)  route 0.490ns (13.1%))
    if {![regexp {Data Path Delay:\s+([0-9.]+)ns\s+\(logic\s+([0-9.]+)ns[^)]*\)\s+route\s+([0-9.]+)ns} \
            $rpt -> total logic route]} {
        puts "SKIP: $name $part no data path delay (design may have no timing path)"
        return
    }
    set levels 0
    regexp {Logic Levels:\s+(\d+)} $rpt -> levels

    puts "RESULT: {\"case\":\"$name\",\"family\":\"$::cur_family\",\"speed_grade\":\"$::cur_grade\",\"data_path_ns\":$total,\"logic_ns\":$logic,\"route_ns\":$route,\"logic_levels\":$levels}"
}

# Every case runs at the baseline -1, which is what the presets are fitted to.
# The -2/-3 grades only need to resolve a per-family scale factor, and each run
# costs a full synthesis on a host that is also serving the app — so those grades
# use the `speed_grade_cases` subset, chosen to span carry / LUT / mux / FF-only
# paths. Anything skipped here is skipped loudly, never silently narrowed.
foreach {fam grades} $families {
    foreach {grade part} $grades {
        set cur_family $fam
        set cur_grade $grade
        foreach c $cases {
            lassign $c name file top
            if {$grade ne "-1" && [lsearch -exact $sg_cases $name] < 0} {
                continue
            }
            run_case $name $file $top $part
        }
    }
}
close_project -quiet
puts "DONE"
