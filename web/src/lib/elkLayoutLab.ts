export type ElkLayoutLabTriState = 'default' | 'on' | 'off'
export type ElkLayoutLabThoroughness = 'auto' | '1' | '4' | '7'
export type ElkLayoutLabCrossingStrategy =
  'default' | 'LAYER_SWEEP' | 'MEDIAN_LAYER_SWEEP'

export interface ElkLayoutLabConfig {
  layerSpacing: number
  nodeSpacing: number
  edgeNodeSpacing: number
  greedySwitch: ElkLayoutLabTriState
  thoroughness: ElkLayoutLabThoroughness
  mergeEdges: boolean
  favorStraightEdges: ElkLayoutLabTriState
  crossingStrategy: ElkLayoutLabCrossingStrategy
}

export interface ElkLayoutStudy {
  layoutOptions: Record<string, string>
}

export const ELK_LAYOUT_LAB_STORAGE_KEY = 'elk-readability-study'

export const BASELINE_ELK_LAYOUT_LAB_CONFIG: ElkLayoutLabConfig = {
  layerSpacing: 66,
  nodeSpacing: 30,
  edgeNodeSpacing: 20,
  greedySwitch: 'default',
  thoroughness: 'auto',
  mergeEdges: true,
  favorStraightEdges: 'default',
  crossingStrategy: 'default',
}

const triStates = new Set<ElkLayoutLabTriState>(['default', 'on', 'off'])
const thoroughnessValues = new Set<ElkLayoutLabThoroughness>([
  'auto',
  '1',
  '4',
  '7',
])
const crossingStrategies = new Set<ElkLayoutLabCrossingStrategy>([
  'default',
  'LAYER_SWEEP',
  'MEDIAN_LAYER_SWEEP',
])

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
}

/** Normalize persisted development settings before passing them to ELK. */
export function normalizeElkLayoutLabConfig(
  value: unknown,
): ElkLayoutLabConfig {
  const candidate =
    value != null && typeof value === 'object'
      ? (value as Partial<ElkLayoutLabConfig>)
      : {}
  return {
    layerSpacing: boundedNumber(candidate.layerSpacing, 66, 8, 240),
    nodeSpacing: boundedNumber(candidate.nodeSpacing, 30, 4, 160),
    edgeNodeSpacing: boundedNumber(candidate.edgeNodeSpacing, 20, 2, 120),
    greedySwitch: triStates.has(candidate.greedySwitch as ElkLayoutLabTriState)
      ? (candidate.greedySwitch as ElkLayoutLabTriState)
      : 'default',
    thoroughness: thoroughnessValues.has(
      candidate.thoroughness as ElkLayoutLabThoroughness,
    )
      ? (candidate.thoroughness as ElkLayoutLabThoroughness)
      : 'auto',
    mergeEdges:
      typeof candidate.mergeEdges === 'boolean' ? candidate.mergeEdges : true,
    favorStraightEdges: triStates.has(
      candidate.favorStraightEdges as ElkLayoutLabTriState,
    )
      ? (candidate.favorStraightEdges as ElkLayoutLabTriState)
      : 'default',
    crossingStrategy: crossingStrategies.has(
      candidate.crossingStrategy as ElkLayoutLabCrossingStrategy,
    )
      ? (candidate.crossingStrategy as ElkLayoutLabCrossingStrategy)
      : 'default',
  }
}

/** Translate the readable development controls into ELK's string options. */
export function elkLayoutStudyFromConfig(
  config: ElkLayoutLabConfig,
): ElkLayoutStudy {
  const layoutOptions: Record<string, string> = {
    'elk.layered.spacing.nodeNodeBetweenLayers': String(config.layerSpacing),
    'elk.spacing.nodeNode': String(config.nodeSpacing),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(config.edgeNodeSpacing),
    'elk.layered.mergeEdges': String(config.mergeEdges),
  }

  if (config.greedySwitch !== 'default') {
    layoutOptions['elk.layered.crossingMinimization.greedySwitch.type'] =
      config.greedySwitch === 'on' ? 'TWO_SIDED' : 'OFF'
    if (config.greedySwitch === 'on') {
      layoutOptions[
        'elk.layered.crossingMinimization.greedySwitch.activationThreshold'
      ] = '0'
    }
  }
  if (config.thoroughness !== 'auto') {
    layoutOptions['elk.layered.thoroughness'] = config.thoroughness
  }
  if (config.favorStraightEdges !== 'default') {
    layoutOptions['elk.layered.nodePlacement.favorStraightEdges'] = String(
      config.favorStraightEdges === 'on',
    )
  }
  if (config.crossingStrategy !== 'default') {
    layoutOptions['elk.layered.crossingMinimization.strategy'] =
      config.crossingStrategy
  }

  return { layoutOptions }
}
