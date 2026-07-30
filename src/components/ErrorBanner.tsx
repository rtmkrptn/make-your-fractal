import { Banner } from '@primer/react'

interface Props {
  message: string | null
}

export function ErrorBanner({ message }: Props) {
  if (!message) return null
  return (
    <Banner
      variant="critical"
      title="Error"
      description={
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          {message}
        </pre>
      }
    />
  )
}
