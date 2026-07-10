const fallback = {
  logic: '#58a6ff',
  'logic-solid': '#1f6feb',
  secondary: '#bc8cff',
  wire: '#9aa4b2',
  'wire-dim': '#3a4657',
  canvas: '#0d1117',
}

function color(tone) {
  return 'var(--' + tone + ', ' + fallback[tone] + ')'
}

function path(d, tone = 'logic', width = 3.2, extra = '') {
  return (
    '<path d="' +
    d +
    '" fill="none" stroke="' +
    color(tone) +
    '" stroke-width="' +
    width +
    '" stroke-linecap="round" stroke-linejoin="round" ' +
    extra +
    '/>'
  )
}

function filledPath(d, tone = 'logic-solid', extra = '') {
  return '<path d="' + d + '" fill="' + color(tone) + '" ' + extra + '/>'
}

function dot(x, y, tone = 'logic', radius = 3.2) {
  return '<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + color(tone) + '"/>'
}

function ring(x, y, tone = 'logic', radius = 4.2, width = 2.6) {
  return (
    '<circle cx="' +
    x +
    '" cy="' +
    y +
    '" r="' +
    radius +
    '" fill="none" stroke="' +
    color(tone) +
    '" stroke-width="' +
    width +
    '"/>'
  )
}

function rect(x, y, width, height, tone = 'logic', radius = 3, strokeWidth = 2.8) {
  return (
    '<rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    width +
    '" height="' +
    height +
    '" rx="' +
    radius +
    '" fill="none" stroke="' +
    color(tone) +
    '" stroke-width="' +
    strokeWidth +
    '"/>'
  )
}

function group(body, transform) {
  return '<g transform="' + transform + '">' + body + '</g>'
}

function xorCore(tone = 'logic', arcTone = tone, width = 3.2) {
  return (
    path('M17 14c14 0 25 6 33 18-8 12-19 18-33 18 7-11 7-25 0-36Z', tone, width) +
    path('M11 14c7 11 7 25 0 36', arcTone, width)
  )
}

function xorClassic(tone = 'logic', arcTone = tone, wireTone = 'wire') {
  return (
    path('M4 22h16M4 42h16M50 32h10', wireTone, 3) +
    xorCore(tone, arcTone) +
    dot(60, 32, tone, 2.6)
  )
}

function orCore(tone = 'logic', width = 3.2) {
  return path('M15 14c14 0 26 6 35 18-9 12-21 18-35 18 7-11 7-25 0-36Z', tone, width)
}

function andCore(tone = 'logic', width = 3.2) {
  return path('M15 14h15c13 0 21 7 21 18s-8 18-21 18H15Z', tone, width)
}

function inverter(tone = 'logic', width = 3.2) {
  return path('M16 15v34l30-17Z', tone, width) + ring(50, 32, tone, 3, width)
}

function svgMarkup(logo) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    logo.draw() +
    '</svg>'
  )
}

