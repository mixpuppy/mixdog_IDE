<script setup lang="ts">
/**
 * mixdog progress bar: a little dog runs along the track toward a bone.
 * pct = 0..100 -> the dog stands at that point with a paw-print trail behind it.
 * pct = null   -> unknown length: the dog keeps running laps.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ pct: number | null; width?: number; height?: number }>(), { width: 150, height: 6 })

const DOG_W = 26
const indeterminate = computed(() => props.pct === null)
const p = computed(() => Math.max(0, Math.min(100, props.pct ?? 0)))
/** dog's left edge in px; it stops right before the bone */
const dogX = computed(() => (props.width - DOG_W - 6) * (p.value / 100))
</script>

<template>
  <div class="dogbar" :class="{ ind: indeterminate }" :style="{ width: width + 'px', '--h': height + 'px', '--w': width + 'px' }">
    <div class="track">
      <div v-if="!indeterminate" class="fill" :style="{ width: `calc(${dogX + DOG_W / 2}px)` }" />
    </div>
    <!-- the goal -->
    <svg class="bone" width="12" height="7" viewBox="0 0 12 7" aria-hidden="true">
      <path d="M2.2 1.2a1.3 1.3 0 0 1 2.1.9h3.4a1.3 1.3 0 1 1 1.9 1.4 1.3 1.3 0 1 1-1.9 1.4H4.3a1.3 1.3 0 1 1-2.1.9 1.3 1.3 0 0 1 0-2.3 1.3 1.3 0 0 1 0-2.3z" />
    </svg>
    <div class="dog" :style="indeterminate ? {} : { transform: `translateX(${dogX}px)` }">
      <svg :width="DOG_W" height="19" viewBox="0 0 28 20" aria-hidden="true">
        <g class="bob">
          <path class="tail" d="M5.5 8.5C3.5 7.5 2.2 5.2 2.4 2.6" />
          <g class="legs a">
            <rect x="6.2" y="11.5" width="2" height="6" rx="1" />
            <rect x="16.2" y="11.5" width="2" height="6" rx="1" />
          </g>
          <g class="legs b">
            <rect x="8.6" y="11.5" width="2" height="6" rx="1" />
            <rect x="13.8" y="11.5" width="2" height="6" rx="1" />
          </g>
          <ellipse class="fur" cx="12" cy="10" rx="8" ry="4.6" />
          <ellipse class="spot" cx="9.5" cy="8.6" rx="3" ry="2" />
          <rect class="collar" x="16.8" y="8.2" width="1.8" height="4.4" rx="0.9" transform="rotate(-12 17.7 10.4)" />
          <circle class="fur" cx="21" cy="7" r="4.5" />
          <ellipse class="snout" cx="24.8" cy="8.6" rx="2.7" ry="1.9" />
          <circle class="nose" cx="27.2" cy="8" r="0.95" />
          <circle class="eye" cx="22.2" cy="5.9" r="0.85" />
          <path class="ear" d="M19.6 2.9c-1.8.2-2.8 1.9-2.4 4.6.2 1 1.2 1.2 1.7.4.8-1.3 1.3-3 .7-5z" />
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.dogbar {
  position: relative;
  height: 20px;
  flex-shrink: 0;
}
.track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  height: var(--h);
  border-radius: 99px;
  background: var(--hover);
  box-shadow: inset 0 0 0 0.5px var(--border-strong);
  overflow: hidden;
}
/* paw-print trail */
.fill {
  height: 100%;
  border-radius: 99px;
  background-color: #d9a066;
  background-image: radial-gradient(circle at 3px 50%, rgba(90, 55, 25, 0.45) 1.1px, transparent 1.4px);
  background-size: 7px 100%;
  transition: width 0.35s ease-out;
}
.ind .track::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  border-radius: 99px;
  background: linear-gradient(90deg, transparent, rgba(217, 160, 102, 0.55));
  animation: lap 1.8s linear infinite;
}
.bone {
  position: absolute;
  right: -2px;
  bottom: 1px;
  fill: #f3e6cf;
  stroke: #b28a5c;
  stroke-width: 0.6;
}
.dog svg {
  display: block;
}
.dog {
  position: absolute;
  left: 0;
  bottom: calc(var(--h) - 1px);
  transition: transform 0.35s ease-out;
}
.ind .dog {
  animation: dogLap 1.8s linear infinite;
}
@keyframes lap {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
@keyframes dogLap {
  from {
    transform: translateX(-26px);
  }
  to {
    transform: translateX(calc(var(--w) - 8px));
  }
}
.fur {
  fill: #d9a066;
}
.spot {
  fill: #b9814b;
}
.snout {
  fill: #ecc796;
}
.nose,
.eye {
  fill: #2b1d12;
}
.ear {
  fill: #8a5a2f;
}
.collar {
  fill: #ff453a;
}
.tail {
  fill: none;
  stroke: #c98f55;
  stroke-width: 2;
  stroke-linecap: round;
  transform-box: fill-box;
  transform-origin: 100% 100%;
  animation: wag 0.3s ease-in-out infinite alternate;
}
.legs rect {
  fill: #c98f55;
  transform-box: fill-box;
  transform-origin: 50% 0;
}
.legs.a rect {
  animation: stepA 0.32s ease-in-out infinite alternate;
}
.legs.b rect {
  animation: stepB 0.32s ease-in-out infinite alternate;
}
.bob {
  animation: bob 0.16s ease-in-out infinite alternate;
}
@keyframes stepA {
  from {
    transform: rotate(32deg);
  }
  to {
    transform: rotate(-32deg);
  }
}
@keyframes stepB {
  from {
    transform: rotate(-32deg);
  }
  to {
    transform: rotate(32deg);
  }
}
@keyframes wag {
  from {
    transform: rotate(-14deg);
  }
  to {
    transform: rotate(18deg);
  }
}
@keyframes bob {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-0.8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .legs rect,
  .tail,
  .bob,
  .ind .dog,
  .ind .track::after {
    animation: none;
  }
}
</style>
