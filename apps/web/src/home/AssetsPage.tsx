import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import AssetLibrary from '../AssetLibrary'
import '../App.css'
import './home.css'
import UserSheet from './UserSheet'

const CHIP_ACTIONS = [
  { label: 'PS插件', tone: 'orange' },
  { label: '创作者挑战赛', tone: 'purple' },
  { label: '加入合伙人', tone: 'cyan' },
  { label: '邀请有礼', tone: 'peach' },
]

/**
 * 我的资产：独立全页，深色星空壳层，无左侧导航。
 * 「返回首页」与筛选栏同行置左；用户/活动胶囊在同行右侧，避免叠在内容上。
 */
export default function AssetsPage() {
  const [params] = useSearchParams()
  const assetId = params.get('assetId')
  const [userOpen, setUserOpen] = useState(false)
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem('room_design_display_name') || '设计师',
  )

  return (
    <div className="fb-home fb-assets-page">
      <div className="fb-sky-milky" aria-hidden />

      <main className="fb-assets-main">
        <AssetLibrary
          initialAssetId={assetId}
          toolbarLeading={
            <Link to="/" className="fb-assets-back" title="返回首页">
              <span className="fb-assets-back-icon" aria-hidden>
                ⌂
              </span>
              <span>返回首页</span>
            </Link>
          }
          toolbarTrailing={
            <div className="fb-assets-toolbar-chips">
              <button
                type="button"
                className="fb-user-chip"
                aria-label="打开个人中心"
                onClick={() => setUserOpen(true)}
              >
                <span className="fb-user-avatar" aria-hidden>
                  {displayName.slice(0, 1)}
                </span>
                <div className="fb-user-meta">
                  <strong>本地用户</strong>
                  <span>免费</span>
                </div>
              </button>
              {CHIP_ACTIONS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className={`fb-action-chip fb-action-chip--${chip.tone}`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          }
        />
      </main>

      <UserSheet
        open={userOpen}
        onClose={() => {
          setUserOpen(false)
          setDisplayName(
            localStorage.getItem('room_design_display_name') || '设计师',
          )
        }}
        displayName={displayName}
      />
    </div>
  )
}