const logos = [
  {
    id: 'X01',
    family: 'xor',
    name: 'XOR Fanout',
    note: 'A logic gate opening into two explorable paths.',
    tags: 'branch cone graph endpoint',
    draw: () =>
      path('M4 22h16M4 42h16', 'wire', 3) +
      xorCore() +
      path('M50 32h4m0 0 6-8m-6 8 6 8', 'logic', 3.2) +
      dot(60, 24, 'secondary', 3) +
      dot(60, 40, 'secondary', 3),
  },
  {
    id: 'X02',
    family: 'xor',
    name: 'Open XOR',
    note: 'The most direct, diagram-literate option.',
    tags: 'classic simple gate pure',
    draw: () => xorClassic(),
  },
  {
    id: 'X03',
    family: 'xor',
    name: 'XOR Probe',
    note: 'A selected output node turns the gate into an explorer.',
    tags: 'inspect endpoint target selected',
    draw: () =>
      path('M4 22h16M4 42h16', 'wire', 3) +
      xorCore() +
      path('M50 32h5', 'logic', 3.2) +
      ring(59, 32, 'secondary', 4.2, 2.5) +
      dot(59, 32, 'secondary', 1.8),
  },
  {
    id: 'X04',
    family: 'xor',
    name: 'XOR Aperture',
    note: 'An open inspection ring frames a compact gate.',
    tags: 'lens orbit inspect circle',
    draw: () =>
      path('M11 48A25 25 0 1 1 53 18', 'wire-dim', 2.7) +
      path('M48 11v9h9', 'secondary', 2.7) +
      group(xorClassic('logic', 'logic', 'wire'), 'translate(11 11) scale(.66)'),
  },
  {
    id: 'X05',
    family: 'xor',
    name: 'Split XOR',
    note: 'Purple separates the XOR cue from the logic body.',
    tags: 'two tone purple offset arc',
    draw: () => xorClassic('logic', 'secondary', 'wire'),
  },
  {
    id: 'X06',
    family: 'xor',
    name: 'Solid XOR',
    note: 'A bold cutout silhouette built for favicon scale.',
    tags: 'filled compact favicon strong',
    draw: () =>
      path('M3 22h17M3 42h17M49 32h12', 'logic-solid', 4) +
      filledPath('M17 13c14 0 25 6 34 19-9 13-20 19-34 19 7-12 7-26 0-38Z') +
      path('M10 12c8 12 8 28 0 40', 'canvas', 4.6),
  },
  {
    id: 'X07',
    family: 'xor',
    name: 'XOR in Path',
    note: 'One highlighted route passes through a compact gate.',
    tags: 'diagonal route graph source',
    draw: () =>
      path('M7 51 24 39M41 25 57 12M7 51 44 52', 'wire-dim', 2.5) +
      dot(7, 51, 'wire', 3.2) +
      dot(57, 12, 'secondary', 3.2) +
      dot(44, 52, 'wire-dim', 2.8) +
      group(xorCore(), 'translate(11 10) scale(.68)') +
      path('M20 42 43 23', 'logic', 3),
  },
  {
    id: 'X08',
    family: 'xor',
    name: 'XOR Cone',
    note: 'Source nodes converge, then resolve to one endpoint.',
    tags: 'fanin endpoint sources cone',
    draw: () =>
      dot(6, 20, 'wire', 3) +
      dot(6, 44, 'wire', 3) +
      path('M9 20 20 25M9 44 20 39', 'wire', 2.7) +
      group(xorCore(), 'translate(10 11) scale(.66)') +
      path('M43 32h9', 'logic', 3) +
      ring(57, 32, 'secondary', 4.2, 2.6),
  },
  {
    id: 'X09',
    family: 'xor',
    name: 'Gate Crosshair',
    note: 'Corner marks suggest inspection without a literal lens.',
    tags: 'focus inspect corners target',
    draw: () =>
      path('M8 20V8h12M44 8h12v12M56 44v12H44M20 56H8V44', 'wire-dim', 2.8) +
      group(xorClassic(), 'translate(11 11) scale(.66)'),
  },
  {
    id: 'X10',
    family: 'xor',
    name: 'XOR Ladder',
    note: 'Two gates step through a compact transformation path.',
    tags: 'cascade chain diagonal double',
    draw: () =>
      group(xorCore(), 'translate(0 4) scale(.44)') +
      group(xorCore('secondary', 'secondary'), 'translate(34 31) scale(.44)') +
      path('M22 18h8v25h8', 'wire', 2.8) +
      dot(4, 14, 'wire', 2.5) +
      dot(60, 45, 'secondary', 2.5),
  },

  {
    id: 'G01',
    family: 'gates',
    name: 'Half Adder',
    note: 'XOR and AND share input rails in a compact stack.',
    tags: 'adder pair and xor arithmetic',
    draw: () =>
      path('M7 17v30M7 17h13M7 47h13M12 26h8M12 38h8', 'wire', 2.5) +
      group(xorCore(), 'translate(12 -1) scale(.48)') +
      group(andCore('secondary'), 'translate(12 30) scale(.48)') +
      path('M36 14h20M36 45h20', 'logic', 2.7) +
      dot(58, 14, 'logic', 2.5) +
      dot(58, 45, 'secondary', 2.5),
  },
  {
    id: 'G02',
    family: 'gates',
    name: 'AND to XOR',
    note: 'A two-cell path with the second gate highlighted.',
    tags: 'cascade cell path combinational',
    draw: () =>
      group(andCore('wire'), 'translate(-1 14) scale(.48)') +
      path('M23 29h12', 'wire', 2.8) +
      group(xorCore(), 'translate(29 13) scale(.5)') +
      path('M54 29h7', 'logic', 2.8) +
      dot(61, 29, 'secondary', 2.5),
  },
  {
    id: 'G03',
    family: 'gates',
    name: 'XOR to OR',
    note: 'A logic chain that stays readable without labels.',
    tags: 'cascade cell path or',
    draw: () =>
      group(xorCore(), 'translate(-1 14) scale(.48)') +
      path('M23 29h12', 'logic', 2.8) +
      group(orCore('secondary'), 'translate(29 13) scale(.5)') +
      path('M54 29h7', 'secondary', 2.8) +
      dot(61, 29, 'secondary', 2.5),
  },
  {
    id: 'G04',
    family: 'gates',
    name: 'MUX Route',
    note: 'One selected input crosses a simplified multiplexer.',
    tags: 'mux selection route inputs',
    draw: () =>
      path('M5 16h14M5 27h14M5 38h14M5 49h14', 'wire-dim', 2.6) +
      path('M5 27h14', 'logic', 3.4) +
      path('M19 10 45 17v30l-26 7Z', 'wire', 3) +
      path('M45 32h13', 'logic', 3.2) +
      dot(58, 32, 'secondary', 3),
  },
  {
    id: 'G05',
    family: 'gates',
    name: 'Inverter Trail',
    note: 'Two inversion bubbles create a rhythmic signal path.',
    tags: 'not bubbles chain trail',
    draw: () =>
      group(inverter('logic'), 'translate(-2 12) scale(.55)') +
      path('M28 30h8v13h5', 'wire', 2.8) +
      group(inverter('secondary'), 'translate(31 25) scale(.48)') +
      dot(61, 40, 'secondary', 2.5),
  },
  {
    id: 'G06',
    family: 'gates',
    name: 'Gate Stack',
    note: 'Parallel AND and OR paths meet at a selected node.',
    tags: 'parallel stack merge node',
    draw: () =>
      group(andCore('logic'), 'translate(6 -1) scale(.46)') +
      group(orCore('secondary'), 'translate(6 31) scale(.46)') +
      path('M30 14h11v18h10M30 46h11V32', 'wire', 2.6) +
      ring(55, 32, 'logic', 4, 2.5),
  },
  {
    id: 'G07',
    family: 'gates',
    name: 'Converging Gates',
    note: 'Two distinct logic cells resolve to one endpoint.',
    tags: 'fanin converge endpoint pair',
    draw: () =>
      group(andCore('wire'), 'translate(-1 -1) scale(.46)') +
      group(xorCore('logic', 'logic'), 'translate(-1 33) scale(.44)') +
      path('M23 14 45 30M23 48 45 34', 'wire', 2.7) +
      path('M45 32h10', 'logic', 3) +
      dot(58, 32, 'secondary', 3),
  },
  {
    id: 'G08',
    family: 'gates',
    name: 'Mirrored XORs',
    note: 'Opposing gate silhouettes create an abstract X.',
    tags: 'mirror negative space pair x',
    draw: () =>
      group(xorCore('logic', 'logic'), 'translate(-3 13) scale(.52)') +
      group(xorCore('secondary', 'secondary'), 'translate(67 13) scale(-.52 .52)') +
      dot(32, 30, 'wire', 3),
  },
  {
    id: 'G09',
    family: 'gates',
    name: 'Logic Quilt',
    note: 'Four simplified cells form a compact component field.',
    tags: 'grid cells library symbols',
    draw: () =>
      group(andCore('logic'), 'translate(1 0) scale(.38)') +
      group(orCore('secondary'), 'translate(34 0) scale(.38)') +
      group(xorCore('secondary', 'logic'), 'translate(1 34) scale(.38)') +
      group(inverter('logic'), 'translate(34 34) scale(.38)'),
  },
  {
    id: 'G10',
    family: 'gates',
    name: 'Gate Portal',
    note: 'A single AND cell held inside source-like brackets.',
    tags: 'brackets cell code portal',
    draw: () =>
      path('M18 8H8v48h10M46 8h10v48H46', 'wire-dim', 3) +
      group(andCore('logic'), 'translate(10 10) scale(.7)') +
      dot(56, 32, 'secondary', 2.8),
  },

  {
    id: 'S01',
    family: 'signal',
    name: 'Edge Node',
    note: 'A single rising edge with a selected sample point.',
    tags: 'clock pulse rising waveform',
    draw: () => path('M6 43h13V20h24v23h15', 'logic', 4) + dot(19, 20, 'secondary', 4),
  },
  {
    id: 'S02',
    family: 'signal',
    name: 'Pulse Arrow',
    note: 'A pulse resolves into forward motion.',
    tags: 'clock waveform arrow direction',
    draw: () =>
      path('M5 43h12V19h21v24h15', 'logic', 4) +
      path('m48 36 9 7-9 7', 'secondary', 3.4),
  },
  {
    id: 'S03',
    family: 'signal',
    name: 'Phase Pair',
    note: 'Two offset signals create depth without a clock face.',
    tags: 'waveform dual phase purple',
    draw: () =>
      path('M5 38h12V16h20v22h20', 'logic', 3.6) +
      path('M5 49h23V27h20v22h9', 'secondary', 3.6),
  },
  {
    id: 'S04',
    family: 'signal',
    name: 'Waveform S',
    note: 'A signal trace bends into a compact circuit S.',
    tags: 'clock monogram s pulse',
    draw: () =>
      path('M52 10H20v20h25v24H12', 'logic', 4) +
      dot(52, 10, 'secondary', 3.5) +
      dot(12, 54, 'secondary', 3.5),
  },
  {
    id: 'S05',
    family: 'signal',
    name: 'Signal Fanout',
    note: 'A rising edge immediately opens into two paths.',
    tags: 'clock branch fanout waveform',
    draw: () =>
      path('M5 44h14V22h17', 'logic', 3.8) +
      path('M36 22h6l15-10M42 22l15 13', 'wire', 3) +
      dot(58, 11, 'secondary', 3) +
      dot(58, 36, 'secondary', 3),
  },
  {
    id: 'S06',
    family: 'signal',
    name: 'Edge Window',
    note: 'Inspection corners isolate one decisive signal edge.',
    tags: 'clock focus corners inspect',
    draw: () =>
      path('M7 20V8h12M45 8h12v12M57 44v12H45M19 56H7V44', 'wire-dim', 2.8) +
      path('M14 43h15V21h21', 'logic', 4) +
      dot(29, 21, 'secondary', 3.2),
  },
  {
    id: 'S07',
    family: 'signal',
    name: 'Dual Edge X',
    note: 'Rising and falling traces cross with a wire bridge.',
    tags: 'clock crossing x bridge signal',
    draw: () =>
      path('M7 48h14V16h36', 'logic', 3.6) +
      path('M7 16h18v13c0 4 5 4 5 0v-2h9v21h18', 'secondary', 3.6),
  },
  {
    id: 'S08',
    family: 'signal',
    name: 'Signal Loop',
    note: 'A looping route contains one sharp pulse transition.',
    tags: 'cycle loop waveform route',
    draw: () =>
      path('M20 12h23a10 10 0 0 1 10 10v20a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42V31h13V18h20', 'wire', 3.4) +
      path('M10 31h13V18h20', 'logic', 3.8) +
      dot(43, 18, 'secondary', 3.2),
  },
  {
    id: 'S09',
    family: 'signal',
    name: 'Bitstream',
    note: 'Discrete states become a forward-moving schematic trace.',
    tags: 'bits digital stream nodes',
    draw: () =>
      path('M6 40h8V23h9v17h9V23h9v17h9V23h8', 'wire-dim', 3.2) +
      path('M6 40h8V23h9v17h9', 'logic', 3.7) +
      dot(58, 23, 'secondary', 3),
  },

  {
    id: 'N01',
    family: 'netlist',
    name: 'Layered Cone',
    note: 'One source, two layers, and one highlighted route.',
    tags: 'graph cone path nodes endpoint',
    draw: () =>
      path('M9 32 25 15 50 32M9 32l16 17 25-17M25 15v34', 'wire-dim', 2.7) +
      path('M9 32 25 15 50 32', 'logic', 3.5) +
      dot(9, 32, 'wire', 3.2) +
      dot(25, 15, 'logic', 3.2) +
      dot(25, 49, 'wire-dim', 3.2) +
      ring(54, 32, 'secondary', 4, 2.6),
  },
  {
    id: 'N02',
    family: 'netlist',
    name: 'Highlighted Diamond',
    note: 'A single route is selected through a compact netlist.',
    tags: 'graph path diamond nodes',
    draw: () =>
      path('M8 32 32 9l24 23-24 23ZM32 9v46', 'wire-dim', 2.8) +
      path('M8 32 32 9l24 23', 'logic', 3.6) +
      dot(8, 32, 'wire', 3.2) +
      dot(32, 9, 'logic', 3.2) +
      dot(32, 55, 'wire-dim', 3.2) +
      dot(56, 32, 'secondary', 3.4),
  },
  {
    id: 'N03',
    family: 'netlist',
    name: 'Longest Path Stair',
    note: 'An orthogonal route climbs through three structural nodes.',
    tags: 'depth stair graph route longest',
    draw: () =>
      path('M8 51h13V39h15V26h16V12h6', 'logic', 3.7) +
      path('M21 39 36 51M36 26 49 39', 'wire-dim', 2.6) +
      dot(8, 51, 'wire', 3.1) +
      dot(21, 39, 'logic', 3.1) +
      dot(36, 26, 'logic', 3.1) +
      dot(52, 12, 'secondary', 3.4),
  },
  {
    id: 'N04',
    family: 'netlist',
    name: 'Fanout Y',
    note: 'One source opens into three inspectable endpoints.',
    tags: 'graph branch share node endpoints',
    draw: () =>
      path('M9 32h17M26 32 50 13M26 32h25M26 32l24 19', 'wire', 3.2) +
      dot(9, 32, 'logic', 4) +
      dot(53, 12, 'secondary', 3.2) +
      dot(54, 32, 'secondary', 3.2) +
      dot(53, 52, 'secondary', 3.2),
  },
  {
    id: 'N05',
    family: 'netlist',
    name: 'Fanin Y',
    note: 'Three source paths converge on one selected endpoint.',
    tags: 'graph converge sources endpoint',
    draw: () =>
      path('M10 13 34 32M10 32h24M10 51l24-19h17', 'wire', 3.2) +
      dot(8, 12, 'wire', 3.2) +
      dot(8, 32, 'wire', 3.2) +
      dot(8, 52, 'wire', 3.2) +
      ring(55, 32, 'secondary', 4.4, 2.8),
  },
  {
    id: 'N06',
    family: 'netlist',
    name: 'Selected Hub',
    note: 'A ringed node anchors three graph directions.',
    tags: 'graph network hub selected spokes',
    draw: () =>
      path('M32 32 12 13M32 32l22-15M32 32l18 22', 'wire-dim', 3) +
      path('M32 32 12 13', 'logic', 3.8) +
      ring(32, 32, 'secondary', 6, 3) +
      dot(12, 13, 'logic', 3.5) +
      dot(54, 17, 'wire-dim', 3.2) +
      dot(50, 54, 'wire-dim', 3.2),
  },
  {
    id: 'N07',
    family: 'netlist',
    name: 'Route Finder',
    note: 'One blue route threads a muted node field.',
    tags: 'maze path explorer graph grid',
    draw: () =>
      path('M9 11h18v15h15V12h13M9 52h13V38h20v14h13M27 11v27M42 26v12', 'wire-dim', 2.5) +
      path('M9 52h13V38h20V26h13V12', 'logic', 3.6) +
      dot(9, 52, 'wire', 3.2) +
      dot(55, 12, 'secondary', 3.4),
  },
  {
    id: 'N08',
    family: 'netlist',
    name: 'Probe Mesh',
    note: 'A selected node surfaces from a small circuit mesh.',
    tags: 'inspect probe graph mesh focus',
    draw: () =>
      path('M9 16h18l10 16 18-13M9 48h18l10-16 18 13M27 16v32', 'wire-dim', 2.5) +
      path('M9 48h18l10-16', 'logic', 3.5) +
      ring(37, 32, 'secondary', 5, 2.8) +
      dot(9, 16, 'wire-dim', 2.8) +
      dot(9, 48, 'logic', 3.1) +
      dot(55, 19, 'wire-dim', 2.8) +
      dot(55, 45, 'wire-dim', 2.8),
  },
  {
    id: 'N09',
    family: 'netlist',
    name: 'Cell Chain',
    note: 'Three generic netlist cells connected in a clean path.',
    tags: 'cells boxes chain graph',
    draw: () =>
      rect(5, 24, 14, 16, 'wire', 2.5, 2.6) +
      rect(25, 14, 14, 16, 'logic', 2.5, 2.8) +
      rect(45, 29, 14, 16, 'secondary', 2.5, 2.8) +
      path('M19 32h6V22M39 22h6v15', 'wire', 2.7),
  },
  {
    id: 'N10',
    family: 'netlist',
    name: 'Logic Lens',
    note: 'A graph path passes beneath an inspection lens.',
    tags: 'explorer inspect lens graph path',
    draw: () =>
      path('M7 46 23 35 38 40 51 25', 'wire-dim', 2.7) +
      path('M7 46 23 35 38 40', 'logic', 3.5) +
      dot(7, 46, 'wire', 3) +
      dot(23, 35, 'logic', 3) +
      dot(38, 40, 'logic', 3) +
      ring(39, 26, 'secondary', 13, 3) +
      path('m48 36 9 9', 'secondary', 3.4),
  },

  {
    id: 'M01',
    family: 'monogram',
    name: 'Circuit S',
    note: 'A single orthogonal trace forms an ownable S.',
    tags: 'letter synth s circuit trace',
    draw: () =>
      path('M51 12H22c-7 0-11 4-11 10s4 10 11 10h20c7 0 11 4 11 10S49 52 42 52H13', 'logic', 4.2) +
      dot(51, 12, 'secondary', 3.6) +
      dot(13, 52, 'secondary', 3.6),
  },
  {
    id: 'M02',
    family: 'monogram',
    name: 'Split Rail S',
    note: 'Blue and purple rails carve an S in negative space.',
    tags: 'letter s dual circuit rails',
    draw: () =>
      path('M52 11H23c-8 0-13 4-13 10s5 10 13 10h18c8 0 13 4 13 11s-5 11-13 11H12', 'logic', 3.4) +
      path('M52 18H24c-3 0-5 1-5 3s2 3 5 3h18c13 0 21 7 21 18S55 60 42 60H12', 'secondary', 3.4),
  },
  {
    id: 'M03',
    family: 'monogram',
    name: 'X Bridge',
    note: 'Crossing schematic wires turn the letter X into a circuit.',
    tags: 'letter x crossover bridge trace',
    draw: () =>
      path('M10 10 54 54', 'logic', 4) +
      path('M54 10 37 27c-4 4-10-2-6-6l2-2-23 35', 'secondary', 4) +
      dot(10, 10, 'logic', 3.4) +
      dot(54, 54, 'logic', 3.4) +
      dot(54, 10, 'secondary', 3.4) +
      dot(10, 54, 'secondary', 3.4),
  },
  {
    id: 'M04',
    family: 'monogram',
    name: 'Node S',
    note: 'Three connected nodes imply both synthesis and traversal.',
    tags: 'letter s graph nodes curve',
    draw: () =>
      path('M51 13C20 5 11 18 19 29s34 3 27 20C41 60 19 56 12 51', 'logic', 4) +
      dot(51, 13, 'secondary', 3.6) +
      dot(32, 32, 'logic', 3.6) +
      dot(12, 51, 'secondary', 3.6),
  },
  {
    id: 'M05',
    family: 'monogram',
    name: 'SX Ligature',
    note: 'An S-shaped trace exits into a branching X.',
    tags: 'letters sx synth explorer branch',
    draw: () =>
      path('M34 11H17v16h17v10H15v16h19', 'logic', 3.8) +
      path('M34 32 55 12M34 32l21 21', 'secondary', 3.8) +
      dot(55, 12, 'secondary', 3.2) +
      dot(55, 53, 'secondary', 3.2),
  },
  {
    id: 'M06',
    family: 'monogram',
    name: 'X Junction',
    note: 'Four terminal traces meet at a central via.',
    tags: 'letter x node junction circuit',
    draw: () =>
      path('M10 10 54 54M54 10 10 54', 'wire', 3.8) +
      path('M10 10 32 32 54 10', 'logic', 4.2) +
      dot(10, 10, 'logic', 3.4) +
      dot(54, 10, 'logic', 3.4) +
      dot(10, 54, 'wire', 3.2) +
      dot(54, 54, 'wire', 3.2) +
      dot(32, 32, 'secondary', 4.1),
  },
  {
    id: 'M07',
    family: 'monogram',
    name: 'Explorer E',
    note: 'An E-shaped circuit ends each rail in a node.',
    tags: 'letter e explorer circuit terminals',
    draw: () =>
      path('M17 11v42M17 12h32M17 32h25M17 52h32', 'logic', 4) +
      dot(49, 12, 'secondary', 3.4) +
      dot(42, 32, 'secondary', 3.4) +
      dot(49, 52, 'secondary', 3.4),
  },
  {
    id: 'M08',
    family: 'monogram',
    name: 'Bracket X',
    note: 'Code-like brackets frame an energized X path.',
    tags: 'letter x code brackets source',
    draw: () =>
      path('M20 10 7 32l13 22M44 10l13 22-13 22', 'wire-dim', 3.6) +
      path('M24 20 40 44M40 20 24 44', 'logic', 4) +
      dot(32, 32, 'secondary', 3.2),
  },
  {
    id: 'M09',
    family: 'monogram',
    name: 'Signal SE',
    note: 'A compact S-to-E handoff joins the product initials.',
    tags: 'letters se initials synth explorer',
    draw: () =>
      path('M30 12H13v17h17v23H11', 'logic', 3.7) +
      path('M37 12v40M37 12h17M37 32h14M37 52h17', 'secondary', 3.7) +
      dot(54, 12, 'secondary', 2.8) +
      dot(54, 52, 'secondary', 2.8),
  },
]

