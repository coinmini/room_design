import { useEffect, useState } from 'react'

export type NotifyItem = {
  id: string
  title: string
  body: string
  time: string
  unread?: boolean
  tag?: string
}

const SAMPLE_NOTICES: NotifyItem[] = [
  {
    id: 'n1',
    title: '生图任务已完成',
    body: '你提交的「真实感室内效果图」已写入我的资产，可前往查看。',
    time: '刚刚',
    unread: true,
    tag: '生成',
  },
  {
    id: 'n2',
    title: '项目已创建',
    body: '精选案例「流线玻璃幕墙」已创建为新项目，可在画布继续编辑。',
    time: '12 分钟前',
    unread: true,
    tag: '项目',
  },
  {
    id: 'n3',
    title: '学堂更新',
    body: '讲师课程新增「灯光设计进阶」「风格色板系统课」，欢迎学习。',
    time: '1 小时前',
    unread: true,
    tag: '学堂',
  },
  {
    id: 'n4',
    title: '系统提示',
    body: '本地模型 kuyao · gpt-image-2 运行正常，可继续使用首页生图。',
    time: '今天 10:20',
    unread: false,
    tag: '系统',
  },
  {
    id: 'n5',
    title: '资产同步',
    body: '个人资产库已自动归档最近成功任务，缩略图已更新。',
    time: '昨天',
    unread: false,
    tag: '资产',
  },
]

type NotifySheetProps = {
  open: boolean
  onClose: () => void
  onUnreadChange?: (count: number) => void
}

export default function NotifySheet({
  open,
  onClose,
  onUnreadChange,
}: NotifySheetProps) {
  const [items, setItems] = useState<NotifyItem[]>(SAMPLE_NOTICES)

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

  useEffect(() => {
    const unread = items.filter((item) => item.unread).length
    onUnreadChange?.(unread)
  }, [items, onUnreadChange])

  if (!open) return null

  const unreadCount = items.filter((item) => item.unread).length

  const markAllRead = () => {
    setItems((current) => current.map((item) => ({ ...item, unread: false })))
  }

  const markRead = (id: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, unread: false } : item,
      ),
    )
  }

  return (
    <div className="fb-notify-root" role="presentation" onClick={onClose}>
      <div
        className="fb-notify-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-notify-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fb-notify-head">
          <div>
            <h2 id="fb-notify-title">通知</h2>
            <p>
              {unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
            </p>
          </div>
          <div className="fb-notify-head-actions">
            {unreadCount > 0 ? (
              <button
                type="button"
                className="fb-notify-action"
                onClick={markAllRead}
              >
                全部已读
              </button>
            ) : null}
            <button
              type="button"
              className="fb-notify-close"
              aria-label="关闭"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        <div className="fb-notify-list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`fb-notify-item${item.unread ? ' is-unread' : ''}`}
              onClick={() => markRead(item.id)}
            >
              <div className="fb-notify-item-top">
                <span className="fb-notify-tag">{item.tag ?? '消息'}</span>
                <time>{item.time}</time>
              </div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              {item.unread ? <span className="fb-notify-dot" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function countUnreadNotices(items: NotifyItem[] = SAMPLE_NOTICES): number {
  return items.filter((item) => item.unread).length
}
