import { describe, expect, it } from 'vitest'
import {
  canvasToScreen,
  handoffJobToAsset,
  layoutGraphByStage,
  nodeIdentity,
  resolveFlowEdges,
  screenToCanvas,
  zoomPercent,
} from './layoutMath'
import type { CanvasGraphNode } from './types'

describe('layoutMath', () => {
  it('lays out nodes by workflowStage columns', () => {
    const nodes: CanvasGraphNode[] = [
      {
        id: 'a:v1',
        assetId: 'a',
        variantId: 'v1',
        workflowStage: 'color_plan',
      },
      {
        id: 'b:v1',
        assetId: 'b',
        variantId: 'v1',
        workflowStage: 'style_scheme',
      },
      {
        id: 'a:v2',
        assetId: 'a',
        variantId: 'v2',
        workflowStage: 'color_plan',
      },
    ]
    const laid = layoutGraphByStage(nodes)
    expect(laid).toHaveLength(3)
    const color = laid.filter((n) => n.workflowStage === 'color_plan')
    const style = laid.filter((n) => n.workflowStage === 'style_scheme')
    expect(color[0].x).toBe(color[1].x)
    expect(color[1].y).toBeGreaterThan(color[0].y)
    expect(style[0].x).toBeGreaterThan(color[0].x)
  })

  it('uses jobId:variantId identity and handoff to asset', () => {
    expect(nodeIdentity({ jobId: 'job_1', variantId: 'warm', isTemporary: true })).toBe(
      'partial:job_1:warm',
    )
    expect(nodeIdentity({ assetId: 'asset_1', variantId: 'warm' })).toBe('asset_1:warm')
    expect(handoffJobToAsset('job_1:warm', 'asset_9', 'warm')).toBe('asset_9:warm')
  })

  it('resolves flow edges via approved or matching source variant', () => {
    const nodes: CanvasGraphNode[] = [
      {
        id: 'p:warm',
        assetId: 'p',
        variantId: 'warm',
        approved: true,
      },
      {
        id: 'p:cool',
        assetId: 'p',
        variantId: 'cool',
      },
      {
        id: 'c:a',
        assetId: 'c',
        variantId: 'a',
      },
    ]
    const edges = resolveFlowEdges(nodes, [
      {
        id: 'p->c',
        sourceAssetId: 'p',
        sourceVariantId: 'cool',
        targetAssetId: 'c',
      },
    ])
    expect(edges).toEqual([
      { id: 'p->c:c:a', source: 'p:cool', target: 'c:a' },
    ])
  })

  it('converts viewport screen/canvas coordinates and zoom percent', () => {
    const viewport = { x: 100, y: 50, zoom: 2 }
    expect(screenToCanvas(140, 90, viewport)).toEqual({ x: 20, y: 20 })
    expect(canvasToScreen(20, 20, viewport)).toEqual({ x: 140, y: 90 })
    expect(zoomPercent(1.25)).toBe(125)
    expect(zoomPercent(2)).toBe(200)
  })
})