const familyNames = {
  xor: 'XOR',
  gates: 'Gates',
  signal: 'Signal',
  netlist: 'Netlist',
  monogram: 'Monogram',
}

const grid = document.querySelector('#logo-grid')
const noResults = document.querySelector('#no-results')
const resultCount = document.querySelector('#result-count')
const totalCount = document.querySelector('#total-count')
const search = document.querySelector('#search')
const filters = document.querySelector('#filters')
const selectedStage = document.querySelector('#selected-stage')
const selectionId = document.querySelector('#selection-id')
const decisionTitle = document.querySelector('#decision-title')
const decisionNote = document.querySelector('#decision-note')
const lockup = document.querySelector('#lockup-preview')
const lockupMark = document.querySelector('#lockup-mark')
const preview16 = document.querySelector('#preview-16')
const preview24 = document.querySelector('#preview-24')
const preview32 = document.querySelector('#preview-32')
const copyChoice = document.querySelector('#copy-choice')
const clearChoice = document.querySelector('#clear-choice')
const toast = document.querySelector('#toast')

let activeFamily = 'all'
let query = ''
let selected = null
let previewTheme = 'dark'
let toastTimer = null

function readStoredChoice() {
  try {
    return localStorage.getItem('synth-explorer-logo-choice')
  } catch {
    return null
  }
}

