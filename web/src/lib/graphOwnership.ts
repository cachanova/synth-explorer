/** A retained layout is interactive only for the design that produced it. */
export function isDisplayedDesignCurrent(
  currentDesignId: string | null | undefined,
  displayedDesignId: string | null | undefined,
): boolean {
  return currentDesignId != null && displayedDesignId === currentDesignId
}
