export function boundaryFaninRequest(
  node: number,
  label: string,
  rootPort: string,
  rootPortBit?: number,
) {
  return {
    node,
    dir: 'fanin' as const,
    label,
    rootPort,
    rootPortBit,
  }
}

export function boundaryPathPinSelection(
  endpointKind: string,
  endpointPort: string,
  bits: number[],
) {
  return endpointKind === 'blackbox'
    ? { rootPort: endpointPort, rootPortBits: bits }
    : {}
}
