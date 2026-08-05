import { useEffect } from 'react'
import type { SchoolCard, SchoolTabKey } from './schoolData'

type DetailProps = {
  open: boolean
  kind: SchoolTabKey
  card: SchoolCard | null
  onClose: () => void
}

type ListProps = {
  open: boolean
  kind: SchoolTabKey
  cards: SchoolCard[]
  onClose: () => void
  onSelect: (card: SchoolCard) => void
}

function useBodyLock(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
}

/** 单条课程 / 作品详情 */
export function SchoolDetailSheet({ open, kind, card, onClose }: DetailProps) {
  useBodyLock(open, onClose)
  if (!open || !card) return null

  const isCourse = kind === 'tutor'

  return (
    <div className="fb-school-root" role="presentation" onClick={onClose}>
      <div
        className="fb-school-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-school-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fb-school-sheet-head">
          <div>
            <span className="fb-school-kicker">
              {isCourse ? '讲师课程' : '讲师作品'}
            </span>
            <h2 id="fb-school-detail-title">{card.title}</h2>
            <p className="fb-school-en">{card.en}</p>
          </div>
          <button
            type="button"
            className="fb-school-close"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="fb-school-sheet-body">
          <div className="fb-school-hero">
            <img src={card.image} alt={card.title} />
          </div>

          <section className="fb-school-block">
            <h3>讲师介绍</h3>
            <div className="fb-school-instructor">
              <div className="fb-school-avatar" aria-hidden>
                {card.instructor.slice(0, 1)}
              </div>
              <div>
                <strong>{card.instructor}</strong>
                <p>{card.instructorBio}</p>
              </div>
            </div>
          </section>

          <section className="fb-school-block">
            <h3>{isCourse ? '课程介绍' : '作品介绍'}</h3>
            {card.meta ? (
              <div className="fb-school-meta">{card.meta}</div>
            ) : null}
            <p>{card.description}</p>
          </section>

          {isCourse ? (
            <section className="fb-school-block">
              <h3>课程视频</h3>
              <div className="fb-school-video" aria-label="视频课程占位">
                <div className="fb-school-video-play" aria-hidden>
                  ▶
                </div>
                <div className="fb-school-video-copy">
                  <strong>视频课程占位</strong>
                  <span>后续可替换为正式课程播放器 / 视频地址</span>
                </div>
              </div>
            </section>
          ) : (
            <section className="fb-school-block">
              <h3>讲师微信</h3>
              <p className="fb-school-qr-tip">
                扫码添加讲师微信，沟通作品与合作（占位二维码，可替换正式图）
              </p>
              <div className="fb-school-qr" aria-label="讲师微信二维码占位">
                <div className="fb-school-qr-inner">
                  <span>WeChat</span>
                  <small>{card.instructor} · 二维码</small>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** 全部课程 / 全部作品网格 */
export function SchoolListSheet({
  open,
  kind,
  cards,
  onClose,
  onSelect,
}: ListProps) {
  useBodyLock(open, onClose)
  if (!open) return null

  const title = kind === 'tutor' ? '全部课程' : '全部作品'

  return (
    <div className="fb-school-root" role="presentation" onClick={onClose}>
      <div
        className="fb-school-sheet fb-school-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-school-list-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fb-school-sheet-head">
          <div>
            <span className="fb-school-kicker">我的学堂</span>
            <h2 id="fb-school-list-title">{title}</h2>
            <p className="fb-school-en">共 {cards.length} 个</p>
          </div>
          <button
            type="button"
            className="fb-school-close"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="fb-school-list-grid">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="fb-school-list-card"
              onClick={() => onSelect(card)}
            >
              <img src={card.image} alt="" loading="lazy" />
              <div className="fb-school-list-copy">
                <strong>{card.title}</strong>
                <span>
                  {card.instructor}
                  {card.meta ? ` · ${card.meta}` : ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
