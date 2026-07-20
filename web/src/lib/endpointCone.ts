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
