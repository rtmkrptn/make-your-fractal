import { Button, ButtonGroup, FormControl, Select } from '@primer/react'
import { DownloadIcon, SyncIcon } from '@primer/octicons-react'
import { Preset } from '../types'
import { PALETTE_NAMES } from '../render/shaderTemplate'
import { ShareMenu } from './ShareMenu'
import { ShareOptions } from '../shareState'

interface Props {
  presets: Preset[]
  selectedPresetId: string
  onSelectPreset: (id: string) => void
  maxIter: number
  onMaxIterChange: (v: number) => void
  colorScheme: number
  onColorSchemeChange: (v: number) => void
  onResetView: () => void
  onDownloadPNG: () => void
  onShare: (options: ShareOptions) => void
}

export function ControlsPanel({
  presets,
  selectedPresetId,
  onSelectPreset,
  maxIter,
  onMaxIterChange,
  colorScheme,
  onColorSchemeChange,
  onResetView,
  onDownloadPNG,
  onShare,
}: Props) {
  return (
    <div className="controls-panel">
      <FormControl>
        <FormControl.Label>Preset</FormControl.Label>
        <Select value={selectedPresetId} onChange={(e) => onSelectPreset(e.target.value)} block>
          {presets.map((p) => (
            <Select.Option key={p.id} value={p.id}>
              {p.name}
            </Select.Option>
          ))}
        </Select>
      </FormControl>

      <FormControl>
        <FormControl.Label>Max iterations: {maxIter}</FormControl.Label>
        <input
          type="range"
          min={20}
          max={1500}
          step={10}
          value={maxIter}
          onChange={(e) => onMaxIterChange(Number(e.target.value))}
          className="range-input"
        />
      </FormControl>

      <FormControl>
        <FormControl.Label>Color palette</FormControl.Label>
        <Select value={String(colorScheme)} onChange={(e) => onColorSchemeChange(Number(e.target.value))} block>
          {PALETTE_NAMES.map((name, idx) => (
            <Select.Option key={name} value={String(idx)}>
              {name}
            </Select.Option>
          ))}
        </Select>
      </FormControl>

      <div className="controls-actions-row">
        <ButtonGroup>
          <Button leadingVisual={SyncIcon} onClick={onResetView}>
            Reset view
          </Button>
          <Button leadingVisual={DownloadIcon} onClick={onDownloadPNG}>
            Download PNG
          </Button>
        </ButtonGroup>
        <ShareMenu onShare={onShare} />
      </div>
    </div>
  )
}
