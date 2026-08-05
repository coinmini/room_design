import { describe, expect, it } from 'vitest'
import {
  applyImageStacks,
  remapEdgesForStacks,
  stackEndpointMap,
  stackKeyFor,
} from './stackMath'
import { galleryGridColumns } from './StackGallery'
import type { CanvasGraphNode } from './types'

const node = (
  id: string,
  stage: string,
  overrides: Partial<CanvasGraphNode> = {},
): CanvasGraphNode => ({
  id,
  assetId: overrides.assetId ?? 'asset-1',
  variantId: id.includes(':') ? id.split(':').slice(1).join(':') : id,
  workflowStage: stage,
  label: overrides.label || id,
  url: `/img/${id}.png`,
  ...overrides,
})

describe('stackMath', () => {
  it('keys all multi-image stages by asset+stage', () => {
    expect(
      stackKeyFor(node('a:v1', 'color_plan', { assetId: 'c' })),
    ).toBe('stack:asset:c:color_plan')
    expect(
      stackKeyFor(node('a:v1', 'layout', { assetId: 'l' })),
    ).toBe('stack:asset:l:layout')
    expect(
      stackKeyFor(node('a:v1', 'axonometric', { assetId: 'x' })),
    ).toBe('stack:asset:x:axonometric')
    expect(
      stackKeyFor(node('a:v1', 'style_scheme', { assetId: 's' })),
    ).toBe('stack:asset:s:style_scheme')
    expect(
      stackKeyFor(node('a:v1', 'tone_scheme', { assetId: 't' })),
    ).toBe('stack:asset:t:tone_scheme')
    expect(
      stackKeyFor(node('a:v1', 'space_render', { assetId: 'sp' })),
    ).toBe('stack:asset:sp:space_render')
    // 单结果阶段不堆叠
    expect(
      stackKeyFor(node('a:v1', 'floorplan', { assetId: 'f' })),
    ).toBeNull()
    expect(
      stackKeyFor(node('a:v1', 'local_edit', { assetId: 'e' })),
    ).toBeNull()
  })

  it('collapses multi variants of any stackable stage', () => {
    const nodes = [
      node('c:1', 'color_plan', { label: '彩平 1', approved: true }),
      node('c:2', 'color_plan', { label: '彩平 2' }),
      node('c:3', 'color_plan', { label: '彩平 3' }),
      node('c:4', 'color_plan', { label: '彩平 4' }),
    ]
    const display = applyImageStacks(nodes, new Set())
    expect(display).toHaveLength(1)
    expect(display[0].isStack).toBe(true)
    expect(display[0].stackCount).toBe(4)
    expect(display[0].label).toMatch(/4 张/)
    expect(display[0].id).toBe('stack:asset:asset-1:color_plan')
  })

  it('stacks layout pair (≥2)', () => {
    const nodes = [
      node('l:a', 'layout', { label: '方案 A' }),
      node('l:b', 'layout', { label: '方案 B' }),
    ]
    const display = applyImageStacks(nodes, new Set())
    expect(display).toHaveLength(1)
    expect(display[0].isStack).toBe(true)
    expect(display[0].stackCount).toBe(2)
  })

  it('expands stack when key is in expanded set', () => {
    const nodes = [
      node('a:living', 'space_render', { label: '客厅' }),
      node('a:bedroom', 'space_render', { label: '卧室' }),
    ]
    const key = 'stack:asset:asset-1:space_render'
    const display = applyImageStacks(nodes, new Set([key]))
    expect(display).toHaveLength(2)
    expect(display.every((n) => n.stackExpanded)).toBe(true)
  })

  it('does not stack single image', () => {
    const nodes = [node('a:only', 'color_plan')]
    const display = applyImageStacks(nodes, new Set())
    expect(display).toHaveLength(1)
    expect(display[0].isStack).toBeFalsy()
    expect(display[0].id).toBe('a:only')
  })

  it('stacks multi skeletons of same parent stage', () => {
    const nodes = [1, 2, 3, 4].map((n) =>
      node(`skeleton:gen-1-${n}`, 'color_plan', {
        assetId: undefined,
        isSkeleton: true,
        parentAssetId: 'parent-layout',
        variantId: `gen-1-${n}`,
        label: `彩平方案 ${n}`,
        url: null,
      }),
    )
    const display = applyImageStacks(nodes, new Set())
    expect(display).toHaveLength(1)
    expect(display[0].isStack).toBe(true)
    expect(display[0].stackCount).toBe(4)
    expect(display[0].label).toMatch(/生成中/)
  })

  it('uses fixed 2×2 / max-4 page layout so each image is larger', () => {
    expect(galleryGridColumns(2)).toBe(2)
    expect(galleryGridColumns(4)).toBe(2)
    expect(galleryGridColumns(11)).toBe(2)
  })

  it('remaps edges to stack id when collapsed', () => {
    const original = [
      node('p:v1', 'color_plan', { assetId: 'p' }),
      node('a:living', 'space_render', { assetId: 'space-asset' }),
      node('a:bedroom', 'space_render', { assetId: 'space-asset' }),
    ]
    const display = applyImageStacks(original, new Set())
    const map = stackEndpointMap(original, display)
    const edges = remapEdgesForStacks(
      [
        { id: 'e1', source: 'p:v1', target: 'a:living' },
        { id: 'e2', source: 'p:v1', target: 'a:bedroom' },
      ],
      map,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].target).toBe('stack:asset:space-asset:space_render')
  })
})
