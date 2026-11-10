import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { interpolateColor, toRGBColor } from '../Spinner/utils.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
  /**
   * Aura shimmer step. When omitted (and not reduced-motion), the sigil
   * self-drives its own gentle shimmer + light-sweep via an internal clock.
   * AnimatedClawd passes explicit values to keep its frame timeline in sync.
   */
  shimmerStep?: number
  tentacleFrame?: number
}

const TAU_AURA = [
  'rgb(255,94,48)',
  'rgb(238,72,42)',
  'rgb(210,58,44)',
  'rgb(144,55,39)',
  'rgb(255,132,64)',
] as const

type TauAuraColor = (typeof TAU_AURA)[number]

// Core glow ramp, brightest → base, used near the diagonal light-sweep.
const CORE_GLOW = ['rgb(255,224,196)', 'rgb(255,176,128)', 'rgb(255,132,92)'] as const
// The resting core color "breathes" slowly between a deep and a warm ember,
// giving the sigil a living, molten-metal feel when nothing else is moving.
const EMBER_DEEP = { r: 206, g: 78, b: 56 }
const EMBER_WARM = { r: 255, g: 138, b: 96 }

const TAU_SIGIL = [
  ' ╔████████╗  ',
  ' ╚═══██╔══╝ ',
  '     ██║     ',
  '     ██║     ',
  '     ██║  ██╗',
  '     ╚█████╔╝',
  '      ╚════╝ ',
] as const

// Frame cadence (ms) for the self-driven shimmer, plus derived step periods.
const FRAME_MS = 90
const AURA_STEP_MS = 360 // aura color cycles ~4× slower than the sweep
const BREATHE_MS = 3200 // slow brightness oscillation of the resting core
// Diagonal sweep length: max(row + col) across the sigil, plus a dark gap so
// the light pulses through rather than scrolling continuously.
const SWEEP_LEN = 26

function auraColor(index: number, shimmerStep: number): TauAuraColor {
  return TAU_AURA[(index + shimmerStep) % TAU_AURA.length]!
}

// Color for a core cell: bright glow ramp when the sweep is passing over it,
// otherwise the slowly-breathing resting ember.
function coreColor(distance: number, restingCore: string): string {
  return CORE_GLOW[distance] ?? restingCore
}

function auraText(
  text: string,
  row: number,
  shimmerStep: number,
  sweepPos: number,
  restingCore: string,
): React.ReactNode {
  return Array.from(text).map((char, col) => {
    if (char === '█') {
      const distance = Math.abs(row + col - sweepPos)
      return (
        <Text key={`${col}-${char}`} bold color={coreColor(distance, restingCore)}>
          {char}
        </Text>
      )
    }
    return (
      <Text key={`${col}-${char}`} color={auraColor(col, shimmerStep + row)}>
        {char}
      </Text>
    )
  })
}

/**
 * Compact Tau sigil. The exported name stays Clawd so existing layout and
 * animation wiring can migrate without touching every caller in this pass.
 *
 * Animated when uncontrolled: the ember aura cycles, a brighter light-sweep
 * traces diagonally across the core, and the resting core breathes between two
 * embers. Once scrolled into history OffscreenFreeze halts the clock.
 */
export function Clawd({
  pose = 'default',
  shimmerStep,
  tentacleFrame,
}: Props): React.ReactNode {
  const controlled = shimmerStep !== undefined || tentacleFrame !== undefined
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  // Hook must run unconditionally; a null interval simply parks the clock.
  const [ref, time] = useAnimationFrame(
    controlled || reducedMotion ? null : FRAME_MS,
  )

  const posePulse = pose === 'arms-up' ? 2 : pose === 'look-left' ? 1 : 0
  const autoStep = Math.floor(time / AURA_STEP_MS)
  const shift = (shimmerStep ?? autoStep) + (tentacleFrame ?? autoStep) + posePulse
  // Controlled callers have no continuous clock, so ride their frame index;
  // uncontrolled mode walks the sweep smoothly off the internal clock.
  const sweepPos = controlled
    ? shift % SWEEP_LEN
    : Math.floor(time / FRAME_MS) % SWEEP_LEN

  // Slow molten breathing of the resting core (0..1..0 over BREATHE_MS).
  const breathe = (Math.sin((time / BREATHE_MS) * Math.PI * 2) + 1) / 2
  const restingCore = toRGBColor(
    interpolateColor(EMBER_DEEP, EMBER_WARM, breathe),
  )

  return (
    <Box
      ref={ref}
      flexDirection="column"
      alignItems="center"
      width={13}
      flexShrink={0}
    >
      {TAU_SIGIL.map((line, index) => (
        <Text key={line}>
          {auraText(line, index, shift, sweepPos, restingCore)}
        </Text>
      ))}
    </Box>
  )
}
