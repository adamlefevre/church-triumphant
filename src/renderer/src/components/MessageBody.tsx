import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Renders untrusted mail HTML in a sandboxed frame with no scripts. Remote images are
 * blocked unless allowed, so senders cannot tell when a message was opened.
 */
export function MessageBody({ html, text, remoteImages }: { html: string | null; text: string | null; remoteImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)
  const doc = useMemo(() => {
    const body = html
      ? DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['srcset'] })
      : `<pre>${(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
    const img = remoteImages ? 'img-src data: https: http:;' : 'img-src data:;'
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>
      body{margin:0;font:14px/1.55 -apple-system,system-ui,'Segoe UI',sans-serif;color:#e7e9ee;background:transparent;word-wrap:break-word;overflow:hidden}
      a{color:#9db4ff} pre{white-space:pre-wrap;font:inherit;margin:0} img{max-width:100%;height:auto}
      blockquote{border-left:2px solid #333a4a;margin:0;padding-left:10px;color:#9aa1b2} table{max-width:100%}
    </style></head><body>${body}</body></html>`
  }, [html, text, remoteImages])

  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    const measure = () => {
      const h = frame.contentDocument?.documentElement.scrollHeight
      if (h) setHeight(h + 4)
    }
    frame.addEventListener('load', measure)
    const t = setInterval(measure, 500)
    return () => {
      frame.removeEventListener('load', measure)
      clearInterval(t)
    }
  }, [doc])

  // allow-same-origin only lets us measure the height; without allow-scripts nothing in the mail can run.
  return <iframe ref={ref} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full border-0 block" style={{ height }} />
}