function storeChoice(id) {
  try {
    localStorage.setItem('synth-explorer-logo-choice', id)
  } catch {
    // URL state still preserves the choice when storage is unavailable.
  }
}

function removeStoredChoice() {
  try {
    localStorage.removeItem('synth-explorer-logo-choice')
  } catch {
    // Clearing the URL still clears the visible choice.
  }
}

function createPreview(markup, className) {
  const element = document.createElement('div')
  element.className = className
  element.innerHTML = markup
  return element
}

function createCard(logo) {
  const card = document.createElement('label')
  card.className = 'logo-card theme-dark'
  card.dataset.id = logo.id

  const radio = document.createElement('input')
  radio.type = 'radio'
  radio.name = 'logo-choice'
  radio.value = logo.id
  radio.className = 'logo-radio'
  radio.checked = selected?.id === logo.id

  const topline = document.createElement('div')
  topline.className = 'card-topline'

  const id = document.createElement('span')
  id.className = 'card-id'
  id.textContent = logo.id

  const family = document.createElement('span')
  family.className = 'card-family'
  family.textContent = familyNames[logo.family]

  topline.append(id, family)

  const stage = createPreview(svgMarkup(logo), 'card-stage theme-dark')

  const copy = document.createElement('div')
  copy.className = 'card-copy'

  const name = document.createElement('h3')
  name.textContent = logo.name

  const note = document.createElement('p')
  note.textContent = logo.note

  copy.append(name, note)

  const microRow = document.createElement('div')
  microRow.className = 'micro-row'

  const microLabel = document.createElement('span')
  microLabel.className = 'micro-label'
  microLabel.textContent = '16 px check'

  const darkMicro = createPreview(svgMarkup(logo), 'micro theme-dark')
  const lightMicro = createPreview(svgMarkup(logo), 'micro theme-light')
  microRow.append(microLabel, darkMicro, lightMicro)

  card.append(radio, topline, stage, copy, microRow)
  radio.addEventListener('change', () => {
    if (radio.checked) selectLogo(logo, true)
  })

  if (selected?.id === logo.id) card.classList.add('selected')
  return card
}

