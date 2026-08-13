/** A retained layout is interactive only for the design that produced it. */
export function isDisplayedDesignCurrent(
  currentDesignId: string | null | undefined,
  displayedDesignId: string | null | undefined,
): boolean {
  return currentDesignId != null && displayedDesignId === currentDesignId
}

/** A cone request is interactive only while its originating design is current. */
export function isRequestDesignMismatch(
  currentDesignId: string | null | undefined,
  request: { kind: string; designId?: string } | null | undefined,
): boolean {
  return currentDesignId != null && request?.kind === 'cone' && request.designId !== currentDesignId
}
