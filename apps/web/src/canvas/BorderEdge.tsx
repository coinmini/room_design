import {
  BaseEdge,
  getBezierPath,
  Position,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react'

/**
 * 边的端点强制落在源/目标节点方框的右/左边中点，
 * 避免自定义 Handle 偏移导致连线「飘」在缝中间。
 */
export default function BorderEdge({
  id,
  source,
  target,
  style,
  markerEnd,
  markerStart,
}: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!sourceNode || !targetNode) return null

  const sw = sourceNode.measured?.width ?? sourceNode.width ?? 220
  const sh = sourceNode.measured?.height ?? sourceNode.height ?? 200
  const th = targetNode.measured?.height ?? targetNode.height ?? 200

  const sx = sourceNode.internals.positionAbsolute.x
  const sy = sourceNode.internals.positionAbsolute.y
  const tx = targetNode.internals.positionAbsolute.x
  const ty = targetNode.internals.positionAbsolute.y

  // 源：右边中点；目标：左边中点（贴方框边框）
  const sourceX = sx + sw
  const sourceY = sy + sh / 2
  const targetX = tx
  const targetY = ty + th / 2

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    // 控制点贴近端点，直线段会接到边框而不是缩在中间
    curvature: 0.25,
  })

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
    />
  )
}

export const canvasEdgeTypes = {
  border: BorderEdge,
}