function renderGrid() {
  const normalized = query.trim().toLowerCase()
  const visible = logos.filter((logo) => {
    const familyMatch = activeFamily === 'all' || logo.family === activeFamily
    const haystack = (logo.id + ' ' + logo.name + ' ' + logo.note + ' ' + logo.tags).toLowerCase()
    return familyMatch && (!normalized || haystack.includes(normalized))
  })

  grid.replaceChildren(...visible.map(createCard))
  resultCount.textContent = visible.length + (visible.length === 1 ? ' option' : ' options')
  noResults.hidden = visible.length !== 0
}

function updateThemeClasses() {
  const dark = previewTheme === 'dark'
  selectedStage.classList.toggle('theme-dark', dark)
  selectedStage.classList.toggle('theme-light', !dark)
  lockup.classList.toggle('theme-dark', dark)
  lockup.classList.toggle('theme-light', !dark)

  document.querySelectorAll('.theme-button').forEach((button) => {
    const active = button.dataset.theme === previewTheme
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  })
}

function selectLogo(logo, updateLocation) {
  selected = logo
  const markup = svgMarkup(logo)

  selectedStage.innerHTML = markup
  lockupMark.innerHTML = markup
  preview16.innerHTML = markup
  preview24.innerHTML = markup
  preview32.innerHTML = markup
  selectionId.textContent = logo.id
  decisionTitle.textContent = logo.name
  decisionNote.textContent = logo.note
  copyChoice.disabled = false
  clearChoice.disabled = false

  storeChoice(logo.id)
  if (updateLocation) history.replaceState(null, '', '#' + logo.id.toLowerCase())

  document.querySelectorAll('.logo-card').forEach((card) => {
    const active = card.dataset.id === logo.id
    card.classList.toggle('selected', active)
    card.querySelector('.logo-radio').checked = active
  })
}

