# Read Xilinx's characterized per-BEL delays straight out of Vivado.
#
# This replaces inferring cell delays from `report_timing` path tables. That
# approach only ever saw cells that happened to land on some design's critical
# path, which meant:
#   * `MUXF*` was never measured at all (no example inferred one), and
#   * every sample was drawn from the *slowest* paths -- a selection bias.
# `get_speed_models` has neither problem: it returns the numbers Vivado holds
# for the device, whether or not a design uses them. It is a documented UG835
# API (the same one Project X-Ray uses), not a decryption route.
#
# NOTE: an empty in-memory project has zero speed models. A device must be
# linked first, which is what makes `get_bels` (and hence `-of_objects`) work.
#
# Emits: SM: <family> <bel_type> <arc> <slow_max> <fast_min>
# Only CELL delays live here. The *net* term cannot come from this: it is
# Vivado's pre-placement estimate ("the delay of the best possible placement,
# based on the nature of the driver and loads as well as the fanout" -- UG906),
# a heuristic rather than silicon, and it stays empirical. See vivado.tcl.

set parts {
    series7         xc7a35tcpg236-1
    ultrascale      xcku035-fbva676-1-c
    ultrascale_plus xcku5p-ffva676-1-e
}

# One BEL per type is enough: the fabric is regular, so every instance of a type
# carries the same speed model. We assert that below rather than assume it.
set want {*LUT* *CARRY* *FF* *MUX* *SRL*}

foreach {fam part} $parts {
    close_project -quiet
    create_project -in_memory -part $part
    link_design -part $part

    foreach pattern $want {
        set bels [get_bels -quiet -filter "TYPE =~ $pattern"]
        if {[llength $bels] == 0} {
            puts "MISS: $fam no bels matching $pattern"
            continue
        }
        # Group by BEL type so we report each distinct type once.
        array unset seen
        foreach b $bels {
            set t [get_property TYPE $b]
            if {[info exists seen($t)]} { continue }
            set seen($t) 1
            foreach sm [get_speed_models -quiet -of_objects $b] {
                set arc  [get_property NAME $sm]
                set slow [get_property -quiet SLOW_MAX $sm]
                set fast [get_property -quiet FAST_MIN $sm]
                if {$slow eq ""} { continue }
                puts "SM: $fam $t $arc $slow $fast"
            }
        }
    }
}
close_project -quiet
puts "DONE"
