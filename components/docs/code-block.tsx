'use client'

import { useState } from 'react'

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative group border border-white/10 bg-white/[0.02]">
      {lang != null && (
        <span className="absolute top-2 left-3 font-mono text-[10px] text-white/25 uppercase tracking-wider">
          {lang}
        </span>
      )}
      <button
        onClick={copy}
        className="absolute top-2 right-2 font-mono text-[10px] text-white/30 hover:text-white border border-white/10 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      {/* Wide snippets scroll inside the block rather than pushing the page sideways. */}
      <pre className="overflow-x-auto px-4 pt-9 pb-4 text-[13px] leading-relaxed">
        <code className="font-mono text-white/75">{code}</code>
      </pre>
    </div>
  )
}
