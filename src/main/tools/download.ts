/** Download + unzip helpers for IDE-managed tools (JDK, Maven, Tomcat). */
import https from 'https'
import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { publish } from '../core/events'

const UA = { 'User-Agent': 'mixdog-ide' }

export function fetchText(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: UA }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects <= 0) return reject(new Error('too many redirects'))
          return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} ${url}`))
        }
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })
}

export function downloadFile(url: string, dest: string, label: string, redirects = 8): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: UA }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects <= 0) return reject(new Error('too many redirects'))
          return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, label, redirects - 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} ${url}`))
        }
        const total = Number(res.headers['content-length'] ?? 0)
        let got = 0
        let lastPct = -1
        const out = createWriteStream(dest)
        res.on('data', (c: Buffer) => {
          got += c.length
          const pct = total ? Math.floor((got / total) * 100) : -1
          if (pct !== lastPct) {
            lastPct = pct
            publish('tools.download.progress', { label, pct, got, total })
          }
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
        out.on('error', reject)
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

/** Extract a zip with Windows' bundled bsdtar (fast, no dependency). */
export function unzip(zip: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zip, '-C', destDir], { windowsHide: true, maxBuffer: 1 << 24 }, (err, _o, stderr) =>
      err ? reject(new Error(stderr || String(err))) : resolve()
    )
  })
}

/**
 * Download a zip and extract it into `parentDir`. Returns the path of the
 * single top-level folder the archive contained.
 */
export async function installZip(url: string, parentDir: string, label: string): Promise<string> {
  await fs.mkdir(parentDir, { recursive: true })
  const tmp = join(parentDir, `.download-${Date.now()}.zip`)
  const staging = join(parentDir, `.extract-${Date.now()}`)
  publish('tools.download.start', { label, url })
  try {
    await downloadFile(url, tmp, label)
    publish('tools.download.progress', { label, pct: 100, phase: 'extract' })
    await fs.mkdir(staging)
    await unzip(tmp, staging)
    const [top] = await fs.readdir(staging)
    const final = join(parentDir, top)
    await fs.rm(final, { recursive: true, force: true })
    await fs.rename(join(staging, top), final)
    publish('tools.download.done', { label, path: final })
    return final
  } catch (e) {
    publish('tools.download.error', { label, error: String(e) })
    throw e
  } finally {
    await fs.rm(tmp, { force: true })
    await fs.rm(staging, { recursive: true, force: true })
  }
}

/** Highest "x.y.z/" entry in an Apache directory listing, optionally filtered by major prefix. */
export async function latestApacheVersion(listingUrl: string, prefix = ''): Promise<string> {
  const html = await fetchText(listingUrl)
  const versions = [...html.matchAll(/href="v?(\d+\.\d+\.\d+)\/"/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(prefix))
  if (!versions.length) throw new Error(`버전 목록을 찾을 수 없습니다: ${listingUrl}`)
  const num = (v: string): number[] => v.split('.').map(Number)
  versions.sort((a, b) => {
    const [x, y] = [num(a), num(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  return versions[versions.length - 1]
}
