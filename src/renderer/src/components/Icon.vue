<script setup lang="ts">
/** Small SF-Symbols-like stroke icon set. Add new icons to PATHS. */
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })

const PATHS: Record<string, string> = {
  folder: 'M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.7h3.5A1.5 1.5 0 0 1 13.5 7.2v4.3A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z',
  file: 'M4.5 2.5h4.6l2.9 2.9v7.6a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zM9 2.6V5.5h2.9',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  git: 'M4.5 3v10M4.5 9.5c0-2.5 7-1.5 7-5M11.5 4.5m-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M4.5 13m-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M4.5 3m-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0',
  server: 'M3 3.5h10v4H3zM3 8.5h10v4H3zM5.2 5.5h.01M5.2 10.5h.01',
  terminal: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5',
  play: 'M5 3.2v9.6L12.6 8z',
  stop: 'M4 4h8v8H4z',
  bug: 'M5.5 6.5a2.5 2.5 0 0 1 5 0v3.5a2.5 2.5 0 0 1-5 0zM8 6.5V13M3 8.5h2.5M10.5 8.5H13M3.5 5l2 1.5M12.5 5l-2 1.5M3.5 12.5l2-1.5M12.5 12.5l-2-1.5M6.3 4.3 5.5 3M9.7 4.3l.8-1.3',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6',
  branch: 'M5 2.5v11M5 10c0-3 6-2 6-5.5M11 4.5m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
  sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  panel: 'M2.5 3.5h11v9h-11zM2.5 9.5h11',
  warning: 'M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01',
  plus: 'M8 3v10M3 8h10',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3',
  expand: 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9',
  collapse: 'M13.5 2.5 9.5 6.5M9.5 3v3.5H13M2.5 13.5l4-4M6.5 13V9.5H3',
  hammer: 'M9.5 2.5l4 4-1.5 1.5-4-4zM8.6 5.4 2.8 11.2a1.1 1.1 0 0 0 1.6 1.6l5.8-5.8',
  pulse: 'M1.5 8.5h3l1.5-4 3 8 1.5-4h4',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  globe: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12',
  target: 'M8 13.5A5.5 5.5 0 1 0 8 2.5a5.5 5.5 0 0 0 0 11zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1v2M8 13v2M1 8h2M13 8h2',
  maven: 'M3 12.5V4.2L8 9l5-4.8v8.3M3 4.2 5.5 2.5M13 4.2l-2.5-1.7',
  collapseAll: 'M4.5 2.5 8 6l3.5-3.5M4.5 13.5 8 10l3.5 3.5M2.5 8h11',
  follow: 'M3 8h7.5M8 5l3 3-3 3M13 3v10',
  database: 'M3 4c0-1 2.2-1.8 5-1.8S13 3 13 4v8c0 1-2.2 1.8-5 1.8S3 13 3 12zM3 4c0 1 2.2 1.8 5 1.8S13 5 13 4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 6.5v6',
  view: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  column: 'M5.5 2.5h5v11h-5zM5.5 6h5',
  key: 'M5.5 10.5a3 3 0 1 1 2.6-1.5L13.5 9v2h-1.5v1.5h-2v-2l-1.9-.5',
  schema: 'M2.5 4.5h4v3h-4zM9.5 8.5h4v3h-4zM4.5 7.5v2.5h5',
  console: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5',
  plug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2',
  unplug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2M2.5 2.5l11 11',
  edit: 'M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z',
  open: 'M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.7h3.5A1.5 1.5 0 0 1 13.5 7.2v.3M2.5 12.5l1.8-4.5h10.2l-1.8 4.5z',
  check: 'M3 8.5l3.2 3.2L13 4.8',
  undo: 'M5.5 3.5 2.8 6.2l2.7 2.7M3 6.2h6.5a3.7 3.7 0 0 1 0 7.4H7',
  save: 'M3 2.5h8l2.5 2.5v8.5H3zM5.5 2.5v3h5v-3M5.5 13.5V9.5h5v4',
  rowAdd: 'M2.5 4h11M2.5 8h6M2.5 12h6M12 9.5v5M9.5 12h5',
  rowDel: 'M2.5 4h11M2.5 8h6M2.5 12h6M10 10l4 4M14 10l-4 4',
  resume: 'M3.5 3v10M7 3.5l6 4.5-6 4.5z',
  stepOver: 'M2.5 9a5.5 5.5 0 0 1 10.5-2.2M13.5 3.5v3.6H9.9M8 12.2v.1',
  stepInto: 'M8 2.5v7M5 6.8l3 3 3-3M8 13.2v.1',
  stepOut: 'M8 10V3M5 5.7l3-3 3 3M8 13.2v.1',
  mute: 'M8 8m-4.5 0a4.5 4.5 0 1 0 9 0 4.5 4.5 0 1 0-9 0M3 13l10-10'
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.35"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="PATHS[name]" :fill="name === 'play' || name === 'stop' ? 'currentColor' : 'none'" />
  </svg>
</template>
