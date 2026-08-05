/**
 * W2-1 spike：验证 @xyflow/react + React 19.2 + 自定义节点 + 深色 CSS 变量。
 * 结论：成功 → 正式画布采用 xyflow（见 ProjectCanvas）。
 */
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './theme.css'
import { canvasNodeTypes } from './CanvasNodeCard'
import type { CanvasGraphNode } from './types'

const sample: CanvasGraphNode = {
  id: 'spike:demo',
  assetId: 'spike',
  variantId: 'demo',
  label: 'spike_card',
  title: 'Spike 节点',
  workflowStage: 'color_plan',
  approved: true,
  url: '',
}

export default function SpikeCanvas() {
  return (
    <div className="canvas-theme" style={{ height: 360, borderRadius: 12, overflow: 'hidden' }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            {
              id: sample.id,
              type: 'canvasCard',
              position: { x: 80, y: 60 },
              data: { graphNode: sample, showActions: true },
            },
          ]}
          edges={[]}
          nodeTypes={canvasNodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.5}
            color="rgba(255,255,255,0.09)"
            bgColor="#0a0a0d"
          />
          <MiniMap />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
