import { Link, useSearchParams } from 'react-router-dom'
import AssetLibrary from '../AssetLibrary'
import '../App.css'
import './home.css'

const CHIP_ACTIONS = [
  { label: 'PS插件', tone: 'orange' },
  { label: '创作者挑战赛', tone: 'purple' },
  { label: '加入合伙人', tone: 'cyan' },
  { label: '邀请有礼', tone: 'peach' },
]

/**
 * 我的资产：独立全页，深色星空壳层，无左侧导航。
 * 兼容 /assets?assetId= 与旧链 /workspace?module=assets&assetId=
 */
export default function AssetsPage() {
  const [params] = useSearchParams()
  const assetId = params.get('assetId')
  const displayName =
    localStorage.getItem('room_design_display_name') || '设计师'

  return (
    <div className="fb-home fb-assets-page">
      <div className="fb-sky-milky" aria-hidden />

      <div className="fb-top-chips">
        <Link to="/" className="fb-user-chip fb-assets-home-link" title="返回首页">
          <span className="fb-user-avatar" aria-hidden>
            ⌂
          </span>
          <div className="fb-user-meta">
            <strong>返回首页</strong>
            <span>工作台</span>
          </div>
        </Link>
        <div className="fb-user-chip">
          <span className="fb-user-avatar" aria-hidden>
            {displayName.slice(0, 1)}
          </span>
          <div className="fb-user-meta">
            <strong>本地用户</strong>
            <span>免费</span>
          </div>
        </div>
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

      <main className="fb-assets-main">
        <AssetLibrary initialAssetId={assetId} />
      </main>
    </div>
  )
}
