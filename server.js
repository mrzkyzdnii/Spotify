import http from 'http'
import { URL } from 'url'
import { WebSocketServer } from 'ws'
import yts from 'yt-search'
import axios from 'axios'
import * as cheerio from 'cheerio'

const PORT = Number(process.env.PORT || 3020)
const MAX_RESULTS = 15
const BASE_URL = 'https://spotidown.app'
const RAPID_HOST = 'rapid.spotidown.app'
const SITE_KEY = '6LcXkaUqAAAAAGvO0z9Mg54lpG22HE4gkl3XYFTK'
const RECAPTCHA_VERSION = 'AI7Fbyu7OpLvtxXargsbepSz'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const jobs = new Map()
const coverCache = new Map()

const headers = (extra = {}) => ({ 'User-Agent': USER_AGENT, ...extra })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = (res, status, data) => {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
  res.end(body)
}
const baseUrl = req => `${String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim()}://${String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim()}`
const clean = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)
const safeId = value => String(value ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)

class Spotidown {
  async recaptcha() {
    const co = Buffer.from('https://spotidown.app:443').toString('base64').replace(/=/g, '.')
    const anchor = new URL('https://www.google.com/recaptcha/api2/anchor')
    for (const [key, value] of [['ar','1'],['k',SITE_KEY],['co',co],['hl','en'],['v',RECAPTCHA_VERSION],['size','invisible'],['cb','123']]) anchor.searchParams.set(key, value)
    const anchorHtml = (await axios.get(anchor.toString(), { headers: headers() })).data
    const token = anchorHtml.match(/id="recaptcha-token" value="([^"]+)"/)?.[1]
    if (!token) throw new Error('Captcha Spotidown tidak tersedia.')
    const reload = await axios.post(`https://www.google.com/recaptcha/api2/reload?k=${SITE_KEY}`, new URLSearchParams({ v: RECAPTCHA_VERSION, reason: 'q', c: token, k: SITE_KEY, co, hl: 'en', size: 'invisible' }).toString(), { headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded' }) })
    const result = reload.data.match(/"rresp","([^"]+)"/)?.[1]
    if (!result) throw new Error('Captcha gagal diproses.')
    return result
  }

  async session() {
    const response = await axios.get(`${BASE_URL}/en6`, { headers: headers() })
    const cookie = response.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') || ''
    const $ = cheerio.load(response.data)
    const input = $("form[name='spotifyurl'] input[type='hidden']").not('#g-recaptcha-response').first()
    const csrfName = input.attr('name')
    const csrfValue = input.attr('value')
    if (!csrfName || !csrfValue) throw new Error('Token Spotidown tidak ditemukan.')
    return { cookie, csrfName, csrfValue }
  }

  async resolve(query) {
    const session = await this.session()
    const captcha = await this.recaptcha()
    const form = new FormData()
    form.append('url', query.trim())
    form.append('g-recaptcha-response', captcha)
    form.append(session.csrfName, session.csrfValue)
    const response = await axios.post(`${BASE_URL}/action`, form, { headers: headers({ Cookie: session.cookie, Referer: `${BASE_URL}/en6`, Origin: BASE_URL, 'X-Requested-With': 'XMLHttpRequest' }) })
    if (response.data.error) throw new Error(clean(response.data.message || 'Lagu tidak ditemukan.'))
    const $ = cheerio.load(response.data.data)
    const formTrack = $("form[name='submitspurl']").first()
    const data = formTrack.find("input[name='data']").val()
    const base = formTrack.find("input[name='base']").val()
    const token = formTrack.find("input[name='token']").val()
    if (!data || !base || !token) throw new Error('Lagu tidak ditemukan atau hasilnya kosong.')
    let info = {}
    try { info = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) } catch {}
    const trackForm = new FormData()
    trackForm.append('data', data); trackForm.append('base', base); trackForm.append('token', token)
    const track = await axios.post(`${BASE_URL}/action/track`, trackForm, { headers: headers({ Cookie: session.cookie, Referer: `${BASE_URL}/en6`, Origin: BASE_URL, 'X-Requested-With': 'XMLHttpRequest' }) })
    if (track.data.error) throw new Error(clean(track.data.message || 'Gagal membuat link audio.'))
    const $$ = cheerio.load(track.data.data)
    const downloadUrl = $$('a[href*="rapid.spotidown.app"]').attr('href')
    if (!downloadUrl) throw new Error('Link audio tidak ditemukan.')
    const parsed = new URL(downloadUrl)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== RAPID_HOST) throw new Error('Link audio tidak valid.')
    return { title: info.name || $('h3[itemprop="name"]').text().trim() || query, artist: info.artist || $('.spotidown-downloader-middle p').text().trim() || 'Unknown Artist', album: info.album || '-', duration: info.duration || '-', cover: info.cover || $('.spotidown-downloader-left img').attr('src') || '', downloadUrl: parsed.toString() }
  }
}
const spot = new Spotidown()
const resolveJob = query => {
  const key = query.trim().toLowerCase()
  if (jobs.has(key)) return jobs.get(key)
  const job = spot.resolve(query).finally(() => jobs.delete(key))
  jobs.set(key, job)
  return job
}