function clearSelection() {
  selected = null
  selectedStage.innerHTML = '<div class="empty-mark" aria-hidden="true">?</div>'
  lockupMark.replaceChildren()
  preview16.replaceChildren()
  preview24.replaceChildren()
  preview32.replaceChildren()
  selectionId.textContent = 'None'
  decisionTitle.textContent = 'Pick a mark'
  decisionNote.textContent = 'Click any option to see it in context and save the choice.'
  copyChoice.disabled = true
  clearChoice.disabled = true
  removeStoredChoice()
  history.replaceState(null, '', location.pathname + location.search)

  document.querySelectorAll('.logo-card').forEach((card) => {
    card.classList.remove('selected')
    card.querySelector('.logo-radio').checked = false
  })
}

function showToast(message) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add('visible')
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2200)
}

async function copySelection() {
  if (!selected) return
  const choice = 'Synth Explorer logo choice: ' + selected.id + ' — ' + selected.name + '\n' + location.href

  let copied = false

  try {
    await navigator.clipboard.writeText(choice)
    copied = true
  } catch {
    let textarea = null
    try {
      textarea = document.createElement('textarea')
      textarea.value = choice
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      copied = document.execCommand('copy')
    } catch {
      copied = false
    } finally {
      textarea?.remove()
    }
  }

  showToast(
    copied
      ? 'Copied ' + selected.id + ' — ' + selected.name
      : 'Copy failed — selection is ' + selected.id + ' — ' + selected.name,
  )
}

