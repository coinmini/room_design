import { useEffect, useState } from 'react'

export type AboutDoc = 'agreement' | 'privacy' | null

type AboutSheetProps = {
  open: boolean
  onClose: () => void
}

/**
 * 左侧 dock「应用」弹出：关于 / 协议 / 隐私 / 客服
 * 备案与版权文案按本地 AI 设计产品占位，可后续替换正式主体信息。
 */
export default function AboutSheet({ open, onClose }: AboutSheetProps) {
  const [doc, setDoc] = useState<AboutDoc>(null)

  useEffect(() => {
    if (!open) setDoc(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (doc) setDoc(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, doc, onClose])

  if (!open) return null

  return (
    <div className="fb-about-root" role="presentation" onClick={onClose}>
      <div
        className="fb-about-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-about-title"
        onClick={(event) => event.stopPropagation()}
      >
        {doc ? (
          <div className="fb-about-doc">
            <header className="fb-about-doc-head">
              <button
                type="button"
                className="fb-about-back"
                onClick={() => setDoc(null)}
              >
                ‹ 返回
              </button>
              <h2>
                {doc === 'agreement' ? '用户协议' : '隐私政策'}
              </h2>
            </header>
            <div className="fb-about-doc-body">
              {doc === 'agreement' ? <AgreementBody /> : <PrivacyBody />}
            </div>
          </div>
        ) : (
          <>
            <header className="fb-about-head">
              <div className="fb-about-brand" aria-hidden>
                RD
              </div>
              <div>
                <h2 id="fb-about-title">AI 室内设计</h2>
                <p>本地无限画布 · 智能创作工作台</p>
              </div>
              <button
                type="button"
                className="fb-about-close"
                aria-label="关闭"
                onClick={onClose}
              >
                ×
              </button>
            </header>

            <div className="fb-about-links">
              <button
                type="button"
                className="fb-about-link"
                onClick={() => setDoc('agreement')}
              >
                <span>用户协议</span>
                <span aria-hidden>›</span>
              </button>
              <button
                type="button"
                className="fb-about-link"
                onClick={() => setDoc('privacy')}
              >
                <span>隐私政策</span>
                <span aria-hidden>›</span>
              </button>
            </div>

            <section className="fb-about-support">
              <h3>联系客服</h3>
              <p>扫码添加客服（请替换为正式二维码）</p>
              <div className="fb-about-qr" aria-label="客服二维码占位">
                <div className="fb-about-qr-inner">
                  <span>QR</span>
                  <small>客服二维码</small>
                </div>
              </div>
              <p className="fb-about-support-tip">
                工作日 10:00–19:00 · support@example.com
              </p>
            </section>

            <footer className="fb-about-foot">
              <div>京ICP备xxxxxx号</div>
              <div>© 2026 AI室内设计</div>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function AgreementBody() {
  return (
    <>
      <p className="fb-about-meta">更新日期：2026 年 8 月 5 日 · 生效日期：2026 年 8 月 5 日</p>
      <p>
        欢迎使用「AI 室内设计」本地工作台（下称「本产品」）。本用户协议（下称「本协议」）是你与本产品运营方之间关于使用本产品及相关服务的法律协议。请你在使用前仔细阅读并充分理解全部条款。你开始使用本产品，即视为已阅读并同意本协议。
      </p>
      <h3>1. 服务内容</h3>
      <p>
        本产品面向室内设计、空间方案等专业创作场景，提供包括但不限于：本地项目管理、无限画布工作流、图像生成与编辑、资产归档与预览等功能。部分能力依赖你配置的第三方模型服务（如图像生成 API），其可用性、计费与输出质量由相应服务提供方决定。
      </p>
      <h3>2. 账号与本地使用</h3>
      <p>
        当前版本以本地部署/本地使用为主。你应妥善保管本机数据、密钥与访问凭证。因设备丢失、密钥泄露或未授权访问导致的损失，由你自行承担，法律法规另有规定的除外。
      </p>
      <h3>3. 用户内容与知识产权</h3>
      <p>
        你上传、输入的图片、文案、提示词及生成结果等（下称「用户内容」）的权利归属，按你与内容来源方之间的约定及适用法律确定。你保证对用户内容拥有合法权利或已获充分授权，不得上传侵权、违法或侵犯他人隐私的内容。
      </p>
      <p>
        本产品界面、软件代码、文档与品牌标识的知识产权归运营方或权利人所有。未经许可，不得复制、修改、反向工程或用于本协议未允许的用途。
      </p>
      <h3>4. AI 生成内容特别提示</h3>
      <p>
        AI 生成结果可能存在不准确、不完整或不适用于施工落地的情况，仅供设计参考与创作辅助。你应对生成结果进行专业审核后再用于商业交付、报建或施工。因直接采用未经验证的生成结果造成的损失，本产品在法律允许范围内不承担责任。
      </p>
      <h3>5. 禁止行为</h3>
      <p>
        你不得利用本产品从事违法违规活动，不得攻击、干扰服务正常运行，不得滥用接口或进行自动化批量抓取，不得规避安全或计费机制。
      </p>
      <h3>6. 免责与责任限制</h3>
      <p>
        在法律允许的最大范围内，本产品按「现状」提供，不对不间断、无错误或满足特定目的作出保证。因不可抗力、第三方服务中断、网络故障等导致的服务不可用，运营方不承担责任。
      </p>
      <h3>7. 协议变更与终止</h3>
      <p>
        我们可能适时修订本协议，并通过产品内提示等方式公布。若你继续使用，即视为接受修订。你可随时停止使用本产品；若严重违反本协议，我们有权限制或终止向你提供服务。
      </p>
      <h3>8. 适用法律与争议解决</h3>
      <p>
        本协议适用中华人民共和国法律。因本协议产生的争议，双方应友好协商；协商不成的，提交运营方所在地有管辖权的人民法院诉讼解决。
      </p>
      <h3>9. 联系我们</h3>
      <p>
        关于本协议的问题，可通过产品内「联系客服」或发送邮件至 support@example.com 与我们联系。
      </p>
    </>
  )
}

function PrivacyBody() {
  return (
    <>
      <p className="fb-about-meta">更新日期：2026 年 8 月 5 日 · 生效日期：2026 年 8 月 5 日</p>
      <p>
        「AI 室内设计」（下称「我们」）重视个人信息与创作数据的保护。本隐私政策说明我们在提供 AI 室内设计相关服务时，如何收集、使用、存储与保护信息，以及你享有的权利。
      </p>
      <h3>1. 我们处理的信息</h3>
      <p>
        <strong>本地创作数据：</strong>项目名称、设计提示词、画布节点与布局、上传的参考图、生成结果及资产缩略图等，默认保存在你的本地环境或你配置的服务端存储中。
      </p>
      <p>
        <strong>设备与日志信息：</strong>为保障服务稳定，可能记录必要的技术日志（如错误码、任务状态、接口耗时），用于排查问题与改进体验。
      </p>
      <p>
        <strong>第三方模型服务：</strong>当你启用图像生成、视觉识别等能力时，相关图片与提示词将按你的配置发送至对应 API 提供商处理。请同时阅读该提供商的隐私与数据政策。
      </p>
      <h3>2. 我们如何使用信息</h3>
      <p>
        用于实现项目管理、画布工作流、图像生成与编辑、资产展示；用于故障诊断、安全防护与产品优化；在获得你同意或法律要求时用于其他用途。
      </p>
      <h3>3. 存储与安全</h3>
      <p>
        我们采取合理的技术与管理措施保护数据安全。本地部署场景下，数据主要受你所在环境的安全策略约束。请勿在不可信设备上保存密钥，并定期备份重要项目。
      </p>
      <h3>4. 共享与披露</h3>
      <p>
        我们不会出售你的个人信息。仅在下列情况下共享或披露：获得你的明确同意；为实现服务所必需的第三方处理者（如模型 API）；法律法规或有权机关依法要求。
      </p>
      <h3>5. 你的权利</h3>
      <p>
        在适用法律范围内，你有权查询、更正、删除本地保存的项目与资产数据，或停止使用相关功能。你可通过删除项目/资产、清理本地存储或联系客服行使相关权利。
      </p>
      <h3>6. 未成年人保护</h3>
      <p>
        本产品主要面向具备完全民事行为能力的专业用户。若你是未成年人，请在监护人同意与指导下使用。
      </p>
      <h3>7. 政策更新</h3>
      <p>
        我们可能适时更新本政策，并通过产品界面提示。重大变更时，我们将以更显著方式告知。
      </p>
      <h3>8. 联系我们</h3>
      <p>
        如对本政策有疑问、投诉或建议，请通过产品内「联系客服」或 support@example.com 与我们联系。我们将在合理期限内答复。
      </p>
    </>
  )
}
