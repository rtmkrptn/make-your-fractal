import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, BaseStyles } from '@primer/react'
// @primer/react's components only *consume* --fgColor-*/--bgColor-*/etc via
// var(); the primitives package is what actually *defines* those custom
// properties (scoped to [data-color-mode] etc.), so both themes must be
// imported for light/dark/auto to do anything at all.
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '@primer/primitives/dist/css/functional/typography/typography.css'
import App from './App'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider colorMode="auto">
      <BaseStyles>
        <App />
      </BaseStyles>
    </ThemeProvider>
  </StrictMode>,
)
