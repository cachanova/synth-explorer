import { describe, expect, it } from 'vitest'
import {
  BASELINE_ELK_LAYOUT_LAB_CONFIG,
  elkLayoutStudyFromConfig,
  normalizeElkLayoutLabConfig,
} from './elkLayoutLab'

describe('ELK layout lab configuration', () => {
  it('maps the universal baseline without replacing ELK automatic policies', () => {
    expect(
      elkLayoutStudyFromConfig(BASELINE_ELK_LAYOUT_LAB_CONFIG).layoutOptions,
    ).toEqual({
      'elk.layered.spacing.nodeNodeBetweenLayers': '66',
      'elk.spacing.nodeNode': '30',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.mergeEdges': 'true',
    })
  })

  it('maps every optional readability control to the installed ELK option', () => {
    expect(
      elkLayoutStudyFromConfig({
        ...BASELINE_ELK_LAYOUT_LAB_CONFIG,
        greedySwitch: 'on',
        thoroughness: '7',
        mergeEdges: false,
        favorStraightEdges: 'on',
        crossingStrategy: 'MEDIAN_LAYER_SWEEP',
      }).layoutOptions,
    ).toMatchObject({
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '0',
      'elk.layered.thoroughness': '7',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.crossingMinimization.strategy': 'MEDIAN_LAYER_SWEEP',
    })
  })

  it('bounds persisted numbers and discards unknown enum values', () => {
    expect(normalizeElkLayoutLabConfig({
      layerSpacing: 999,
      nodeSpacing: -1,
      edgeNodeSpacing: Number.NaN,
      greedySwitch: 'sometimes',
      thoroughness: '99',
      mergeEdges: false,
      favorStraightEdges: 'off',
      crossingStrategy: 'unknown',
    })).toEqual({
      layerSpacing: 240,
      nodeSpacing: 4,
      edgeNodeSpacing: 20,
      greedySwitch: 'default',
      thoroughness: 'auto',
      mergeEdges: false,
      favorStraightEdges: 'off',
      crossingStrategy: 'default',
    })
  })
})