filters.addEventListener('click', (event) => {
  const button = event.target.closest('.filter')
  if (!button) return
  activeFamily = button.dataset.family

  filters.querySelectorAll('.filter').forEach((filter) => {
    const active = filter === button
    filter.classList.toggle('active', active)
    filter.setAttribute('aria-pressed', active ? 'true' : 'false')
  })
  renderGrid()
})

search.addEventListener('input', () => {
  query = search.value
  renderGrid()
})

document.querySelectorAll('.theme-button').forEach((button) => {
  button.addEventListener('click', () => {
    previewTheme = button.dataset.theme
    updateThemeClasses()
  })
})

copyChoice.addEventListener('click', copySelection)
clearChoice.addEventListener('click', clearSelection)

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1).toUpperCase()
  const match = logos.find((logo) => logo.id === id)
  if (match) selectLogo(match, false)
  else clearSelection()
})

function initialSelection() {
  const hashId = location.hash.slice(1).toUpperCase()
  const storedId = readStoredChoice()

  if (hashId) {
    const hashMatch = logos.find((logo) => logo.id === hashId)
    if (hashMatch) selectLogo(hashMatch, false)
    else clearSelection()
    return
  }

  const storedMatch = logos.find((logo) => logo.id === storedId)
  if (storedMatch) selectLogo(storedMatch, true)
}

totalCount.textContent = logos.length
renderGrid()
updateThemeClasses()
initialSelection()
