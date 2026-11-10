import * as React from 'react'
import { useState } from 'react'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { hueToRgb, toRGBColor } from '../Spinner/utils.js'

// Tau brand hue range: violet (270) → cyan (180) → green (120), cycling
const TAU_HUE_START = 270  // violet
const TAU_HUE_RANGE = 150  // sweeps 270→120 then back
const CYCLE_MS = 3000      // full cycle period

// Settled color: electric cyan-mint (Tau brand)
const SETTLED_COLOR = toRGBColor({ r: 120, g: 255, b: 220 })

function tauPulse(time: number): { r: number; g: number; b: number } {
  const t = (time % CYCLE_MS) / CYCLE_MS
  // Sine wave: smooth 0→1→0 oscillation over the hue range
  const wave = (Math.sin(t * Math.PI * 2 - Math.PI / 2) + 1) / 2
  const hue = (TAU_HUE_START - wave * TAU_HUE_RANGE + 360) % 360
  return hueToRgb(hue)
}

export function AnimatedAsterisk({
  char = TEARDROP_ASTERISK,
}: {
  char?: string
}): React.ReactNode {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 50)

  if (reducedMotion) {
    return (
      <Box ref={ref}>
        <Text color={SETTLED_COLOR}>{char}</Text>
      </Box>
    )
  }

  const rgb = tauPulse(time)

  return (
    <Box ref={ref}>
      <Text color={toRGBColor(rgb)}>{char}</Text>
    </Box>
  )
}
