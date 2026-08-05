import { describe, expect, it } from 'vitest'
import { buildCanvasFlow, skeletonNodesFromSlots } from './buildCanvasFlow'
import type { CanvasGraph } from './types'

describe('buildCanvasFlow', () => {
  it('merges skeleton nodes and parent-asset set', () => {
    const body: CanvasGraph = {
      projectId: 'p1',
      assetCount: 1,
      nodeCount: 1,
      nodes: [
        {
          id: 'p:v1',
          assetId: 'p',
          variantId: 'v1',
          workflowStage: 'layout',
          approved: true,
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceAssetId: 'p',
          targetAssetId: 'c',
        },
      ],
    }
    const built = buildCanvasFlow({
      body,
      skeletons: [
        {
          id: 's1',
          groupId: 'g1',
          label: '彩平 1',
          workflowStage: 'color_plan',
          parentNodeId: 'p:v1',
          parentAssetId: 'p',
        },
      ],
      expandedStacks: new Set(),
      stage01ConfirmedJobs: {},
    })

    expect(built.parentIds.has('p')).toBe(true)
    expect(built.displayNodes.some((n) => n.id === 'skeleton:s1')).toBe(true)
    expect(built.edges.some((e) => e.skeleton && e.source === 'p:v1')).toBe(
      true,
    )
  })

  it('marks stage01Confirmed for floorplan nodes', () => {
    const body: CanvasGraph = {
      projectId: 'p1',
      assetCount: 1,
      nodeCount: 1,
      nodes: [
        {
          id: 'fp:a',
          assetId: 'fp',
          variantId: 'a',
          workflowStage: 'floorplan',
          jobId: 'job-fp',
        },
      ],
      edges: [],
    }
    const built = buildCanvasFlow({
      body,
      skeletons: [],
      expandedStacks: new Set(),
      stage01ConfirmedJobs: { 'job-fp': { ok: true } },
    })
    expect(built.displayNodes[0].actionCtx.stage01Confirmed).toBe(true)
  })
})

describe('skeletonNodesFromSlots', () => {
  it('maps moduleKey by workflowStage', () => {
    const nodes = skeletonNodesFromSlots([
      {
        id: '1',
        groupId: 'g',
        label: '布局',
        workflowStage: 'layout',
      },
      {
        id: '2',
        groupId: 'g',
        label: '识别',
        workflowStage: 'floorplan',
      },
    ])
    expect(nodes[0].moduleKey).toBe('layout')
    expect(nodes[1].moduleKey).toBe('floorplan')
    expect(nodes[0].isSkeleton).toBe(true)
  })
})