async function coverProxy(res, coverUrl) {
  try {
    const parsed = new URL(coverUrl)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid')
    const cached = coverCache.get(parsed.toString())
    if (cached && cached.expires > Date.now()) { res.writeHead(200, cached.headers); return res.end(cached.buffer) }
    const response = await axios.get(parsed.toString(), { responseType: 'arraybuffer', headers: headers({ Accept: 'image/*' }), timeout: 20000 })
    const buffer = Buffer.from(response.data)
    const out = { buffer, headers: { 'content-type': response.headers['content-type'] || 'image/jpeg', 'content-length': buffer.length, 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' }, expires: Date.now() + 86400000 }
    coverCache.set(parsed.toString(), out); res.writeHead(200, out.headers); res.end(buffer)
  } catch { json(res, 404, { status: false, message: 'Cover tidak tersedia.' }) }
}
async function audioProxy(req, res, remoteUrl) {
  const response = await fetch(remoteUrl, { headers: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*' } })
  if (!response.ok && response.status !== 206) throw new Error(`audio upstream ${response.status}`)
  const out = { 'content-type': response.headers.get('content-type') || 'audio/mpeg', 'accept-ranges': response.headers.get('accept-ranges') || 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=1800' }
  for (const key of ['content-length', 'content-range', 'content-disposition']) { const value = response.headers.get(key); if (value) out[key] = value }
  res.writeHead(response.status, out)
  if (req.method === 'HEAD' || !response.body) return res.end()
  const reader = response.body.getReader()
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r)) }; res.end() } catch { try { res.destroy() } catch {} }
}

const rootHtml = '<!doctype html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1>SpoPlay</h1><p>WebSocket Spotify player is running.</p><p>/health</p></body></html>'
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  res.setHeader('access-control-allow-origin', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(rootHtml) }
  if (u.pathname === '/health') return json(res, 200, { ok: true, service: 'SpoPlay', version: '1.0.0', uptime: process.uptime() })
  if (u.pathname === '/cover') return coverProxy(res, u.searchParams.get('url') || '')
  if (u.pathname === '/audio') {
    const remote = u.searchParams.get('url') || ''
    try { const parsed = new URL(remote); if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== RAPID_HOST) throw new Error('invalid'); return await audioProxy(req, res, parsed.toString()) } catch { return json(res, 502, { status: false, message: 'Audio gagal dimuat.' }) }
  }
  json(res, 404, { status: false, message: 'Not Found' })
})
const wss = new WebSocketServer({ server })
const send = (ws, type, data) => ws.readyState === 1 && ws.send(JSON.stringify({ type, data, time: Date.now() }))
wss.on('connection', (ws, request) => {
  const origin = baseUrl(request)
  send(ws, 'ready', { service: 'SpoPlay', version: '1.0.0' })
  ws.on('message', async raw => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return send(ws, 'error', { message: 'Request tidak valid.' }) }
    if (message.type === 'search') {
      const query = String(message.query || '').trim().slice(0, 100)
      if (!query) return send(ws, 'search_result', { query: '', results: [] })
      send(ws, 'searching', { query })
      try {
        const result = await yts(query + ' music')
        const items = (result.videos || []).slice(0, MAX_RESULTS).map(v => ({ id: v.videoId, title: v.title, artist: v.author?.name || 'Unknown Artist', duration: v.timestamp || '', views: Number(v.views || 0), ago: v.ago || '', cover: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`, query: `${v.title} ${v.author?.name || ''}`.trim() }))
        send(ws, 'search_result', { query, results: items })
      } catch (error) { send(ws, 'error', { message: 'Pencarian musik gagal. Coba kata kunci lain.' }) }
      return
    }
    if (message.type === 'resolve') {
      const query = String(message.query || '').trim().slice(0, 180)
      if (!query) return send(ws, 'error', { message: 'Lagu tidak valid.' })
      send(ws, 'resolving', { message: 'Menyiapkan audio Spotify...' })
      try {
        const result = await resolveJob(query)
        send(ws, 'resolved', { ...result, cover: result.cover ? `${origin}/cover?url=${encodeURIComponent(result.cover)}` : '', streamUrl: `${origin}/audio?url=${encodeURIComponent(result.downloadUrl)}` })
      } catch (error) { send(ws, 'error', { message: clean(error?.message || 'Gagal menyiapkan audio.') }) }
    }
  })
})
server.listen(PORT, '0.0.0.0', () => console.log(`SpoPlay listening on 0.0.0.0:${PORT}`))
