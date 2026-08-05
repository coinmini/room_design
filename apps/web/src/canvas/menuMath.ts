/** 右键 / 派生菜单贴边定位 */
export function clampMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth: number,
  menuHeight: number,
) {
  const pad = 10
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = clientX
  let y = clientY
  if (x + menuWidth + pad > vw) x = Math.max(pad, vw - menuWidth - pad)
  if (y + menuHeight + pad > vh) y = Math.max(pad, vh - menuHeight - pad)
  if (x < pad) x = pad
  if (y < pad) y = pad
  return { x, y }
}
